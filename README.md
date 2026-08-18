# @zhourenke/dsh-agent-rate-limit

English | [中文](README.zh.md)

**Agent loop rate limiter** — prevents TPM (Tokens Per Minute) and RPM (Requests Per Minute) limit violations by intercepting the LLM streaming pipeline and adding adaptive delays between requests.

When model providers enforce rate limits (e.g., Alibaba Cloud Bailian's 15,000 RPM + 1,200,000 TPM for deepseek-v4-flash), the agent loop can trigger these limits every few steps, causing errors and interruptions. This plugin solves that by:

- Tracking token usage in a **sliding 60-second window**
- **Estimating input tokens** from messages before each request
- **Counting output tokens** from stream chunks as they arrive
- **Adding adaptive delays** when approaching TPM or RPM limits
- **Exponential backoff** on rate-limit errors (auto-retry with `{ kind: 'retry' }`)

## How it works

```
User input → [agent/request] → [llm/stream*] → LLM API → [agent/request] → ...
                                    ↑
                          Rate limiter intercepts here

  ┌─ Sliding window (60s FIFO) ──────────────────────┐
  │  t0:  +5000 tokens (input)                       │
  │  t5: +12000 tokens (input)                       │
  │  t12: +8000 tokens (input)                       │
  │  ...                                             │
  │  Current window: 980,000 / 1,200,000 TPM         │
  │  Remaining: 220,000 tokens → pass through        │
  │  If approaching limit → delay before next request │
  └───────────────────────────────────────────────────┘
```

The plugin intercepts two Waterfall events:

| Event | Purpose |
|-------|---------|
| `llm/stream` | Check rate limits → delay if needed → stream tokens → count output tokens → update window |
| `agent/request-error` | Detect rate-limit errors (429) → return `{ kind: 'retry' }` with exponential backoff |

## Installation

This plugin is a **DSH profile bundle**. The only supported installation method is to place the package folder directly into a DSH profile's `node_modules` and list it in that profile's `dsh.profile.bundles` array. No `npm link`, no pnpm, and no registry access is required.

### Find your DSH profile

First, determine which profile you are using:

```powershell
# List available profiles
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Name
```

Common profiles: `web`, `tui`, `headless`. The profile directory is `$env:USERPROFILE\.dsh\profiles\<name>\`.

### Step 1 — Copy the package folder into the profile

```powershell
# Create the scoped directory if it does not exist
$target = "$env:USERPROFILE\.dsh\profiles\<name>\node_modules\@zhourenke"
New-Item -ItemType Directory -Force $target

# Copy the whole plugin folder (package.json, cordis.patch.yml, lib/, ...)
Copy-Item -Recurse C:\path\to\dsh-agent-rate-limit "$target\"
```

The copied tree must contain `package.json` (with `dsh.bundle.patch`), `cordis.patch.yml`, and `lib/`.

### Step 2 — Register the bundle

Edit `$env:USERPROFILE\.dsh\profiles\<name>\package.json`:

```diff
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
+       "@zhourenke/dsh-agent-rate-limit"
      ]
    }
  }
```

No `dependencies` entry is needed — DSH resolves bundles purely by package name from the profile's `node_modules` at startup (a `dependencies` entry only matters to `pnpm install`, which is not used for this plugin).

### Step 3 — Restart DSH

The plugin is loaded on the next DSH startup. When you update the plugin source, re-copy the folder (or use a junction if you prefer live updates) and restart DSH.

### Verify the installation

After restarting DSH, check the startup logs for `[agent-rate-limit]` entries confirming that the rate limiter is active:

```powershell
dsh web 2>&1 | Select-String "agent-rate-limit"
```

Expected output:

```
[agent-rate-limit] Plugin loaded. TPM: 1200000, RPM: 15000, factor: 0.8, window: 60000ms, retryOn429: true
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `windowMs` | `60000` | Sliding window size in milliseconds (60s). |
| `tpmLimit` | `1200000` | TPM (Tokens Per Minute) limit. Default matches Alibaba Cloud Bailian deepseek-v4-flash. |
| `rpmLimit` | `15000` | RPM (Requests Per Minute) limit. |
| `safetyFactor` | `0.8` | Safety factor (0.8 = use 80% of the limit, leaving 20% buffer). |
| `maxBackoffMs` | `30000` | Maximum backoff delay in milliseconds (30s). |
| `retryOn429` | `true` | When `true` (default), HTTP 429 responses are silently retried with adaptive backoff — the conversation continues smoothly. Set to `false` to surface 429 errors to the user. |

