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
 * Verified against DSH 0.1.7-rc.2: the `llm/stream` Waterfall signature, the
 * disjoint `TokenUsage` counts, the `error`/`aborted` finish reasons, and the
 * injected `timer`/`commands` services are all unchanged from the version this
 * plugin was first written against, and no shipped DSH package paces requests
 * against a provider TPM/RPM quota.
 *
 * @module @zhourenke/dsh-agent-rate-limit
 */
import z from '@deepseek-ai/schemastery';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Default sliding window size in milliseconds (60 seconds). */
const DEFAULT_WINDOW_MS = 60_000;
/** Default TPM (Tokens Per Minute) limit, matching a common high-throughput tier. */
const DEFAULT_TPM_LIMIT = 1_200_000;
/** Default RPM (Requests Per Minute) limit. */
const DEFAULT_RPM_LIMIT = 15_000;
/** Default safety factor (0.8 = use 80% of the limit to leave buffer). */
const DEFAULT_SAFETY_FACTOR = 0.8;
/** Default: verbose logging (false = only log startup and critical errors). */
const DEFAULT_VERBOSE = false;
/**
 * Default: count failed/aborted attempts into the window when the stream
 * reported actual usage. The upstream has already processed and billed the
 * prompt, so excluding it would understate window pressure. Failed attempts
 * are logged either way.
 */
const DEFAULT_COUNT_FAILED_ATTEMPTS = true;
/** @internal Sliding-window rate limiter state. */
const windowEntries = [];
/** @internal Recent actual input token counts from the API usage chunk (max 3 entries). */
const recentInputTokens = [];
/**
 * Get the average of recent actual input token counts.
 * Returns 0 if no recent data is available.
 * @internal
 */
function getAverageInputTokens() {
    if (recentInputTokens.length === 0)
        return 0;
    const sum = recentInputTokens.reduce((a, b) => a + b, 0);
    return Math.round(sum / recentInputTokens.length);
}
/** @internal Resolved config. */
let windowMs = DEFAULT_WINDOW_MS;
let tpmLimit = DEFAULT_TPM_LIMIT;
let rpmLimit = DEFAULT_RPM_LIMIT;
let safetyFactor = DEFAULT_SAFETY_FACTOR;
let verbose = DEFAULT_VERBOSE;
let countFailedAttempts = DEFAULT_COUNT_FAILED_ATTEMPTS;
/**
 * Initialize the rate limiter with the given config.
 * @internal
 */
function initRateLimiter(config) {
    windowMs = config.windowMs;
    tpmLimit = config.tpmLimit;
    rpmLimit = config.rpmLimit;
    safetyFactor = config.safetyFactor;
    verbose = config.verbose;
    countFailedAttempts = config.countFailedAttempts;
    windowEntries.length = 0;
    recentInputTokens.length = 0;
}
/**
 * Remove entries that have fallen outside the sliding window.
 * @internal
 */
function pruneWindow(now) {
    const cutoff = now - windowMs;
    while (windowEntries.length > 0 && windowEntries[0].timestamp < cutoff) {
        windowEntries.shift();
    }
}
/**
 * Sum all tokens currently in the sliding window.
 * @internal
 */
function sumWindow(now) {
    pruneWindow(now);
    let total = 0;
    for (const entry of windowEntries) {
        total += entry.tokens;
    }
    return total;
}
/**
 * Add tokens to the sliding window.
 * @internal
 */
function addToWindow(tokens, now) {
    // Prune first to keep the array small
    pruneWindow(now);
    windowEntries.push({ timestamp: now, tokens });
}
/**
 * Get the effective TPM limit after applying the safety factor.
 * @internal
 */
function getEffectiveTpmLimit() {
    return tpmLimit * safetyFactor;
}
/**
 * Calculate the required delay before the next request, in milliseconds.
 * Returns 0 if no delay is needed.
 * @internal
 */
