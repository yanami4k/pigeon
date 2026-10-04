# 测试减重 审计

- 基线：5bbd0ec
- 分支：test-slim（头 f337155）
- 范围：决策 370（测试减重）。本段不迁 Vitest（决策 369）。共七个提交：
  - 1273625 逐文件计时与覆盖率量具（`scripts/test-timing.mjs`、`scripts/test-coverage.mjs`）
  - 6ebdc09 跑批器测试共用夹具、缩小规模
  - 7e0cfcc 修快照器漏掉同一秒内等长改动的产品缺陷（见第七节）
  - 26a203c 修 script-ui 测试的挂起与渲染时序、放宽编排夹具的等待上限
  - 242f679 按逐文件覆盖率删并重复的测试
  - 38ddbd5 文案断言改测结构与片段
  - f337155 快慢分档、CI 改跑 `verify:full`、`docs/testing.md`
- 测量环境：验证服务器（8 vCPU、31 GB，Node 24.12.0，git 2.43.0）；测试步并发 6；计时时服务器上没有别的测试进程（另注明的除外）。

## 一、前后对比

| 项 | 改前（5bbd0ec） | 改后（f337155） |
|---|---|---|
| 产品代码（src 下非测试、非夹具） | 234 个文件，52,134 行 | 234 个文件，52,139 行 |
| 测试代码（`*.test.ts`） | 281 个文件，62,285 行 | 273 个文件，61,137 行 |
| 测试夹具（`*fixtures.ts`、`testing.ts`） | 17 个文件，2,656 行 | 17 个文件，2,683 行 |
| 测试与产品代码之比（夹具计入测试） | 1.25 | 1.22 |
| 测试与产品代码之比（不计夹具） | 1.19 | 1.17 |
| 测试项 | 1627（通过 1625，跳过 2） | 1578（通过 1576，跳过 2）；快档 1235，慢档 343 |
| `npm run verify` 全程 | 99.0 秒（lint 0.6、check 16.1、测试 80.8、deps 1.4；测试为全部文件） | 70.4 秒（lint 0.6、check 17.2、快档测试 51.0、deps 1.5） |
| `npm run verify:full` 全程 | —（改前无此脚本；全部测试即改前的 verify） | 93.0 秒（lint 0.6、check 16.9、两档测试 74.1、deps 1.4） |
| 慢档单独跑（`npm run test:slow`） | — | 38.2 秒 |
| 跑批器测试 `stream-runner.test.ts` 单独跑 | 28.2–29.7 秒（两次） | 9.4–9.9 秒（三次；测于 6ebdc09，之后该文件只改了两处题面断言） |
| 跑批器测试串行（各测试依次跑） | 45.4 秒 | 约 16.8 秒 |
| 逐文件计时（每文件单独进程，并发 6）的总墙钟 | 81.7 秒 | 90.9 秒 |

- 决策 370 记的比例 1.14 是把夹具计入产品代码的口径（62,285 / 54,790），改后同一口径为 1.12（61,137 / 54,822）。
- 逐文件计时在并发 6 下波动大：同一批没改动的文件在两次测量之间相差 10%–60%（例如 `run-cli` 10.2→13.7 秒、`boundary-rules` 6.7→10.8 秒），总墙钟由排在最后的长文件决定。前后对比以分步计时的 verify 与 verify:full 为准。
- 改前逐文件计时那一轮里 `closeout-fixes.test.ts` 偶发失败一次（见第七节），其余全过。

## 二、跑批器测试（`src/eval/stream-runner.test.ts`）

改前：56 项。前 43 项在一个并发 describe 里，每项都从头建人的仓库（6 个提交、参考工作区）、为每一步经 bundle 新建假容器、现算人的基准与两类用例再跑一批；各项耗时之和 628 秒，并发下墙钟 35.9 秒。串行逐项计时（关掉并发、按阶段计时）合计 45.4 秒：

| 阶段 | 串行耗时（秒） | 占比 |
|---|---|---|
| 建仓库（人的历史、清单、参考工作区） | 9.52 | 21% |
| 开假容器（经 bundle 建起点） | 12.63 | 28% |
| 跑用例（人的基准、叠放运行、判题） | 5.87 | 13% |
| 跑批其余（工作区的 git 操作、落盘、整理） | 13.68 | 30% |
| 其他（断言、单独用例的准备） | 3.70 | 8% |

各项明细见文末附表一。

