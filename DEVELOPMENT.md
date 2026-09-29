# 开发注意事项（Development Notes）

面向维护者。使用者请看 [README.md](README.md)——那里只回答"能不能用、怎么调、哪里会踩坑"，实现内部细节一律放在本文档。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 全部实现，单文件 |
| `lib/index.js` | 编译产物，**必须提交**（路线 A） |
| `lib/types/index.d.ts` | 类型声明，**必须提交** |
| `test/index.test.mjs` | 对编译产物的执行测试 |
| `cordis.patch.yml` | profile 层插入声明 |
| `icon.svg` | 插件图标，`package.json` 的 `icon` 指向它；由宿主直接读取，不经过代码 |
| `locale/en.json`、`locale/zh.json` | 插件列表里的显示名与说明（`meta.title` / `meta.description`） |
| `pnpm-workspace.yaml` | 放行预发布宿主包的最小发布年龄豁免表 |

## 本地开发与构建

```powershell
pnpm install        # 安装开发依赖
pnpm run typecheck  # 类型检查
pnpm run build      # 编译到 lib/
pnpm test           # 先构建，再执行 lib/ 产物
```

**每次修改 `src/index.ts` 后必须运行 `pnpm run build`，并把 `lib/` 一并提交。**

`pnpm test` 不是可选项。`tsc` 只做类型检查与转译，漂移检查只看 git 状态——**没有任何一步执行过产物**。于是「模块在 import 时抛错」（导入了宿主已删除的符号、在顶层解构了 `undefined`）可以一路绿灯，直到用户重启 DSH 才在启动日志里爆出来。测试直接 `import` 编译产物，用模拟 ctx 走一遍加载、事件注册、流包装与窗口记账。

`test` 脚本写作 `"pnpm run build && node --test"`，两点都不能省：`node --test` 不带参数才会递归发现全部测试文件（`node --test test` 与 `node --test test/` 在 Node 25 下都报 `MODULE_NOT_FOUND`）；串上构建则保证执行的永远是源码当前编译出的产物，而不是上一次的残留。

`tsconfig.json` 开启了 `noUnusedLocals` 与 `noUnusedParameters`：它们是"移除冗余逻辑"唯一能自动化的判据，未使用的局部变量与参数会在 `typecheck` 阶段直接报 TS6133。开启前用 `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` 探测过，零告警。有意不用的参数改成 `_` 前缀即可豁免这条规则。

## 开发挂载：让 DSH 加载你改的代码

用目录连接点把插件挂进 profile 的 `node_modules`，改完 `pnpm run build` 再重启即可，不必每次重新安装：

```powershell
[System.IO.Directory]::CreateDirectory("$prof\node_modules\@zhourenke") | Out-Null
New-Item -ItemType Junction -Path "$prof\node_modules\@zhourenke\dsh-agent-rate-limit" -Target $PWD
```

**连接点会绕过 profile 里已提升的依赖**：Node 按 realpath 解析后沿工作区路径向上找 `node_modules`，所以插件目录里必须自己 `pnpm install` 一份，否则启动时报 `Cannot find package '@deepseek-ai/schemastery'`。

**改配置不需要重启，改代码才需要。** profile 的补丁层是热重载的（`patchReload: live`，由 Cordis HMR 监视，见 `PLUGIN_RELEASE_GUIDE.md`「发布与生效」）：编辑 `~/.dsh/profiles/web/cordis.patch.yml` 里的 `config:` 保存即生效，调参时不必反复重启。但 `lib/` 的变更**必须重启**才会重新加载——热重载重组的只是补丁层，bundle 与模块在进程启动时就已确定。

注意连接点挂载的插件**无法用 `dsh plugin remove` 卸载**（它不在 profile 的 `dependencies` 里），需要手工删连接点再摘掉 `dsh.profile.bundles` 条目。

## 配置面：包内 patch 与 profile patch

