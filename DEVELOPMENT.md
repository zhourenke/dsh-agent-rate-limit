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

**RPM 分支不带这个倍数，是有意的，不是漏写**：它只在计数已经触到上限时才生效，超限比例按构造就是 ~1（一次并发涌入能把计数推过上限一点点，推不过一整个上限）。TPM 分支正相反——一条长 prompt 就能越过整个窗口，那才是倍数要修正的情形；给 RPM 的等待也乘一遍，只会把一个"最旧条目过期即可解决"的等待拉长。

**两处"窗口非空"守卫都是多余条件，已删。** RPM 分支原来写作 `currentRpm >= rpmLimit && windowEntries.length > 0`，但 `rpmLimit` 在状态初始化之前就过了护栏（必须为正），而 `currentRpm` 就是 `windowEntries.length`——**触到上限必然意味着窗口里至少有一条**，后半个条件永远为真（它若为假，说明护栏被绕过了，那是另一个 bug）。TPM 分支同样不需要：空窗口时 `currentTpm` 为 0，反向累加的循环根本不执行，函数自然落到"不延迟"——这也正是想要的语义，**等待排不干一个本来就空的窗口**。判据一致：条件要么由上游不变量保证，要么由循环自身的空集合语义覆盖，不要在第二处重复表达同一件事。

### 4. 输入估算：取最近 3 次实际值的平均

窗口为空时没有历史，只能估算——而**估算这件事宿主已经实现过**，所以本轮把本地那份密度整个删掉，改成注入 `tokenMeter` 服务、逐条消息调用 `ctx.tokenMeter.estimateMessage(message)`。它就是宿主自己的估算器（渲染上下文占用的同一个函数：`text` / `reasoning` 按固定 4 字符/令牌外加每块开销，`tool-call` 按 `name + arguments`，其余块按引用结构的 JSON 长度），于是本插件报出的数字与 DSH 其它界面报出的数字同源，不再有第二套密度需要跟着宿主的词表维护。

代价要写清楚：宿主的密度对中文偏低（按 4 字符/令牌，实际更接近 1.5 字符/令牌），而低估是限速器最危险的方向。影响面仅限**冷启动的那一次估算**——窗口一旦收到真实 `usage`，支配延迟的就是最近 3 次实际输入的平均，估算值不再参与；而冷启动此刻窗口要么是空的（延迟本就为 0），要么只有旁路调用的账目，误差落在几千令牌量级。为这点误差重新引入一套本地密度，等于把宿主的词表抄一遍，得不偿失。

两处**故意不计**：`system` 字段（只有手工构造的一次性调用方会用，而宿主的估算器只接受消息，插件不替它发明密度）与工具 schema（`options.tools`，估算器按一个本监听器看不到的规范信封头计价）。两者相对提示词总量都很小，第一次真实 `usage` 之后即被覆盖。循环构造的请求把系统提示词作为 `messages` 的首条 system 消息，那条消息照常计价。

估算调用整体包在 `try/catch` 里：宿主的估算器对宿主形状的请求是全函数，但**限速器绝不能把自己的记账变成请求失败**，真抛出来时降级为"规模未知"并打印 `[agent-rate-limit] Input estimate failed […]`，请求继续走 RPM 分支。这是本轮唯一新增的日志行，且只在异常路径出现。

之后用最近 3 次 API 实际输入令牌数的滑动平均，比任何估算都准确。只保留 3 个样本是为了对负载变化保持响应。**辅助调用是唯一的例外**：带 `purpose` 的旁路调用（上下文压缩、会话标题）照常计时并计入窗口，但不进入这个平均——压缩请求贴着上下文上限、标题请求极短，两者都不能代表下一次普通请求。样本的喂入与 `countFailedAttempts` 无关：失败的尝试同样会把刚暴露出的提示词大小喂进去，因为重试发的就是同一个提示词。

### 5. 命令注册必须把 disposer 交还给 `ctx.effect`

```ts
ctx.effect?.(() => ctx.commands.register({ name, description, handler }))
```

`register()` 返回的正是注销该定义的那个函数，而 `ctx.effect(cb)` 的清理函数就是 `cb` 的返回值。写成 `() => { ctx.commands.register(...) }` 会把返回值丢掉，注册于是不随插件卸载回收；web profile 用 `patchReload: live`，下次激活就会撞上宿主的 `command "agent-rate-limit" is already registered in this scope`。

### 6. 上下文用本地结构接口，事件载荷用宿主类型