function calculateDelay(estimatedInputTokens, now) {
    const effectiveTpmLimit = getEffectiveTpmLimit();
    const currentTpm = sumWindow(now);
    const currentRpm = windowEntries.length;
    // 1. Check RPM limit
    if (currentRpm >= rpmLimit && windowEntries.length > 0) {
        const oldest = windowEntries[0];
        const expireAt = oldest.timestamp + windowMs;
        if (expireAt > now) {
            return expireAt - now + 100;
        }
    }
    // 2. Check if we need to delay based on TPM.
    //    We need enough room in the window for the new request.
    //    target = the maximum tokens the window can have for us to proceed.
    const target = effectiveTpmLimit - estimatedInputTokens;
    if (currentTpm > target && windowEntries.length > 0) {
        // Walk from the NEWEST entries (which expire last) toward the oldest.
        // We want to keep the newest entries (sum <= target) and let the
        // oldest entries expire so the window drains.
        // When cumulative >= target, entry i is the oldest entry we'd keep.
        // Wait for it to expire; after it does, the remaining window
        // (entries i+1..end) has sum < target.
        let cumulative = 0;
        for (let i = windowEntries.length - 1; i >= 0; i--) {
            cumulative += windowEntries[i].tokens;
            if (cumulative >= target) {
                const expireAt = windowEntries[i].timestamp + windowMs;
                if (expireAt > now) {
                    const baseDelay = expireAt - now + 100;
                    // With concurrent agents, MULTIPLY by the TPM overshoot ratio.
                    // Other agents keep adding tokens during the delay, so the
                    // window drains much slower than baseDelay assumes.
                    const concurrencyRatio = Math.max(1, currentTpm / effectiveTpmLimit);
                    return Math.round(baseDelay * concurrencyRatio);
                }
                break;
            }
        }
    }
    // 3. No delay needed
    return 0;
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
 * Deliberately not the host's `ctx.tokenMeter.estimateMessage`: that estimator
 * prices at a fixed 4 chars/token, which understates CJK input by roughly
 * 2.6x, and understating is the dangerous direction for a limiter — the window
 * would admit more than the provider allows. The meter's own subject is
 * context pressure rather than provider rate limits, and this function is only
 * the cold-start fallback before the first real `usage` sample arrives.
 *
 * @internal
 */
function estimateTokens(text) {
    if (!text || text.length === 0)
        return 0;
    // Count CJK characters
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 1.5 + otherChars / 3.5);
}
/**
 * Price one content block under the local CJK-aware density.
 *
 * Images and files are never sent as bytes: request assembly projects each
 * occurrence to handle or placeholder text, so the block's JSON size is the
 * closest local proxy for what the provider actually receives. That is also how
 * the host's own meter prices these blocks, its coarser density aside.
 *
 * @internal
 */
function estimateBlockTokens(block) {
    switch (block.type) {
        case 'text':
        case 'reasoning':
            return estimateTokens(block.text);
        case 'tool-call':
            return estimateTokens(block.name) + estimateTokens(block.arguments);
        default:
            return estimateTokens(JSON.stringify(block));
    }
}
/**
 * Estimate the input tokens of one request.
 *
 * A loop-built request carries its assembled system prompt as the leading
 * system-role message, so walking `messages` already covers it; the `system`
 * field covers one-shot callers that pass the prompt separately. Tool schemas
 * (`tools`) are not counted — they are a small serialized block compared with
 * the conversation, and the first real `usage` sample supersedes this estimate
 * for every later request.
 *
 * @internal
 */
function estimateRequestTokens(options) {
    let total = 0;
    for (const message of options.messages) {
        for (const block of message.content)
            total += estimateBlockTokens(block);
    }
    if (options.system !== undefined)
        total += estimateTokens(options.system);
    return total;
}
// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------
/** Cordis plugin name used by loader diagnostics. */
const name = 'agent-rate-limit';
/** Hard dependency on the timer service and commands service. */
const inject = ['timer', 'commands'];
/** Plugin configuration schema. */
const Config = z.object({
    windowMs: z.number().default(DEFAULT_WINDOW_MS),
    tpmLimit: z.number().default(DEFAULT_TPM_LIMIT),
    rpmLimit: z.number().default(DEFAULT_RPM_LIMIT),
    safetyFactor: z.number().default(DEFAULT_SAFETY_FACTOR),
    verbose: z.boolean().default(DEFAULT_VERBOSE),
    countFailedAttempts: z.boolean().default(DEFAULT_COUNT_FAILED_ATTEMPTS),
});
/**
 * Register the agent rate limiter.
 *
 * Intercepts the `llm/stream` Waterfall event to add a delay before each LLM
 * request based on the sliding window state, then records actual token usage
 * from the stream. Retry logic is delegated to the built-in DSH `dsh-llm-retry`
 * plugin via provider-level `retryPolicy` configuration.
 */
