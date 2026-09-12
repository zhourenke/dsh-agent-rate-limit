[English](README.en.md) | **中文**

# @zhourenke/dsh-agent-rate-limit

**为 DSH 自动加上 TPM/RPM 速率限制：在触发供应商限速之前，先按滑动窗口余量把请求排好队。**

DSH 的 Agent 循环能在几十秒内连续发出多个请求，很容易撞上供应商的每分钟令牌数（TPM）或每分钟请求数（RPM）上限，导致整轮对话被 429 打断。本插件在 LLM 流式管线前插一层自适应延迟：窗口还有余量就直接放行，接近上限才等待——**只延迟，不拒绝**。装好即用，无需改动 DSH 源码。

## 它解决什么问题

- **撞限速导致对话中断**：多个 Agent 并发时令牌消耗远超单次请求的量，插件按滑动窗口提前排队
- **免人工调参**：默认值匹配常见配额，不配置也能工作
- **账单口径准确**：从 API 的 `usage` 数据块读取真实令牌消耗，**含缓存命中**，与账单一致
- **随时可卸**：作为 profile 层插入，不修改 DSH 本体

## 安装

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-agent-rate-limit"
```

**必须重启 DSH 才会生效**——插件由 loader 在进程启动时加载，刷新页面无效。

卸载：

```powershell
dsh plugin --profile web remove @zhourenke/dsh-agent-rate-limit
```

## 快速上手

默认配置即可工作，装上就完事。**确认生效**：在聊天输入框输入

```
/agent-rate-limit
```

看到 `Status: loaded` 就是已经加载并在工作。

要调整限额，编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: agent-rate-limit
      name: '@zhourenke/dsh-agent-rate-limit'
      config:
        tpmLimit: 1200000
        rpmLimit: 15000
        verbose: true
```

改完同样需要重启 DSH。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|:---:|---|
| `windowMs` | number | `60000` | 滑动窗口大小（毫秒）。默认 60 秒，与供应商的 TPM/RPM 统计周期一致，一般不用改 |
| `tpmLimit` | number | `1200000` | 每分钟令牌上限。默认匹配阿里云百炼 deepseek-v4-flash |
| `rpmLimit` | number | `15000` | 每分钟请求数上限 |
| `safetyFactor` | number | `0.8` | 安全系数。**实际生效上限 = `tpmLimit × safetyFactor`**，默认只用 80% 配额，留 20% 缓冲 |
| `verbose` | boolean | `false` | 输出每次请求的延迟与令牌记录日志，排查问题时打开 |

## 查看状态

`/agent-rate-limit` 会打印当前配置与窗口占用：

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

`Window entries` 是当前 60 秒窗口内的请求数，`Current TPM` 是窗口内累计令牌数。两者都远低于限额时，插件不会产生任何延迟。

## 它会怎么干预你的请求

- **只延迟，不拒绝**：插件永远不会让请求失败，也不会返回错误，只在必要时等待
- **有余量就放行**：窗口内累计令牌加上本次预估输入仍低于生效上限时，延迟为 `0`
- **接近上限才排队**：等待到足够的旧记录滑出窗口、腾出空间为止
- **并发时自动延长**：多个 Agent 同时请求时，你的等待期间其他 Agent 仍在消耗配额，插件按超限比例放大延迟
- **失败的请求不占额度**：以 `error` / `aborted` 结束的流不计入窗口，重试不会被自己拖慢
- **延迟发生在下发之前**：等待加在流开始之前，不会打断已经开始输出的响应

## 已知限制（实测确认）

- **按进程独立计数**：窗口状态存在 DSH 进程内，多个 DSH 实例互不共享——同时跑多个 profile 时，每个实例都按完整配额独立计算，合计仍可能超限。
- **配置对 provider 是全局的**：一份配置作用于该插件实例下的所有 provider，无法给不同 provider 设不同限额。
- **首次请求只能估算**：窗口为空时没有历史数据，输入令牌数按启发式估算；之后改用最近 3 次 API 实际值的平均。
- **单次超大请求无法拆分**：如果一次请求本身就接近配额，插件只能等它滑出窗口，不能把它切开。
- **不保证不撞限速**：插件的目标是大幅降低概率，而不是数学保证。配额被其它程序同时消耗时仍可能触发 429——那部分由 DSH 内置的重试机制接管。

## 给 Agent 的要点

- 本插件**没有工具、没有模型可见的接口**，对模型完全透明，无需也无法主动调用
- 速率限制是自动生效的：撞到限额时表现为**响应变慢**，而不是报错
- 判断是否生效：请用户输入 `/agent-rate-limit`，出现 `Status: loaded` 即为已加载
- 配置文件是 `~/.dsh/profiles/web/cordis.patch.yml`，任何改动都要**重启 DSH** 才生效

## 兼容性

在 **DSH v0.1.5-rc.1**（2026-09）下测试通过。

## 许可证

MIT