两份文件同名、同 schema，也可能写着同一对 `id`/`name`，**区别不在文件而在条目用了哪个动作**：

- **包内 `cordis.patch.yml`** 用 `- insert:`，把插件行插进 profile 层——这是插件被识别为 profile 层条目的唯一开关。
- **`<profile>/cordis.patch.yml`** 是用户的补丁层，用 `- id:` 直挂**同 id 覆盖**已有条目的 `config:`。**不要在这里写 `- insert:`**：`insert` 是"无条件追加一行"的动作，写在这里不会报错，而是追加**第二个同 id 实例**，速率限制随之算两遍。

`id` 应与插件导出的 `name` 一致（本仓库为 `agent-rate-limit`），便于诊断。README 只展示可直接照抄的配置片段，上面这段机制说明留在本文档。

判据与实测：`PLUGIN_RELEASE_GUIDE.md`「发布与生效」、分册 `guide/installation-and-profile.md`。

## 实现要点（为什么这样做）

### 1. 令牌记账取 API 的 `usage`，不取估算值

每次成功调用后从 `usage` 数据块读取 `inputTokens` / `outputTokens`，并把 `cacheReadTokens` 与 `cacheWriteTokens` **一起计入**总额——`inputTokens` 只含未命中缓存的输入，只算它会让记账远低于账单。

### 2. 失败与中止的尝试：默认计入窗口，且**日志不能吞**

`llm/stream` 的失败是通过 **`finish` 数据块的 `reason.kind`** 表达的（`'error'` / `'aborted'`），**不是抛异常**。漏掉这个判断，`for await` 会正常结束，代码会把一次失败的请求当成成功记进窗口。这是本项目最容易写错的一处。

更早一版还错在另一半：失败尝试**连同日志一起被丢弃**。结果是插件日志永远无法与 DSH 的轮次统计对账——宿主（`dsh-token-meter`）把 `assistant/attempt` 也算作独立计费的一次，**每一次尝试都计费**；而**失败的那一次通常正是冷缓存的那一次**，整个 prompt 未缓存地送到上游，重试时缓存已热、显示的 `uncached` 为 0。于是"未缓存输入消失了"这个现象，根因就在这行被吞掉的日志里。

现在：`countFailedAttempts` 默认 `true`（上游确实处理并计费了那次 prompt，不计会低估窗口压力），可关；**无论开关如何都打印日志**，失败行在原格式后追加 `[<原因>]` 标记。没有 usage 的失败（请求在产出 usage 前就被拒，例如 429）打印 `No usage reported [<原因>]`。

### 2.1 日志格式：保持原有的三段式

成功记录行沿用原格式，**没有**前缀或额外字段：

```
[agent-rate-limit] Recorded 21459 tokens (uncached: 0, cached: 18944, output: 2515)
```

失败尝试不改这段结构，只在末尾追加一个方括号标记，里面就是失败原因：

```
[agent-rate-limit] Recorded 399195 tokens (uncached: 187803, cached: 209280, output: 2112) [error]
[agent-rate-limit] Recorded 203542 tokens (uncached: 0, cached: 203264, output: 278) [aborted]
```

没有用量可记的失败，同样是一句话加同一个标记：

```
[agent-rate-limit] No usage reported [error]
```

- **三段式的含义**：`uncached` 是未命中缓存的输入，`cached` 是命中部分（`cacheRead + cacheWrite`），`output` 是产出；三者之和就是计费总额 `totalTokens`
- **标记是追加的**，所以按老格式解析日志的读者不受影响；方括号里的原因取自 `finish` 数据块，取值 `error` / `aborted`
- **标记不写是否计入窗口**。是否需要那条信息看 `/agent-rate-limit` 的 `Count failed:` 一行——那是配置，不是每次请求的属性，放在每行日志里只会重复
- **usage 自检**：`totalTokens` 与分项之和不一致时打印 `Recorded total mismatch (computed: …, reported: …, uncached: …, cached: …, output: …)`——`computed` 是插件按三段式算出的和，`reported` 是上游给的 `totalTokens`。上游/中转站改口径时第一时间可见，窗口仍取 `computed`
- **宿主统计的对账口径**：宿主把 `assistant/attempt` 也当作独立计费的一次，即**每次尝试都计费**；失败那次通常正是**冷缓存**那次，重试时缓存已热，于是日志里看到 `uncached: 0` 是**真实**的全命中，不是丢数。两者对不上账时先确认失败尝试是否在日志里（现在一定在），再查上游是否改了 usage 字段