`CommandResult` 在 `@deepseek-ai/dsh-commands` 里是 `{ kind: 'success'; text?: string } | { kind: 'error'; text: string }`，本地声明**不能**图省事写成 `kind: string`——那样拼错 `kind` 能通过 `tsc`，却会在宿主注册边界抛 `handler must return a CommandResult`，直到用户第一次敲命令才暴露。

`PluginContext` 保持本地形状：把 `ctx` 整体绑到宿主类型上，等于把插件绑到每一个会增强 `Context` 的宿主包。但 `on('llm/stream', …)` 的载荷改为宿主自己的类型（`GenerateOptions` / `StreamChunk`，用 `import type` 引入），事件名仍然是字面量。两处都收紧的理由是错误代价不对称：事件名打错是**静默失效**（不报错，只是插件再也不触发），载荷漂移则会让 `chunk.type === 'usage'` 这类判断悄悄走空——两者都该由 `tsc` 拦住，而不是靠升级后的人工复核。

`import type` 会被完全擦除，运行时不装载 `@deepseek-ai/dsh-llm`：测试里有一条断言盯着编译产物中不出现该包的 import，防止有人把它改成值导入。

**代价**：`ctx` 上的服务形状仍是本地写的。宿主若改了 `ctx.timeout`、`commands.register` 或 `tokenMeter.estimateMessage` 的签名，`tsc` 不会报错，因此升级后仍要连同签名人工核对（见「与 DSH 版本对齐」）。不过**注入这件事是框架强制的**：cordis 4.0.4 下，`inject` 里没写某个服务却去读它的属性会直接抛 `cannot get property "timer" without inject`（实测）；服务改名不会静默失效，失败点只是从编译期挪到了激活期——所以 `inject` 必须与实际读取的服务严格一致，多写一个也会让插件为一个无关的包白等。

### 7. 定时器的 Promise 与插件生命周期绑定

`ctx.timeout(ms)`——timer 服务混入 `Context` 的那一面——由宿主实现为一个 context effect，**绑定在调用它的那个插件 fiber 上**，因此**插件被卸载时，等待中的延迟会以 `Context has been disposed` 拒绝**，web profile 的补丁层热重载就会触发这条路径。实测 `ctx.timer.timeout(ms)` 与 `ctx.timeout(ms)` 两种写法行为一致（都随调用方 fiber 一起被拒绝）；宿主的类型只把更老的 `timer.setTimeout` / `timer.setInterval` 标为 `@deprecated use ctx.timeout() / ctx.interval() instead`，所以插件改用混入面，而 `inject` 里**仍必须保留 `timer`**（不声明就连 `ctx.timeout` 也读不到）。延迟点把 `await` 包在 `try/catch` 里，只留一行 verbose 日志就继续：替换上来的那个激活实例随即接手调速，而为一个正在被拆掉的等待让请求失败，代价明显更大。

这种"随插件一起消失"的语义正是本插件需要的：延迟不应比安排它的插件活得更久。

### 8. 数值配置要过一遍护栏：`z.number()` 挡不住 `NaN`

`schemastery` 的 `z.number()` 只检查类型，**`NaN` 与任意有限值都能通过**，范围约束也补不上这个洞——实测（3.18.4）：`z.number().min(1)` 拒绝 `0` 与 `-5`（`expected number >= 1 but got 0`），却**放行 `NaN`**。所以护栏只能写在消费这些数值的地方。

它值得单列，是因为三种非法值都**静默失败、且方向各不相同**：`NaN` 让窗口比较全部为假，于是插件照常加载、命令照常回 `Status: loaded`，却再也不产生任何延迟；`windowMs: 0` 表示任何条目一进窗口就被剪掉，窗口永远为空；`safetyFactor: 0` 把生效上限压成 0，于是每个请求都要等满一个窗口。前两种是"限速器悄悄不工作"，正是这个插件最不该出现的失败形态。

`apply` 因此在解析完配置、注册任何监听之前先做 `Number.isFinite(value) && value > 0`，不满足就抛错（错误里带字段名）。**这与宿主的既有行为一致**：cordis 的 `resolveConfig` 会用插件导出的 `Config` 校验配置，类型不对时直接抛 `ValidationError`，所以"数值非法"和"类型不对"是同一种响度。抛在注册之前还有一个好处——不会留下半注册的插件。

## 测试要点

