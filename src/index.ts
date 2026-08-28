/**
 * @zhourenke/dsh-agent-rate-limit
 *
 * An agent loop rate limiter that prevents TPM (Tokens Per Minute) and
 * RPM (Requests Per Minute) limit violations by intercepting the LLM
 * streaming pipeline and adding adaptive delays between requests.
 *
 * Supports configurable limits, exponential backoff on rate-limit errors,
 * and a sliding-window algorithm that tracks both input and output tokens.
 *
 * @module @zhourenke/dsh-agent-rate-limit
 */

import z from '@deepseek-ai/schemastery'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sliding window size in milliseconds (60 seconds). */
const DEFAULT_WINDOW_MS = 60_000

/** Default TPM (Tokens Per Minute) limit for Alibaba Cloud Bailian deepseek-v4-flash. */
const DEFAULT_TPM_LIMIT = 1_200_000

/** Default RPM (Requests Per Minute) limit. */
const DEFAULT_RPM_LIMIT = 15_000

/** Default safety factor (0.8 = use 80% of the limit to leave buffer). */
const DEFAULT_SAFETY_FACTOR = 0.8

/** Default: silently retry 429 errors (true) or surface them to the user (false). */
const DEFAULT_RETRY_ON_429 = true

/** Default maximum consecutive 429 retries per burst before giving up. */
const DEFAULT_MAX_RETRIES = 5

/** Default maximum exponential backoff delay in milliseconds. */
const DEFAULT_MAX_BACKOFF_MS = 30_000

/** Default: verbose logging (false = only log startup and critical errors). */
const DEFAULT_VERBOSE = false

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

/** @internal Consecutive rate-limit error counter. */
let consecutiveErrors = 0

/** @internal Timestamp of the last rate-limit error (ms). 0 = no recent error. */
let lastRateLimitErrorAt = 0

/** @internal Whether to silently retry on 429 errors. */
let retryOn429 = DEFAULT_RETRY_ON_429

/** @internal Consecutive 429 retry count in the current burst. */
let retryCount = 0

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
let maxBackoffMs = DEFAULT_MAX_BACKOFF_MS
let maxRetries = DEFAULT_MAX_RETRIES
let verbose = DEFAULT_VERBOSE

/**
 * Initialize the rate limiter with the given config.
 * @internal
 */