改法：
- 共用起点：默认的人的历史、清单与参考基准在一个文件里只建一次，按建仓参数记忆（题面两段名单两种格式共用一份）；人的仓库只读，参考工作区经 `ReferenceCases` 自带的队列串行使用，参考基准头一次用到时现算并落盘，之后读回。每个测试另开自己的目录放输出与环境。"判题前清理"用例的两份起点文件（静态检查配置、人写的同名钩子文件）并入默认起点，别的用例不看它们。
- 起点模板（`stream-toy-fixtures.ts`）：同一提交的起点在本进程里只经 bundle 建一次（与容器实现同一条路），之后每次打开复制一份；复制出的目录与重新建的相同。
- 缩小规模：一步即可证明的行为改为只跑一步——撞宽上限（四种情形各一步）、conftest 不影响判题（两种忽略写法各一步）、依赖切换的其他失败、lint 环境按该步提交切换、题面给用例名、题面第二段（274）。
- 文件末尾参考基准的几条用例共用一个单提交仓库与参考工作区（内存采样那条另装工作区），放进第二个并发 describe；用到玩具仓库的三条移进第一个 describe。
- 删除为已删除功能留下的测试与断言：
  - 删「复盘随决策 331 删除：推送格与不推送的格子复盘字段一律为 null，agent 的轮数、用量与花费即整步的计量」：只证明复盘列恒为空；轮数、用量与花费取网关计量由同文件「限额：一步撞上额度即作废…」断言；其中 agent 墙钟取自报一句并入「固定起点…」。
  - 「固定起点…」去掉"新行不写 head/regressions/attribution/reverted、不写 fullPassRate、review 为 null、不写 verify.json"（决策 322、327、331 删除的功能）；补"没撞上限的步 hitStepBudget 为 false"。
  - 「撞宽上限（171）」去掉 hitReviewBudget 为空；「条件表（193、194）」标题去掉验证门与回炉的说明。
  - 「conftest 不影响判题与测量」去掉"下一题开工时也不在"：每步新开环境由「固定起点…」断言（agent 留下的文件不带进下一步）。
- `stream-report.test.ts` 去掉"次要指标表不再有验证工具故障一列"。

改后：55 项，单独跑 9.4–9.9 秒，串行约 16.8 秒。

## 三、快档与慢档

划分写成清单 `scripts/test-tiers.mjs`（不用命名约定：每项旁边写得下理由，文件不必改名；清单某项匹配不到文件时跑测试的脚本即报错）。慢档：

| 清单项 | 理由 |
|---|---|
| `src/eval/**/*.test.ts` | 跑批器与实验装置：多数用例真跑 git 与假容器，部分用实验镜像起真容器；只在 eval 有改动时与合并前跑 |
| `src/cli/spawn-worker-cli.test.ts` | 单独跑 15.2 秒：在 `pigeon run` 子进程里派 worker、等并行完成、合并分支，每条用例冷启动一次 CLI 子进程 |
| `src/execution/container-host.test.ts` | 单独跑 13.0 秒：真容器层验超时杀干净、退出码、输出截断与路径映射 |
| `src/execution/hook-runner.test.ts` | 单独跑 10.1 秒：超时杀整棵进程树与经真容器执行钩子 |

- 单独跑在 7–10 秒之间、留在快档的：`sandbox`（7.9）、`run-cli`（7.6）、`script-acceptance`（8.5）、`orchestration-ui`（8.6）、`spawn-worker-headless`（7.1）。
- 脚本：`npm run test` 只跑快档；`npm run test:slow` 跑慢档；`npm run verify` 用快档；`npm run verify:full` 跑两档（同一次 node --test）。环境变量 `TEST_CONCURRENCY` 给出时作为 `--test-concurrency` 传下去。
- CI（`.github/workflows/ci.yml`）改跑 `npm run verify:full`，推送 main 与每个 PR 仍全量把关（决策 336）。

## 四、按覆盖率删并

做法：每个测试文件单独跑一遍覆盖率（node 自带，lcov），算出每个文件独有覆盖的产品代码行。独有行为 0 的 90 个文件中，4 个是静态规则检查（`boundary-rules`、`grants-writers`、`pigeon-paths-boundary`、`session-tree-conformance`，不执行产品代码），不算候选；其余 86 个逐条测试核对：所测行为在别处是否已有等价断言，同一行为跨层重复时只留最合适的一层。删并 41 个文件，测试代码净减约 1,250 行。

整文件删除（8 个）：

| 文件 | 理由（等价断言所在） |
|---|---|
| `application/replace-edit-e2e` | `runtime-edit-mode`「编辑模式缺省为 replace…」、`tools/read-file-replace`「read_file replace 模式…」、`pi-runtime/adapter-tools`「yolo 模式：写工具自动放行…」 |
| `application/runtime-skills` | `headless`「显式 skillRoots 只用给定的根、agentsMd 关掉…」、`skills/catalog`「扫描项目级与用户级…」、`runtime-pushed-memory`「只推送…」 |
| `skills/skill-governance` | `adapter-tools`「deny 清单绝对…」「熔断…」、`headless`「prompt 模式无审批通道一律 fail-closed…」、`load-skill-tool`、`mcp-prompts-e2e` |
| `tools/registry-json-schema` | `mcp/registry-bridge`「MCP 映射…」、`tools/registry`「parameters 必须是对象 schema…」 |
| `tools/error-kind` | 三类归 domain 与 AbortError 归 undefined 的断言并入 `error-kind-codes`；归 environment 一条与 `error-kind-codes`「errno 风格 code 归 environment」相同 |
| `cli/legacy-memory-fields` | `session-list`「旧格式会话…末尾给一行计数提示」、`trace`「会话不存在…旧格式会话单独说明…」；replay 与 trace 共用 `missingSessionError` |
| `cli/approval-host` | 两条断言（工具、网站、参数三行相连；放权不带目录限定）并入 `web-governance` 第一条，其余该条原有 |
| `orchestration/roles-tester` | "父策略允许时 tester 拿到 run_command 且通过 assertPolicySubset"并入 `roles`「父策略齐全时…」，其余两段该文件原有 |