- 直接 `import '../lib/index.js'`，断言模块契约（`name` / `inject` / `apply` / `Config`）
- 用模拟 ctx 调一次 `apply`：这是唯一能覆盖事件监听与命令注册路径的办法
- 覆盖 `finish` 的 `error` / `aborted` 两条分支：**默认计入窗口**，且**必须出现在日志里**；`countFailedAttempts: false` 时只记日志不占窗口
- 覆盖「失败后重试再成功」：两次尝试都要出现在账上——这是曾经漏掉失败尝试时留下的盲区
- 覆盖没有 usage 的失败（如请求还没产出 usage 就被拒），确认提示 `No usage reported` 而不是静默
- 用 `captureLogs()` 抓 `console.log` 断言日志形态：成功行**逐字**等于原格式 `Recorded N tokens (uncached: …, cached: …, output: …)` 且无尾标记，失败行在其后追加 `[<原因>]`，无 usage 的失败整行等于 `No usage reported [<原因>]`
- 覆盖 `totalTokens` 与分项不一致时打印 `Recorded total mismatch (computed: …, reported: …)`，且窗口仍取分项之和
- 覆盖超限路径，确认真的走到了 `ctx.timeout(`
- 覆盖 **RPM 分支**（原先没有任何用例走到它，只有 TPM 分支被测过）：把 `rpmLimit` 压到 `1` 并配合超大的 `tpmLimit`，让延迟只可能来自计数上限；断言等待不超过一个窗口，这就是"该分支不乘超限比例"的可执行形式
- 用**只差一个字段**的对照用例覆盖 `purpose`：同样的账目与限额下，带 `purpose` 的样本不进估算，不带的那次会进——这是唯一能把"辅助调用不参与平均"钉死的写法
- 覆盖冷启动估算：provider 从不上报 usage 时，窗口按估算值记账，且下一次请求是否等待由该估算决定（同时证明估算值是每次请求现算、不缓存）
- 覆盖估算的**委托对象**：假 ctx 里的 `tokenMeter.estimateMessage` 记录被问到过哪些消息，断言多消息请求里每一条都被宿主估算器计价、而 `system` 字段不被计价（这条测试是"估算由宿主实现"这句话的凭据，而不是对某个密度的断言）
- 覆盖估算器抛错：宿主的估算器真抛出来时，请求照常完成，并打印 `Input estimate failed`
- 覆盖定时器被卸载拒绝：`ctx.timeout` 拒绝后，chunk 仍全部到达调用方，并打印 `Delay abandoned`
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
| `@deepseek-ai/dsh-llm` | `^0.2.0-rc.2` | `llm/stream` 的载荷类型。源码只有 `import type`，编译产物不装载它 |
| `@deepseek-ai/schemastery` | `~3.18.4` | 配置校验，**唯一真实的 `dependencies`** |

schemastery 写 `~` 而不是 `^`，是为了与宿主声明的范围一致：宿主自己也钉在 `~3.18.4`，范围一旦放宽到下一个 minor，pnpm 就可能装出第二份 `schemastery`，让 `Config` 的类型在宿主侧变成两个实体（TS2883）。

**服务型能力不写进依赖。** `timer` / `commands` / `tokenMeter` 都是宿主已装载的服务：插件只用 `inject` 声明、用本地结构接口读取，`package.json` 里不出现这些包名。`tokenMeter` 尤其值得记一笔——`@deepseek-ai/dsh-token-meter` 的 `estimate` 子路径是不依赖任何服务的纯函数，完全可以直接 import，但那样会把该包连同它的依赖（`zod`、`dsh-util-values` 等）拖进**每一次插件安装**，而走服务则一个字节都不增加，还自动跟着宿主升级。判断标准：能用宿主已装载的服务就别 import 包，只有服务面确实拿不到所需数据时才考虑直接依赖。

`devDependencies` 中的两个宿主包**钉死到精确版本**（`4.0.4` / `0.2.0-rc.2`）：连接点安装时插件解析到的是自己 `node_modules` 里的副本，写范围就会对着与线上不同的宿主做类型检查与测试。

**这两条 peer 会参与宿主启动时的准入判定。** 宿主只统计名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer（因此 cordis 不参与），按 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定；不匹配的插件默认不装载，除非在 profile 的豁免表里点名放行。`includePrerelease: true` 意味着 `^0.2.0-rc.2` 既匹配当前宿主，也放行同一 minor 线内后续的预发布版（rc.3、正式 0.2.0……），但**不跨 minor**：本插件只跟随一条宿主版本线，0.1.x 那一代已经不在服务范围内。本轮把清单直接喂给宿主自己的判定函数验证过——对 0.2.0-rc.2 判为放行，对 0.1.7-rc.2 判为拒绝并给出 `{"@deepseek-ai/dsh-llm":"^0.2.0-rc.2"}`，正是想要的结果。

