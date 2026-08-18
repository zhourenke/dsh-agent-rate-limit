//#region lib/index.js
/**
 * @deepseek-ai/dsh-agent-rate-limit
 *
 * An agent loop rate limiter that prevents TPM (Tokens Per Minute) and
 * RPM (Requests Per Minute) limit violations by intercepting the LLM
 * streaming pipeline and adding adaptive delays between requests.
 *
 * Supports configurable limits, exponential backoff on rate-limit errors,
 * and a sliding-window algorithm that tracks both input and output tokens.
 *
 * @module @deepseek-ai/dsh-agent-rate-limit
 */
import z from "@deepseek-ai/schemastery";
//#endregion

//#region constants
/** Default sliding window size in milliseconds (60 seconds). */
const DEFAULT_WINDOW_MS = 60_000;
/** Default TPM (Tokens Per Minute) limit for Alibaba Cloud Bailian deepseek-v4-flash. */
const DEFAULT_TPM_LIMIT = 1_200_000;
/** Default RPM (Requests Per Minute) limit. */
const DEFAULT_RPM_LIMIT = 15_000;
/** Default safety factor (0.8 = use 80% of the limit to leave buffer). */
const DEFAULT_SAFETY_FACTOR = 0.8;
/** Default maximum exponential backoff delay in milliseconds. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;
//#endregion

//#region sliding window state
/** @type {Array<{timestamp:number, tokens:number}>} */
const windowEntries = [];
/** @type {number} */
let consecutiveErrors = 0;
/** @type {number} */
let windowMs = DEFAULT_WINDOW_MS;
/** @type {number} */
let tpmLimit = DEFAULT_TPM_LIMIT;
/** @type {number} */
let rpmLimit = DEFAULT_RPM_LIMIT;
/** @type {number} */
let safetyFactor = DEFAULT_SAFETY_FACTOR;
/** @type {number} */
let maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
//#endregion

//#region rate limiter core
/**
 * Initialize the rate limiter with the given config.
 * @param {object} config
 * @param {number} config.windowMs
 * @param {number} config.tpmLimit
 * @param {number} config.rpmLimit
 * @param {number} config.safetyFactor
 * @param {number} config.maxBackoffMs
 */
function initRateLimiter(config) {
	windowMs = config.windowMs;
	tpmLimit = config.tpmLimit;
	rpmLimit = config.rpmLimit;
	safetyFactor = config.safetyFactor;
	maxBackoffMs = config.maxBackoffMs;
	windowEntries.length = 0;
	consecutiveErrors = 0;
}

/**
 * Remove entries that have fallen outside the sliding window.
 * @param {number} now - current timestamp
 */
function pruneWindow(now) {
	const cutoff = now - windowMs;
	while (windowEntries.length > 0 && windowEntries[0].timestamp < cutoff) {
		windowEntries.shift();
	}
}

/**
 * Sum all tokens currently in the sliding window.
 * @param {number} now - current timestamp
 * @returns {number} total tokens in the window
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
 * @param {number} tokens - tokens to add
 * @param {number} now - current timestamp
 */
function addToWindow(tokens, now) {
	pruneWindow(now);
	windowEntries.push({ timestamp: now, tokens });
}

/**
 * Record a rate-limit error for backoff calculation.
 */
function recordError() {
	consecutiveErrors++;
}

/**
 * Reset the consecutive error counter.
 */
function resetErrors() {
	consecutiveErrors = 0;
}

/**
 * Calculate the exponential backoff delay based on consecutive errors.
 * @returns {number} delay in milliseconds
 */
function getBackoffDelay() {
	if (consecutiveErrors === 0) return 0;
	// Exponential backoff: 1s, 2s, 4s, 8s, ... capped at maxBackoffMs
	return Math.min(
		Math.pow(2, consecutiveErrors - 1) * 1000,
		maxBackoffMs
	);
}

/**
 * Get the effective TPM limit, reduced by consecutive errors.
 * @returns {number} effective TPM limit
 */
function getEffectiveTpmLimit() {
	// Each consecutive error reduces the limit by 10%, minimum 30% of original
	const factor = Math.max(0.3, safetyFactor - consecutiveErrors * 0.1);
	return tpmLimit * factor;
}

/**
 * Calculate the required delay before the next request, in milliseconds.
 * Returns 0 if no delay is needed.
 * @param {number} estimatedInputTokens - estimated tokens for the next request
 * @param {number} now - current timestamp
 * @returns {number} delay in milliseconds (0 = no delay)
 */
function calculateDelay(estimatedInputTokens, now) {
	pruneWindow(now);

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

	// 2. Check TPM limit (current usage already exceeds limit)
	if (currentTpm >= effectiveTpmLimit && windowEntries.length > 0) {
		const oldest = windowEntries[0];
		const expireAt = oldest.timestamp + windowMs;
		if (expireAt > now) {
			return expireAt - now + 100;
		}
	}

	// 3. Check if adding estimated tokens would exceed limit
	if (currentTpm + estimatedInputTokens >= effectiveTpmLimit && windowEntries.length > 0) {
		// Walk from the oldest entries to find when enough tokens expire
		const target = effectiveTpmLimit - estimatedInputTokens;
		let cumulative = 0;
		for (let i = windowEntries.length - 1; i >= 0; i--) {
			cumulative += windowEntries[i].tokens;
			if (cumulative >= target) {
				const expireAt = windowEntries[i].timestamp + windowMs;
				if (expireAt > now) {
					return expireAt - now + 100;
				}
				break;
			}
		}
	}

	// 4. Apply backoff delay (if there were consecutive errors)
	return getBackoffDelay();
}
//#endregion

