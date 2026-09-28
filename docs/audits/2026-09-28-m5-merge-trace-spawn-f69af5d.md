# 合并五：trace 补全与主 agent 派 worker 并回 formal-v2（基线 f69af5d）

- 基线：formal-v2 的 f69af5d（标签 formal-run-v1 指向它；标签不动，正式跑只用标签那一版，本段合并不影响它）。
- 分支：formal-v2。只合并、解决冲突并核对三处交汇，不加功能、不重构；只提交，不推送。
- 依据：trace-classes 的审计 `docs/audits/2026-09-28-trace-classes-66d329c.md`、agent-spawn 的审计 `docs/audits/2026-09-28-agent-spawn-66d329c.md`、冻结前加固审计 `docs/audits/2026-09-28-freeze-guard-66d329c.md`；决策 264–269、271。

## 一、合并的两条分支与提交

两条分支都从 66d329c 开出；formal-v2 其后并入了冻结前加固、基线修复、分析脚本、集成冒烟与网关修复（66d329c 之后 33 个提交）。按顺序用普通合并提交并入，不变基、不压缩：

| 顺序 | 分支 | 分支头 | 分支上的提交 | 合并提交 |
|---|---|---|---|---|
| 1 | trace-classes | f0c1cda | 4 个（44e4bea、8681a13、c30ff24、f0c1cda） | f5b5601 |
| 2 | agent-spawn | 2d44147 | 5 个（651f332、62c0c82、fbd51e7、6a43a1f、2d44147） | c28f395 |

合并后另有一个提交 2c2e8b8，只改测试（第三、五节）。

## 二、冲突文件与解决方式

两次合并都没有冲突文件（git 的 ort 策略直接合成）。

- trace-classes 改的 9 个文件（`application/format.ts`、`cli/trace.ts` 与其测试、`state/session-judge.ts`、`state/session-view.ts`、`tui/approval.ts` 等）与 formal-v2 在 66d329c 之后改的文件没有重叠，逐文件直接取分支版本。
- agent-spawn 与 formal-v2 有 4 个文件两边都改过，git 自动合成，逐个核对两边意图都在：

| 文件 | formal-v2 一侧（保留） | agent-spawn 一侧（保留） | 核对 |
|---|---|---|---|
| `src/cli/index.ts` | `eval stream` 的参数：`--accept-harness-change`、`--allow-dirty-harness`、`--sample`、`--seed`、`--spend-limit-cny`、`--memory-limit`、`--review-max-turns`、`--review-wall-clock-min` 等，用法提示与解析 | 顶层路由 `routeTopLevel`（不带子命令进终端界面、`--line` 进命令行对话、`--help`）、`launchTui`、`lineMain`、`TOP_LEVEL_HELP`；`pigeon run` 的 `--no-spawn-workers`、`--worker-concurrency`、`--worker-limit` | 两侧改动分别在 `evalStreamMain` 与 `runMain`/`main` 两段，互不覆盖；合并后逐项 grep 都在 |
| `src/eval/stream-experiment.ts` | 代码版本只读一次（`currentHarnessRef` 一次，身份头与结果行同一个）、`harnessAllowance` 交给 `checkOrWriteIdentity`、`readStoredIdentity` 交给报告 | `effectivePigeonSettings` 记 `spawnWorkers: STREAM_SPAWN_WORKERS`；导入 `STREAM_SPAWN_WORKERS` | 两侧改的是相邻的导入块与不同函数，合成后类型检查通过 |
| `src/eval/stream-identity.ts` | `checkHarness`（续跑比对代码版本）、`HarnessAllowance`、`StoredStreamIdentity`、`readStoredIdentity`、首次开跑的 `allowDirtyHarness` | 身份头 `core.agents.pigeon.spawnWorkers?: boolean` 一项 | 续跑核对的字段集合不另列：`mergeCore` 对 `agents.pigeon` 按两边键的并集逐项比，新字段两次都记了且相同即放行，不同即点名 `agents.pigeon.spawnWorkers`；不因新增字段误拒同版本续跑（第三节第 2 项的用例钉住） |
| `src/eval/stream-identity.test.ts` | 代码版本的 5 个用例（提交号不同、未提交改动、显式放行、原因为空、首次开跑） | "身份头记主 agent 派 worker 的实际生效值（265）"1 个用例 | 两侧新增的用例位置不同，全部保留 |

合并后的头（c28f395）在服务器上 lint、类型检查通过后才开始下面的核对。

## 三、要核对的三处交汇

### 1. 实验里没有派 worker