async function apply(ctx, config) {
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
    };
    initRateLimiter(cfg);
    if (verbose)
        console.log(`[agent-rate-limit] Plugin loaded. TPM: ${cfg.tpmLimit}, RPM: ${cfg.rpmLimit}, factor: ${cfg.safetyFactor}, window: ${cfg.windowMs}ms, verbose: ${cfg.verbose}`);
    /**
     * Intercept the LLM stream waterfall to apply rate limiting.
     *
     * Before the stream starts, checks the sliding window and delays
     * if approaching TPM or RPM limits. After the stream, records the
     * actual token usage (input estimation + output count).
     */
    ctx.on('llm/stream', (options, next) => {
        // Get the original stream
        const originalStream = next();
        // Return a wrapped stream that adds delay before the first chunk
        // and counts output tokens
        const wrappedStream = (async function* () {
            const now = Date.now();
            // Auxiliary model calls (context compaction, session title) are marked
            // with `purpose` by the agent loop. They spend real provider quota, so
            // they are paced and counted exactly like any other request — but they
            // stay out of the input-size average: a compaction prompt sits at the
            // context ceiling and a title prompt is tiny, so either sample would
            // mispredict the next ordinary request.
            const auxiliary = options.purpose !== undefined;
            // Use the average of recent actual input token counts from the API as the
            // estimate for this request — far more accurate than heuristic estimation.
            // The moving average smooths out variance across concurrent requests.
            // Fall back to heuristic estimation only for the very first request.
            const estimatedInputTokens = getAverageInputTokens() || estimateRequestTokens(options);
            // Calculate and apply delay before the first chunk
            const delay = calculateDelay(estimatedInputTokens, now);
            if (delay > 0) {
                const currentTpm = sumWindow(now);
                const effectiveLimit = getEffectiveTpmLimit();
                if (verbose)
                    console.log(`[agent-rate-limit] Delaying ${delay}ms (TPM: ${currentTpm}/${Math.round(effectiveLimit)} ×${Math.max(1, currentTpm / effectiveLimit).toFixed(2)}, RPM: ${windowEntries.length}/${rpmLimit})`);
                try {
                    await ctx.timer.timeout(delay);
                }
                catch {
                    // A live patch reload disposes the pending delay — the host implements
                    // `timeout` as a context effect — which rejects it. The replacement
                    // activation owns pacing from that point on, and failing the request
                    // over a pause that is being torn down would be strictly worse.
                    if (verbose)
                        console.log('[agent-rate-limit] Delay abandoned: the plugin was disposed while waiting');
                }
            }
            // Stream chunks, capture actual API token usage, and detect failures
            let hadFailure = false;
            let usageSeen = false;
            let actualInputTokens = 0;
            let actualOutputTokens = 0;
            let wireTotal;
            let finishReason = 'unknown';
            // Usage breakdown for verbose logging (uncached + cache hits)
            let usageUncached = 0;
            let usageCachedRead = 0;
            let usageCachedWrite = 0;
            for await (const chunk of originalStream) {
                // Capture the actual token usage from the API's usage chunk.
                // DSH's TokenUsage convention is DISJOINT: inputTokens is uncached input
                // only; cache hits arrive separately as cacheReadTokens/cacheWriteTokens.
                // We recombine every part to match the API's billed total.
                // `reasoningTokens` is an OUTPUT subset — dsh-token-meter's turn usage
                // documents it that way — so adding it here would double-count.
                if (chunk.type === 'usage') {
                    const usage = chunk.usage;
                    usageSeen = true;
                    usageUncached = usage.inputTokens;
                    usageCachedRead = usage.cacheReadTokens ?? 0;
                    usageCachedWrite = usage.cacheWriteTokens ?? 0;
                    wireTotal = usage.totalTokens;
                    actualInputTokens = usageUncached + usageCachedRead + usageCachedWrite;
                    actualOutputTokens = usage.outputTokens;
                }
                // Detect terminal error/aborted finish chunks — the LLM adapter signals
                // failures (e.g. HTTP 429) as finish chunks, NOT by throwing. Without
                // this check, the for-await loop completes normally, and the code
                // below would incorrectly treat a failed attempt as a success.
                // `FinishReason` is merge-extensible, so any other kind — including a
                // provider-specific one a third-party adapter adds — falls through as a
                // completed attempt.
                if (chunk.type === 'finish') {
                    finishReason = chunk.reason.kind;
                    if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                        hadFailure = true;
                    }
                }
                yield chunk;
            }
            const recordTime = Date.now();
            // Feed the input estimate from ANY attempt that reported usage, including
            // failed ones: a retry sends the same prompt, so the size a failed attempt
            // just revealed is exactly what the next attempt needs. 3 samples keeps it
            // responsive to load changes. Auxiliary calls are the one exception — they
            // are counted in the window, but their size is not a representative sample
            // for the next ordinary request.
            if (!auxiliary && usageSeen && actualInputTokens > 0) {
                recentInputTokens.push(actualInputTokens);
                if (recentInputTokens.length > 3)
                    recentInputTokens.shift();
            }
            // Drift guard: the usage contract guarantees
            // `totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite`.
            // A mismatch means upstream/relay accounting changed, which would skew
            // this window silently.
            if (usageSeen &&
                wireTotal !== undefined &&
                wireTotal !== actualInputTokens + actualOutputTokens &&
                verbose) {
                console.log(`[agent-rate-limit] Recorded total mismatch (computed: ${actualInputTokens + actualOutputTokens}, ` +
                    `reported: ${wireTotal}, uncached: ${usageUncached}, ` +
                    `cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens})`);
            }
            if (!hadFailure) {
                // Use the API's actual token counts when available (far more accurate
                // than heuristic estimation), otherwise fall back to the estimated sum.
                const totalTokens = usageSeen ? actualInputTokens + actualOutputTokens : estimatedInputTokens;
                addToWindow(totalTokens, recordTime);
                if (verbose) {
                    const detail = usageSeen
                        ? `uncached: ${usageUncached}, cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens}`
                        : `estimated: ${estimatedInputTokens}i`;
                    console.log(`[agent-rate-limit] Recorded ${totalTokens} tokens (${detail})`);
                }
                return;
            }
            // Failed or aborted attempt. When the stream reported usage the upstream
            // already processed and billed the prompt, so by default it is counted
            // into the window (`countFailedAttempts: true`); the switch restores the
            // old "failed attempts consume no budget" behavior. Either way the line is
            // ALWAYS logged: swallowing it here is what previously made these logs
            // impossible to reconcile with the harness turn statistics, because a
            // failed cold-cache attempt is exactly where the uncached input lives.
            if (usageSeen) {
                const totalTokens = actualInputTokens + actualOutputTokens;
                const counted = countFailedAttempts;
                if (counted)
                    addToWindow(totalTokens, recordTime);
                if (verbose) {
                    console.log(`[agent-rate-limit] Recorded ${totalTokens} tokens (uncached: ${usageUncached}, ` +
                        `cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens}) ` +
                        `[${finishReason}]`);
                }
            }
            else if (verbose) {
                console.log(`[agent-rate-limit] No usage reported [${finishReason}]`);
            }
        })();
        return wrappedStream;
    });
    // Register the /agent-rate-limit command.
    //
    // The effect callback must RETURN what Cordis hands back: `register()`
    // returns the exact disposer that unregisters the definition, and dropping
    // it leaves the registration alive after the plugin unloads. The web profile
    // reloads patches live, so the next activation would then fail with
    // `command "agent-rate-limit" is already registered in this scope`.
    ctx.effect?.(() => ctx.commands.register({
        name: 'agent-rate-limit',
        description: 'Show agent-rate-limit plugin status and configuration.',
        handler: () => {
            const now = Date.now();
            pruneWindow(now);
            const currentTpm = sumWindow(now);
            const effectiveLimit = getEffectiveTpmLimit();
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
            ];
            return { kind: 'success', text: lines.join('\n') };
        },
    }));
}
export { apply, Config, inject, name };
export { DEFAULT_WINDOW_MS, DEFAULT_TPM_LIMIT, DEFAULT_RPM_LIMIT, DEFAULT_SAFETY_FACTOR, DEFAULT_VERBOSE, DEFAULT_COUNT_FAILED_ATTEMPTS, };
