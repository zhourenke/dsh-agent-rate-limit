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

## 开发挂载：让 DSH 加载你改的代码

用目录连接点把插件挂进 profile 的 `node_modules`，改完 `pnpm run build` 再重启即可，不必每次重新安装：

```powershell
[System.IO.Directory]::CreateDirectory("$prof\node_modules\@zhourenke") | Out-Null
New-Item -ItemType Junction -Path "$prof\node_modules\@zhourenke\dsh-agent-rate-limit" -Target $PWD
```

**连接点会绕过 profile 里已提升的依赖**：Node 按 realpath 解析后沿工作区路径向上找 `node_modules`，所以插件目录里必须自己 `pnpm install` 一份，否则启动时报 `Cannot find package '@deepseek-ai/schemastery'`。

**改配置不需要重启，改代码才需要。** profile 的补丁层是热重载的（`patchReload: live`，由 Cordis HMR 监视，见 `PLUGIN_RELEASE_GUIDE.md` §5）：编辑 `~/.dsh/profiles/web/cordis.patch.yml` 里的 `config:` 保存即生效，调参时不必反复重启。但 `lib/` 的变更**必须重启**才会重新加载——热重载重组的只是补丁层，bundle 与模块在进程启动时就已确定。

注意连接点挂载的插件**无法用 `dsh plugin remove` 卸载**（它不在 profile 的 `dependencies` 里），需要手工删连接点再摘掉 `dsh.profile.bundles` 条目。

## 实现要点（为什么这样做）

### 1. 令牌记账取 API 的 `usage`，不取估算值

每次成功调用后从 `usage` 数据块读取 `inputTokens` / `outputTokens`，并把 `cacheReadTokens` 与 `cacheWriteTokens` **一起计入**总额——`inputTokens` 只含未命中缓存的输入，只算它会让记账远低于账单。

### 2. 失败与中止的流不计入窗口

`llm/stream` 的失败是通过 **`finish` 数据块的 `reason.kind`** 表达的（`'error'` / `'aborted'`），**不是抛异常**。漏掉这个判断，`for await` 会正常结束，代码会把一次失败的请求当成成功记进窗口，重试于是被自己拖慢。这是本项目最容易写错的一处。

### 3. 延迟算法：从最新条目反向找切分点

`calculateDelay` 先查 RPM（`currentRpm >= rpmLimit` 时等到最旧条目过期），再查 TPM：

- `target = tpmLimit × safetyFactor - estimatedInputTokens`
- 窗口累计 `> target` 时，**从最新条目往前**累加，找到累计值 `>= target` 的那一条 `i`
- 等 `i` 过期即可：它滑出后，剩下 `i+1..end` 的累计必然 `< target`
- `baseDelay = expireAt - now + 100`（+100ms 是防边界抖动的余量）

并发时其他 Agent 仍在消耗配额，窗口排水比 `baseDelay` 假设的慢，因此**乘以超限比例** `max(1, currentTpm / effectiveTpmLimit)`。

### 4. 输入估算：取最近 3 次实际值的平均

窗口为空时没有历史，只能按启发式估算（CJK 约 1.5 字符/令牌）。之后用最近 3 次 API 实际输入令牌数的滑动平均，比启发式准确得多。只保留 3 个样本是为了对负载变化保持响应。

### 5. 命令注册必须把 disposer 交还给 `ctx.effect`

```ts
ctx.effect?.(() => ctx.commands.register({ name, description, handler }))
```

`register()` 返回的正是注销该定义的那个函数，而 `ctx.effect(cb)` 的清理函数就是 `cb` 的返回值。写成 `() => { ctx.commands.register(...) }` 会把返回值丢掉，注册于是不随插件卸载回收；web profile 用 `patchReload: live`，下次激活就会撞上宿主的 `command "agent-rate-limit" is already registered in this scope`。

### 6. 本地结构接口要逐字照抄宿主的字面量类型

`CommandResult` 在 `@deepseek-ai/dsh-commands` 里是 `{ kind: 'success'; text?: string } | { kind: 'error'; text: string }`，本地声明**不能**图省事写成 `kind: string`——那样拼错 `kind` 能通过 `tsc`，却会在宿主注册边界抛 `handler must return a CommandResult`，直到用户第一次敲命令才暴露。

## 测试要点

- 直接 `import '../lib/index.js'`，断言模块契约（`name` / `inject` / `apply` / `Config`）
- 用模拟 ctx 调一次 `apply`：这是唯一能覆盖事件监听与命令注册路径的办法
- 覆盖 `finish` 的 `error` / `aborted` 两条分支，确认它们不记账
- 覆盖超限路径，确认真的走到了 `ctx.timer.timeout(`
- 模块级状态由 `apply` 内的 `initRateLimiter()` 重置，因此多次 `apply` 之间天然隔离

## 发布纪律

- **`lib/` 必须提交，且与 `src/` 同一次提交。** `dsh plugin add github:...` 只接收 git 跟踪的文件，本仓库不在安装时构建，所以产物不同步会让 GitHub 安装静默运行旧代码。
- **不要添加 `prepare` 脚本。** git 托管的包会在安装时执行它，而 pnpm 默认拦截依赖的构建脚本，这会让 `dsh plugin add` 直接失败，直到用户手动在 profile 的 `pnpm-workspace.yaml` 中放行。
- **`files` 只列不会被自动包含的产物。** 当前为 `lib/index.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`。`package.json` / `README*` / `LICEN[CS]E*` 以及 `main` 指向的文件无论如何都会装上，列了是空操作；而 `types` 与 `exports` 的目标**不在**自动包含集里，`.d.ts` 一旦漏出 `files` 就会被静默丢弃——插件照常加载，只是不带类型。
- 新增产物（第二入口、运行时读取的数据文件）时，必须同步放宽 `files`，并用 `pnpm pack --dry-run` 核对真实载荷。

## 运行时依赖（与 DSH 版本匹配）

宿主提供的包走 `peerDependencies` 并全部标 `optional: true`（阻止 pnpm 引入第二份副本）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.2` | 插件框架（走自己的版本线） |
| `@deepseek-ai/dsh-llm` | `^0.1.5-rc.1` | `llm/stream` 接口 |
| `@deepseek-ai/dsh-llm-retry` | `^0.1.5-rc.1` | 重试（本插件不再自行实现） |
| `@deepseek-ai/schemastery` | `^3.18.1` | 配置校验，**唯一真实的 `dependencies`** |

`devDependencies` 中的三个宿主包**钉死到精确版本**（`4.0.2` / `0.1.5-rc.1` / `0.1.5-rc.1`）：连接点安装时插件解析到的是自己 `node_modules` 里的副本，写范围就会对着与线上不同的宿主做类型检查与测试。

DSH 升级后按 `PLUGIN_RELEASE_GUIDE.md` §8 重新核对事件名、宿主符号与 peer 范围。

## 许可证

MIT