**关于尝试标识**：`GenerateOptions` 里**没有** turn/step/attemptId，只有 `sessionId`（轮次号在 agent-loop 的 session 事件里，`llm/stream` 载荷不携带）。因此日志**不输出**轮次或序号——需要逐条对应时按时间顺序与宿主记录比对，或自行在会话记录里对齐。

失败尝试即使不计入窗口，也会**回灌输入估算**（`recentInputTokens`）：重试发的是同一个 prompt，失败那次揭示的真实规模正是下一次估算需要的。

### 3. 延迟算法：从最新条目反向找切分点

`calculateDelay` 先查 RPM（`currentRpm >= rpmLimit` 时等到最旧条目过期），再查 TPM：

- `target = tpmLimit × safetyFactor - estimatedInputTokens`
- 窗口累计 `> target` 时，**从最新条目往前**累加，找到累计值 `>= target` 的那一条 `i`
- 等 `i` 过期即可：它滑出后，剩下 `i+1..end` 的累计必然 `< target`
- `baseDelay = expireAt - now + 100`（+100ms 是防边界抖动的余量）

并发时其他 Agent 仍在消耗配额，窗口排水比 `baseDelay` 假设的慢，因此**乘以超限比例** `max(1, currentTpm / effectiveTpmLimit)`。

### 4. 输入估算：取最近 3 次实际值的平均

窗口为空时没有历史，只能按启发式估算。密度按字符类型分档（CJK 约 1.5 字符/令牌，其余约 3.5 字符/令牌），内容块按 0.1.7 的词表逐类计价：`text` / `reasoning` 按文本，`tool-call` 按 `name + arguments`，其余块（`image` / `file` 等）按引用结构的 JSON 长度计价。最后这一类不是随手兜底：图片与文件从不上传字节，请求装配会把它们投影成句柄或占位文本，所以结构长度是本地能拿到的、最接近"实际送出内容"的代理。系统提示词在循环构造的请求里是 `messages` 的首条 system 消息，因此遍历消息即可覆盖；`system` 字段另算一遍以覆盖一次性调用方。工具 schema（`options.tools`）不计入。

之后用最近 3 次 API 实际输入令牌数的滑动平均，比启发式准确得多；只保留 3 个样本是为了对负载变化保持响应。**辅助调用是唯一的例外**：带 `purpose` 的旁路调用（上下文压缩、会话标题）照常计时并计入窗口，但不进入这个平均——压缩请求贴着上下文上限、标题请求极短，两者都不能代表下一次普通请求。样本的喂入与 `countFailedAttempts` 无关：失败的尝试同样会把刚暴露出的提示词大小喂进去，因为重试发的就是同一个提示词。

**故意不用 `ctx.tokenMeter.estimateMessage`。** 宿主的估算器按固定 4 字符/令牌计价，中文会被低估约 2.6 倍，而"低估"是限速器最危险的方向——窗口会放进比 provider 允许的更多请求。此外它的主题是上下文压力（渲染上下文占用），不是 provider 配额，用途本就不同。

### 5. 命令注册必须把 disposer 交还给 `ctx.effect`

```ts
ctx.effect?.(() => ctx.commands.register({ name, description, handler }))
```

