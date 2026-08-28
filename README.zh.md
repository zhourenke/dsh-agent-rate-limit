# @zhourenke/dsh-agent-rate-limit

DSH Agent 速率限制插件。通过拦截 LLM 流式管线，在请求间添加自适应延迟，防止 TPM（每分钟令牌数）和 RPM（每分钟请求数）超限。同时以递增退避重试 HTTP 429 响应。

## 安装

将包复制到 DSH 配置文件的 `node_modules`：

```powershell
# 从仓库根目录
Copy-Item -Recurse -Force .\dsh-agent-rate-limit $env:USERPROFILE\.dsh\profiles\web\node_modules\@zhourenke\dsh-agent-rate-limit
```

或使用目录联接（开发时自动同步）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@zhourenke\dsh-agent-rate-limit" -Target "C:\path\to\dsh-agent-rate-limit"
```

## 用法

在 agent preset 中添加：

```yaml
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
```

## 配置

| 键 | 默认值 | 说明 |
|-----|:------:|------|
| `windowMs` | `60000` | 滑动窗口大小（毫秒，60 秒）。 |
| `tpmLimit` | `1200000` | TPM（每分钟令牌数）限制。默认值匹配阿里云百炼 deepseek-v4-flash。 |
| `rpmLimit` | `15000` | RPM（每分钟请求数）限制。 |
| `safetyFactor` | `0.8` | 安全系数（0.8 = 使用 80% 的限额，留 20% 缓冲）。 |
| `maxBackoffMs` | `30000` | 最大退避延迟（毫秒，30 秒）。 |
| `retryOn429` | `true` | 为 `true` 时，HTTP 429 响应被静默重试（递增退避）。 |
| `maxRetries` | `5` | 每次突发中最多连续重试 429 的次数，超过后放弃。 |
| `verbose` | `false` | 为 `true` 时记录每次请求的详细日志（延迟、token 记录、重试尝试）。 |

## 查看状态

在聊天输入框输入 `/agent-rate-limit` 查看当前插件状态和配置。

## 工作原理

### Token 追踪

1. **Token 记录**：每次成功的模型调用后，从 API 的 `usage` chunk 中提取精确的 token 计数，比启发式估算准确得多。
2. **滑动窗口**：60 秒 FIFO 队列追踪近期 token 消耗。每次请求前检查当前窗口是否接近 TPM 或 RPM 限制，按需延迟。
3. **输入估算**：使用最近 3 次实际输入 token 数的平均值作为下次请求的估算值。仅首次请求回退到启发式估算（CJK：~1.5 字符/token，其他：~3.5 字符/token）。

### 错误恢复

检测到 HTTP 429 时：

1. 递增当前突发重试计数
2. 返回 `{ kind: 'retry' }` 透明重试
3. 应用递增退避：2s → 4s → 8s → 16s → 30s（上限 `maxBackoffMs`）
4. 连续失败 `maxRetries` 次后放弃重试并报错
5. 成功时重置重试计数

### 速率限制检测

通过检查错误中的 `statusCode`、`code` 和 `message` 检测 HTTP 429，匹配模式包括 `rate limit`、`too many requests`、`tpm`、`rpm`、`quota`、`throttl`、`429`。

## 致谢

为 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 构建。