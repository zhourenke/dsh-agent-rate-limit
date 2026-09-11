**English** | [中文](README.md)

# @zhourenke/dsh-agent-rate-limit

A DSH agent loop rate limiter. Prevents TPM/RPM limit violations by intercepting the LLM streaming pipeline, computing sliding-window headroom before each request, and adding adaptive delays. Retry logic is delegated to DSH's built-in `dsh-llm-retry` plugin via provider-level `retryPolicy` configuration.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-agent-rate-limit"
```

This installs the package from GitHub, detects the `dsh.bundle` declaration, and automatically registers it as a profile layer. Restart DSH to activate.

## Compatibility

Tested with **DSH v0.1.5-rc.1** (September 2026). The plugin requires the following runtime packages:

- `@deepseek-ai/schemastery` (configuration schema)
- `@deepseek-ai/cordis` (plugin framework)
- `@deepseek-ai/dsh-llm` (LLM stream interface)

Install dependencies before use with the corresponding DSH version.

To uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-agent-rate-limit
```

## Configuration

Edit the `cordis.patch.yml`:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
  config:
    verbose: true   # enable debug logging
```

| Key | Default | Description |
|-----|---------|-------------|
| `windowMs` | `60000` | Sliding window size in milliseconds (60s). |
| `tpmLimit` | `1200000` | TPM (Tokens Per Minute) limit. Default matches Alibaba Cloud Bailian deepseek-v4-flash. |
| `rpmLimit` | `15000` | RPM (Requests Per Minute) limit. |
| `safetyFactor` | `0.8` | Safety factor (0.8 = use 80% of the limit, leaving 20% buffer). |
| `verbose` | `false` | When `true`, log per-request details (delay and token recording). |

## Check status

Type `/agent-rate-limit` in the chat input:

```
Status: loaded
Config:
  TPM limit:     1,200,000 (effective: 959,968)
  RPM limit:     15,000
  Safety factor: 0.8
  Window:        60s
  Verbose:       false
Current:
  Window entries:  12
  Current TPM:     14,765
```

## How it works

### Token tracking

1. **Token recording**: After each successful model call, the plugin records the exact token count from the API's `usage` chunk, **including cache hits** (`cacheReadTokens`/`cacheWriteTokens`), to match the API billed total.
2. **Sliding window**: A 60-second FIFO queue tracks recent token consumption. Before each request, the plugin checks if the current window is approaching the TPM or RPM limit and delays accordingly.
3. **Input estimation**: Uses the average of the last 3 actual input token counts from the API. Falls back to heuristic estimation only for the very first request.

Log example:

```
Recorded 113190 tokens (uncached: 1322, cached: 111616, output: 252)
```

### Delay algorithm

When the window approaches the TPM limit, the plugin calculates how long to wait for enough old entries to expire. It walks from the **newest entries** backward, finds the split point where "keep newest, discard oldest" brings the window below the limit, and waits for the right entry to expire.

Under concurrent agents, other agents keep adding tokens during the delay. The plugin automatically scales the delay by the TPM overshoot ratio:

```
Delaying 6854ms (TPM: 977031/960000 ×1.02, RPM: 12/15000, ...)  ← slight overshoot, minimal adjustment
Delaying 6982ms (TPM: 1759784/960000 ×1.83, RPM: 16/15000, ...)  ← 83% overshoot, 83% longer delay
```

## Development

```powershell
pnpm install        # install dev dependencies
pnpm run typecheck  # type check
pnpm run build      # compile to lib/
pnpm test           # execute the lib/ artifact
```

**Run `pnpm run build` and commit `lib/` after every change to `src/index.ts`.**

`pnpm test` is not optional. `tsc` only type-checks and transpiles, and the drift check only inspects git state — **nothing ever executes the artifact**. So "the module throws on import" (importing a symbol the host removed, destructuring `undefined` at module scope) stays green until the user restarts DSH and reads the startup log. The test imports the compiled artifact directly and drives it through a mock ctx: loading, event registration, stream wrapping, and window accounting.

`dsh plugin add github:...` only receives files tracked by git. This repository commits its build output instead of building at install time, so `lib/` must stay in sync with the source; otherwise a GitHub-installed plugin silently runs stale code with no error to signal it.

Do not add a `prepare` script. Git-hosted packages run it at install time, and pnpm blocks dependency build scripts by default, so `dsh plugin add` would fail outright until the user manually allows it in the profile's `pnpm-workspace.yaml`.

## Credits

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Tested with DSH v0.1.5-rc.1.