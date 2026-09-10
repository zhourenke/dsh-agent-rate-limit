[English](README.en.md) | **中文**

# @zhourenke/dsh-agent-rate-limit

DSH Agent 速率限制插件。通过拦截 LLM 流式管线，在请求前计算滑动窗口 TPM/RPM 余量并添加自适应延迟，防止触发提供商限速。重试逻辑交由 DSH 内置的 `dsh-llm-retry` 插件处理，通过 provider 级别的 `retryPolicy` 配置。

## 安装

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-agent-rate-limit"
```

此命令从 GitHub 下载包，自动检测 `dsh.bundle` 声明并注册为 profile 层。重启 DSH 后生效。

卸载：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-agent-rate-limit
```

## 兼容性

已在 **DSH v0.1.5-rc.1**（2026 年 9 月）版本下测试通过。插件依赖以下运行时包：

- `@deepseek-ai/schemastery`（配置校验）
- `@deepseek-ai/cordis`（插件框架）
- `@deepseek-ai/dsh-llm`（LLM 流接口）

安装依赖后即可在相应版本的 DSH 中使用。

## 配置

编辑 `cordis.patch.yml`：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-rate-limit
  name: '@zhourenke/dsh-agent-rate-limit'
  config:
    verbose: true   # 启用调试日志
```

| 配置项 | 默认值 | 说明 |
|-------|--------|------|
| `windowMs` | `60000` | 滑动窗口大小（毫秒，60 秒）。 |
| `tpmLimit` | `1200000` | TPM 限制。默认匹配阿里云百炼 deepseek-v4-flash。 |
| `rpmLimit` | `15000` | RPM 限制。 |
| `safetyFactor` | `0.8` | 安全系数（0.8 = 使用 80% 限额，预留 20% 缓冲）。 |
| `verbose` | `false` | 启用后输出每次请求的延迟和令牌记录日志。 |

## 查看状态

在聊天输入框输入 `/agent-rate-limit`：

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

## 工作原理

### 令牌追踪

1. **记录令牌数**：每次成功调用后，插件从 API 的 `usage` 数据块中记录精确的令牌消耗，**包含缓存命中**（`cacheReadTokens`/`cacheWriteTokens`），以匹配 API 账单总额。
2. **滑动窗口**：60 秒 FIFO 队列记录最近令牌消耗。每次请求前检查窗口是否接近 TPM/RPM 上限，必要时延迟。
3. **输入估算**：取最近 3 次 API 实际输入令牌数的平均值作为估算。仅首次请求使用启发式估算。

日志示例：

```
Recorded 113190 tokens (uncached: 1322, cached: 111616, output: 252)
```

### 延迟算法

当窗口接近 TPM 上限时，插件计算需要等待多久让足够多的旧条目过期。算法从**最新条目**开始往前遍历，找到「保留最新条目，丢弃最旧条目」的切分点，确保延迟后排空到限额以下。

多 Agent 并发时，单个 Agent 的等待期间其他 Agent 仍在添加令牌。插件根据当前 TPM 超限比例自动延长等待时间：

```
Delaying 6854ms (TPM: 977031/960000 ×1.02, RPM: 12/15000, ...)  ← 轻微超限，几乎不变
Delaying 6982ms (TPM: 1759784/960000 ×1.83, RPM: 16/15000, ...)  ← 超限 83%，延迟加长 83%

## Credits

Built for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).

Tested with DSH v0.1.5-rc.1.