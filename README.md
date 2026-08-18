# @deepseek-ai/dsh-agent-rate-limit

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

This plugin is a **DSH bundle patch** — it must be registered in a DSH profile's `package.json` and listed in that profile's `dsh.profile.bundles` array.

### Find your DSH profile

```powershell
# List available profiles
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Name
```

Common profiles: `web`, `tui`, `headless`. The profile directory is `$env:USERPROFILE\.dsh\profiles\<name>\`.

### Option A: Local development (npm link)

```powershell
# Step 1 — Create a global link
cd C:\path\to\dsh-agent-rate-limit
npm link

# Step 2 — Register the plugin in your profile's package.json
# Edit $env:USERPROFILE\.dsh\profiles\<name>\package.json
# Add "@deepseek-ai/dsh-agent-rate-limit" to dsh.profile.bundles

# Step 3 — Restart DSH
```

### Option B: Published npm package (future)

```powershell
dsh plugin --profile <name> add @deepseek-ai/dsh-agent-rate-limit
```

### Option C: file: protocol (no npm link)

```powershell
cd "$env:USERPROFILE\.dsh\profiles\<name>"
pnpm add "file:C:\path\to\dsh-agent-rate-limit"
```

Then manually add `"@deepseek-ai/dsh-agent-rate-limit"` to the `dsh.profile.bundles` array in the same `package.json`, and restart DSH.

### Verify the installation

After restarting DSH, the plugin starts automatically. Check the DSH logs for `[agent-rate-limit]` entries confirming that the rate limiter is active.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `windowMs` | `60000` | Sliding window size in milliseconds (60s). |
| `tpmLimit` | `1200000` | TPM (Tokens Per Minute) limit. Default matches Alibaba Cloud Bailian deepseek-v4-flash. |
| `rpmLimit` | `15000` | RPM (Requests Per Minute) limit. |
| `safetyFactor` | `0.8` | Safety factor (0.8 = use 80% of the limit, leaving 20% buffer). |
| `maxBackoffMs` | `30000` | Maximum exponential backoff delay in milliseconds (30s). |

### Example: Adjusting for different providers

```yaml
# In your profile's cordis config or agent preset:
- id: agent-rate-limit
  name: '@deepseek-ai/dsh-agent-rate-limit'
  config:
    tpmLimit: 2000000     # 2M TPM for a different provider
    rpmLimit: 5000        # 5K RPM
    safetyFactor: 0.75    # 75% utilization, 25% buffer
```

## How the rate limiting works

### Token estimation

The plugin uses a heuristic to estimate tokens from text:
- **CJK characters** (Chinese, Japanese, Korean): ~1.5 chars per token
- **Other characters** (Latin, numbers, etc.): ~3.5 chars per token

This is intentionally conservative — it's better to delay slightly more than to hit the rate limit.

### Error recovery

When a rate-limit error is detected (HTTP 429, or error text containing "rate limit", "too many requests", etc.), the plugin:

1. Records the error in the consecutive error counter
2. Returns `{ kind: 'retry' }` to tell the agent loop to retry
3. Applies **exponential backoff**: 1s, 2s, 4s, 8s, ... (capped at `maxBackoffMs`)
4. **Reduces the effective TPM limit** by 10% per consecutive error (minimum 30% of original)
5. Resets the counter when a request succeeds

### Sliding window algorithm

The sliding window maintains a FIFO queue of `{ timestamp, tokens }` entries. Before each request:

1. Prune entries older than `windowMs` (60s)
2. Sum remaining tokens = current TPM
3. Count entries = current RPM
4. If RPM ≥ limit → delay until oldest entry expires
5. If TPM ≥ limit → delay until oldest entry expires
6. If TPM + estimated input tokens ≥ limit → delay until enough tokens expire
7. Apply backoff delay if there were consecutive errors

## Rate limit detection patterns

The plugin detects rate-limit errors by matching these patterns in the error:

| Pattern | Example |
|---------|---------|
| HTTP status code | `429`, `RATE_LIMITED` |
| "rate limit" text | `rate limit exceeded`, `rate_limit` |
| "too many requests" | `too many requests, please try again later` |
| TPM/RPM tokens | `TPM limit reached`, `token limit exceeded` |
| "throttle" | `request throttled`, `throttling` |

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