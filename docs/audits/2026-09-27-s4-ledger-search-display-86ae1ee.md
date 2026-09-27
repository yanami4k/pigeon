# 账本重构第三段：搜索与显示改读新存储（决策 180、181、185、187、206、210，基线 86ae1ee）

范围：读者 C（agent 看得见的会话检索）与读者 D（给人看的显示）改读新会话存储。旧账本仍双写不停，停写与删除是第四段；跑批器按文件操作会话的部分（src/eval/）本段不改。基线为 formal-v2 分支 86ae1ee，分支 ledger-s4，提交 f016728。

## 一、迁移的读者

| 组 | 读者 | 入口 |
|---|---|---|
| C | search_sessions、read_session_entry | src/memory/search-tools.ts，扫描在 src/memory/session-search.ts |
| C | /search 命令（cli 与 tui 共用） | src/application/search.ts |
| D | 会话列表（投影层与命令层） | src/persistence/session-list.ts、src/application/session-list.ts |
| D | 会话摘要 | src/state/session-view.ts 的 summarizeSessionView |
| D | trace | src/cli/trace.ts |
| D | replay 显示 | src/cli/replay.ts |
| D | 历史（TUI 续跑视图的显示部分与 --with-content 共用） | src/application/history.ts；tui/resume-view.ts 调用方式不变 |
| D | 格式化 | application/format.ts 未改；新读者沿用其中的短编号、参数摘要、分类徽章与验证结论措辞 |

读别的进程的会话一律经第一段的只读读取器，从不写文件。旧的纯投影（state/trace.ts、state/replay.ts、session-summary.ts 的 summarizeSession）与格式化里只剩它们在用的 describeContentGaps、breakerScopeLabel 保留不动，生产代码已不再调用，随第四段删除。

## 二、新增与改动

| 文件 | 内容 |
|---|---|
| src/state/session-view.ts（新） | 原生视图：把一个会话文件的主分支条目投影成按 Run 切段的消息（Run 内序号由 Run 开始条目现算）、七种自定义条目、轮次与工具调用配对、worker 父子关系、Run 级失败分类；会话摘要 summarizeSessionView。纯函数，输入按结构读取 |
| src/persistence/session-catalog.ts（新） | 按会话号定位与按时间序列举新存储里的会话、读成原生视图；按文件名数出只在旧账本里的会话；双写期检索筛选 hasLegacyEventFile |
| src/memory/session-search.ts、search-tools.ts | 读者 C 改读新存储，agent 可见文字见第三节 |
| src/application/search.ts、session-list.ts、history.ts，src/persistence/session-list.ts，src/cli/trace.ts、replay.ts | 读者 D 改读新存储 |
| src/state/session-summary.ts | 过滤判据的参数类型放宽为只需创建时间、工具名与失败分类（一行） |
| src/application/session-view-fixtures.ts（新）、history-fixtures.ts | 测试设施：旧账本事件文件占位、一个 Run 的简写；seedToolRun 改为经第一段夹具写新存储，消息内容与迁移前逐条相同 |
| spikes/ledger-migration/compare-readers.ts（新）、README.md | 读者输出的新旧对照与预期差异清单 |

行数（git numstat）：

| 类别 | 文件数 | 新增 | 删除 |
|---|---|---|---|
| 生产代码（含新文件 2 个，638 行） | 11 | 1,191 | 1,024 |
| 测试 | 18 | 1,145 | 1,521 |
| 测试设施 | 2 | 42 | 64 |
| spikes/ledger-migration | 2 | 442 | 0 |
| 合计 | 33 | 2,820 | 2,609 |

未改：src/state/materialize.ts、src/state/index.ts、src/application/session-store-fixtures.ts、src/persistence/session-reader.ts、src/eval/ 下全部文件、docs/roadmap/decisions.md。

## 三、原生视图的口径

