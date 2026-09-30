/**
 * @zhourenke/dsh-agent-rate-limit
 *
 * An agent loop rate limiter that prevents TPM (Tokens Per Minute) and
 * RPM (Requests Per Minute) limit violations by intercepting the LLM
 * streaming pipeline and adding adaptive delays between requests.
 *
 * Supports configurable limits and a sliding-window algorithm that tracks
 * both input and output tokens. Retry logic for 429/rate-limit errors is
 * delegated to the built-in DSH `dsh-llm-retry` plugin via provider-level
 * `retryPolicy` configuration.
 *
 * Verified against DSH 0.2.0-rc.2. The `llm/stream` Waterfall signature still
 * ends in a lazy `async *adapterStream`, so a listener's delay genuinely
 * precedes the provider request; the `TokenUsage` counts stay disjoint; a
 * failure still arrives as a `finish` chunk whose `reason.kind` is `error` or
 * `aborted`; and the `timer`/`commands`/`tokenMeter` services this plugin reads
 * are all present. No shipped DSH package paces requests against a provider
 * TPM/RPM quota: `dsh-llm-retry` reacts to 429s after the fact, and
 * `dsh-token-meter` measures context pressure, not rate limits.
 *
 * @module @zhourenke/dsh-agent-rate-limit
 */

import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sliding window size in milliseconds (60 seconds). */
const DEFAULT_WINDOW_MS = 60_000

/** Default TPM (Tokens Per Minute) limit, matching a common high-throughput tier. */
const DEFAULT_TPM_LIMIT = 1_200_000

/** Default RPM (Requests Per Minute) limit. */
const DEFAULT_RPM_LIMIT = 15_000

/** Default safety factor (0.8 = use 80% of the limit to leave buffer). */
const DEFAULT_SAFETY_FACTOR = 0.8

/** Default: verbose logging (false = only log startup and critical errors). */
const DEFAULT_VERBOSE = false

/**
 * Default: count failed/aborted attempts into the window when the stream
 * reported actual usage. The upstream has already processed and billed the
 * prompt, so excluding it would understate window pressure. Failed attempts
 * are logged either way.
 */
const DEFAULT_COUNT_FAILED_ATTEMPTS = true

// ---------------------------------------------------------------------------
// Sliding window rate limiter
// ---------------------------------------------------------------------------

/** One entry in the sliding-window token history. */
interface WindowEntry {
  /** Timestamp when the tokens were consumed (ms). */
  timestamp: number
  /** Number of tokens consumed. */
  tokens: number
}

/** @internal Sliding-window rate limiter state. */
const windowEntries: WindowEntry[] = []

/** @internal Recent actual input token counts from the API usage chunk (max 3 entries). */
const recentInputTokens: number[] = []

/**
 * Get the average of recent actual input token counts.
 * Returns 0 if no recent data is available.
 * @internal
 */
function getAverageInputTokens(): number {
  if (recentInputTokens.length === 0) return 0
  const sum = recentInputTokens.reduce((a, b) => a + b, 0)
  return Math.round(sum / recentInputTokens.length)
}

/** @internal Resolved config. */
let windowMs = DEFAULT_WINDOW_MS
let tpmLimit = DEFAULT_TPM_LIMIT
let rpmLimit = DEFAULT_RPM_LIMIT
let safetyFactor = DEFAULT_SAFETY_FACTOR
let verbose = DEFAULT_VERBOSE
let countFailedAttempts = DEFAULT_COUNT_FAILED_ATTEMPTS

/** Configuration after the schema's defaults and the local normalization. */
interface ResolvedConfig {
  windowMs: number
  tpmLimit: number
  rpmLimit: number
  safetyFactor: number
  verbose: boolean
  countFailedAttempts: boolean
}

