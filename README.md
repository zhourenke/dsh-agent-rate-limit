# @zhourenke/dsh-agent-rate-limit

A DSH agent loop rate limiter that prevents TPM (Tokens Per Minute) and RPM (Requests Per Minute) limit violations by intercepting the LLM streaming pipeline and adding adaptive delays between requests. Also retries HTTP 429 responses with escalating backoff.

## Installation

Copy the package to your DSH profile's `node_modules`:

```powershell
# From the repo root
Copy-Item -Recurse -Force .\dsh-agent-rate-limit $env:USERPROFILE\.dsh\profiles\web\node_modules\@zhourenke\dsh-agent-rate-limit
```

Or use a directory junction for development:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@zhourenke\dsh-agent-rate-limit" -Target "C:\path\to\dsh-agent-rate-limit"
```

## Usage

Add to your agent preset:

```yaml
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `windowMs` | `60000` | Sliding window size in milliseconds (60s). |
| `tpmLimit` | `1200000` | TPM (Tokens Per Minute) limit. Default matches Alibaba Cloud Bailian deepseek-v4-flash. |
| `rpmLimit` | `15000` | RPM (Requests Per Minute) limit. |
| `safetyFactor` | `0.8` | Safety factor (0.8 = use 80% of the limit, leaving 20% buffer). |
| `maxBackoffMs` | `30000` | Maximum backoff delay in milliseconds (30s). |
| `retryOn429` | `true` | When `true`, HTTP 429 responses are silently retried with escalating backoff. |
| `maxRetries` | `5` | Maximum consecutive 429 retries per burst before giving up. |
| `verbose` | `false` | When `true`, log per-request details (delay, token recording, retry attempts). |

## Check status

Type `/agent-rate-limit` in the chat input to see current plugin status and configuration.

## How it works

### Token tracking

1. **Token recording**: After each successful model call, the plugin records the exact token count from the API's `usage` chunk — far more accurate than heuristic estimation.
2. **Sliding window**: A 60-second FIFO queue tracks recent token consumption. Before each request, the plugin checks if the current window is approaching the TPM or RPM limit and delays accordingly.
3. **Input estimation**: For the pre-request delay calculation, the plugin uses the average of the last 3 actual input token counts from the API. Falls back to heuristic estimation (CJK: ~1.5 chars/token, others: ~3.5 chars/token) only for the very first request.

### Error recovery

When a rate-limit error is detected (HTTP 429), the plugin:

1. Increments the retry count for the current burst
2. Returns `{ kind: 'retry' }` to retry transparently
3. Applies escalating backoff: 2s → 4s → 8s → 16s → 30s (capped at `maxBackoffMs`)
4. Gives up after `maxRetries` consecutive failures and surfaces the error
5. Resets the retry counter on success

### Rate limit detection

The plugin detects HTTP 429 by checking the error's `statusCode`, `code`, and `message` for patterns like `rate limit`, `too many requests`, `tpm`, `rpm`, `quota`, `throttl`, and `429`.

## Credits

Built for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).