`register()` 返回的正是注销该定义的那个函数，而 `ctx.effect(cb)` 的清理函数就是 `cb` 的返回值。写成 `() => { ctx.commands.register(...) }` 会把返回值丢掉，注册于是不随插件卸载回收；web profile 用 `patchReload: live`，下次激活就会撞上宿主的 `command "agent-rate-limit" is already registered in this scope`。

### 6. 上下文用本地结构接口，事件载荷用宿主类型

`CommandResult` 在 `@deepseek-ai/dsh-commands` 里是 `{ kind: 'success'; text?: string } | { kind: 'error'; text: string }`，本地声明**不能**图省事写成 `kind: string`——那样拼错 `kind` 能通过 `tsc`，却会在宿主注册边界抛 `handler must return a CommandResult`，直到用户第一次敲命令才暴露。

`PluginContext` 保持本地形状：把 `ctx` 整体绑到宿主类型上，等于把插件绑到每一个会增强 `Context` 的宿主包。但 `on('llm/stream', …)` 的载荷改为宿主自己的类型（`GenerateOptions` / `StreamChunk`，用 `import type` 引入），事件名仍然是字面量。两处都收紧的理由是错误代价不对称：事件名打错是**静默失效**（不报错，只是插件再也不触发），载荷漂移则会让 `chunk.type === 'usage'` 这类判断悄悄走空——两者都该由 `tsc` 拦住，而不是靠升级后的人工复核。

`import type` 会被完全擦除，运行时不装载 `@deepseek-ai/dsh-llm`：测试里有一条断言盯着编译产物中不出现该包的 import，防止有人把它改成值导入。

**代价**：`ctx` 上的服务形状仍是本地写的。宿主若改了 `timer.timeout` 或 `commands.register` 的签名，`tsc` 不会报错，因此升级后仍要连同签名人工核对（见「与 DSH 版本对齐」）。

### 7. 定时器的 Promise 与插件生命周期绑定

`ctx.timer.timeout(ms)` 由宿主实现为一个 context effect，因此**插件被卸载时，等待中的 `timeout` 会以 `Context has been disposed` 拒绝**——web profile 的补丁层热重载就会触发这条路径。延迟点把 `await` 包在 `try/catch` 里，只留一行 verbose 日志就继续：替换上来的那个激活实例随即接手调速，而为一个正在被拆掉的等待让请求失败，代价明显更大。

这种"随插件一起消失"的语义正是本插件需要的：延迟不应比安排它的插件活得更久。

### 8. 数值配置要过一遍护栏：`z.number()` 挡不住 `NaN`

`schemastery` 的 `z.number()` 只检查类型，**`NaN` 与任意有限值都能通过**，范围约束也补不上这个洞——实测（3.18.4）：`z.number().min(1)` 拒绝 `0` 与 `-5`（`expected number >= 1 but got 0`），却**放行 `NaN`**。所以护栏只能写在消费这些数值的地方。

它值得单列，是因为三种非法值都**静默失败、且方向各不相同**：`NaN` 让窗口比较全部为假，于是插件照常加载、照常打日志，却再也不产生任何延迟；`windowMs: 0` 表示任何条目一进窗口就被剪掉，窗口永远为空；`safetyFactor: 0` 把生效上限压成 0，于是每个请求都要等满一个窗口。前两种是"限速器悄悄不工作"，正是这个插件最不该出现的失败形态。

`apply` 因此在解析完配置、注册任何监听之前先做 `Number.isFinite(value) && value > 0`，不满足就抛错（错误里带字段名）。**这与宿主的既有行为一致**：cordis 的 `resolveConfig` 会用插件导出的 `Config` 校验配置，类型不对时直接抛 `ValidationError`，所以"数值非法"和"类型不对"是同一种响度。抛在注册之前还有一个好处——不会留下半注册的插件。

## 测试要点

