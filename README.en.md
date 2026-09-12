**English** | [中文](README.md)

# @zhourenke/dsh-agent-rate-limit

**Automatic TPM/RPM rate limiting for DSH: requests are queued against sliding-window headroom before the provider throttles them.**

A DSH agent loop can fire several requests within seconds and easily hit a provider's tokens-per-minute (TPM) or requests-per-minute (RPM) ceiling, which cuts a whole turn short with a 429. This plugin inserts an adaptive delay in front of the LLM streaming pipeline: it passes straight through while the window has headroom and waits only when the window approaches the limit — **it delays, it never rejects**. Works out of the box, no DSH source changes.

## What it solves

- **Throttling that breaks a conversation**: with several agents running at once, token consumption far exceeds any single request, so the plugin queues against a sliding window
- **No manual tuning**: defaults match common quotas, so it works unconfigured
- **Billing-accurate accounting**: real token usage is read from the API's `usage` chunk, **cache hits included**, matching the billed total
- **Removable at any time**: it installs as a profile layer and never patches DSH itself

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-agent-rate-limit"
```

**DSH must be restarted for this to take effect** — the new bundle is only loaded when the process starts, so refreshing the page does nothing. (Adjusting its configuration *after* installing does not require a restart; see Quick start.)

To uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-agent-rate-limit
```

## Quick start

The defaults work as-is; install it and you are done. **To confirm it is live**, type this in the chat input:

```
/agent-rate-limit
```

Seeing `Status: loaded` means it is loaded and working.

To change the limits, edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
  config:
    tpmLimit: 1200000
    rpmLimit: 15000
    verbose: true
```

The `id` must be `agent-rate-limit`: the bundle already inserted that entry, so what you write is a **config override for the same id**. **Do not wrap it in `- insert:`** — that is the form the bundle patch inside the package uses (its job is to add the entry), and using it here inserts a **second instance**, making the rate limit count twice.

**Saving the file is enough; no restart is needed.** The web profile's patch layer is hot-reloaded (`patchReload: live`, re-applied by Cordis HMR when the file changes). Note the distinction: **installing or removing the plugin itself still requires a restart**, because the bundle list is fixed when the process starts.

## Configuration

| Key | Type | Default | Description |
|---|---|:---:|---|
| `windowMs` | number | `60000` | Sliding window size in milliseconds. 60s matches the provider's TPM/RPM accounting period; rarely needs changing |
| `tpmLimit` | number | `1200000` | Tokens-per-minute ceiling. The default matches Alibaba Cloud Bailian deepseek-v4-flash |
| `rpmLimit` | number | `15000` | Requests-per-minute ceiling |
| `safetyFactor` | number | `0.8` | Safety factor. **The effective ceiling is `tpmLimit × safetyFactor`**, so by default only 80% of the quota is used, leaving a 20% buffer |
| `verbose` | boolean | `false` | Log the delay and token accounting for every request; turn on when diagnosing |

## Checking status

`/agent-rate-limit` prints the current configuration and window occupancy:

```
Status: loaded
Config:
  TPM limit:     1,200,000 (effective: 960,000)
  RPM limit:     15,000
  Safety factor: 0.8
  Window:        60s
  Verbose:       false
Current:
  Window entries:  12
  Current TPM:     14,765
```

`Window entries` is the number of requests inside the current 60-second window and `Current TPM` is the tokens accumulated in it. While both sit well below the ceilings the plugin adds no delay at all.

## How it affects your requests

- **Delays, never rejects**: the plugin never fails a request and never returns an error; it only waits when it has to
- **Passes through while there is headroom**: when the accumulated window plus this request's estimated input stays under the effective ceiling, the delay is `0`
- **Queues only near the ceiling**: it waits until enough old entries slide out of the window to free up room
- **Scales up under concurrency**: while you wait, other agents keep drawing on the quota, so the plugin multiplies the delay by the overshoot ratio
- **Failed requests cost no budget**: streams ending in `error` / `aborted` are not recorded, so retries do not slow themselves down
- **The delay happens before dispatch**: waiting occurs before the stream starts and never interrupts a response already in flight

## Known limitations (measured)

- **Counted per process**: the window lives inside the DSH process, so multiple DSH instances do not share it — running several profiles at once means each one computes against the full quota, and the total can still exceed it.
- **Configuration is global across providers**: one configuration applies to every provider under that plugin instance; there is no way to give different providers different ceilings.
- **The first request can only be estimated**: with an empty window there is no history, so input tokens are estimated heuristically; afterwards the average of the last 3 real API values is used.
- **A single oversized request cannot be split**: if one request alone approaches the quota, the plugin can only wait for it to slide out of the window, not break it up.
- **No guarantee against throttling**: the goal is to sharply reduce the probability, not to prove it impossible. If something else consumes the quota at the same time a 429 can still occur — DSH's built-in retry takes over from there.

## Notes for agents

- This plugin has **no tool and no model-visible interface**; it is entirely transparent to the model and cannot be invoked or controlled by it
- Rate limiting is automatic: hitting the ceiling shows up as a **slower response**, never as an error
- To check whether it is live, ask the user to run `/agent-rate-limit`; `Status: loaded` means it is loaded
- The configuration file is `~/.dsh/profiles/web/cordis.patch.yml`; editing it takes effect **as soon as it is saved, with no restart** (the patch layer is hot-reloaded). Only installing or removing the plugin itself requires a restart

## Compatibility

Tested with **DSH v0.1.5-rc.1** (2026-09).

## License

MIT