- 只读主分支（main 通道从根到叶）。
- 切段：Run 开始条目之后、下一个 Run 开始之前的消息属于它，Run 内序号从 1 起、每条消息占一个（同第一段的分叉点定位）；自定义条目按数据里的 runId 归属 Run，不带 runId 的是会话级条目；Run 开始之前的消息不计入任何 Run。
- 分支会话：pi 的 fork 复制来源历史时条目号与时间戳原样保留，复制段属于来源会话。复制段止于文件头 metadata 记下的分叉点（Run 开始之后按消息条数数到第 runSeq 条）；来源在新存储里没有文件时分支文件不含复制段，长度为 0。检索、历史、trace、replay、摘要都从复制段之后开始，同一条消息不会以同一个条目号出现在两个会话里。
- 自定义条目数据按 version 与 v1 schema 校验，不合的跳过并记入视图告警；读取器跳过的行同样并入告警，trace 在"异常项"下列出。
- 创建时间：会话号是 Pigeon 的 sess_<ULID> 时取 ULID 时间分量（与旧列表同一口径），否则取文件名里的创建时间；列表按它从旧到新，同一时刻按会话号。
- 条目时间：取新存储条目自身的时间戳（写入时刻），对应旧正文记录的写入时刻。
- Run 级失败分类沿用 state/classification.ts 的同一个判据函数 classifyRunOutcome：停止原因取 Run 收尾里的（无则取末条助手消息的）；上游合成失败消息按 pi-runtime 的同一判据（空文本、用量全零、带错误文本）识别；结束方式为 breaker 即熔断；有开始无收尾即未收尾。
- 工具级失败分类（Q4：由消息、工具档位与审批模式现算）属第二段，本段未实现：会话摘要的失败分类只含 Run 级，trace 的工具调用不再有分类行，改为结果行。
- 会话摘要：Run 数为 Run 开始条目数；工具名取助手消息里的工具调用（按出现先后去重）；用量合计取助手消息的 usage；worker 来历取文件头；派出数与未收尾数取 worker 条目。旧摘要的待对账数随写操作回执停写（184）不再有来源，从摘要与列表中去掉。

## 四、检索工具的 agent 可见文字：改前改后逐字对照

口径（185、Q6）：只删与治理记录、正文哈希相关的字句，其余逐字不变；条目编号换成新存储的编号；命中行里"Run 第 N 条"保留，由 Run 开始条目现算。

### 4.1 工具说明

search_sessions（改前改后相同）：

> 检索本项目历史会话的消息正文（用户输入、模型回复与思维链、工具输出）。关键词大小写不敏感、按字面子串匹配、多个关键词须同时出现；不支持正则。结果从新到旧，最多 20 条。命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文。

read_session_entry 改前：

> 按 entryId 读取历史会话里一条消息的完整原文（含思维链与工具输出），并附同一 Run 里每次工具调用的审批与回执状态。entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。

read_session_entry 改后：

> 按 entryId 读取历史会话里一条消息的完整原文（含思维链与工具输出）。entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。

装配根注册元数据里的 read_session_entry 说明由"按 entryId 读取历史消息原文与同 Run 治理邻居"改为"按 entryId 读取历史消息原文"；search_sessions 的不变。两个工具的参数 schema 不变。

### 4.2 search_sessions 的典型输出

改前（尖括号为占位，旧条目号形如 entry_<ULID>）：

```
命中 2 条（关键词：网关；从新到旧）：
- <旧条目号>｜会话 <会话号>｜<Run 号> 第 1 条｜user｜<ISO 时刻>
  部署网关
- <旧条目号>｜会话 <会话号>｜<Run 号> 第 3 条｜toolResult（read_file）｜<ISO 时刻>
  网关配置在 gw.yaml
片段只是线索：用 read_session_entry 按 entryId 读原文与当时的治理记录，结论须回查原文。
```

改后（新条目号为 pi 条目号）：

```
命中 2 条（关键词：网关；从新到旧）：
- <新条目号>｜会话 <会话号>｜<Run 号> 第 1 条｜user｜<ISO 时刻>
  部署网关
- <新条目号>｜会话 <会话号>｜<Run 号> 第 3 条｜toolResult（read_file）｜<ISO 时刻>
  网关配置在 gw.yaml
片段只是线索：用 read_session_entry 按 entryId 读原文，结论须回查原文。
```

未命中、达到 20 条上限、达到总字节上限三种提示行不变。

### 4.3 read_session_entry 的典型输出

改前：

```
[<旧条目号>｜会话 <会话号>｜<Run 号> 第 2 条｜assistant｜<ISO 时刻>]
正文哈希：<64 位十六进制>（与 entry 回指一致）
--- 正文 ---
[thinking] 先读文件
我来改
[toolCall] edit_file（tc-1）
--- 同 Run 治理邻居（1 次工具调用）---
- edit_file（tc-1）：意图批准（human）→ Receipt 已执行，有错误
```

改后：

```
[<新条目号>｜会话 <会话号>｜<Run 号> 第 2 条｜assistant｜<ISO 时刻>]
--- 正文 ---
[thinking] 先读文件
我来改
[toolCall] edit_file（tc-1）
```

工具结果消息的头行照旧带"（工具名，出错）"；找不到条目的报错文字不变。工具的 details 去掉 contentHash 与 hashVerified 两个字段（details 不进模型上下文）。