**没有 `@deepseek-ai/dsh-llm-retry` 的声明。** 重试由宿主的那个插件负责，本插件既不监听 `agent/request-error` 也不 import 它——声明一个代码从不接触的 peer 只会让声明与实现不一致。

DSH 升级后按 `PLUGIN_RELEASE_GUIDE.md`「DSH 升级后的复核」重新核对事件名、宿主符号与 peer 范围。

## 与 DSH 版本对齐（0.2.0-rc.2）

本轮按 `PLUGIN_RELEASE_GUIDE.md`「DSH 升级后的复核」逐项核对，结论与本插件的处置：

| 复核项 | 0.2.0-rc.2 的状态 | 本轮处置 |
|---|---|---|
| `llm/stream` 拦截点 | 仍是唯一的 waterfall：终端的 `return this.ctx.waterfall(this, "llm/stream", …)` 落到 `async *adapterStream()`，仍然惰性 | 不变——延迟确实发生在 provider 请求之前 |
| 官方监听者 | `dsh-llm` / `dsh-agent-loop` 的 invariant、`dsh-session-title`、`dsh-session-checkpoint-policy` 也注册在该事件上，全部同步注册、惰性取流、只读 | 插件仍只读 `options`（循环构造的请求是深冻结的） |
| 事件载荷 | `GenerateOptions` / `StreamChunk` / `TokenUsage` 形状未变；`FinishReason` 仍是可合并扩展的对象联合，按 `reason.kind` 读 | 不变（插件读的本来就是 `reason.kind`） |
| `TokenUsage` | 仍是**互不重叠**的计数，`reasoningTokens` 是输出子集 | 明确不并入总和，否则重复计数 |
| `purpose` | 旁路标记仍在（`'compaction' \| 'session-title'`），是官方给旁路调用留的信号 | 计时记账照旧，但不进估算样本 |
| 令牌估算 | 新增官方 `dsh-token-meter`：`estimateMessage()` 计量单条消息，并以 `tokenMeter` 服务注入；它在 `dsh-base` 的依赖里，profile 必装 | **删掉本地 CJK 密度**，改注入 `tokenMeter` 逐条计价 |
| `timer` 服务 | `cordis-plugin-timer` 仍把 `timeout` / `interval` 混入 `Context`；`setTimeout` / `setInterval` 已标废弃 | 改调 `ctx.timeout()`，`inject` 保留 `timer` |
| 注入语义 | cordis **强制**校验 `inject`：未声明就读服务的属性会抛 `cannot get property "…" without inject` | `inject` 增加 `tokenMeter` |
| 定时器生命周期 | 混入面与 `timer.timeout` 都绑定调用方 fiber，卸载时以 `Context has been disposed` 拒绝 | 延迟点容错不变 |
| 宿主准入判定 | 判定函数与语义未变（只统计 `dsh` / `dsh-*` 的 peer，`includePrerelease: true`） | peer 对齐到 `^0.2.0-rc.2`；实测同一份清单在 0.1.7-rc.2 下被判拒绝 |
| 显示元数据 | `readPluginMeta()` 仍读 `locale/en.json`、包 `exports` 与 `icon` | 不变 |
| 官方限速能力 | 仍然**没有** TPM/RPM 限速：对全部宿主包的 `lib/**.js` 扫 `TPM` / `RPM` / `per-minute` / `tpmLimit` 等关键字零命中；`dsh-llm-retry` 是事后重试，`dsh-token-meter` 量的是上下文占用 | 没有需要删掉的重复实现 |

判定方式值得单独记一笔：把本仓库的清单直接喂给宿主自己的 `evaluatePluginCompatibility()`，得到"无冲突"；再用宿主自己的 `readPluginMeta()` 读出两份字典与图标（图标被解析成内联 data URL）。**用宿主函数验证集成面，比人工比对文档可靠**——这是本仓库唯一能证明"宿主真的读到了"的办法。

本轮看过但**决定不采纳**的宿主能力，理由留档：`finish.reason.failure` 上的 `code` / `status` / `providerRetryAfterMs`（可把 provider 建议的退避时长种进冷却窗口，但要改行为或日志格式）；`llm.imageRequestPricing(provider, model).priceImages(images)`（图片本可按路由真实视觉令牌计价，但图片在请求装配里会被投影成句柄或占位，复现那套投影是适配器的职责，而插件只做冷启动估算，用宿主估算器的结构计价已与上下文界面同源）；`isAgentLoopRequest()`（可作"是否为循环构造的请求"的第二判据，但 `purpose` 已经是官方给旁路的信号，多一个判据只会让冷启动估算多一条分支）。

## 许可证

MIT