- 做法：跑批器的 Pigeon 条件（`eval/stream-agents.ts` 的 `pigeonStepAgent`）调用 headless 时明确传 `spawnWorkers: STREAM_SPAWN_WORKERS`（常量 `false`）；headless 缺省也关；身份头与结果行的 `agents.pigeon.spawnWorkers` 由 `effectivePigeonSettings` 记同一常量。最简 agent 条件是宿主上的独立进程，不装 Pigeon 的任何工具。
- 测试：`src/application/spawn-worker-registration.test.ts` 原有的"pigeon run：缺省不注册、开了才注册；跑批器各条件……"一例扩成五个条件——断言 `CONDITION_SPECS` 恰有 5 个条件，其中非 Pigeon 的只有 `minimal`（agent 为 `minimal`），4 个 Pigeon 条件按各自的 `sessionSearch`、`pushedMemory` 与 `STREAM_SPAWN_WORKERS` 经 headless 装配出的工具清单都含 `read_file`、都不含 `spawn_worker`；`effectivePigeonSettings({}, "m").spawnWorkers` 为 `false`（原有断言）。

### 2. 续跑核对

- 做法：不改代码。身份头 `core.agents.pigeon` 合并后含 `spawnWorkers`，续跑时 `mergeCore` 按并集逐项比；core 一致后 `checkHarness` 比代码版本，不符即拒绝，`--accept-harness-change` 放行并追加 `infoLog`，报告的设置一节列出。
- 测试：`src/eval/stream-identity.test.ts` 新增"合并后的身份头：agents.pigeon 记派 worker 关（265）并与代码版本（269）一起核对……"一例。用 `effectivePigeonSettings({}, "m")`（跑批器实际写进身份头的 Pigeon 参数，含 `spawnWorkers: false`）作 `agents.pigeon`，起一个输出目录：① 开跑，身份头记 `spawnWorkers: false`；② 同一提交号续跑放行，摘要不变，不追加 `infoLog`；③ `spawnWorkers` 改为 `true` 续跑拒绝，报文点名 `agents.pigeon.spawnWorkers`；④ 换提交号（aaa1111 → bbb2222）续跑拒绝，报文列出记录的与当前的代码并提示 `--accept-harness-change`，身份头不动；⑤ 带原因放行，摘要不变，`infoLog` 追加一条（时刻、新代码、原因），`core` 里的 `spawnWorkers` 照旧；⑥ 把读出的身份头交给 `renderStreamReport`，设置一节写出开跑时的代码与这次放行（时刻、新提交号、原因）。

### 3. trace 对含 worker 的会话

- 做法：不改代码。`spawn_worker` 在注册表里是只读档、可并行，经同一个审批闸与同一个运行面标记（`pi-runtime/adapter.ts` 的 `#markToolResult`），trace 的审批行、出错归类行与分类行对它与对其他工具同一取法；角色写错时上游参数校验先拒绝，没到审批闸，即"未经审批闸（上游拦截）"、域错误、业务失败。
- 测试：`src/cli/trace-workers.test.ts` 新增"trace（真实运行）：主 agent 派 worker 的会话……"一例。真实 headless 运行（真实编排器、git 工作树、假模型，无人值守的 prompt 模式而不是 yolo，`spawnWorkers: true`）：主 agent 同一次回复派两个 `spawn_worker`，一个角色 `explorer`（worker 读一个文件后收尾），一个角色写错（`janitor`）。断言父会话的 trace：列出派出的 worker 1 个（completed）；两次 `spawn_worker` 调用名下依次为"审批：策略自动放行（policy:auto）｜分类：正常"与"审批：未经审批闸（上游拦截）｜出错归类：域错误｜分类：业务失败"；整份 trace 没有"分类：未知"与"分类：无（"。再按父会话 trace 给的进入命令取 worker 会话的 trace：回指父会话，它自己的 `read_file` 调用为"审批：策略自动放行（policy:auto）｜分类：正常"。
- 测试先行时发现的一点：yolo 模式下审批闸对只读档也记 `policy:yolo`（yolo 批发授权优先于 read 层的自动放行，`application/governance.ts` 既有规则），用例因此取 prompt 模式，让"只读档不经人批"以 `policy:auto` 呈现。

## 四、变异反向验证

在服务器专属目录里逐项植入（每次只改一处，替换前核对原文恰好出现一次），跑列出的测试文件，记下变红的用例；每项之后 `git checkout` 还原，还原后源文件 sha256 与植入前一致、`git status --porcelain` 为空（9 项都逐字一致）。基线（10 个测试文件 128 例）全绿。

