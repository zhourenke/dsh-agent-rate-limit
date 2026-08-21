# @zhourenke/dsh-agent-rate-limit

[English](README.md) | 中文

**Agent 循环速率限制器** — 通过拦截 LLM 流式调用管道并在请求之间添加自适应延迟，防止 TPM（每分钟令牌数）和 RPM（每分钟请求数）限制违规。

当模型供应商实施速率限制时（例如阿里云百炼对 deepseek-v4-flash 的 15,000 RPM + 1,200,000 TPM），Agent 循环每几步就可能触发限制，导致错误和中断。本插件通过以下方式解决此问题：

- 在 **60 秒滑动窗口** 中跟踪令牌使用情况
- 在每次请求前**估算输入令牌**数
- 实时**统计输出令牌**数（从流式块中）
- 在接近 TPM 或 RPM 限制时**添加自适应延迟**
- 速率限制错误时**指数退避**（自动重试，返回 `{ kind: 'retry' }`）

## 工作原理

```
用户输入 → [agent/request] → [llm/stream*] → LLM API → [agent/request] → ...
                                    ↑
                          速率限制器在此处拦截

  ┌─ 滑动窗口 (60s FIFO) ──────────────────────┐
  │  t0:  +5000 tokens (输入)                    │
  │  t5: +12000 tokens (输入)                    │
  │  t12: +8000 tokens (输入)                    │
  │  ...                                       │
  │  当前窗口: 980,000 / 1,200,000 TPM          │
  │  剩余: 220,000 tokens → 通过                 │
  │  若接近限制 → 在下一次请求前延迟              │
  └─────────────────────────────────────────────┘
```

本插件拦截两个 Waterfall 事件：

| 事件 | 用途 |
|------|------|
| `llm/stream` | 检查速率限制 → 必要时延迟 → 流式传输令牌 → 统计输出令牌 → 更新窗口 |
| `agent/request-error` | 检测速率限制错误 (429) → 返回 `{ kind: 'retry' }` 并指数退避 |

## 安装

本插件是一个 **DSH 配置文件包（profile bundle）**。目前唯一支持的安装方式是把插件文件夹**直接放置**到 DSH 配置文件的 `node_modules` 中，并在该配置文件的 `dsh.profile.bundles` 列表里注册。**无需 `npm link`、无需 pnpm、无需访问 npm registry**。

### 找到你的 DSH 配置文件

首先确定你使用的是哪个配置文件（profile）：

```powershell
# 列出所有可用的配置文件
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Name
```

常见的配置文件：`web`、`tui`、`headless`。配置文件目录为 `$env:USERPROFILE\.dsh\profiles\<名称>\`。

### 第 1 步 — 把插件文件夹复制进配置文件

```powershell
# 若作用域目录不存在则创建
$target = "$env:USERPROFILE\.dsh\profiles\<名称>\node_modules\@zhourenke"
New-Item -ItemType Directory -Force $target

# 复制整个插件文件夹（package.json、cordis.patch.yml、lib/ 等）
Copy-Item -Recurse C:\path\to\dsh-agent-rate-limit "$target\"
```

复制后的目录必须包含 `package.json`（含 `dsh.bundle.patch`）、`cordis.patch.yml` 和 `lib/`。

### 第 2 步 — 注册 bundle

编辑 `$env:USERPROFILE\.dsh\profiles\<名称>\package.json`：

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

**无需在 `dependencies` 中添加任何条目**——DSH 启动时只按包名从配置文件的 `node_modules` 物理解析 bundle（`dependencies` 条目只对 `pnpm install` 有意义，本插件不依赖它）。

### 第 3 步 — 重启 DSH

下次启动 DSH 时插件会被加载。更新插件源码后重新复制文件夹（或使用 junction 以实现热更新），然后重启 DSH。

### 验证安装

重启 DSH 后，检查启动日志中是否有 `[agent-rate-limit]` 条目，确认速率限制器已激活：

```powershell
dsh web 2>&1 | Select-String "agent-rate-limit"
```

预期输出：

```
[agent-rate-limit] Plugin loaded. TPM: 1200000, RPM: 15000, factor: 0.8, window: 60000ms, retryOn429: true
```

## 配置

| 键 | 默认值 | 说明 |
|-----|:------:|------|
| `windowMs` | `60000` | 滑动窗口大小（毫秒，60 秒）。 |
| `tpmLimit` | `1200000` | TPM（每分钟令牌数）限制。默认值匹配阿里云百炼 deepseek-v4-flash。 |
| `rpmLimit` | `15000` | RPM（每分钟请求数）限制。 |
| `safetyFactor` | `0.8` | 安全系数（0.8 = 使用 80% 的限额，留 20% 缓冲）。 |
| `maxBackoffMs` | `30000` | 最大退避延迟（毫秒，30 秒）。 |
| `retryOn429` | `true` | 为 `true`（默认）时，HTTP 429 响应被静默重试（自适应退避），对话全程丝滑。设为 `false` 则 429 错误会报给用户。 |
| `maxRetries` | `5` | 每次突发中最多连续重试 429 的次数，超过后放弃重试并把错误报给用户。防止永久性错误（如账户配额真正耗尽）导致无限重试循环。 |

### 示例：针对不同供应商调整

```yaml
# 在配置文件的 cordis 配置或 agent preset 中：
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
  config:
    tpmLimit: 2000000     # 对于其他供应商，2M TPM
    rpmLimit: 5000        # 5K RPM
    safetyFactor: 0.75    # 75% 利用率，25% 缓冲
    retryOn429: true      # 静默重试 429（推荐）
    maxRetries: 5         # 连续 5 次 429 后放弃