单条删除：

| 文件：测试 | 理由（等价断言所在） |
|---|---|
| `approval-reason-source`「人写理由…」 | `adapter-tools`「prompt 模式：审批拒绝…reason 逐字进 toolResult」 |
| `headless`「结果从新会话存储现算；会话根下有同号旧格式平铺…」 | `session-store`「会话根下有同号的旧格式平铺文件…」 |
| `runtime-output-limit`「注入快照 model 段配置了才写…」 | 同文件「输出上限装配（未配置／配置 4096）」 |
| `runtime-web-tools`「跑批器各条件不注册联网工具」 | `stream-experiment`「身份头与结果行记 Pigeon 实际生效的参数…」 |
| `spawn-worker-registration`「可并行…」 | `spawn-worker-tool`「派出立即返回…」与「…执行模式可并行」 |
| `workers-compaction`「主会话没给压缩配置…」 | `runtime-compaction`「缺省开启…」与同文件继承那条 |
| `session-search-switch`「会话检索关掉时模型硬调检索工具…」 | 同文件开关那条与 `adapter-tools`「未广告的工具名…」 |
| `session-search-switch`「推送记忆打开：headless…」 | `runtime-pushed-memory`「入口…」与 `pushed`「只推送的入口…」 |
| `session-store-fixtures` 三条夹具自检（worker 子会话、分叉、撕裂末行与未知条目） | 读这些夹具产出的十余个下游测试，与 `session-reader` 的两条读取器测试 |
| `state/events`「JSON 往返后深度相等且校验通过」 | `pi-runtime/adapter` 对每条真实事件做 schema 校验 |
| `tools/edit-file`「锚点漂移拒绝」 | 同文件「多段预检原子性…」与 `hashline`「锚点 tag 不匹配…」 |
| `tools/hashline-insert-diff`「既有拒绝规则不变」 | `hashline`「多处编辑范围重叠拒绝」「锚点行号越界拒绝」 |
| `tools/hashline`「buildEditDiff：unified-ish 头…」 | `hashline-insert-diff`「replace 与 delete 的记账和 diff 不变」的全文断言 |
| `approvals/handler-host`「不带主机名的请求照旧…」 | `cli/approval-ui`「[d] 创建目录限定 grant…」「[a] 创建工具级 grant…」 |
| `cli/approval-sandbox`「能建目录放权的会话照旧提供 [d]…」 | 同上 |
| `eval/stream-results`「旧结果行带验证门与回炉字段…」 | 已删功能的字段；读旧行由同文件「旧结果行带撤回与延续式字段…」、四个字段列入旧字段清单由「结果行字段清单」断言 |
| `persistence/grants-config-lock`「依次写入互不覆盖…」 | `grants-config`「升格写入…」与 `cli/grants`「/revoke config#N…」 |
| `pi-runtime/adapter-grants` ⑥⑦⑧ | ⑥：`grants-config`「畸形文件响亮失败」；⑦：`adapter-tools`「幽灵工具名熔断」与 `classification`「aborted 有熔断记录」；⑧：`adapter-tools`「read 层自动放行」与 `headless` 的落盘标记 |
| `pi-runtime/snapshot` v14、v11、v13 三条 | 只证明已删字段被宽松对象放过（已删功能） |
| `launch-flags`「审阅与自动验证参数已…退役」「验证门、回炉与失败自动分叉重试的参数已…删除」 | 已删参数；未知参数响亮失败由同文件「取值校验」断言（同条另去掉 `--memory-budget` 一句） |

合并后删除原测试：`runtime-web-tools`「给了 webTools 才注册两件工具…」（toolTiers 两句并入 `launch-flags-web`）；`spawn-worker-registration` 两条（并入 `orchestration-wiring` 两条）；`runtime-edit-mode` 截断引导（并入同文件缺省 replace 那条）；`runtime-memory`「agentsMd 关掉」（并入 `headless`「显式 skillRoots…」）；`runtime-pushed-memory` worker 三角色循环收成 implementer 一条（是否带写入与角色无关）；`attempt-group`「全做完」（并入第一条）；`workers-recovery-e2e`「旧格式会话续跑」（并入 `resume`「续跑：旧格式会话…」）；`edit-file`「无实际变化的编辑拒绝」（报错文字并入 `hashline` 同名）；`loop-guard-run`「打转叫停后照常结束」（并入同文件第 5/10/20 轮那条）；`trace-classes` T3（会话列表比对与逐调用核对并入 T1）。另删断言：`step-admission` 第一条里与 `model-gateway`「开跑前校验」重复的 7 路拒绝。