/**
 * Reject a configuration the limiter cannot honor.
 *
 * `Config` checks the type only: schemastery's `z.number()` accepts `NaN` and
 * every finite value, 0 and negatives included (measured: `min(1)` rejects `0`
 * and `-5` but passes `NaN`). Each of those fails silently and in the wrong
 * direction for a limiter — `NaN` makes every window comparison false, so no
 * delay is ever computed and the plugin keeps logging while pacing nothing;
 * `windowMs: 0` never accumulates a window; `safetyFactor: 0` waits out the
 * whole window on every request. Throwing matches what the host already does
 * for a config of the wrong type (`resolveConfig` throws `ValidationError`), so
 * a bad number stays exactly as loud as a bad type.
 *
 * @internal
 */
function assertUsableLimits(cfg: ResolvedConfig): void {
  const require = (key: string, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`[agent-rate-limit] config ${key} must be a positive finite number, got ${value}`)
    }
  }
  require('windowMs', cfg.windowMs)
  require('tpmLimit', cfg.tpmLimit)
  require('rpmLimit', cfg.rpmLimit)
  require('safetyFactor', cfg.safetyFactor)
}

/**
 * Initialize the rate limiter with the given config.
 * @internal
 */
function initRateLimiter(config: ResolvedConfig): void {
  windowMs = config.windowMs
  tpmLimit = config.tpmLimit
  rpmLimit = config.rpmLimit
  safetyFactor = config.safetyFactor
  verbose = config.verbose
  countFailedAttempts = config.countFailedAttempts
  windowEntries.length = 0
  recentInputTokens.length = 0
}

/**
 * Remove entries that have fallen outside the sliding window.
 * @internal
 */
function pruneWindow(now: number): void {
  const cutoff = now - windowMs
  while (windowEntries.length > 0 && windowEntries[0].timestamp < cutoff) {
    windowEntries.shift()
  }
}

/**
 * Sum all tokens currently in the sliding window.
 * @internal
 */
function sumWindow(now: number): number {
  pruneWindow(now)
  let total = 0
  for (const entry of windowEntries) {
    total += entry.tokens
  }
  return total
}

/**
 * Add tokens to the sliding window.
 * @internal
 */
function addToWindow(tokens: number, now: number): void {
  // Prune first to keep the array small
  pruneWindow(now)
  windowEntries.push({ timestamp: now, tokens })
}

/**
 * Get the effective TPM limit after applying the safety factor.
 * @internal
 */
function getEffectiveTpmLimit(): number {
  return tpmLimit * safetyFactor
}

/**
 * Calculate the required delay before the next request, in milliseconds.
 * Returns 0 if no delay is needed.
 * @internal
 */