```

## 速率限制的工作原理

### 令牌估算

本插件使用启发式方法估算文本中的令牌数：
- **CJK 字符**（中文、日文、韩文）：约 1.5 字符/令牌
- **其他字符**（拉丁字母、数字等）：约 3.5 字符/令牌

这是有意保守的——稍微多延迟一点也比触发速率限制要好。

### 错误恢复

检测到速率限制错误时（HTTP 429，阿里云百炼等供应商在 TPM 或 RPM 超限时的典型响应），本插件：

1. 记录错误并递增当前突发的重试计数
2. 返回 `{ kind: 'retry' }` 告诉 Agent 循环**透明地重试**——用户完全看不到错误
3. 应用**递增退避**：2s → 4s → 8s → 16s → 30s（上限 `maxBackoffMs`），每次重试都降低对 API 的压力
4. **连续失败 `maxRetries` 次后放弃重试**（默认 5 次），把错误报给用户。这防止了永久性错误导致无限重试循环——例如账户配额真正耗尽（`"Allocated quota exceeded, please increase your quota limit"`）
5. 请求成功时重试计数自动重置

若你想让 429 错误报给用户而不是静默重试，可将配置项 `retryOn429` 设为 `false`。

### 滑动窗口算法

滑动窗口维护一个 FIFO 队列，包含 `{ timestamp, tokens }` 条目。在每次请求前：

1. 删除早于 `windowMs`（60s）的条目
2. 求和剩余令牌 = 当前 TPM
3. 统计条目数 = 当前 RPM
4. 如果 RPM ≥ 限制 → 延迟直到最旧条目过期
5. 如果 TPM ≥ 限制 → 延迟直到最旧条目过期
6. 如果 TPM + 估算输入令牌 ≥ 限制 → 延迟直到足够令牌过期
7. 如果有连续错误，应用退避延迟

## 速率限制检测

本插件通过检查错误中的以下信号来检测 HTTP 429 响应：

| 信号 | 示例 |
|------|------|
| HTTP 状态码 | `statusCode: 429` |
| 错误码 | `429`, `RATE_LIMITED`, `QUOTA` |
| "rate limit" 文本 | `rate limit exceeded`, `rate_limit` |
| "too many requests" | `too many requests, please try again later` |
| TPM/RPM 令牌 | `TPM limit reached`, `token limit exceeded` |
| "throttle" | `request throttled`, `throttling` |
| "quota" | `Allocated quota exceeded`（百炼） |
| 消息中的 "429" | `429: {...}` |

匹配到任一信号时，插件默认（`retryOn429: true`）会以自适应退避透明地重试。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    dsh-agent-rate-limit                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  SlidingWindow（模块级状态）                                │  │
│  │  ┌─────────────────────┐  ┌───────────────────────────┐   │  │
│  │  │  windowEntries[]    │  │  consecutiveErrors        │   │  │
│  │  │  {timestamp,tokens} │  │  （指数退避）              │   │  │
│  │  └─────────────────────┘  └───────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ctx.on('llm/stream', ...)          ctx.on('agent/request-error')│
│  ┌─────────────────────────┐        ┌─────────────────────────┐  │
│  │ 1. 检查滑动窗口         │        │ 1. 检测速率限制         │  │
│  │ 2. 必要时延迟           │        │ 2. 返回 {kind:'retry'}  │  │
│  │ 3. 统计输出令牌         │        │ 3. 记录错误             │  │
│  │ 4. 更新窗口             │        └─────────────────────────┘  │
│  └─────────────────────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
```

## 依赖

- `@deepseek-ai/schemastery` — 配置模式验证
- `@deepseek-ai/cordis` — 插件框架
- `@deepseek-ai/dsh-invariants` — DSH 不变性
- `@deepseek-ai/dsh-llm` — LLM 错误类型

## 许可证

MIT