审核后保留：`loop-guard-run`「真实形状…」（打转模式带两条调用、工具调用数上限别处无）；`model-pricing`「价目」（计费判定）；`adapter-grants` ②④⑤（装配层是该行为最合适的一层）；其余候选为唯一断言或最合适的一层。

改后独有覆盖为 0 的文件 80 个（多为单元层，同样的行另被装配或端到端测试执行）。

## 五、文案断言

清点：全部测试里整段比对 40 字以上的工具说明、报错、提示与返回文字。定稿原文的来源：产品代码里标"定稿原文"的（`spawn-worker-tool`、`orchestration-tools`、`take-worker-tool`、`task-list-tool`、`script-texts`、`loop-guard`），以及会话检索三件工具的说明（决策 339）与记忆文字 v2（推送段、update_memory 说明与参数、写满被拒的文字；决策 227，后经 329、332 重写）。

- 改写 57 处：能由产品模板或常量生成的改为生成（`SPAWN_WORKER_TEXTS`、`workerStartLine`、`TAKE_WORKER_TEXTS.taken`、`LEGACY_READER_HINT`、`resumeApprovalText`、`previousRunWorkerText`、`MEMORY_CONFLICT_TEXTS`、`runCommandTexts`、`TRUNCATION_GUIDANCE` 等），其余只检区分片段或结构正则。分布：spawn-worker-tool 13、spawn-worker-headless 5、spawn-worker-cli 2、workers-start 3、take-worker-tool 2、loop-guard-run 1、loop-guard-worker 1、search-tools 1、update-memory-tool 1、runtime-edit-mode 3、run-command-text 6、memory-command 6、旧格式会话提示 5、orchestration-ui 1、workers 2、stream-runner 2、stream-agents 1；另经辅助函数与常量间接改到 headless 的派出文字（4 处）、起点行正则与 workers-start 的起点行常量（5 处）。
- 删除 1 处：spawn_worker 说明在同一测试里的第二次逐字比对，改为接线断言（工具上的说明等于按缺省设置生成的说明）。
- 每段定稿原文只留一处逐字检查：spawn_worker 与四件编排工具的说明、参数、固定情形返回文字在 `spawn-worker-tool.test.ts`；收尾四模板与起点行在 `workers-start.test.ts`；take_worker 的说明、参数、taken、unknown、failed 在 `take-worker-tool.test.ts`；打转文字在 `loop-guard-view.test.ts`（终端叫停）与 `loop-guard-worker.test.ts`（worker 原因）；三件检索工具说明在 `search-tools.test.ts`；记忆文字 v2 在 `pushed.test.ts`（推送段）与 `update-memory-tool.test.ts`（说明与参数、新增被拒、替换被拒），这几处注释写明逐字检查守"改文字必须升 MEMORY_TEXT_VERSION"。

## 六、不稳定的测试

`src/tui/script-ui.test.ts`（Windows 上「审批：本次脚本内同类都允许…」确定性失败，失败后进程挂约 10 分钟）：
- 失败原因：按 `s` 后固定等 80 毫秒即查屏幕；批准之后同一串调用里有同步的 git 调用（Windows 上每次约 0.3 秒），屏幕常在 80 毫秒后才重绘。
- 挂起原因：失败后只停了壳，脚本继续派下一个 worker；被拒的 worker 等一个没人发的中断，执行器子进程的管道让事件循环不空，直到编排器的卡住判定（10 分钟）到点。
- 改法（只改测试）：按键后轮询等屏幕出现期望文字（上限 15 秒）；对脚本结果的等待都加上限；收尾一律停脚本、停壳、取消全部 worker、等运行结束（至多 5 秒）后杀掉执行器子进程。
- 验证：服务器上整文件连跑 3 次通过；人为改错一条断言后 1 秒内退出（原版同样改错后 60 秒仍未退出，被外层超时杀掉）。Windows 11 本机：整文件 5/5 通过（29 秒），该条单跑 2 次通过（各 12 秒），人为改错同一断言后 10 秒退出。

`orchestration-ui` 相关测试（负载高时偶发失败）：服务器上加压未复现——8 份并行跑 3 轮（当时另有一轮全量测试并发在跑）24 次全过；把测试进程与 3 个空转进程绑在同一个 CPU 上，`orchestration-ui`、`orchestration-shell`、`session-tree` 各 3 次全过。这组测试里唯一受墙钟预算约束的是共用夹具 `until` 的 2 秒上限（机器忙、进程整段停顿时会误报），放宽到 15 秒；条件一成立即返回，不拖慢通过的用例。

`src/application/closeout-fixes.test.ts`（负载下偶发失败）：根因在产品代码，见第七节。修复后服务器上并行跑 32 次（当时服务器上另有测试在跑）全过。

## 七、顺带修复的产品缺陷

