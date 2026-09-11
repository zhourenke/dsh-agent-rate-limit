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
/** Default sliding window size in milliseconds (60 seconds). */
declare const DEFAULT_WINDOW_MS = 60000;
/** Default TPM (Tokens Per Minute) limit for Alibaba Cloud Bailian deepseek-v4-flash. */
declare const DEFAULT_TPM_LIMIT = 1200000;
/** Default RPM (Requests Per Minute) limit. */
declare const DEFAULT_RPM_LIMIT = 15000;
/** Default safety factor (0.8 = use 80% of the limit to leave buffer). */
declare const DEFAULT_SAFETY_FACTOR = 0.8;
/** Default: verbose logging (false = only log startup and critical errors). */
declare const DEFAULT_VERBOSE = false;
/** Cordis plugin name used by loader diagnostics. */
declare const name = "agent-rate-limit";
/** Hard dependency on the timer service and commands service. */
declare const inject: string[];
/** Plugin configuration schema. */
declare const Config: z<Schemastery.ObjectS<{
    windowMs: z<number, number>;
    tpmLimit: z<number, number>;
    rpmLimit: z<number, number>;
    safetyFactor: z<number, number>;
    verbose: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    windowMs: z<number, number>;
    tpmLimit: z<number, number>;
    rpmLimit: z<number, number>;
    safetyFactor: z<number, number>;
    verbose: z<boolean, boolean>;
}>>;
/** One command registration accepted by the injected `commands` service. */
interface CommandDefinition {
    /** Command name invoked as `/<name>`. */
    name: string;
    /** One-line description shown in command listings. */
    description: string;
    /** Produce the command's rendered result. */
    handler: () => {
        kind: string;
        text?: string;
    };
}
/**
 * The minimal structural view of the Cordis plugin context this plugin uses.
 *
 * Declaring it locally keeps the plugin independent of DSH's published type
 * packages while still type-checking every call site.
 */
interface PluginContext {
    /** Subscribe to a Waterfall event. */
    on(name: string, handler: (options: unknown, next: () => AsyncIterable<unknown>) => unknown): void;
    /** Register a lifecycle effect, disposed together with the plugin. */
    effect?(callback: () => void): void;
    /** Injected timeout service. */
    timer: {
        timeout: (ms: number) => Promise<void>;
    };
    /** Injected command registry. */
    commands?: {
        register(definition: CommandDefinition): () => void;
    };
}
/**
 * Register the agent rate limiter.
 *
 * Intercepts the `llm/stream` Waterfall event to add a delay before each LLM
 * request based on the sliding window state, then records actual token usage
 * from the stream. Retry logic is delegated to the built-in DSH `dsh-llm-retry`
 * plugin via provider-level `retryPolicy` configuration.
 */
declare function apply(ctx: PluginContext, config: Record<string, unknown>): Promise<void>;
export { apply, Config, inject, name };
export { DEFAULT_WINDOW_MS, DEFAULT_TPM_LIMIT, DEFAULT_RPM_LIMIT, DEFAULT_SAFETY_FACTOR, DEFAULT_VERBOSE, };