//#region token estimation
/**
 * Roughly estimate the number of tokens in a text string.
 *
 * Heuristic: CJK characters average ~1.5 chars/token,
 * other characters average ~3.5 chars/token.
 * This is sufficient for rate-limiting purposes — we don't need
 * exact counts, just a conservative estimate to stay under the limit.
 *
 * @param {string} text - the text to estimate
 * @returns {number} estimated token count
 */
function estimateTokens(text) {
	if (!text || text.length === 0) return 0;
	// Count CJK characters
	const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
	const otherChars = text.length - cjkChars;
	return Math.ceil(cjkChars / 1.5 + otherChars / 3.5);
}

/**
 * Estimate tokens from an array of messages (each with a `content` field).
 * @param {Array<{content?: string}>} messages - array of messages
 * @returns {number} estimated total tokens
 */
function estimateTokensFromMessages(messages) {
	let total = 0;
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			total += estimateTokens(msg.content);
		}
	}
	return total;
}

/**
 * Estimate tokens from a stream chunk delta text.
 * @param {string} delta - text delta from a stream chunk
 * @returns {number} estimated tokens in the delta
 */
function estimateTokensFromDelta(delta) {
	return estimateTokens(delta);
}
//#endregion

//#region plugin definition
/** Cordis plugin name used by loader diagnostics. */
const name = "agent-rate-limit";
/** Hard dependency on the timer service. */
const inject = ["timer"];
/** Plugin configuration schema. */
const Config = z.object({
	windowMs: z.number().default(DEFAULT_WINDOW_MS),
	tpmLimit: z.number().default(DEFAULT_TPM_LIMIT),
	rpmLimit: z.number().default(DEFAULT_RPM_LIMIT),
	safetyFactor: z.number().default(DEFAULT_SAFETY_FACTOR),
	maxBackoffMs: z.number().default(DEFAULT_MAX_BACKOFF_MS)
});

/**
 * Register the agent rate limiter.
 *
 * Intercepts two Waterfall events:
 * - `llm/stream`: adds a delay before each LLM request based on the sliding
 *   window state, then counts output tokens from the stream chunks.
 * - `agent/request-error`: detects rate-limit errors (HTTP 429) and returns
 *   `{ kind: 'retry' }` with exponential backoff.
 *
 * @param {object} ctx - plugin context
 * @param {object} config - resolved plugin configuration
 */
async function apply(ctx, config) {
	// Initialize rate limiter state
	initRateLimiter({
		windowMs: Number(config.windowMs ?? DEFAULT_WINDOW_MS),
		tpmLimit: Number(config.tpmLimit ?? DEFAULT_TPM_LIMIT),
		rpmLimit: Number(config.rpmLimit ?? DEFAULT_RPM_LIMIT),
		safetyFactor: Number(config.safetyFactor ?? DEFAULT_SAFETY_FACTOR),
		maxBackoffMs: Number(config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)
	});

	/**
	 * Intercept the LLM stream waterfall to apply rate limiting.
	 *
	 * Before the stream starts, checks the sliding window and delays
	 * if approaching TPM or RPM limits. After the stream, records the
	 * actual token usage (input estimation + output count).
	 */
	ctx.on("llm/stream", (options, next) => {
		// Get the original stream
		const originalStream = next();

		// Return a wrapped stream that adds delay before the first chunk
		// and counts output tokens
		const wrappedStream = (async function* () {
			const now = Date.now();
			const messages = options.messages ?? [];
			const estimatedInputTokens = estimateTokensFromMessages(messages);

			// Calculate and apply delay before the first chunk
			const delay = calculateDelay(estimatedInputTokens, now);
			if (delay > 0) {
				await ctx.timer.timeout(delay);
			}

			// Stream chunks and count output tokens
			let outputTokens = 0;
			for await (const chunk of originalStream) {
				if (typeof chunk.delta === "string") {
					outputTokens += estimateTokensFromDelta(chunk.delta);
				}
				yield chunk;
			}

			// Record actual token usage after the stream completes
			addToWindow(estimatedInputTokens + outputTokens, Date.now());
			resetErrors();
		})();

		return wrappedStream;
	});

	/**
	 * Intercept request errors to detect rate-limit responses and retry.
	 */
	ctx.on("agent/request-error", async (payload, next) => {
		const failure = payload.failure;
		const errorMessage = typeof failure?.message === "string" ? failure.message : "";
		const errorCode = typeof failure?.code === "string" ? failure.code : "";

		// Detect rate limit errors: HTTP 429, or error text matching common patterns
		const isRateLimit =
			errorCode === "RATE_LIMITED" ||
			errorCode === "429" ||
			/rate\s*limit/i.test(errorMessage) ||
			/too\s+many\s+requests/i.test(errorMessage) ||
			/tpm|rpm|token.*limit/i.test(errorMessage) ||
			/throttl/i.test(errorMessage);

		if (isRateLimit) {
			recordError();
			return { kind: "retry" };
		}

		// For non-rate-limit errors, delegate to the default handler
		return next();
	});
}
//#endregion

export { apply, Config, inject, name };
export {
	DEFAULT_WINDOW_MS,
	DEFAULT_TPM_LIMIT,
	DEFAULT_RPM_LIMIT,
	DEFAULT_SAFETY_FACTOR,
	DEFAULT_MAX_BACKOFF_MS
};