- 现象：`closeout-fixes.test.ts` 在负载下偶发失败——改前逐文件计时那一轮失败 1 次；服务器上 8 份并行跑 4 轮，32 次失败 1 次；两次失败的是两条不同的测试，都是快照器该出快照时没出。
- 根因：`src/orchestration/checkpoint.ts` 取工作区当前文件树时，先把用户的索引复制成临时索引再 `git add -A`。复制件的修改时间是"现在"，使 git 对"同一秒内改动"的保护失效：git 只对修改时间不早于索引文件修改时间的条目重新比内容，其余只比 stat（秒级时间、大小、inode）。文件在上次入索引的同一秒里被改、长度不变，而取快照时已跨入下一秒，git 就判它没改，`afterChange` 返回空，这次改动没有快照。
- 复现：在服务器上卡秒边界确定性复现，4 次中跨秒的 2 次全部漏掉改动。
- 修法：复制后把临时索引的访问与修改时间设回真索引的（`utimesSync`），产品代码只改这一处。
- 验证：回归测试「同一秒内的改动、长度不变也打出快照…」用固定时间戳构造同秒、等长的改动（关掉 ctime 比对），不依赖机器快慢。去掉修复，只有这一条变红；还原后 7 项全过，文件与修复版逐字一致。修复后卡秒边界复现 0 次漏；`closeout-fixes.test.ts` 并行 32 次全过。

## 八、覆盖率

逐文件覆盖率的并集（node 自带覆盖率，按行；计 src 下除 `*.test.ts` 与 `*fixtures.ts` 以外的文件）：

| 模块 | 改前（覆盖/可执行） | 改后（覆盖/可执行） |
|---|---|---|
| `src/approvals/` | 98.41%（372/378） | 98.41%（372/378） |
| `src/application/governance.ts` | 96.66%（578/598） | 96.66%（578/598） |
| `src/tools/policy.ts` | 100.00%（94/94） | 100.00%（94/94） |
| `src/tools/paths.ts` | 96.43%（108/112） | 96.43%（108/112） |
| `src/tools/edit-file.ts` | 98.60%（141/143） | 98.60%（141/143） |
| `src/tools/replace-edit.ts` | 98.93%（185/187） | 98.93%（185/187） |
| `src/tools/local-host.ts` | 86.89%（265/305） | 86.89%（265/305） |
| `src/tools/workspace-host.ts` | 100.00%（105/105） | 100.00%（105/105） |
| `src/persistence/` | 94.59%（1627/1720） | 94.59%（1627/1720） |
| `src/application/session-store.ts` | 96.43%（351/364） | 96.43%（351/364） |
| `src/eval/model-gateway.ts` | 98.70%（1212/1228） | 98.70%（1212/1228） |
| `src/execution/` | 93.86%（2521/2686） | 93.86%（2521/2686） |
| 全部产品代码 | 92.96%（48,561/52,237） | 92.96%（48,564/52,242） |

关键模块的已覆盖行与可执行行前后逐项相同。改后这一轮测量时服务器上另有测试在跑，并发取 2；覆盖率只看执行到的行，不受负载影响。改后可执行行多 5 行（这一段唯一改动的产品文件是第七节的 `checkpoint.ts`），已覆盖行多 3 行。

## 九、关键判定的变异验证

在 f337155 上逐项去掉判定、跑全部测试（两档），再还原并核对文件逐字一致：

| 判定 | 变异 | 变红的用例 | 还原后逐字一致 |
|---|---|---|---|
| 受保护路径拒写 | `governance.ts` 的 `#protectedTargetOf` 一律返回空 | 7：`protected-paths` 5 条（会话放权、配置放权、worker 工作树、符号链接指进 .pigeon、沙箱容器路径）、`governance-hooks`「allow 不免除受保护路径…」、`take-worker-tool`「叠回内容含 .pigeon 下的路径…」 | 是 |
| 写前复核的符号链接拒写 | `paths.ts` 的 `assertWritePathUnchanged` 直接返回 | 3：`write-recheck` 某层目录换成指向工作区外的符号链接（hashline、replace 各 1）、要写的文件换成符号链接 | 是 |
| 网关作业地址的随机串核对 | `model-gateway.ts` 的 `registered` 不比随机串 | 1：`model-gateway`「未登记的作业、错的随机串、非 messages 路径或非 POST 都回 404…」 | 是 |
| 外部 agent 配置的密钥名拒绝 | `stream-external.ts` 去掉密钥名检查 | 1：`stream-external`「配置校验：附加环境变量不得含密钥…」 | 是 |
| 无审批通道时写档与执行档拒绝 | `governance.ts` 无审批通道的分支改为放行 | 7：`governance-hooks` 4 条（ask、allow 与受保护路径、updatedInput、钩子抛错后的判定）、`headless`「prompt 模式无审批通道一律 fail-closed…」、`web-governance`「没有审批通道…web_fetch 按 fail-closed…」、`run-cli`「不带 --yolo 时写调用 fail-closed…」 | 是 |

## 附表一：改前跑批器测试各项耗时（秒）

"并发下耗时"取自改前的逐文件计时（该文件一个进程，与其他文件按并发 6 一起跑；43 项在一个并发 describe 里同时跑）；其余各列为关掉并发、逐项依次跑时的串行耗时与分阶段耗时（"跑批其余"为跑批总耗时减去其中的开假容器与跑用例）。

