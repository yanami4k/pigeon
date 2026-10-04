# 工具并行执行与按环境注册工具 审计

- 基线：5bbd0ec
- 分支：tool-lock
- 范围：决策 353（工具并行执行与提示）、决策 359（按环境只注册用得上的工具）。两件各成一组提交：a79d0c9、8780d48；文档与本审计另成一组。

## 一、工具并行执行（决策 353）

现状：
- `PiRuntimeAdapter` 的 `toolExecution` 只在装配根给了 `parallelTools`（注册了派 worker 时）才为 `parallel`，跑批器、沙箱与容器、`--line`、worker 会话一律 `sequential`。
- 上游（`agent-loop.js`）的规则：同一批调用里只要有一件工具标为串行，整批走逐个"准备（参数校验、`beforeToolCall` 即治理的钩子、审批与预览）→ 执行"的串行执行器；全部可并行时先按调用顺序逐个准备，全部准备完再同时执行。
- 系统提示从未引导模型把互不依赖的调用放进同一次回复。

改法：
- 适配器的 `parallelTools` 选项改为 `executionModeOf`（逐工具的执行模式，缺省一律串行）；`toolExecution` 恒为 `parallel`；包装工具时以 `executionModeOf` 的结果覆盖工具自带的 `executionMode`。
- 执行模式在一处登记：`src/application/tool-execution-modes.ts` 的 `PARALLEL_TOOLS`（read_file、search_sessions、read_session_entry、list_sessions、web_search、web_fetch）为并行，其余一律串行，没登记的也按串行；grep、glob 合并后加进来。装配根把 `toolExecutionModeOf` 交给适配器，各环境同一规则。
- 效果：纯读的一批同时执行；读写混排的一批按顺序逐个准备、执行，审批与预览的时机与改前的串行模式相同——连发几个 edit_file 改同一文件时，后一个的预览基于前一个改完的内容。
- 取舍，以及与决策 353 原话的出入：353 写的是在工具层加读写锁。若把所有工具都标为可并行、在执行处取锁，上游会先把整批调用都准备完（含审批与预览）才开始执行，同一批里后面的写的预览就会基于前面的写执行之前的内容。为不出现这个回归，改为直接用上游的逐工具模式。"读同时、写独占、顺序不变"的效果照样达成；代价是读写混排的批里读也不并行。
- 原先标为可并行的 spawn_worker、load_skill 现按串行：spawn_worker 派出即返回，一批里连派几个的效果不变。
- 系统提示在编辑句之后加一句（`PARALLEL_READS_SENTENCE`）：「互不依赖的读取与搜索放在同一次回复里一起发。」

改动过的现有测试：
- `src/pi-runtime/adapter-tools.test.ts`：并行批次的钩子停止用例，`parallelTools: true` 改为 `executionModeOf: () => "parallel"`。
- `src/application/runtime-edit-mode.test.ts`：hashline 模式的系统提示逐字基准补上新加的一句。

新增测试（`src/application/tool-execution-modes.test.ts`，3 项）：
- 登记表：读类工具并行；edit_file、run_command、MCP 工具名、spawn_worker 与没登记的名字串行。
- 容器执行端（以本地执行端包一层交给装配根，读文件记下起止、命令不真起进程；没有派 worker）：两件 read_file 的一批起止交错（同时执行）；read_file、run_command、read_file 的一批严格按顺序逐个执行。
- prompt 模式下一次回复里连发两个 edit_file 改同一文件：第二次请示时文件已是第一次改完的内容，第二次的预览在场，最终内容为两次都改完。

变异（逐条改坏、跑本文件、确认变红后还原）：

| 变异 | 结果 |
| --- | --- |
| 登记表一律返回并行（混排批也并行） | 变红 |
| 只把 edit_file、run_command 标串行（没登记的成了并行） | 变红 |
| 适配器仍按串行模式交给上游 | 变红 |

## 二、按环境只注册用得上的工具（决策 359）

现状：orchestrate、派 worker 那一组、web_search、会话检索三件在用不了的环境里照样注册（没有 docker、不是 git 仓库、缺搜索 key、没有历史会话），调用才报错或搜不到。