function initRateLimiter(config: {
  windowMs: number
  tpmLimit: number
  rpmLimit: number
  safetyFactor: number
  maxBackoffMs: number
  retryOn429: boolean
  maxRetries: number
  verbose: boolean
}): void {
  windowMs = config.windowMs
  tpmLimit = config.tpmLimit
  rpmLimit = config.rpmLimit
  safetyFactor = config.safetyFactor
  maxBackoffMs = config.maxBackoffMs
  retryOn429 = config.retryOn429
  maxRetries = config.maxRetries
  verbose = config.verbose
  windowEntries.length = 0
  consecutiveErrors = 0
  lastRateLimitErrorAt = 0
  retryCount = 0
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
 * Record a rate-limit error for backoff calculation.
 * @internal
 */
function recordError(): void {
  consecutiveErrors++
  retryCount++
  const now = Date.now()
  if (now - lastRateLimitErrorAt > 10_000) {
    lastRateLimitErrorAt = now
  }
}

/**
 * Reset the consecutive error counter and retry budget.
 * @internal
 */
function resetErrors(): void {
  consecutiveErrors = 0
  retryCount = 0
  // Keep lastRateLimitErrorAt so the backoff still decays gradually
}

/**
 * Calculate the adaptive backoff delay based on the retry count.
 * Escalates with each retry: 2s, 4s, 8s, 16s, ... capped at maxBackoffMs.
 * @internal
 */
function getBackoffDelay(): number {
  if (retryCount === 0) return 0
  const delay = Math.min(
    Math.pow(2, Math.min(retryCount, 5)) * 1000,
    maxBackoffMs,
  )
  return Math.round(delay)
}

/**
 * Get the effective TPM limit, reduced when a recent rate-limit error occurred.
 * The reduction decays linearly over 60 seconds after the last error.
 * @internal
 */
function getEffectiveTpmLimit(): number {
  if (lastRateLimitErrorAt === 0) return tpmLimit * safetyFactor
  const msSinceError = Date.now() - lastRateLimitErrorAt
  if (msSinceError > 60_000) return tpmLimit * safetyFactor
  // Reduce by up to 50% right after an error, decaying back to safetyFactor
  const reduction = Math.max(0.5, 1 - msSinceError / 120_000)
  return tpmLimit * safetyFactor * reduction
}

/**
 * Calculate the required delay before the next request, in milliseconds.
 * Returns 0 if no delay is needed.
 * @internal
 */
function calculateDelay(estimatedInputTokens: number, now: number): number {
  pruneWindow(now)

  const effectiveTpmLimit = getEffectiveTpmLimit()
  const currentTpm = sumWindow(now)
  const currentRpm = windowEntries.length

  // 1. Check RPM limit
  if (currentRpm >= rpmLimit && windowEntries.length > 0) {
    const oldest = windowEntries[0]
    const expireAt = oldest.timestamp + windowMs
    if (expireAt > now) {
      return expireAt - now + 100
    }
  }

  // 2. Check TPM limit (current usage already exceeds limit)
  if (currentTpm >= effectiveTpmLimit && windowEntries.length > 0) {
    const oldest = windowEntries[0]
    const expireAt = oldest.timestamp + windowMs
    if (expireAt > now) {
      return expireAt - now + 100
    }
  }

  // 3. Check if adding estimated tokens would exceed limit
  if (currentTpm + estimatedInputTokens >= effectiveTpmLimit && windowEntries.length > 0) {
    // Walk from the oldest entries to find when enough tokens expire
    const target = effectiveTpmLimit - estimatedInputTokens
    let cumulative = 0
    for (let i = windowEntries.length - 1; i >= 0; i--) {
      cumulative += windowEntries[i].tokens
      if (cumulative >= target) {
        const expireAt = windowEntries[i].timestamp + windowMs
        if (expireAt > now) {
          return expireAt - now + 100
        }
        break
      }
    }
  }

  // 4. Apply backoff delay (if there were consecutive errors)
  return getBackoffDelay()
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Roughly estimate the number of tokens in a text string.
 *
 * Heuristic: CJK characters average ~1.5 chars/token,
 * other characters average ~3.5 chars/token.
 * This is sufficient for rate-limiting purposes — we don't need
 * exact counts, just a conservative estimate to stay under the limit.
 *
 * @internal
 */
function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  // Count CJK characters
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  const otherChars = text.length - cjkChars
  return Math.ceil(cjkChars / 1.5 + otherChars / 3.5)
}

/**
 * Extract text content from a ContentBlock recursively.
 * DSH messages carry content as ContentBlock[] (never a plain string).
 * @internal
 */
function extractBlockText(block: { type?: string; text?: string; arguments?: string; content?: unknown[] }): string {
  if (block.type === 'text' || block.type === 'reasoning') {
    return block.text ?? ''
  }
  if (block.type === 'tool-call') {
    return block.arguments ?? ''
  }
  if (block.type === 'tool-result' && Array.isArray(block.content)) {
    let text = ''
    for (const child of block.content) {
      text += extractBlockText(child as { type?: string; text?: string; arguments?: string; content?: unknown[] })
    }
    return text
  }
  return ''
}

/**
 * Estimate tokens from an array of DSH messages.
 * DSH Message.content is always ContentBlock[], never a plain string.
 * @internal
 */
function estimateTokensFromMessages(messages: Array<{ content?: unknown[] }>): number {
  let total = 0
  for (const msg of messages) {
    const blocks = msg.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        total += estimateTokens(extractBlockText(block as { type?: string; text?: string; arguments?: string; content?: unknown[] }))
      }
    }
  }
  return total
}