- 直接 `import '../lib/index.js'`，断言模块契约（`name` / `inject` / `apply` / `Config`）
- 用模拟 ctx 调一次 `apply`：这是唯一能覆盖事件监听与命令注册路径的办法
- 覆盖 `finish` 的 `error` / `aborted` 两条分支：**默认计入窗口**，且**必须出现在日志里**；`countFailedAttempts: false` 时只记日志不占窗口
- 覆盖「失败后重试再成功」：两次尝试都要出现在账上——这是曾经漏掉失败尝试时留下的盲区
- 覆盖没有 usage 的失败（如请求还没产出 usage 就被拒），确认提示 `No usage reported` 而不是静默
- 用 `captureLogs()` 抓 `console.log` 断言日志形态：成功行**逐字**等于原格式 `Recorded N tokens (uncached: …, cached: …, output: …)` 且无尾标记，失败行在其后追加 `[<原因>]`，无 usage 的失败整行等于 `No usage reported [<原因>]`
- 覆盖 `totalTokens` 与分项不一致时打印 `Recorded total mismatch (computed: …, reported: …)`，且窗口仍取分项之和
- 覆盖超限路径，确认真的走到了 `ctx.timer.timeout(`
- 用**只差一个字段**的对照用例覆盖 `purpose`：同样的账目与限额下，带 `purpose` 的样本不进估算，不带的那次会进——这是唯一能把"辅助调用不参与平均"钉死的写法
- 覆盖冷启动估算：provider 从不上报 usage 时，窗口按估算值记账，且下一次请求是否等待由该估算决定（同时证明估算值是每次请求现算、不缓存）
- 覆盖定时器被卸载拒绝：`ctx.timer.timeout` 拒绝后，chunk 仍全部到达调用方，并打印 `Delay abandoned`
- 覆盖清单契约：`icon` 字段、`exports['./locale/*.json']`、`files` 条目、字典的非空标题与说明，以及编译产物里不出现 `@deepseek-ai/dsh-llm` 的值导入
- 覆盖数值配置护栏：四个数值取 `0`、负数或 `NaN` 时必须抛错，且**抛错发生在注册之前**——监听器与命令都不留痕
- 模块级状态由 `apply` 内的 `initRateLimiter()` 重置，因此多次 `apply` 之间天然隔离

## 发布纪律

- **`lib/` 必须提交，且与 `src/` 同一次提交。** `dsh plugin add github:...` 只接收 git 跟踪的文件，本仓库不在安装时构建，所以产物不同步会让 GitHub 安装静默运行旧代码。
- **不要添加 `prepare` 脚本。** git 托管的包会在安装时执行它，而 pnpm 默认拦截依赖的构建脚本，这会让 `dsh plugin add` 直接失败，直到用户手动在 profile 的 `pnpm-workspace.yaml` 中放行。
- **`files` 只列不会被自动包含的产物。** 当前为 `lib/index.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`。`package.json` / `README*` / `LICEN[CS]E*` 以及 `main` 指向的文件无论如何都会装上，列了是空操作；而 `types` 与 `exports` 的目标**不在**自动包含集里，`.d.ts` 一旦漏出 `files` 就会被静默丢弃——插件照常加载，只是不带类型。图标与语言字典同理：漏了不影响加载，只是插件列表里没有名字、说明与图标；字典里的 `meta.title` / `meta.description` 为空或非字符串时，宿主读取元数据会直接抛错（只有图标失败是降级处理的）。
- 新增产物（第二入口、运行时读取的数据文件）时，必须同步放宽 `files`，并用 `pnpm pack --dry-run` 核对真实载荷。

## 运行时依赖（与 DSH 版本匹配）