### 4.4 随新存储不再出现的条件字句

以下字句在新存储上不再有触发条件（新存储存完整消息、不截断、思考按原样存，179），代码分支一并去掉：命中行末尾的"（该条落盘时已截断）"；读原文里文本块与思考块末尾的"（该块落盘时已截断，全文哈希 …；截断内容不得支撑确定性结论）"；思考未持久化时的"[thinking 未持久化，N 字节]"。/search 命令的"（落盘时已截断）"同理。

## 五、显示读者的变化

- 会话列表：一会话一行的安静行格式不变（时间、Run 数、会话号、用量、worker 父子后缀）；去掉待对账突出行；双写之前创建、只在旧账本里的会话不列出，末尾给一行计数提示（见第七节）。
- 历史：正文、thinking、轮次标记、工具行、折叠的工具结果、Run 结束标记的措辞与顺序不变；去掉审批拒绝行（决定记录停写）、工具行错误归类后缀（工具级分类属第二段）、M5 前会话与正文缺失两种提示。在新存储里找不到的会话给一行"该会话创建于新会话存储启用之前，只在旧账本里，这里不显示历史"。
- trace：会话头去掉待对账与落盘缺口计数，保留崩溃残留（有开始无收尾）计数；worker 会话来历行不变，新增分支会话来历行；Run 头"run.ended 缺失"改为"Run 收尾缺失"；启动快照行格式不变（系统提示哈希由全文现算，模型请求次数改为本 Run 的助手消息条数）；新增结束方式行与验证记录行；每轮一行（时刻取助手消息条目的写入时刻）；工具调用下保留提议参数，去掉审批、拒绝理由、哈希证据、回执、命令档回执、确证、熔断、分类、待对账，改为结果行（成功、出错或无结果消息）与代码快照行；去掉 Run 头下的缺口、熔断落闸与 Eval 验证判决；异常项只剩孤立的 worker 收尾与读取告警。
- replay：时间线由账本记录改为会话条目（message 与七种自定义条目），头行"事件 N 条"改为"条目 N 条"、终态改为结束方式；消息行带 Run 内序号与角色，助手消息行带停止原因与工具调用参数，工具结果消息行带成功或失败；轮次事件、请求观察、Skill 读取、意图、决定、回执、确证、熔断、撞上限与 Eval 验证判决不再出现；快照行去掉"对应条目"。未指定会话时按 Run 号跨会话扫描、同号出现在多个会话时要求消歧，行为不变。
- 找不到会话时，trace 与 replay 对只在旧账本里的会话报"创建于新会话存储启用之前，只在旧账本里（用迁移前的只读旧版查看）"，其余照旧列出已有会话。

## 六、新旧对照（180）

工具：spikes/ledger-migration/compare-readers.ts（口径与预期差异清单见同目录 README.md"读者对照"一节）。在当前代码上用假模型跑三次 headless 双写运行，得到 4 个会话（先改错、验证失败、失败自动分叉重试后改对的来源与分支会话；读不存在的文件出错后撞轮数上限；只聊天正常完成），旧读法取 86ae1ee 的只读工作树。在服务器上运行，提交 f016728：

| 读者 | 比较项 | 一致 | 预期差异计数 | 清单外差异 |
|---|---|---|---|---|
| 双写对照（第一段工具） | 4 个会话 | 4 | — | 0 |
| search_sessions | 5 组关键词 | 5 | 末行去掉"与当时的治理记录" 4，条目号换编号 12 | 0 |
| read_session_entry | 15 条消息 | 15 | 去掉正文哈希行 15、去掉治理邻居段 15、条目号换编号 15 | 0 |
| /search 命令 | 3 组参数 | 3 | 条目号换编号 8 | 0 |
| 会话列表 | 1 | 1 | 无（样例无待对账） | 0 |
| 历史 | 4 个会话 | 4 | 工具行去掉错误归类 1 | 0 |
| trace | 4 个会话 | 4 | 会话头计数 4、审批行 4、哈希证据行 2、回执行 2、工具调用级分类行 4；新增结束方式行 4、验证记录行 2、结果行 4、代码快照行 2、分支会话来历行 1 | 0 |
| replay | 4 个 Run × 分类、时间线、自定义条目 | 12 | 停写记录 llm.request 8、turn.started 8、turn.completed 8、intent 2、receipt 2、run.limit-hit 1 | 0 |

反向核对：在 trace 的轮次行植入一处措辞改动（stopReason= 改为 stop=）后重跑，对照以非零退出码报出，trace 4 项一致数为 0；还原后源文件哈希与提交一致。

## 七、双写之前就存在的旧会话