/**
 * Estimate tokens from a stream chunk delta text.
 * @internal
 */
function estimateTokensFromDelta(delta: string): number {
  return estimateTokens(delta)
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/** Cordis plugin name used by loader diagnostics. */
const name = 'agent-rate-limit'

/** Hard dependency on the timer service and commands service. */
const inject = ['timer', 'commands']

/** Plugin configuration schema. */
const Config = z.object({
  windowMs: z.number().default(DEFAULT_WINDOW_MS),
  tpmLimit: z.number().default(DEFAULT_TPM_LIMIT),
  rpmLimit: z.number().default(DEFAULT_RPM_LIMIT),
  safetyFactor: z.number().default(DEFAULT_SAFETY_FACTOR),
  maxBackoffMs: z.number().default(DEFAULT_MAX_BACKOFF_MS),
  retryOn429: z.boolean().default(DEFAULT_RETRY_ON_429),
  maxRetries: z.number().default(DEFAULT_MAX_RETRIES),
  verbose: z.boolean().default(DEFAULT_VERBOSE),
})

/**
 * Register the agent rate limiter.
 *
 * Intercepts two Waterfall events:
 * - `llm/stream`: adds a delay before each LLM request based on the sliding
 *   window state, then counts output tokens from the stream chunks.
 * - `agent/request-error`: detects rate-limit errors (HTTP 429) and returns
 *   `{ kind: 'retry' }` with exponential backoff.
 */
async function apply(ctx: Record<string, unknown>, config: Record<string, unknown>): Promise<void> {
  // Initialize rate limiter state
  const cfg = {
    windowMs: Number(config.windowMs ?? DEFAULT_WINDOW_MS),
    tpmLimit: Number(config.tpmLimit ?? DEFAULT_TPM_LIMIT),
    rpmLimit: Number(config.rpmLimit ?? DEFAULT_RPM_LIMIT),
    safetyFactor: Number(config.safetyFactor ?? DEFAULT_SAFETY_FACTOR),
    maxBackoffMs: Number(config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
    retryOn429: config.retryOn429 !== false,
    maxRetries: Number(config.maxRetries ?? DEFAULT_MAX_RETRIES),
    verbose: config.verbose === true,
  }
  initRateLimiter(cfg)
  if (verbose) console.log(`[agent-rate-limit] Plugin loaded. TPM: ${cfg.tpmLimit}, RPM: ${cfg.rpmLimit}, factor: ${cfg.safetyFactor}, window: ${cfg.windowMs}ms, retryOn429: ${cfg.retryOn429}, maxRetries: ${cfg.maxRetries}, verbose: ${cfg.verbose}`)

  const timer = ctx as { timer: { timeout: (ms: number) => Promise<void> } }

  /**
   * Intercept the LLM stream waterfall to apply rate limiting.
   *
   * Before the stream starts, checks the sliding window and delays
   * if approaching TPM or RPM limits. After the stream, records the
   * actual token usage (input estimation + output count).
   */
  ctx.on('llm/stream', (options: unknown, next: () => AsyncIterable<unknown>) => {
    // Get the original stream
    const originalStream = next()

    // Return a wrapped stream that adds delay before the first chunk
    // and counts output tokens
    const wrappedStream = (async function* (): AsyncIterable<unknown> {
      const now = Date.now()
      const opts = options as { messages?: Array<{ content?: unknown[] }> }
      const messages = opts.messages ?? []

      // Use the average of recent actual input token counts from the API as the
      // estimate for this request — far more accurate than heuristic estimation.
      // The moving average smooths out variance across concurrent requests.
      // Fall back to heuristic estimation only for the very first request.
      const estimatedInputTokens = getAverageInputTokens() || estimateTokensFromMessages(messages)

      // Calculate and apply delay before the first chunk
      const delay = calculateDelay(estimatedInputTokens, now)
      if (delay > 0) {
        const currentTpm = sumWindow(now)
        const effectiveLimit = getEffectiveTpmLimit()
        if (verbose) console.log(`[agent-rate-limit] Delaying ${delay}ms (TPM: ${currentTpm}/${Math.round(effectiveLimit)}, RPM: ${windowEntries.length}/${rpmLimit}, retries: ${retryCount}/${maxRetries})`)
        await timer.timer.timeout(delay)
      }

      // Stream chunks, capture actual API token usage, and detect failures
      let outputTokens = 0
      let hadFailure = false
      let actualInputTokens = 0
      let actualOutputTokens = 0
      for await (const chunk of originalStream) {
        const chunkObj = chunk as {
          type?: string
          text?: string
          argumentsDelta?: string
          usage?: { inputTokens: number; outputTokens: number }
          reason?: { kind?: string }
        }
        // Capture the actual token usage from the API's usage chunk
        if (chunkObj.type === 'usage' && chunkObj.usage) {
          actualInputTokens = chunkObj.usage.inputTokens
          actualOutputTokens = chunkObj.usage.outputTokens
        }
        // Count output tokens from text/reasoning/tool-call deltas (fallback)
        if (chunkObj.type === 'text-delta' && typeof chunkObj.text === 'string') {
          outputTokens += estimateTokensFromDelta(chunkObj.text)
        } else if (chunkObj.type === 'reasoning-delta' && typeof chunkObj.text === 'string') {
          outputTokens += estimateTokensFromDelta(chunkObj.text)
        } else if (chunkObj.type === 'tool-call-delta' && typeof chunkObj.argumentsDelta === 'string') {
          outputTokens += estimateTokensFromDelta(chunkObj.argumentsDelta)
        }
        // Detect terminal error/aborted finish chunks — the LLM adapter signals
        // failures (e.g. HTTP 429) as finish chunks, NOT by throwing. Without
        // this check, the for-await loop completes normally, and the code
        // below would incorrectly record tokens and reset the retry budget.
        if (chunkObj.type === 'finish' && chunkObj.reason) {
          const reasonKind = chunkObj.reason.kind
          if (reasonKind === 'error' || reasonKind === 'aborted') {
            hadFailure = true
          }
        }
        yield chunk
      }

      // Only record usage and reset retry budget on successful completion
      if (!hadFailure) {
        // Use the API's actual token counts when available (far more accurate
        // than heuristic estimation), otherwise fall back to the heuristic sum.
        const totalTokens = actualInputTokens > 0
          ? actualInputTokens + actualOutputTokens
          : estimatedInputTokens + outputTokens
        addToWindow(totalTokens, Date.now())
        if (verbose) console.log(`[agent-rate-limit] Recorded ${totalTokens} tokens (${actualInputTokens}i + ${actualOutputTokens}o)`)
        // Store the actual input count so the next request can use it
        // as a much more accurate estimate than heuristic calculation.
        // Keep a sliding window of the last 3 values for a stable moving average.
        if (actualInputTokens > 0) {
          recentInputTokens.push(actualInputTokens)
          if (recentInputTokens.length > 3) {
            recentInputTokens.shift()
          }
        }
        resetErrors()
      }
    })()

    return wrappedStream
  })

  /**
   * Intercept request errors to detect HTTP 429 (rate limit / quota) and retry.
   *
   * Bailian (and most LLM providers) use HTTP 429 to signal both TPM/RPM
   * rate limits and temporary quota exhaustion. In both cases a short delay
   * followed by a retry usually resolves the issue. Set `retryOn429: false`
   * in the config if you want 429 errors to surface to the user instead.
   */
  ctx.on('agent/request-error', async (payload: unknown, next: () => Promise<{ kind: string }>) => {
    const p = payload as {
      failure?: { message?: string; code?: string; statusCode?: number }
    }
    const failure = p.failure
    const errorMessage = typeof failure?.message === 'string' ? failure.message : ''
    const errorCode = typeof failure?.code === 'string' ? failure.code : ''
    const httpStatus = typeof failure?.statusCode === 'number' ? failure.statusCode : 0

    // Detect HTTP 429: check statusCode, errorCode, and message text
    const is429 =
      httpStatus === 429 ||
      errorCode === '429' ||
      errorCode === 'RATE_LIMITED' ||
      errorCode === 'QUOTA' ||
      /rate\s*limit/i.test(errorMessage) ||
      /too\s+many\s+requests/i.test(errorMessage) ||
      /tpm|rpm|token.*limit/i.test(errorMessage) ||
      /throttl/i.test(errorMessage) ||
      /quota/i.test(errorMessage) ||
      /429/i.test(errorMessage)

    if (is429) {
      if (retryOn429) {
        // Enforce the retry budget: give up after maxRetries consecutive failures
        // so a permanent error (e.g. account quota exhausted) does not loop forever.
        if (retryCount >= maxRetries) {
          resetErrors()
          if (verbose) console.log(`[agent-rate-limit] ❌ 429 persists after ${maxRetries} retries, giving up — surfacing error to user (${errorCode}: ${errorMessage.slice(0, 120)})`)
          return next()
        }
        recordError()
        const backoff = getBackoffDelay()
        if (verbose) console.log(`[agent-rate-limit] 429 detected (retry ${retryCount}/${maxRetries}), retrying in ${backoff}ms (${errorCode}: ${errorMessage.slice(0, 80)})`)
        return { kind: 'retry' }
      } else {
        if (verbose) console.log(`[agent-rate-limit] 429 detected but retryOn429=false, surfacing to user (${errorCode}: ${errorMessage.slice(0, 80)})`)
        return next()
      }
    }

    // For non-429 errors, delegate to the default handler
    return next()
  })

  // Register /agent-rate-limit command
  const ctxAny = ctx as Record<string, unknown>
  ctxAny.effect?.(() => {
    const cmds = ctxAny.commands as { register: (def: { name: string; description: string; handler: () => { kind: string; text?: string } }) => () => void }
    if (cmds) {
      cmds.register({
        name: 'agent-rate-limit',
        description: 'Show agent-rate-limit plugin status and configuration.',
        handler: () => {
          const now = Date.now()
          pruneWindow(now)
          const currentTpm = sumWindow(now)
          const effectiveLimit = getEffectiveTpmLimit()
          const lines = [
            `Status: loaded`,
            `Config:`,
            `  TPM limit:     ${tpmLimit.toLocaleString()} (effective: ${Math.round(effectiveLimit).toLocaleString()})`,
            `  RPM limit:     ${rpmLimit.toLocaleString()}`,
            `  Safety factor: ${safetyFactor}`,
            `  Window:        ${windowMs / 1000}s`,
            `  Retry on 429:  ${retryOn429}`,
            `  Max retries:   ${maxRetries}`,
            `  Verbose:       ${verbose}`,
            `Current:`,
            `  Window entries:  ${windowEntries.length}`,
            `  Current TPM:     ${currentTpm.toLocaleString()}`,
            `  Consecutive err: ${consecutiveErrors}`,
            `  Retry count:     ${retryCount}`,
            '━━━━━━━━━━━━━━━━━━━━━━',
          ]
          return { kind: 'success', text: lines.join('\n') }
        },
      })
    }
  })
}

export { apply, Config, inject, name }
export {
  DEFAULT_WINDOW_MS,
  DEFAULT_TPM_LIMIT,
  DEFAULT_RPM_LIMIT,
  DEFAULT_SAFETY_FACTOR,
  DEFAULT_RETRY_ON_429,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_VERBOSE,
}