改法：
- `src/application/tool-environment.ts`：会话开始时按需做三项本地检查——PATH 里的绝对目录下有没有 docker 可执行文件（Windows 认 docker.exe，其余平台要有执行权限）、治理根是不是 git 工作区（`isGitWorkspace`）、会话根里有没有本会话以外的会话文件（`listSessionFiles`，只看文件名）。不连 docker、不发请求；只查用得上的项。
- 装配根（`runtime.ts`）的注册：
  - 会话检索三件：决策 193 的开关开着且有历史会话才注册，否则系统提示也不带那一句。
  - 派 worker 那一组（spawn_worker、wait_workers、worker_status、message_worker、stop_worker，主会话另有 take_worker）：治理根是 git 工作区才注册。
  - orchestrate：既要 git 工作区（脚本派的 worker 要建工作树，工具自己对非 git 工作区也拒绝），又要 PATH 里有 docker。
  - web_search：有可用的搜索后端（`webTools.search.backend` 在场）才注册；web_fetch 照常。只剩 web_fetch 时系统提示换成只讲它的一句（`WEB_FETCH_SENTENCE`）：「需要读取某个网页时，用 web_fetch 读取并说明要从中找什么；web_fetch 只交回按问题提炼的结果，不交回网页原文。」
- 一次会话内固定：检查结果放进开局冻结的内容（`FrozenSessionPrompt.toolEnvironment`），`/reload` 重建运行面时沿用，不重查；下次会话重查。`RuntimeDeps` 加 `env`（查 PATH 用的环境变量，缺省 `process.env`）。
- 会话记录：Run 开始条目已记实际广告的工具（`advertisedTools`）；另加可选字段 `skippedTools`（没注册的工具与原因：本项目没有历史会话／工作区不是 git 仓库／PATH 里找不到 docker 可执行文件／搜索后端的不可用说明），都注册了时不带。`RunStartedPayloadSchema` 与 `RunStartDataSchema` 加法式加这一项，经适配器的 Run 开始附加摘要写入。

跑批的工具清单：
- Pigeon 条件同样按环境注册。跑批的 Pigeon 条件本就不注册派 worker、编排脚本与联网工具，会话检索按条件开关。
- 变化：开着会话检索的 search-push、search-only 两个条件，每条流的第一步（作业目录的会话根里还没有之前的会话）不再注册会话检索三件，系统提示也不带那一句；第二步起照旧。push-only、neither、minimal 与外部 agent 条件不变。

改动过的现有测试：
- `src/application/launch-flags-web.test.ts`：三种关法一项里缺省情形给 `webToolsOptionOf` 传一个假 key，选出搜索后端（装配时不发请求）。
- `src/application/runtime-web-tools.test.ts`：夹具的搜索配置换成一个假后端。
- `src/application/runtime-edit-mode.test.ts`：hashline 模式的逐字基准去掉会话检索那一句（临时目录里没有历史会话）。
- `src/application/session-search-switch.test.ts`：开关一项的装配前先在同一目录跑一次，留下一个历史会话。
- `src/eval/stream-agents.test.ts`：四格的工具清单一项在作业目录的会话根里先放一个之前的会话文件。

新增测试（`src/application/tool-environment.test.ts`，6 项）：以 git 工作区、PATH 里有 docker、有历史会话、有搜索后端为基准——齐全时各组都注册且不记没注册的工具；缺 docker 只少 orchestrate；不是 git 仓库少派 worker 那一组与 orchestrate；缺 key 只少 web_search；没有历史会话少会话检索三件；每种情形 Run 开始条目记的没注册的工具与之相符。另一项：开局缺 docker，带着开局冻结的内容重建运行面时环境已有 docker，orchestrate 仍不注册。

## 三、与 worker 工具清单的衔接

worker 工具清单（另一分支，未合并）取主 agent 已注册工具的子集；按环境注册的结果会改变这个子集（例如没有历史会话时，explorer 预设里的会话检索三件随之没有）。两者合并时需一并核对。

## 四、测试量

产品代码 +203 −23 行，测试 +328 −7 行（其中改动现有测试约 30 行）。产品改动多为装配层的接线，量小；各项行为都需装出运行面再观察（执行次序、请示时机、注册与记录），夹具占了测试的大半。

## 五、verify

- 在构建服务器上运行（8 vCPU、31 GB 内存，Linux，Node 24.12.0），提交 8780d48（其后只改文档）。
- lint、tsc 类型检查、依赖规则（576 个模块、4182 条依赖，无违规）通过。
- 全量测试分三条前台命令运行（`node --test --test-concurrency=2`）：src/application 379 项、src/eval 315 项、其余 942 项，合计 1636 项，通过 1634，跳过 2（两项 Windows `.cmd` 用例，只在 Windows 上运行），失败 0。
