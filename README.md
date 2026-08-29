# @zhourenke/dsh-agent-rate-limit

A DSH agent loop rate limiter. Prevents TPM/RPM limit violations by adding adaptive delays between requests. Retries HTTP 429 and transient server overloads (e.g. Nvidia `Service temporarily overloaded`) with escalating backoff.

## Installation

The plugin is loaded as a DSH profile bundle. Add it to your profile's `dsh.profile.bundles` in `package.json`:

```json
"dsh": {
  "profile": {
    "bundles": [
      "@zhourenke/dsh-agent-rate-limit"
    ]
  }
}
```

Then install:

```powershell
cd ~\.dsh\profiles\web
pnpm add @zhourenke/dsh-agent-rate-limit
```

## Configuration

Edit the plugin's `cordis.patch.yml`:

```yaml
# ~/.dsh/profiles/web/node_modules/@zhourenke/dsh-agent-rate-limit/cordis.patch.yml
- insert:
    - id: agent-rate-limit
      name: '@zhourenke/dsh-agent-rate-limit'
      config:
        verbose: true   # 启用调试日志
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

1. **Token recording**: After each successful model call, the plugin records the exact token count from the API's `usage` chunk.
2. **Sliding window**: A 60-second FIFO queue tracks recent token consumption. Before each request, the plugin checks if the current window is approaching the TPM or RPM limit and delays accordingly.
3. **Input estimation**: Uses the average of the last 3 actual input token counts from the API. Falls back to heuristic estimation only for the very first request.

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