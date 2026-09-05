**English** | [中文](README.md)

# @zhourenke/dsh-agent-rate-limit

A DSH agent loop rate limiter. Prevents TPM/RPM limit violations by adding adaptive delays between requests. Retries HTTP 429 and transient server overloads (e.g. Nvidia `Service temporarily overloaded`) with escalating backoff.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-agent-rate-limit"
```

This installs the package from GitHub, detects the `dsh.bundle` declaration, and automatically registers it as a profile layer. Restart DSH to activate.

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
| `maxBackoffMs` | `30000` | Maximum backoff delay in milliseconds (30s). |
| `retryOn429` | `true` | When `true`, retryable errors (429, server overloads) are silently retried with escalating backoff. |
| `maxRetries` | `5` | Maximum consecutive retries per burst before giving up. |
| `verbose` | `false` | When `true`, log per-request details (delay, token recording, retry attempts). |

## Check status

Type `/agent-rate-limit` in the chat input:

```
Status: loaded
Config:
  TPM limit:     1,200,000 (effective: 959,968)
  RPM limit:     15,000
  Safety factor: 0.8
  Window:        60s
  Retry on 429:  true
  Max retries:   5
  Verbose:       false
Current:
  Window entries:  12
  Current TPM:     14,765
  Consecutive err: 0
  Retry count:     0
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

### Error recovery

The plugin retries the following errors with escalating backoff (`2s → 4s → 8s → 16s → 30s`, capped at `maxBackoffMs`):

- **HTTP 429** (rate limit / quota exceeded)
- **Nvidia `Service temporarily overloaded` / `PI_AI_ERROR`** (transient server overload)
- Other provider-specific transient errors matching the detection patterns

After `maxRetries` consecutive failures, the plugin gives up and surfaces the error to the user. The retry counter resets on success.

### Rate limit detection

The plugin detects retryable errors by checking the error's `statusCode`, `code`, and `message` for patterns like `rate limit`, `too many requests`, `tpm`, `rpm`, `quota`, `throttl`, `429`, `service temporarily overloaded`, and `PI_AI_ERROR`.

## Credits

Built for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).