宿主提供的包走 `peerDependencies` 并全部标 `optional: true`（阻止 pnpm 引入第二份副本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.4` | 插件框架（走自己的版本线） |
| `@deepseek-ai/dsh-llm` | `^0.1.7-rc.2` | `llm/stream` 的载荷类型。源码只有 `import type`，编译产物不装载它 |
| `@deepseek-ai/schemastery` | `~3.18.4` | 配置校验，**唯一真实的 `dependencies`** |

schemastery 写 `~` 而不是 `^`，是为了与宿主声明的范围一致：宿主自己也钉在 `~3.18.4`，范围一旦放宽到下一个 minor，pnpm 就可能装出第二份 `schemastery`，让 `Config` 的类型在宿主侧变成两个实体（TS2883）。

`devDependencies` 中的两个宿主包**钉死到精确版本**（`4.0.4` / `0.1.7-rc.2`）：连接点安装时插件解析到的是自己 `node_modules` 里的副本，写范围就会对着与线上不同的宿主做类型检查与测试。

**这两条 peer 会参与宿主启动时的准入判定。** 宿主只统计名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer（因此 cordis 不参与），按 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定；不匹配的插件默认不装载，除非在 profile 的豁免表里点名放行。`includePrerelease: true` 意味着 `^0.1.7-rc.2` 既匹配当前宿主，也放行后续的 0.1.x 预发布版——不必为每个 rc 改一次范围，但宿主跳到 0.2 时要跟进。

**没有 `@deepseek-ai/dsh-llm-retry` 的声明。** 重试由宿主的那个插件负责，本插件既不监听 `agent/request-error` 也不 import 它——声明一个代码从不接触的 peer 只会让声明与实现不一致。

DSH 升级后按 `PLUGIN_RELEASE_GUIDE.md`「DSH 升级后的复核」重新核对事件名、宿主符号与 peer 范围。

## 与 DSH 版本对齐（0.1.7-rc.2）

本轮按 `PLUGIN_RELEASE_GUIDE.md`「DSH 升级后的复核」逐项核对，结论与本插件的处置：

| 复核项 | 0.1.7-rc.2 的状态 | 本轮处置 |
|---|---|---|
| `llm/*` 拦截点 | `llm/stream` 仍是唯一的 waterfall，其余 `llm/*` 都是通知事件 | 不变 |
| 事件载荷 | `GenerateOptions` / `StreamChunk` / `TokenUsage` 形状未变 | 改用 `import type` 绑定宿主类型 |
| `TokenUsage` | 新增 `reasoningTokens`，是**输出子集** | 明确不并入总和，否则重复计数 |
| `FinishReason` | 仍是 `stop` / `tool-calls` / `max-tokens` / `error` / `aborted`，且可被合并扩展 | 未知种类按成功记账的兜底保留 |
| `purpose` | 新增字段，旁路调用（压缩、会话标题）会带上 | 计时记账照旧，但不进估算样本 |
| `timer` / `commands` 服务 | `dsh-base` 仍挂载 `cordis-plugin-timer` 与 `dsh-commands` | `inject` 不变 |
| `timer.timeout` 语义 | 实现为 context effect，插件卸载时拒绝 | 延迟点容错 |
| 宿主准入判定 | 新增启动期版本判定与 profile 豁免表 | peer 范围对齐到 `^0.1.7-rc.2` |
| 显示元数据 | 新增 `locale/*.json` 与 `icon`，不激活即可读 | 提供中英文与图标 |
| 官方限速能力 | **没有**官方 TPM/RPM 限速；`dsh-llm-retry` 是事后重试与退避 | 本次没有需要删掉的重复实现 |

判定方式值得单独记一笔：把本仓库的清单直接喂给宿主自己的 `evaluatePluginCompatibility()`，得到"无冲突"；再用宿主自己的 `readPluginMeta()` 读出两份字典与图标（图标被解析成内联 data URL）。**用宿主函数验证集成面，比人工比对文档可靠**——这是本仓库唯一能证明"宿主真的读到了"的办法。

尚未采纳、但已确认可用的两处宿主能力，留给后续决定：`finish.reason.failure` 上的 `code` / `status` / `providerRetryAfterMs`（可用来把 provider 建议的退避时长种进冷却窗口，但会改动日志格式或行为），以及 `ctx.tokenMeter`（不采纳的理由见实现要点 4）。

## 许可证

MIT