### Example: Adjusting for different providers

```yaml
# In your profile's cordis config or agent preset:
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
  config:
    tpmLimit: 2000000     # 2M TPM for a different provider
    rpmLimit: 5000        # 5K RPM
    safetyFactor: 0.75    # 75% utilization, 25% buffer
    retryOn429: true      # silently retry on 429 (recommended)
```

## How the rate limiting works

### Token estimation

The plugin uses a heuristic to estimate tokens from text:
- **CJK characters** (Chinese, Japanese, Korean): ~1.5 chars per token
- **Other characters** (Latin, numbers, etc.): ~3.5 chars per token

This is intentionally conservative — it's better to delay slightly more than to hit the rate limit.

### Error recovery

When a rate-limit error is detected (HTTP 429, the typical response from providers like Alibaba Cloud Bailian when TPM or RPM limits are hit), the plugin:

1. Records the error timestamp for adaptive backoff calculation
2. Returns `{ kind: 'retry' }` to tell the agent loop to retry **transparently** — the user never sees the error
3. Applies **time-based adaptive backoff**: the delay is proportional to how recently the last error occurred (4s immediately after an error, decaying to 0 over 60s)
4. If the error persists, the backoff keeps the retry rate low, avoiding further API hammering
5. When a request finally succeeds, the backoff resets

Set `retryOn429: false` in the config if you prefer 429 errors to surface to the user instead of being silently retried.

### Sliding window algorithm

The sliding window maintains a FIFO queue of `{ timestamp, tokens }` entries. Before each request:

1. Prune entries older than `windowMs` (60s)
2. Sum remaining tokens = current TPM
3. Count entries = current RPM
4. If RPM ≥ limit → delay until oldest entry expires
5. If TPM ≥ limit → delay until oldest entry expires
6. If TPM + estimated input tokens ≥ limit → delay until enough tokens expire
7. Apply backoff delay if there were consecutive errors

## Rate limit detection

The plugin detects HTTP 429 responses by checking the following in the error:

| Signal | Example |
|---------|---------|
| HTTP status code | `statusCode: 429` |
| Error code | `429`, `RATE_LIMITED`, `QUOTA` |
| "rate limit" text | `rate limit exceeded`, `rate_limit` |
| "too many requests" | `too many requests, please try again later` |
| TPM/RPM tokens | `TPM limit reached`, `token limit exceeded` |
| "throttle" | `request throttled`, `throttling` |
| "quota" | `Allocated quota exceeded` (Bailian) |
| "429" in message | `429: {...}` |

When any of these match, the plugin retries transparently with adaptive backoff by default (`retryOn429: true`).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    dsh-agent-rate-limit                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  SlidingWindow (module-level state)                        │  │
│  │  ┌─────────────────────┐  ┌───────────────────────────┐   │  │
│  │  │  windowEntries[]    │  │  consecutiveErrors        │   │  │
│  │  │  {timestamp,tokens} │  │  (exponential backoff)    │   │  │
│  │  └─────────────────────┘  └───────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ctx.on('llm/stream', ...)          ctx.on('agent/request-error')│
│  ┌─────────────────────────┐        ┌─────────────────────────┐  │
│  │ 1. Check sliding window │        │ 1. Detect rate-limit    │  │
│  │ 2. Delay if needed      │        │ 2. Return {kind:'retry'}│  │
│  │ 3. Count output tokens  │        │ 3. Record error         │  │
│  │ 4. Update window        │        └─────────────────────────┘  │
│  └─────────────────────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Dependencies

- `@deepseek-ai/schemastery` — configuration schema validation
- `@deepseek-ai/cordis` — plugin framework
- `@deepseek-ai/dsh-invariants` — DSH invariants
- `@deepseek-ai/dsh-llm` — LLM error types

## License

MIT