| 编号 | 植入 | 跑的测试文件 | 精确变红的用例 |
|---|---|---|---|
| M1 | `STREAM_SPAWN_WORKERS` 改为 `true` | spawn-worker-registration、stream-experiment、stream-identity（26 例） | 3 例：注册测试"pigeon run：……跑批器五个条件……"；stream-experiment"身份头与结果行记 Pigeon 实际生效的参数……主 agent 派 worker 记关（265）……"；stream-identity"合并后的身份头……" |
| M2 | headless 的 `spawnWorkers` 缺省改为开（没给即注册） | 同上 | 1 例：注册测试"pigeon run：……跑批器五个条件……" |
| M3 | `pigeonStepAgent` 漏传 `spawnWorkers`（依赖 headless 缺省） | 同上 | 0 例。漏传后生效值仍为关：headless 缺省关，且该缺省由 M2 变红的那一例钉住；这一植入在行为上不可观察，没有测试注入点能截获 `pigeonStepAgent` 交给 headless 的选项，本段不加注入点 |
| M4 | `mergeCore` 比 `agents.pigeon` 时跳过 `spawnWorkers` | stream-identity、stream-report、stream-runner（82 例） | 2 例：stream-identity"身份头记主 agent 派 worker 的实际生效值（265）"；"合并后的身份头……" |
| M5 | `checkHarness` 不比提交号 | 同上 | 3 例：stream-identity"代码版本（269）：续跑时提交号不同即拒绝……"、"--accept-harness-change 给了原因才放行……"、"合并后的身份头……"；stream-runner 的 describe 块"固定起点跑批（假 agent、本地假容器）"随其内的"报告的设置一节取自输出目录的身份头……"一例一起列为变红（同一处失败，运行器把所在的 describe 也标红） |
| M6 | 显式放行不把原因记进 `infoLog` | 同上 | 2 例：stream-identity"--accept-harness-change 给了原因才放行……"、"合并后的身份头……"；另有 stream-runner 的"报告的设置一节取自输出目录的身份头……"一例及其所在的 describe 块（同 M5 的说明） |
| M7 | 运行面不给工具结果挂标记（`#markToolResult` 直接返回） | trace-workers、trace、trace-classes、session-judge、spawn-worker-tool（36 例） | 2 例：trace-workers"trace（真实运行）：主 agent 派 worker 的会话……"；trace"trace 报告（真实运行）……审批结果与分类徽章……" |
| M8 | 上游拦截的调用分类为未知 | 同上 | 4 例：trace-workers"trace（真实运行）：主 agent 派 worker 的会话……"；trace-classes"trace 工具调用行……"；session-judge"工具级失败分类：成功、策略拒绝、中止、上游拦截……"、"工具级失败分类（带运行面标记）……" |
| M9 | `spawn_worker` 登记为写档（prompt 模式下要人批，无人值守即拒绝） | 同上 | 1 例：trace-workers"trace（真实运行）：主 agent 派 worker 的会话……" |

## 五、合并后改动的测试及原因

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/application/spawn-worker-registration.test.ts` | "pigeon run：……跑批器各条件（明确关掉）……"改名为"……跑批器五个条件（四格明确关掉，最简 agent 不经 Pigeon）……"，加断言：条件表恰 5 个、非 Pigeon 的只有 `minimal:minimal` | 交汇处第 1 项要求核对五个条件，原用例只列四格 |
| `src/eval/stream-identity.test.ts` | 新增第三节第 2 项的用例；导入 `effectivePigeonSettings`、`readStoredIdentity`、`renderStreamReport` | 交汇处第 2 项 |
| `src/cli/trace-workers.test.ts` | 新增第三节第 3 项的用例与四个辅助函数（建 git 仓库、按会话首条用户消息分派剧本、从 trace 文本取各调用的审批/出错归类/分类三行） | 交汇处第 3 项 |

没有改动原有用例的断言；两条分支自带的测试一个没动。

## 六、verify 的实际运行情况

全部在服务器上跑（云主机 8 vCPU、31 GB 内存，Node 24.12.0，已载入实验镜像与日常沙箱镜像，需要真容器的用例实际运行）；本机没有跑 lint、类型检查与测试。专属目录从 bundle 克隆，依赖经 `npm ci` 安装。

- 合并头 c28f395（改测试之前）：lint 通过（biome 检查 408 个文件）；类型检查通过。
- 三处测试所在的三个文件在 c28f395 的源码上单独跑：22 例全部通过。其中 trace 一例最初按 yolo 模式写、断言 `policy:auto`，跑出 `policy:yolo` 变红，改为 prompt 模式后通过（第三节第 3 项）。
- 交付提交 2c2e8b8：`npm run verify` 的四步依次跑——lint 通过（408 个文件）；check 通过；测试步 `node --test --test-concurrency=6 "src/**/*.test.ts"`（运行前没有别的测试进程）：1176 例，通过 1174，失败 0，取消 0，跳过 2（两个只在 Windows 上跑的 `.cmd` 启动器用例），耗时 111 秒；deps 通过（424 个模块、2940 条依赖，无违规）。四步退出码都为 0。

## 七、没有停下的地方

- 两次合并没有冲突，四个自动合成的文件按第二节逐项核对，没有拿不准的取舍。
- 第四节 M3 那一项在行为上不可观察，是既有结构（headless 缺省关且已被钉住）决定的，没有另加注入点。