| # | 测试（标题前 28 字） | 并发下耗时 | 串行耗时 | 建仓库 | 开假容器 | 跑用例 | 跑批其余 |
|---|---|---|---|---|---|---|---|
| 1 | 固定起点：只跑题（维护步、套用步、跳过步不跑），每步从人 | 18.61 | 0.74 | 0.17 | 0.16 | 0.13 | 0.28 |
| 2 | 撞宽上限（171）：agent 以撞轮数或墙钟上限收尾， | 24.72 | 2.79 | 0.64 | 0.60 | 0.52 | 1.02 |
| 3 | 判题的全量运行在报告写出前被杀、一条结果都没拿到：两类用 | 13.51 | 0.46 | 0.16 | 0.07 | 0.06 | 0.16 |
| 4 | 被打断的一步整题作废不留行，重做时另开干净环境（作废尝试 | 19.47 | 1.08 | 0.16 | 0.46 | 0.13 | 0.33 |
| 5 | 报告的设置一节取自输出目录的身份头：开跑时的代码与显式放 | 13.16 | 0.47 | 0.16 | 0.07 | 0.06 | 0.16 |
| 6 | 记忆快照（191、332）：每步开工前取项目级记忆 .p | 18.68 | 0.86 | 0.16 | 0.23 | 0.13 | 0.33 |
| 7 | 限额：一步撞上额度即作废，整批恢复后另开环境重做同一步， | 18.34 | 0.80 | 0.16 | 0.23 | 0.13 | 0.27 |
| 8 | 复盘随决策 331 删除：推送格与不推送的格子复盘字段一 | 12.46 | 0.49 | 0.16 | 0.16 | 0.08 | 0.09 |
| 9 | agent 暂存了人写测试的改名：判题前原路径恢复成起点 | 12.79 | 0.47 | 0.16 | 0.08 | 0.06 | 0.17 |
| 10 | 全量测量与人写测试集一致：agent 新建的测试文件（未 | 12.78 | 0.47 | 0.16 | 0.07 | 0.06 | 0.17 |
| 11 | agent 新建的、落在人写测试目录树上的 confte | 20.98 | 1.45 | 0.32 | 0.30 | 0.21 | 0.62 |
| 12 | 还原人写测试防绕过：agent 给起点里人写的测试设 s | 17.73 | 0.94 | 0.32 | 0.15 | 0.12 | 0.34 |
| 13 | agent 自己测试的辅助文件：判题的全量运行前按人在该 | 12.67 | 0.49 | 0.16 | 0.07 | 0.06 | 0.19 |
| 14 | 判题前清理（195 补口）：agent 放的解释器启动钩 | 12.48 | 0.49 | 0.16 | 0.07 | 0.06 | 0.20 |
| 15 | 依赖环境按人在该步的依赖声明选：agent 改了声明文件 | 17.12 | 0.74 | 0.16 | 0.15 | 0.13 | 0.30 |
| 16 | 找不到可用的依赖组合：这一步作废、记下原因，作业照常往下 | 12.69 | 0.49 | 0.16 | 0.15 | 0.10 | 0.08 |
| 17 | 判题前切环境时找不到可用的依赖组合（退出码 3）：这一步 | 16.63 | 0.67 | 0.16 | 0.15 | 0.10 | 0.26 |
| 18 | 依赖环境切换的其他失败（命令不在、超时、容器故障等，退出 | 13.28 | 0.85 | 0.32 | 0.30 | 0.09 | 0.12 |
| 19 | 测试配置按人在该步的版本写入：agent 运行前与判题前 | 10.79 | 0.47 | 0.16 | 0.07 | 0.06 | 0.17 |
| 20 | lint 环境按该步人的提交切换：agent 运行前已切 | 16.23 | 0.71 | 0.16 | 0.15 | 0.13 | 0.27 |
| 21 | 结果行带身份摘要与本条件所用 agent 的参数（温度、 | 13.72 | 0.65 | 0.16 | 0.15 | 0.07 | 0.27 |
| 22 | 条件表（193、194）：四格都是 Pigeon，按能否 | 12.94 | 0.66 | 0.16 | 0.15 | 0.07 | 0.27 |
| 23 | 题面给用例名（213 的备用）：名单为这一步要做到的用例 | 14.68 | 0.70 | 0.16 | 0.15 | 0.13 | 0.25 |
| 24 | 题面两段名单（①）：要做到的用例有落在本题新写或改过的测 | 18.78 | 1.45 | 0.32 | 0.30 | 0.31 | 0.51 |
| 25 | 题面第二段与要做到的（274）：人在该步没改的测试文件在 | 18.68 | 1.46 | 0.33 | 0.30 | 0.31 | 0.51 |
| 26 | 人的代码没过检查门的步：清单按预检结果打标记（其余去掉） | 14.09 | 0.70 | 0.16 | 0.15 | 0.13 | 0.25 |
| 27 | 空回复异常结束（决策 170 ②）照常判题、留行，不作废 | 11.31 | 0.46 | 0.16 | 0.07 | 0.06 | 0.16 |
| 28 | 限额与上游故障一律作废重做：一步期间出现并发受限、额度暂 | 16.20 | 1.40 | 0.16 | 0.74 | 0.07 | 0.43 |
| 29 | 作废一步时清掉这次尝试的痕迹：重做时会话检索搜不到上一次 | 17.30 | 0.83 | 0.16 | 0.23 | 0.13 | 0.30 |
| 30 | 进程死在一步中途留下的会话：续跑时不在上一个完成步清单里 | 14.81 | 0.76 | 0.16 | 0.15 | 0.13 | 0.32 |
| 31 | 同一步一再作废：上游故障（与限额信号同一口径）累计 5  | 21.33 | 4.25 | 0.33 | 2.97 | 0.10 | 0.85 |
| 32 | agent 留下未解决的冲突（merge 或 stash | 18.37 | 2.19 | 0.65 | 0.45 | 0.24 | 0.83 |
| 33 | 排队作废（Pigeon）：网关报排队超 30 秒即经按步 | 10.06 | 0.66 | 0.17 | 0.22 | 0.06 | 0.20 |
| 34 | 排队作废（最简 agent）：网关报排队超 30 秒即经 | 9.90 | 0.66 | 0.16 | 0.23 | 0.06 | 0.20 |
| 35 | agent 连续自报被打断、期间没有任何限额信号或上游故 | 8.62 | 0.65 | 0.16 | 0.30 | 0.05 | 0.13 |
| 36 | 停止信号（SIGTERM）：在途的一步作废、不留行，作业 | 12.98 | 0.81 | 0.16 | 0.23 | 0.13 | 0.28 |
| 37 | 结果文件末尾留着写到一半的行（进程被杀）：续跑前隔开它， | 13.75 | 0.77 | 0.16 | 0.15 | 0.13 | 0.32 |
| 38 | 作废重做另开环境、不留那次尝试的痕迹：agent 在被打 | 8.74 | 0.58 | 0.16 | 0.15 | 0.06 | 0.20 |
| 39 | 停止信号在判题的全量运行期间或之后的静态检查期间到达：这 | 15.76 | 1.33 | 0.33 | 0.30 | 0.15 | 0.55 |
| 40 | 因停止信号停下：在途一步的容器与为下一步预先开好的容器照 | 6.20 | 0.43 | 0.16 | 0.15 | 0.05 | 0.06 |
| 41 | 输出目录单实例：另一个跑批进程正占着同一输出目录即拒绝， | 7.60 | 0.47 | 0.16 | 0.08 | 0.06 | 0.17 |
| 42 | 判题前列 conftest 候选遇到 agent 设下的 | 10.64 | 0.65 | 0.16 | 0.15 | 0.06 | 0.27 |
| 43 | 条件需要的 agent 没有接入：该作业停止并说明原因， | 7.31 | 0.47 | 0.16 | 0.07 | 0.06 | 0.17 |
| 44 | 人的基准在报告写出前被杀、拿不全用例：报错停下，不以缺了 | 0.13 | 0.09 | 0.00 | 0.00 | 0.01 | 0.00 |
| 45 | 人的基准多遍比对：每遍都通过的进分母 B；结果前后不一或 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 46 | 人的基准与开跑前检查的缓存带身份（镜像、跑用例的方式、检 | 0.34 | 0.22 | 0.00 | 0.00 | 0.06 | 0.00 |
| 47 | 等价摘要：旧摘要在等价表里且结果没有挂起迹象的读回；在表 | 0.09 | 0.07 | 0.00 | 0.00 | 0.00 | 0.00 |
| 48 | 换根目录：同一份清单、人的基准、检查门结果与身份头整体搬 | 0.26 | 0.15 | 0.00 | 0.00 | 0.02 | 0.00 |
| 49 | 镜像等价只用于人的用例基准：旧镜像的用例基准按镜像等价表 | 0.10 | 0.07 | 0.00 | 0.00 | 0.00 | 0.00 |
| 50 | 等价表里的新摘要就是当前 strands 跑用例外壳的摘 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 51 | 人的基准记录每遍的内存峰值（cgroup 占用减页缓存） | 2.15 | 2.10 | 0.00 | 0.00 | 0.02 | 0.00 |
| 52 | 人的基准提前单独算：只取要全量测量的步的提交、按提交落盘 | 1.37 | 0.84 | 0.16 | 0.15 | 0.20 | 0.09 |
| 53 | 两类用例预计算（214）：全部题逐题在 commit 与 | 2.14 | 1.23 | 0.16 | 0.30 | 0.30 | 0.00 |
| 54 | 治理根按条件 × 遍次隔离：同一作业各步共用一个（会话与 | 2.57 | 1.67 | 0.16 | 0.61 | 0.21 | 0.69 |
| 55 | 放行之后、agent 开始之前出错（例如读网关计量失败） | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 56 | 依赖环境的链接或中间链接被换成真目录（切换脚本的替换会失 | 0.07 | 0.06 | 0.00 | 0.00 | 0.00 | 0.00 |