新存储里没有这些会话。取舍：跳过并提示，不在过渡期回退到旧读法。

- 理由：新代码不读旧格式（187），第四段停写之后旧会话只由只读旧版代码读（211）；过渡期回退旧读法的代码要在第四段整体删掉，且回退期间同一列表里新旧两种口径（待对账、断号、编号）混排。
- 会话列表：只按文件名数会话根下平铺的旧事件文件（`sess_<ULID>.jsonl`，旁置正文与锁文件不算），减去新存储里有文件的，末尾一行："另有 N 个会话创建于新会话存储启用之前，只在旧账本里，这里不列出（用迁移前的只读旧版查看）"。不读旧格式内容。
- trace、replay 与历史：见第五节的提示。
- 检索（agent 可见）：不检索这些会话，不加任何提示（输出口径冻结）。

## 八、双写期检索的筛选

跑批器作废一步时把会话根下不在保留清单里的条目移到隔离目录。新存储的会话文件在按工作目录编码的子目录里：作废的是第一次出现该子目录的尝试时整个子目录被移走；子目录已在保留清单里之后，作废尝试的新文件留在原处。检索若只看新存储，这类作废尝试会被重做时的 agent 检索到。

处理：双写期间，检索（扫描与按条目号读原文）只看旧账本里仍有事件文件的会话（hasLegacyEventFile，只查文件是否存在）；跑批器作废时移走的是旧格式文件，这些会话随之被排除。代价是检索在双写期对旧账本文件有一处存在性依赖；跑批器的文件操作改为移动新存储文件之后、停写旧账本之前须去掉这道筛选（代码注释已写明）。会话列表、trace、replay、历史不加这道筛选。

跑批器现有的"作废一步时清掉这次尝试的痕迹"一例覆盖的是第一种情形（整个子目录被移走），去掉筛选时该例仍通过；第二种情形由 session-search.test.ts 的专门用例覆盖（见 9.2 的 M3）。

## 九、测试与变异

### 9.1 测试

测试会话数据一律用第一段的夹具经真实写者写进新存储；trace、replay 与检索工具的主用例另经真实 Adapter 跑一次、同时接旧账本与新存储写者。

| 文件 | 用例 | 覆盖 |
|---|---|---|
| memory/session-search.test.ts | 11 | 从新到旧、多词与、大小写、条目号与 Run 内序号（第二个 Run 从 1 起）、角色过滤、思考与工具调用名可检索、元字符字面匹配、完整存储不截断、上限即停、工具与时间过滤、分支复制段不重复命中、旧账本事件文件被移走的会话与双写之前的旧会话不检索、撕裂末行不产出命中且文件不改 |
| memory/search-tools.test.ts | 7 | 两个工具说明与注册说明逐字；search_sessions 与 read_session_entry 典型输出逐字；20 条与字节上限；完整原文不截断、找不到条目、给错会话号；经真实 Adapter 调用 |
| application/search.test.ts | 3 | /search 排版逐字、role 与 limit、终端净化 |
| persistence/session-list.test.ts | 7 | 摘要字段、ULID 解码、Run 级五类分类与正常、worker 父子、tool 与 class 过滤、时间过滤与排序（写入先后与创建时间相反）、撕裂末行文件不改、旧格式平铺文件与写了一半的文件头不算会话 |
| application/session-list.test.ts | 3 | 安静行逐字与顺序、过滤器透传、旧会话计数提示 |
| application/history.test.ts | 5 | 时序交织（期望行与迁移前相同）、上限折叠、单条上限、出错工具与合成失败与撞上限、分支只画自己的部分与旧会话提示 |
| cli/trace.test.ts | 7 | 真实双写运行的整份报告、参数截断、崩溃残留、撞上限与合成失败与快照与验证、只读（撕裂末行文件不改）、找不到会话与旧会话提示与 --run、读取告警与分支会话 |
| cli/replay.test.ts | 6 | 真实双写运行的时间线（每个条目恰好一行）、七种自定义条目原位呈现、崩溃残留、只读、找不到与消歧、子进程端到端 |
| cli/trace-workers、trace-mcp、usage-view、content-view | 1 + 1 + 1 + 1 | worker 父子、MCP 投影、用量与启动快照、带正文开关 |

另改的既有测试：tui/history.test.ts（夹具改为异步）、tui/session-view.test.ts（只改 /sessions 一例，续跑各例未动）、cli/content-gap.test.ts（去掉 trace 与 replay 的缺口断言，只留续跑部分）、cli/legacy-memory-fields.test.ts（旧会话在列表只计入提示、trace 与 replay 报"只在旧账本里"）、persistence/retired-kinds.test.ts（退役记录一例的 replay 部分改用旧纯投影 buildRunReplay）、application/workers-recovery-e2e.test.ts（去掉会话列表与 trace 两处显示断言，改由 trace-workers 与 session-list 的新用例覆盖）。

