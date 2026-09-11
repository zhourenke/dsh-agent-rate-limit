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
 * @module @zhourenke/dsh-agent-rate-limit
 */
import z from '@deepseek-ai/schemastery';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Default sliding window size in milliseconds (60 seconds). */
const DEFAULT_WINDOW_MS = 60_000;
/** Default TPM (Tokens Per Minute) limit for Alibaba Cloud Bailian deepseek-v4-flash. */
const DEFAULT_TPM_LIMIT = 1_200_000;
/** Default RPM (Requests Per Minute) limit. */
const DEFAULT_RPM_LIMIT = 15_000;
/** Default safety factor (0.8 = use 80% of the limit to leave buffer). */
const DEFAULT_SAFETY_FACTOR = 0.8;
/** Default: verbose logging (false = only log startup and critical errors). */
const DEFAULT_VERBOSE = false;
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
 * Extract text content from a ContentBlock recursively.
 * DSH messages carry content as ContentBlock[] (never a plain string).
 * @internal
 */
function extractBlockText(block) {
    if (block.type === 'text' || block.type === 'reasoning') {
        return block.text ?? '';
    }
    if (block.type === 'tool-call') {
        return block.arguments ?? '';
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
        let text = '';
        for (const child of block.content) {
            text += extractBlockText(child);
        }
        return text;
    }
    return '';
}
/**
 * Estimate tokens from an array of DSH messages.
 * DSH Message.content is always ContentBlock[], never a plain string.
 * @internal
 */
function estimateTokensFromMessages(messages) {
    let total = 0;
    for (const msg of messages) {
        const blocks = msg.content;
        if (Array.isArray(blocks)) {
            for (const block of blocks) {
                total += estimateTokens(extractBlockText(block));
            }
        }
    }
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
            const opts = options;
            const messages = opts.messages ?? [];
            // Use the average of recent actual input token counts from the API as the
            // estimate for this request — far more accurate than heuristic estimation.
            // The moving average smooths out variance across concurrent requests.
            // Fall back to heuristic estimation only for the very first request.
            const estimatedInputTokens = getAverageInputTokens() || estimateTokensFromMessages(messages);
            // Calculate and apply delay before the first chunk
            const delay = calculateDelay(estimatedInputTokens, now);
            if (delay > 0) {
                const currentTpm = sumWindow(now);
                const effectiveLimit = getEffectiveTpmLimit();
                if (verbose)
                    console.log(`[agent-rate-limit] Delaying ${delay}ms (TPM: ${currentTpm}/${Math.round(effectiveLimit)} ×${Math.max(1, currentTpm / effectiveLimit).toFixed(2)}, RPM: ${windowEntries.length}/${rpmLimit})`);
                await ctx.timer.timeout(delay);
            }
            // Stream chunks, capture actual API token usage, and detect failures
            let hadFailure = false;
            let actualInputTokens = 0;
            let actualOutputTokens = 0;
            // Usage breakdown for verbose logging (uncached + cache hits)
            let usageUncached = 0;
            let usageCachedRead = 0;
            let usageCachedWrite = 0;
            for await (const chunk of originalStream) {
                const chunkObj = chunk;
                // Capture the actual token usage from the API's usage chunk.
                // Note: inputTokens is uncached input only; cache hits are reported
                // separately as cacheReadTokens/cacheWriteTokens. We include all of
                // them to match the API's billed total.
                if (chunkObj.type === 'usage' && chunkObj.usage) {
                    usageUncached = chunkObj.usage.inputTokens;
                    usageCachedRead = chunkObj.usage.cacheReadTokens ?? 0;
                    usageCachedWrite = chunkObj.usage.cacheWriteTokens ?? 0;
                    actualInputTokens = usageUncached + usageCachedRead + usageCachedWrite;
                    actualOutputTokens = chunkObj.usage.outputTokens;
                }
                // Detect terminal error/aborted finish chunks — the LLM adapter signals
                // failures (e.g. HTTP 429) as finish chunks, NOT by throwing. Without
                // this check, the for-await loop completes normally, and the code
                // below would incorrectly record tokens.
                if (chunkObj.type === 'finish' && chunkObj.reason) {
                    const reasonKind = chunkObj.reason.kind;
                    if (reasonKind === 'error' || reasonKind === 'aborted') {
                        hadFailure = true;
                    }
                }
                yield chunk;
            }
            // Only record usage on successful completion
            if (!hadFailure) {
                // Use the API's actual token counts when available (far more accurate
                // than heuristic estimation), otherwise fall back to the estimated sum.
                const totalTokens = actualInputTokens > 0
                    ? actualInputTokens + actualOutputTokens
                    : estimatedInputTokens;
                addToWindow(totalTokens, Date.now());
                if (verbose) {
                    const detail = actualInputTokens > 0
                        ? `uncached: ${usageUncached}, cached: ${usageCachedRead + usageCachedWrite}, output: ${actualOutputTokens}`
                        : `estimated: ${estimatedInputTokens}i`;
                    console.log(`[agent-rate-limit] Recorded ${totalTokens} tokens (${detail})`);
                }
                // Store the actual input count so the next request can use it
                // as a much more accurate estimate than heuristic calculation.
                // Keep a sliding window of the last 3 values for a stable moving average.
                if (actualInputTokens > 0) {
                    recentInputTokens.push(actualInputTokens);
                    if (recentInputTokens.length > 3) {
                        recentInputTokens.shift();
                    }
                }
            }
        })();
        return wrappedStream;
    });
    // Register /agent-rate-limit command
    ctx.effect?.(() => {
        const cmds = ctx.commands;
        if (cmds) {
            cmds.register({
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
                        `Current:`,
                        `  Window entries:  ${windowEntries.length}`,
                        `  Current TPM:     ${currentTpm.toLocaleString()}`,
                        '━━━━━━━━━━━━━━━━━━━━━━',
                    ];
                    return { kind: 'success', text: lines.join('\n') };
                },
            });
        }
    });
}
export { apply, Config, inject, name };
export { DEFAULT_WINDOW_MS, DEFAULT_TPM_LIMIT, DEFAULT_RPM_LIMIT, DEFAULT_SAFETY_FACTOR, DEFAULT_VERBOSE, };