## 附表二：最慢的 30 个测试文件（逐文件计时，每文件单独进程，并发 6）

#### 改前最慢的 30 个测试文件

| 名次 | 文件 | 墙钟（秒） | 测试项 |
|---|---|---|---|
| 1 | src/eval/stream-runner.test.ts | 35.9 | 56 |
| 2 | src/eval/stream-external-docker.test.ts | 33.8 | 3 |
| 3 | src/eval/stream-agents.test.ts | 28.5 | 23 |
| 4 | src/eval/stream-profiles.test.ts | 21.0 | 18 |
| 5 | src/cli/spawn-worker-cli.test.ts | 17.3 | 8 |
| 6 | src/execution/container-host.test.ts | 14.3 | 12 |
| 7 | src/execution/sandbox.test.ts | 11.7 | 13 |
| 8 | src/eval/gateway-network.test.ts | 11.7 | 3 |
| 9 | src/execution/hook-runner.test.ts | 11.3 | 10 |
| 10 | src/cli/run-cli.test.ts | 10.2 | 6 |
| 11 | src/application/script-acceptance.test.ts | 9.2 | 6 |
| 12 | src/tui/orchestration-ui.test.ts | 8.8 | 14 |
| 13 | src/application/spawn-worker-headless.test.ts | 8.2 | 8 |
| 14 | src/boundary-rules.test.ts | 6.7 | 2 |
| 15 | src/tui/session-tree.test.ts | 6.3 | 5 |
| 16 | src/execution/sandbox-docker.test.ts | 5.5 | 2 |
| 17 | src/execution/helper-timeout.test.ts | 4.9 | 4 |
| 18 | src/eval/stream-workspace.test.ts | 4.5 | 23 |
| 19 | src/eval/stream-rejudge.test.ts | 3.6 | 7 |
| 20 | src/tui/shell.test.ts | 3.4 | 7 |
| 21 | src/application/sandbox-session.test.ts | 3.3 | 7 |
| 22 | src/execution/sandbox-limits.test.ts | 3.3 | 8 |
| 23 | src/application/loop-guard-run.test.ts | 3.2 | 6 |
| 24 | src/application/script-runner.test.ts | 3.2 | 8 |
| 25 | src/tui/session-view.test.ts | 3.1 | 7 |
| 26 | src/tui/script-ui.test.ts | 3.1 | 5 |
| 27 | src/tui/orchestration-shell.test.ts | 3.0 | 5 |
| 28 | src/tui/approval.test.ts | 2.9 | 10 |
| 29 | src/application/script-resume.test.ts | 2.8 | 7 |
| 30 | src/cli/replay.test.ts | 2.8 | 6 |