改写旧断言时逐个回看：旧用例断言的是治理、回执、缺口的，改为断言这些内容不再出现（trace 与 replay 的主用例各列一组）或删去；保留下来的断言都能被 9.2 的某一处变异打红，没有变成恒真。

### 9.2 变异反向验证

每次只植入一处，在服务器上跑 9.1 所列 15 个读者测试文件（M3 另加 src/eval/stream-runner.test.ts，单独与检索测试一起重跑以确定用例名），记下变红的用例；以 git checkout 还原后按 sha256 比对源文件，11 处全部逐字一致，工作树干净。

| 变异 | 精确变红的用例 |
|---|---|
| M1 Run 内序号少数一（从 0 起） | /search 排版；replay 真实双写时间线；search_sessions 典型输出逐字；read_session_entry 典型输出逐字；从新到旧逐会话；Run 内序号第二个 Run 从 1 起；角色过滤；元字符字面匹配；分支复制段不重复命中；撕裂末行不产出命中（10 例） |
| M2 不跳过分支会话的复制段 | 历史：分支会话只画自己的部分；trace：读取告警与分支会话；检索：分支复制段不重复命中（3 例） |
| M3 去掉双写期检索筛选 | 检索：旧账本事件文件已被移走的会话不检索（1 例；跑批器那一例不变红，原因见第八节） |
| M4 命中行去掉"Run 第 N 条" | search_sessions 典型输出逐字 |
| M5 命中末行恢复"与当时的治理记录" | search_sessions 典型输出逐字 |
| M6 read_session_entry 忽略给定的会话号 | read_session_entry：给错会话号也找不到 |
| M7 读取前修掉撕裂末行（模拟 pi 的就地修复） | replay 只读；trace 只读；检索撕裂末行文件不改；会话列表只读（4 例） |
| M8 列表按文件路径（写入先后）排序 | 会话列表安静行从旧到新；时间过滤与排序（2 例） |
| M9 摘要不记失败分类 | 过滤器透传（application）；摘要字段；Run 级五类分类；tool 与 class 过滤（4 例） |
| M10 工具行不补结果 | 历史时序交织；出错工具与合成失败；TUI /resume 历史（3 例） |
| M11 旧会话计数不减去新存储里有的 | 会话列表旧会话计数提示 |

## 十、verify 的实际运行

### 10.1 服务器（交付依据）

阿里云 8 vCPU、31 GB 内存、Node 24.12.0，专属目录从本机 git bundle 取提交 f016728 后强制检出（工作树与提交一致）。跑前 pgrep 匹配到另一目录下两个等待测试的内存采样循环（无测试进程），并发按保守取 2。

- lint 通过（检查 385 个文件）；
- check 通过（18 秒）；
- 测试：`node --test --test-concurrency=2 "src/**/*.test.ts"` 144 秒，1095 个用例，1093 通过、0 失败、2 跳过（2 个仅 Windows 的 .cmd 用例）；
- deps 通过（401 个模块、2734 条依赖、无违规）。

提交之前在同一台机器上对当时的工作树（此后只改了一行注释与 spikes）跑过一次全量，结果相同（1095 个用例、0 失败、2 跳过，测试 184 秒）。读者对照（第六节）与变异（9.2）也在这台机器上运行。

### 10.2 本机

本机只做 tsc 类型检查、biome 与依赖规则检查（均通过），测试全部在服务器上跑。

## 十一、已知情况

- 工具级失败分类（Q4）属第二段：本段会话列表的 --class 只按 Run 级分类过滤，trace 工具调用不再有分类徽章。第二段交付工具级分类后，summarizeSessionView 与 trace 的工具调用行可直接接入。
- session-view.ts 另写了一份 Run 级分类的事实装配（判据函数仍是 classification.ts 的同一个），与第二段改判定时可能新增的同类装配重复，两段合并时收成一处。
- 思考不持久化选项：新存储的写者存完整消息、不按该选项剥去思考，打开该选项的运行在历史、trace 带正文与检索里会显示思考全文（旧读法显示"未持久化"）。
- 条目号：新条目号为 pi 的 uuidv7；分支文件复制段与来源同号，读者已按复制段剔除，跨会话按条目号定位不会命中复制段。
- spikes/mcp-acc 与 spikes/tui-acc 的入库探针读旧会话文件，不在 verify 内，本段未动。
