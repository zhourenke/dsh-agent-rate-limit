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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
/** Cordis plugin name used by loader diagnostics. */
declare const name = "agent-rate-limit";
/** Hard dependency on the timer service and commands service. */
declare const inject: string[];
/** Plugin configuration schema. */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
    windowMs: z<number, number, "defined">;
    tpmLimit: z<number, number, "defined">;
    rpmLimit: z<number, number, "defined">;
    safetyFactor: z<number, number, "defined">;
    verbose: z<boolean, boolean, "defined">;
    countFailedAttempts: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    windowMs: z<number, number, "defined">;
    tpmLimit: z<number, number, "defined">;
    rpmLimit: z<number, number, "defined">;
    safetyFactor: z<number, number, "defined">;
    verbose: z<boolean, boolean, "defined">;
    countFailedAttempts: z<boolean, boolean, "defined">;
}>>, "plain">;
/**
 * The rendered outcome a command handler returns.
 *
 * Mirrors `CommandResult` in `@deepseek-ai/dsh-commands`, which the host
 * validates at the registry boundary and rejects by throwing
 * `handler must return a CommandResult`. The union is spelled out with literal
 * types on purpose: declared as `kind: string` a typo would pass `tsc` and only
 * surface on the user's first `/agent-rate-limit`.
 */
type CommandResult = {
    kind: 'success';
    text?: string;
} | {
    kind: 'error';
    text: string;
};
/** One command registration accepted by the injected `commands` service. */
interface CommandDefinition {
    /** Command name invoked as `/<name>`. */
    name: string;
    /** One-line description shown in command listings. */
    description: string;
    /** Produce the command's rendered result. */
    handler: () => CommandResult;
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
    on(name: 'llm/stream', handler: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>): void;
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
    effect(callback: () => void | (() => void)): void;
    /**
     * Injected timeout service.
     *
     * `timeout(ms)` resolves after the delay. The host implements it as a context
     * effect, so disposing the plugin while a delay is pending rejects it
     * ("Context has been disposed"). The web profile reloads patches live, so the
     * delay site below tolerates that rejection rather than letting a reload turn
     * into a failed request.
     */
    timer: {
        timeout: (ms: number) => Promise<void>;
    };
    /** Injected command registry; named in `inject`, so it is always present. */
    commands: {
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