#### 改后最慢的 30 个测试文件

| 名次 | 文件 | 墙钟（秒） | 测试项 |
|---|---|---|---|
| 1 | src/eval/stream-external-docker.test.ts | 35.1 | 3 |
| 2 | src/eval/stream-agents.test.ts | 31.6 | 23 |
| 3 | src/eval/stream-profiles.test.ts | 21.2 | 18 |
| 4 | src/cli/spawn-worker-cli.test.ts | 19.3 | 8 |
| 5 | src/execution/container-host.test.ts | 14.5 | 12 |
| 6 | src/cli/run-cli.test.ts | 13.7 | 6 |
| 7 | src/eval/stream-runner.test.ts | 13.6 | 55 |
| 8 | src/eval/gateway-network.test.ts | 12.8 | 3 |
| 9 | src/execution/sandbox.test.ts | 11.3 | 13 |
| 10 | src/boundary-rules.test.ts | 10.8 | 2 |
| 11 | src/execution/hook-runner.test.ts | 10.8 | 10 |
| 12 | src/application/script-acceptance.test.ts | 10.4 | 6 |
| 13 | src/application/spawn-worker-headless.test.ts | 9.8 | 8 |
| 14 | src/tui/orchestration-ui.test.ts | 8.8 | 14 |
| 15 | src/tui/session-tree.test.ts | 6.6 | 5 |
| 16 | src/application/sandbox-session.test.ts | 5.9 | 7 |
| 17 | src/application/script-runner.test.ts | 5.6 | 8 |
| 18 | src/eval/stream-workspace.test.ts | 5.4 | 23 |
| 19 | src/application/script-resume.test.ts | 5.1 | 7 |
| 20 | src/execution/helper-timeout.test.ts | 5.1 | 4 |
| 21 | src/application/loop-guard-run.test.ts | 4.7 | 5 |
| 22 | src/cli/replay.test.ts | 4.5 | 6 |
| 23 | src/execution/sandbox-docker.test.ts | 4.3 | 2 |
| 24 | src/eval/stream-rejudge.test.ts | 3.7 | 7 |
| 25 | src/application/script-docker.test.ts | 3.5 | 1 |
| 26 | src/tui/shell.test.ts | 3.4 | 7 |
| 27 | src/application/take-worker-tool.test.ts | 3.4 | 7 |
| 28 | src/tui/session-view.test.ts | 3.2 | 7 |
| 29 | src/tui/approval.test.ts | 3.1 | 10 |
| 30 | src/application/protected-paths.test.ts | 3.1 | 10 |