function calculateDelay(estimatedInputTokens: number, now: number): number {
  const effectiveTpmLimit = getEffectiveTpmLimit()
  const currentTpm = sumWindow(now)
  const currentRpm = windowEntries.length

  // 1. Check RPM limit
  //    No overshoot ratio here, unlike the TPM branch below. This branch only
  //    runs once the count has already reached the limit, so a ratio would be
  //    ~1 by construction — a burst can push the count a little past the limit,
  //    not a whole limit past it. The TPM branch is the opposite case: a single
  //    long prompt can overshoot the entire window, which is what its ratio
  //    corrects for. Scaling this delay up as well would only lengthen a wait
  //    that one expiring entry already resolves.
  if (currentRpm >= rpmLimit && windowEntries.length > 0) {
    const oldest = windowEntries[0]
    const expireAt = oldest.timestamp + windowMs
    if (expireAt > now) {
      return expireAt - now + 100
    }
  }

  // 2. Check if we need to delay based on TPM.
  //    We need enough room in the window for the new request.
  //    target = the maximum tokens the window can have for us to proceed.
  const target = effectiveTpmLimit - estimatedInputTokens
  if (currentTpm > target && windowEntries.length > 0) {
    // Walk from the NEWEST entries (which expire last) toward the oldest.
    // We want to keep the newest entries (sum <= target) and let the
    // oldest entries expire so the window drains.
    // When cumulative >= target, entry i is the oldest entry we'd keep.
    // Wait for it to expire; after it does, the remaining window
    // (entries i+1..end) has sum < target.
    let cumulative = 0
    for (let i = windowEntries.length - 1; i >= 0; i--) {
      cumulative += windowEntries[i].tokens
      if (cumulative >= target) {
        const expireAt = windowEntries[i].timestamp + windowMs
        if (expireAt > now) {
          const baseDelay = expireAt - now + 100
          // With concurrent agents, MULTIPLY by the TPM overshoot ratio.
          // Other agents keep adding tokens during the delay, so the
          // window drains much slower than baseDelay assumes.
          const concurrencyRatio = Math.max(1, currentTpm / effectiveTpmLimit)
          return Math.round(baseDelay * concurrencyRatio)
        }
        break
      }
    }
  }

  // 3. No delay needed
  return 0
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the input tokens of one request.
 *
 * Every model-visible message is priced by the host's own estimator — the
 * `tokenMeter` service's `estimateMessage`, the same function behind the
 * context-breakdown projection — so this cold-start fallback reports the numbers
 * the rest of DSH reports for the same content, instead of a second density
 * invented here.
 *
 * A loop-built request carries its assembled system prompt as the leading
 * system-role message, so walking `messages` covers it. Two things are
 * deliberately left out, both small against a prompt that is usually far
 * larger: `options.system`, which only hand-built one-shot callers pass and
 * which no official estimator prices outside a message, and the tool schemas,
 * which the meter prices from a canonical envelope header this listener never
 * sees. The first real `usage` sample supersedes the estimate for every later
 * request, so neither omission can persist.
 *
 * The call is guarded. The host's estimator is total for host-shaped requests,
 * and a throw here would otherwise abort every model call in the session; a
 * limiter must never turn its own accounting into a failed request, so a throw
 * degrades to "unknown size" and is reported.
 *
 * @internal
 */
function estimateRequestTokens(options: GenerateOptions, tokenMeter: PluginContext['tokenMeter']): number {
  try {
    let total = 0
    for (const message of options.messages) total += tokenMeter.estimateMessage(message)
    return total
  } catch (error) {
    console.log(`[agent-rate-limit] Input estimate failed [${error instanceof Error ? error.message : String(error)}]`)
    return 0
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/** Cordis plugin name used by loader diagnostics. */
const name = 'agent-rate-limit'

/** Hard dependencies: the timer, the command registry, and the host token meter. */
const inject = ['timer', 'commands', 'tokenMeter']

/** Plugin configuration schema. */
const Config = z.object({
  windowMs: z.number().default(DEFAULT_WINDOW_MS),
  tpmLimit: z.number().default(DEFAULT_TPM_LIMIT),
  rpmLimit: z.number().default(DEFAULT_RPM_LIMIT),
  safetyFactor: z.number().default(DEFAULT_SAFETY_FACTOR),
  verbose: z.boolean().default(DEFAULT_VERBOSE),
  countFailedAttempts: z.boolean().default(DEFAULT_COUNT_FAILED_ATTEMPTS),
})

/**
 * The rendered outcome a command handler returns.
 *
 * Mirrors `CommandResult` in `@deepseek-ai/dsh-commands`, which the host
 * validates at the registry boundary and rejects by throwing
 * `handler must return a CommandResult`. The union is spelled out with literal
 * types on purpose: declared as `kind: string` a typo would pass `tsc` and only
 * surface on the user's first `/agent-rate-limit`.
 */
type CommandResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** One command registration accepted by the injected `commands` service. */
interface CommandDefinition {
  /** Command name invoked as `/<name>`. */
  name: string
  /** One-line description shown in command listings. */
  description: string
  /** Produce the command's rendered result. */
  handler: () => CommandResult
}

/**
 * The minimal structural view of the Cordis plugin context this plugin uses.
 *
 * The context stays a local shape — typing it from the host packages would
 * couple this plugin to every package that augments `Context` — but the
 * `llm/stream` payload uses the host's own `GenerateOptions` and `StreamChunk`
 * types, so a change to that contract fails `tsc` here instead of surviving
 * silently until an actual request.
 */
interface PluginContext {
  /**
   * Subscribe to a Waterfall event.
   *
   * The event name is spelled as a literal type rather than `string`: a typo
   * in `'llm/stream'` must fail `tsc` instead of silently subscribing to an
   * event that never fires.
   */
  on(
    name: 'llm/stream',
    handler: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>,
  ): void
  /**
   * Register a lifecycle effect, disposed together with the plugin.
   *
   * Required rather than optional: it is a core method of the Cordis context,
   * and calling it through an optional chain would silently drop the command
   * registration's disposer, leaving the next live reload to fail with
   * `command "agent-rate-limit" is already registered in this scope`.
   *
   * The callback's return value IS the disposer, so any registration made
   * inside it has to be returned rather than dropped.
   */
  effect(callback: () => void | (() => void)): void
  /**
   * Injected timeout helper, mixed into the context by the `timer` service.
   *
   * Cordis enforces the injection: reading `ctx.timeout` or `ctx.timer` without
   * `timer` in `inject` throws `cannot get property "timer" without inject`. The
   * service marks its older `setTimeout`/`setInterval` faces deprecated in favour
   * of these mixed-in ones, so this plugin calls `ctx.timeout(ms)` directly.
   *
   * `timeout(ms)` resolves after the delay and is implemented as a context
   * effect bound to the calling plugin's fiber — measured: both this face and
   * `ctx.timer.timeout` reject with "Context has been disposed" once the plugin
   * that called them is disposed. The web profile reloads patches live, so the
   * delay site below tolerates that rejection rather than letting a reload turn
   * into a failed request.
   */
  timeout(delay: number): Promise<void>
  /** Injected command registry; named in `inject`, so it is always present. */
  commands: { register(definition: CommandDefinition): () => void }
  /**
   * Injected host token meter; named in `inject`, so it is always present.
   *
   * Only `estimateMessage` is read. It prices one model-visible message under
   * the host's fixed density — the numbers the context-breakdown projection
   * reports for the same content — which is exactly what this plugin needs
   * before the first real `usage` sample arrives.
   */
  tokenMeter: { estimateMessage: (message: RequestMessage) => number }
}

/**
 * Register the agent rate limiter.
 *
 * Intercepts the `llm/stream` Waterfall event to add a delay before each LLM
 * request based on the sliding window state, then records actual token usage
 * from the stream. Retry logic is delegated to the built-in DSH `dsh-llm-retry`
 * plugin via provider-level `retryPolicy` configuration.
 */
async function apply(ctx: PluginContext, config: Record<string, unknown>): Promise<void> {
  // Initialize rate limiter state
  const cfg = {
    windowMs: Number(config.windowMs ?? DEFAULT_WINDOW_MS),
    tpmLimit: Number(config.tpmLimit ?? DEFAULT_TPM_LIMIT),
    rpmLimit: Number(config.rpmLimit ?? DEFAULT_RPM_LIMIT),
    safetyFactor: Number(config.safetyFactor ?? DEFAULT_SAFETY_FACTOR),
    verbose: config.verbose === true,
    // Default ON: `!== false` keeps an unset value at the default while still
    // honoring an explicit `false`.
    countFailedAttempts: config.countFailedAttempts !== false,
  }
  assertUsableLimits(cfg)
  initRateLimiter(cfg)
  if (verbose) console.log(`[agent-rate-limit] Plugin loaded. TPM: ${cfg.tpmLimit}, RPM: ${cfg.rpmLimit}, factor: ${cfg.safetyFactor}, window: ${cfg.windowMs}ms, verbose: ${cfg.verbose}`)

  /**
   * Intercept the LLM stream waterfall to apply rate limiting.
   *
   * Before the stream starts, checks the sliding window and delays
   * if approaching TPM or RPM limits. After the stream, records the
   * actual token usage (input estimation + output count).
   */
  ctx.on('llm/stream', (options, next) => {
    // Get the original stream
    const originalStream = next()

    // Return a wrapped stream that adds delay before the first chunk
    // and counts output tokens
    const wrappedStream = (async function* (): AsyncIterable<StreamChunk> {
      const now = Date.now()

      // Auxiliary model calls (context compaction, session title) are marked
      // with `purpose` by the agent loop. They spend real provider quota, so
      // they are paced and counted exactly like any other request — but they
      // stay out of the input-size average: a compaction prompt sits at the
      // context ceiling and a title prompt is tiny, so either sample would
      // mispredict the next ordinary request.
      const auxiliary = options.purpose !== undefined

      // Use the average of recent actual input token counts from the API as the
      // estimate for this request — no estimator beats a real measurement.
      // The moving average smooths out variance across concurrent requests.
      // Fall back to the host's estimator only for the very first request.
      const estimatedInputTokens = getAverageInputTokens() || estimateRequestTokens(options, ctx.tokenMeter)

      // Calculate and apply delay before the first chunk
      const delay = calculateDelay(estimatedInputTokens, now)
      if (delay > 0) {
        // The window figures below exist only for the log line, so they are read
        // inside the verbose branch — `sumWindow` walks the whole window, and
        // this path runs on every delayed request.
        if (verbose) {
          const currentTpm = sumWindow(now)
          const effectiveLimit = getEffectiveTpmLimit()
          console.log(`[agent-rate-limit] Delaying ${delay}ms (TPM: ${currentTpm}/${Math.round(effectiveLimit)} ×${Math.max(1, currentTpm / effectiveLimit).toFixed(2)}, RPM: ${windowEntries.length}/${rpmLimit})`)
        }
        try {
          await ctx.timeout(delay)
        } catch {
          // A live patch reload disposes the pending delay — the host implements
          // `timeout` as a context effect — which rejects it. The replacement
          // activation owns pacing from that point on, and failing the request
          // over a pause that is being torn down would be strictly worse.
          if (verbose) console.log('[agent-rate-limit] Delay abandoned: the plugin was disposed while waiting')
        }
      }

      // Stream chunks, capture actual API token usage, and detect failures
      let hadFailure = false
      let usageSeen = false
      let actualInputTokens = 0
      let actualOutputTokens = 0
      let wireTotal: number | undefined
      let finishReason = 'unknown'
      // Usage breakdown for verbose logging (uncached + cache hits)
      let usageUncached = 0
      let usageCachedRead = 0
      let usageCachedWrite = 0
      for await (const chunk of originalStream) {
        // Capture the actual token usage from the API's usage chunk.
        // DSH's TokenUsage convention is DISJOINT: inputTokens is uncached input
        // only; cache hits arrive separately as cacheReadTokens/cacheWriteTokens.
        // We recombine every part to match the API's billed total.
        // `reasoningTokens` is an OUTPUT subset — dsh-token-meter's turn usage
        // documents it that way — so adding it here would double-count.
        if (chunk.type === 'usage') {
          const usage: TokenUsage = chunk.usage
          usageSeen = true
          usageUncached = usage.inputTokens
          usageCachedRead = usage.cacheReadTokens ?? 0
          usageCachedWrite = usage.cacheWriteTokens ?? 0
          wireTotal = usage.totalTokens
          actualInputTokens = usageUncached + usageCachedRead + usageCachedWrite
          actualOutputTokens = usage.outputTokens
        }
        // Detect terminal error/aborted finish chunks — the LLM adapter signals
        // failures (e.g. HTTP 429) as finish chunks, NOT by throwing. Without
        // this check, the for-await loop completes normally, and the code
        // below would incorrectly treat a failed attempt as a success.
        // `FinishReason` is merge-extensible, so any other kind — including a
        // provider-specific one a third-party adapter adds — falls through as a
        // completed attempt.
        if (chunk.type === 'finish') {
          finishReason = chunk.reason.kind
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            hadFailure = true
          }
        }
        yield chunk
      }

      const recordTime = Date.now()

      // Feed the input estimate from ANY attempt that reported usage, including
      // failed ones: a retry sends the same prompt, so the size a failed attempt
      // just revealed is exactly what the next attempt needs. 3 samples keeps it
      // responsive to load changes. Auxiliary calls are the one exception — they
      // are counted in the window, but their size is not a representative sample
      // for the next ordinary request.
      if (!auxiliary && usageSeen && actualInputTokens > 0) {
        recentInputTokens.push(actualInputTokens)
        if (recentInputTokens.length > 3) recentInputTokens.shift()
      }

      // Drift guard: the usage contract guarantees
      // `totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite`.
      // A mismatch means upstream/relay accounting changed, which would skew
      // this window silently.
      if (
        usageSeen &&
        wireTotal !== undefined &&
        wireTotal !== actualInputTokens + actualOutputTokens &&
        verbose
      ) {
        console.log(
          `[agent-rate-limit] Recorded total mismatch (computed: ${actualInputTokens + actualOutputTokens}, ` +
            `reported: ${wireTotal}, uncached: ${usageUncached}, ` +
            `cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens})`,
        )
      }

      if (!hadFailure) {
        // Use the API's actual token counts when available (far more accurate
        // than heuristic estimation), otherwise fall back to the estimated sum.
        const totalTokens = usageSeen ? actualInputTokens + actualOutputTokens : estimatedInputTokens
        addToWindow(totalTokens, recordTime)
        if (verbose) {
          const detail = usageSeen
            ? `uncached: ${usageUncached}, cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens}`
            : `estimated: ${estimatedInputTokens}i`
          console.log(`[agent-rate-limit] Recorded ${totalTokens} tokens (${detail})`)
        }
        return
      }

      // Failed or aborted attempt. When the stream reported usage the upstream
      // already processed and billed the prompt, so by default it is counted
      // into the window (`countFailedAttempts: true`); the switch restores the
      // old "failed attempts consume no budget" behavior. Either way the line is
      // ALWAYS logged: swallowing it here is what previously made these logs
      // impossible to reconcile with the harness turn statistics, because a
      // failed cold-cache attempt is exactly where the uncached input lives.
      if (usageSeen) {
        const totalTokens = actualInputTokens + actualOutputTokens
        const counted = countFailedAttempts
        if (counted) addToWindow(totalTokens, recordTime)
        if (verbose) {
          console.log(
            `[agent-rate-limit] Recorded ${totalTokens} tokens (uncached: ${usageUncached}, ` +
              `cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens}) ` +
              `[${finishReason}]`,
          )
        }
      } else if (verbose) {
        console.log(`[agent-rate-limit] No usage reported [${finishReason}]`)
      }
    })()

    return wrappedStream
  })

  // Register the /agent-rate-limit command.
  //
  // The effect callback must RETURN what Cordis hands back: `register()`
  // returns the exact disposer that unregisters the definition, and dropping
  // it leaves the registration alive after the plugin unloads. The web profile
  // reloads patches live, so the next activation would then fail with
  // `command "agent-rate-limit" is already registered in this scope`.
  ctx.effect(() =>
    ctx.commands.register({
      name: 'agent-rate-limit',
      description: 'Show agent-rate-limit plugin status and configuration.',
      handler: () => {
        const now = Date.now()
        const currentTpm = sumWindow(now)
        const effectiveLimit = getEffectiveTpmLimit()
        const lines = [
          `Status: loaded`,
          `Config:`,
          `  TPM limit:     ${tpmLimit.toLocaleString()} (effective: ${Math.round(effectiveLimit).toLocaleString()})`,
          `  RPM limit:     ${rpmLimit.toLocaleString()}`,
          `  Safety factor: ${safetyFactor}`,
          `  Window:        ${windowMs / 1000}s`,
          `  Verbose:       ${verbose}`,
          `  Count failed:  ${countFailedAttempts}`,
          `Current:`,
          `  Window entries:  ${windowEntries.length}`,
          `  Current TPM:     ${currentTpm.toLocaleString()}`,
          '━━━━━━━━━━━━━━━━━━━━━━',
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    }),
  )
}

export { apply, Config, inject, name }