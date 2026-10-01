# 会话检索的改进（基线 18ab0ce）

范围：决策 339 的七点结论。基线为 claude/build-1-settings 的 18ab0ce（三层设置、路径模块、程序状态移入 .pigeon/state/）。只动会话检索相关的文件；记忆、沙箱及工程设施、钩子各段的内容不在本段。

## 一、提交

| 提交 | 内容 |
|---|---|
| 70a904e | 抽取模块、缓存、检索改写、会话目录与 list_sessions、三件工具的说明、装配与 explorer 角色、全部用例 |
| bf3c3b0 | docs/configuration.md 补"会话检索"一节 |

本审计文件在其后单独一个提交。

## 二、改动清单

### 1 state：可搜文本与目录信息的抽取（新增 src/state/session-search-text.ts）

- 纯函数 extractSessionSearch(view, createdAt)：从会话原生视图抽出
  - 对话正文：user 与 assistant 消息的文字块；思考、工具调用（名字与参数）、图片、未知块都不进；
  - 工具输出：toolResult 消息的文字块，与正文分开存放；
  - 三件检索工具（search_sessions、read_session_entry、list_sessions）的工具结果一律跳过（打开工具输出时也不进）；它们的调用在助手消息的工具调用块里，本就不进正文；
  - 目录信息：会话号、开始时间（调用方给，与会话排序同一口径 sessionRefTime）、第一句使用者的话（原文）、改动过的文件（edit_file 成功的调用取参数 path；run_command 成功结果 details.fileChanges 的 added、modified、removed；反斜杠换正斜杠、去掉开头 ./，按首次出现去重）。
- 三件工具的名字常量移到这里（state 是叶子，抽取模块要用它们跳过自身输出）；memory/search-tools.ts 原样再导出，原有 import 不变。
- state/paths.ts 新增 sessionSearchCacheDirOf(root) = .pigeon/state/search-cache。

### 2 persistence：缓存（新增 src/persistence/session-search-cache.ts）

- 每个会话两份缓存文件：<会话号>.json（格式版本、来源戳、目录信息、对话正文）与 <会话号>.tools.json（格式版本、来源戳、工具输出）。不搜工具输出时只读前一份。
- 来源戳 = 会话文件路径、大小、修改时间；在读会话文件之前取，读的过程中文件被追加时戳比内容旧，下次比对不符即重抽。
- 判定未命中：文件不存在、不是 JSON、形状不符（typebox 编译的校验）、格式版本不是当前值（SESSION_SEARCH_CACHE_VERSION = 1）、来源戳不符。未命中即经只读读取器读会话文件重抽，两份一起覆盖写回。
- 写入走 persistence/atomic-write.ts 的 writeFileAtomic（同目录临时文件写满、fsync、改名）；写缓存失败吞掉（只是少了缓存），读会话文件失败该会话跳过，都不中断检索。
- 读取函数可注入（readView），用例以计数验证命中缓存时不读会话文件。

### 3 memory：检索改写（src/memory/session-search.ts）

- 查询：keywords、includeToolOutput（缺省 false）、roles（在范围之内再筛；给 toolResult 即连同工具输出）、excludeSessionId、since/until（会话创建时间，含两端）。删去原 filters 中按工具与失败分类筛会话（需整份原生视图，与缓存不合；生产代码无调用方）。
- 关键词任一命中即算；按小写去重；每条命中带 matchedKeywords（取查询里的写法）。排序：命中的不同关键词数从多到少 → 消息时间从新到旧 → 会话与会话内先后从后到前。
- 返回值由命中流改为 { hits, total }（排序须看完全部会话，流式上限即停不再成立）；total 为命中总数，供"共 N 条命中，只列出前 M 条"。
- candidateRefs 抽出：排除给定会话、按创建时间预筛，检索与目录共用。

### 4 memory：会话目录（新增 src/memory/session-directory.ts）

- listSessionDirectory：排除当前会话，按开始时间范围与改动文件路径（大小写敏感的字面子串，前缀即其特例）筛选，从新到旧，返回前 limit 个与总数。与检索共用缓存（只读 <会话号>.json）。

### 5 memory：三件工具（src/memory/search-tools.ts）

- search_sessions：参数 keywords（1–8 个）、includeToolOutput、limit（≤20）；去掉 role 参数。输出每条加"｜命中：…"，标题写范围与排序；超上限时"共 N 条命中，只列出前 M 条"；零命中时提示可打开 includeToolOutput。details 增加 total，hits 照旧带 sessionId（分析代码读这一字段，未受影响）。
- read_session_entry：行为不变，可读任一会话（含当前会话）；说明改写。
- list_sessions（新增）：参数 since、until（YYYY-MM-DD 按 UTC 当天，until 取当天结束；其余按 ISO 解析，解析不了即域错误）、path、limit（≤20）。每个会话一行编号、开始时间（UTC，到分）、第一句（空白压平，截断到 60 字），下一行改动文件（最多列 10 个，超出写"等 N 个"）；末行写"未截断……"或"已截断：共 N 个……"。
- SessionToolsOptions 增加 cacheDir 与 currentSessionId；sessionToolRegistrations 增加 list_sessions（read 档，范围同为会话目录）。

### 6 装配与入口

- application/runtime.ts：三件工具同一开关（sessionSearch，缺省开），一起注册、一起进工具清单；传 cacheDir = sessionSearchCacheDirOf(治理根)、currentSessionId = 本运行面的会话号（续接时会话号不变，同一文件，同样排除）。系统提示里提到检索的那一句加上 list_sessions。
- orchestration/roles.ts：explorer 角色的工具加 list_sessions（与另两件同组）。
- application/search.ts（/search 命令，终端界面与 --line 共用）：走同一套检索与缓存；新增 --tool-output；--role toolResult 隐含打开工具输出；输出带范围、排序说明与每条命中的关键词；超上限时报总数。/search 不排除当前会话（使用者在终端里查，查到当前会话无害），见"待确认的取舍"。

### 7 文档

- docs/configuration.md 新增"会话检索"一节：三件工具、缺省范围（排除当前会话、只搜对话正文、工具输出如何打开、检索工具自身输出不进）、缓存位置与形状、哪些入口带。

### 8 实验跑批器与分析代码

- 跑批器经 runHeadless 装配，开关仍为 sessionSearch，未改代码。能检索的两格工具清单多出 list_sessions（eval/stream-agents.test.ts 的预期清单随之更新）。
- 分析代码（eval/analysis/pigeon_analysis/sessions.py）只读 search_sessions 结果 details.hits[].sessionId，字段保留，无需改动；list_sessions 的调用不计入两件检索工具的调用次数（该统计按工具名点名）。

## 三、用例

- 新增用例 14 条：
  - persistence/session-search-cache.test.ts（新文件）6：命中缓存时不读会话文件；大小或修改时间变了即重抽（只改修改时间、只改大小各一段）；版本不符重建；损坏重建（不是 JSON、形状不对、只坏工具输出一份）；缓存目录不可写时照常；6 个进程并发首次检索同一批会话后缓存全部有效、无临时文件残留。
  - memory/session-search.test.ts 4：排除当前会话；同数按消息时间从新到旧（不按会话先后）；三件检索工具自身输出与调用参数不进检索（含打开工具输出时）；创建时间范围。
  - memory/search-tools.test.ts 3：工具层排除当前会话且 read_session_entry 仍可读当前会话；list_sessions 典型输出逐字（第一句截断、改动文件来自 edit_file 成功写入与 run_command 文件变化、失败的 edit_file 与 read_file 不算）；list_sessions 按时间与路径筛选、截断说明、时间写错报错。
  - application/session-search-switch.test.ts 1：经 runHeadless 续接同一会话时 search_sessions 与 list_sessions 都不列出该会话，缓存落在 .pigeon/state/search-cache/。
- 删除用例 2 条（memory/session-search.test.ts"复用 SessionListFilters：tool…since…"与"…class…"）：按工具与失败分类筛会话的能力删去；since 改由"创建时间范围"一条覆盖。
- 改写：
  - memory/session-search.test.ts：首条改为任一命中与排序；角色过滤一条改为"缺省只搜对话正文……工具输出显式打开或按 toolResult 过滤才搜"；上限一条改为前 limit 条与总数；Run 内序号一条的预期顺序改为从新到旧。
  - memory/search-tools.test.ts：说明冻结改为三件工具的新说明与注册描述；典型输出加"命中："与范围、新增打开工具输出与两种零命中文字；上限一条改为"共 25 条命中，只列出前 20 条"。
  - application/search.test.ts：排版一条改为新格式，覆盖 --tool-output 与总数提示。
  - application/thinking-omission.test.ts：选项缺省时原断言"检索能搜到思考正文"，按 339 ② 改为"读原文可见思考、检索搜不到"（语义有意改变）。
  - application/session-search-switch.test.ts、runtime-edit-mode.test.ts：系统提示那一句与三件工具的开关。
  - orchestration/roles.test.ts：explorer 带 list_sessions。eval/stream-agents.test.ts：两格工具清单。eval/stream-runner.test.ts：检索调用改为新返回值（断言不变）。state/paths.test.ts：加缓存目录一行。
- 总数：基线 1507 条，现 1519 条（+14 −2）。

## 四、变异验证

每次只植入一处，跑本段相关的 5 个用例文件（必要时加上对应文件），跑完还原。

| 变异 | 结果 |
|---|---|
| 检索不排除给定会话（candidateRefs 的排除条件恒假） | session-search.test.ts"决策 339 ①：排除当前会话…"、search-tools.test.ts"决策 339 ①：search_sessions 与 list_sessions 排除当前会话…"、session-search-switch.test.ts"决策 339 ①⑥…续接…"变红 |
| 装配不传当前会话号 | session-search-switch.test.ts"决策 339 ①⑥…"精确变红 |
| 排序不看命中关键词数 | session-search.test.ts"决策 339 ④：任一关键词命中…"与 search-tools.test.ts 典型输出两条变红 |
| 同数改为从旧到新 | "④ 任一命中…""④ 同数时按消息时间…"等 6 条变红 |
| 全部关键词命中才算 | "④ 任一命中…"与典型输出两条变红 |
| 工具输出缺省也搜 | "② 缺省只搜对话正文…"、典型输出、/search 排版等 4 条变红 |
| 思考内容进正文 | "② 缺省只搜对话正文…"与 thinking-omission"选项缺省…检索不搜思考内容"两条变红 |
| 检索工具自身输出照收 | "③ 三件检索工具自身的输出永不进检索…"精确变红 |
| 缓存只比路径（大小与修改时间都不比） | session-search-cache.test.ts"会话文件大小或修改时间变了即重抽…"精确变红 |
| 缓存不比修改时间 | 同上精确变红 |
| 缓存不比大小 | 同上精确变红 |
| 缓存不查格式版本 | "缓存格式版本不符即重建…"精确变红 |
| 读缓存遇到损坏抛错（只吞文件不存在） | "缓存损坏时丢弃重建…"与"缓存目录不可写…"两条变红 |
| 失败的 edit_file 也算改动过的文件 | "⑤ list_sessions 典型输出逐字…"变红 |
| 目录不按路径筛 | "⑤ list_sessions 按时间范围与文件路径…"精确变红 |
| 目录不报截断 | 同上精确变红 |
| 写缓存改为直接写目标文件（不经临时文件改名） | 不变红：6 个进程并发写同一批约 100 KB 的缓存文件，三次重复都未观测到残缺内容（读方读到残缺即判为损坏重抽，最终文件由最后一个写者写满）。原子性由 writeFileAtomic 保证，该函数有自己的用例（写到一半中断） |

施工中另发现"同数按消息时间"一条偶发失败：条目时间是写入时刻，夹具写者在第一条助手消息之前延迟落盘，两会话的条目时间可能与写入顺序不一致。改为每段写完关闭、相隔几毫秒再写下一段，连跑 15 次全过。

## 五、耗时量测

量测脚本不入库：用夹具写者造 150 个会话文件，每个约 253 条消息（1 条任务、120 轮助手消息加工具结果、12 条使用者消息），工具结果每条约 3 KB，合计 77.9 MiB；经 search_sessions 与 list_sessions 工具本身计时（3 个关键词，4 核容器，Node 22.22）。两次运行取值相近，列第一次：

| 场景 | 耗时 |
|---|---|
| 基线实现，零命中关键词（全量扫描，对照） | 0.80 s |
| 本段，不落缓存（cacheDir 缺省） | 0.77 s |
| 只搜正文，首次（无缓存，含写两份缓存） | 1.59 s |
| 只搜正文，再次（有缓存） | 0.05 s |
| 连同工具输出，首次（无缓存） | 1.72 s |
| 连同工具输出，再次（有缓存） | 0.56–0.61 s |
| 会话目录，首次（无缓存） | 1.57 s |
| 会话目录，再次（有缓存） | 0.03 s |

- 缓存共 68 MiB（工具输出几乎全文入缓存）。首次多出的约 0.8 s 是写缓存（每份 fsync）。
- 缓存文件的校验起初用 Value.Check，有缓存时只搜正文 0.17 s，其中约 0.13 s 花在校验；改为 typebox 编译的校验后为 0.05 s。

## 六、verify

容器内 `npm i -g npm@11` 后 `npm ci --replace-registry-host=always`，`npm run verify`：

- lint：通过；check：通过；deps：0 违规（570 个模块）。
- test：1519 条，通过 1506，失败 3，跳过 10。
- 3 条失败均为已知现象，与本段无关：eval/stream-profiles.test.ts 两条（Node 22）、eval/stream-workspace.test.ts"家目录下的用户级文件删不掉…"（以 root 运行）。
- 跳过 10 条：没有 docker 守护进程或实验镜像的真容器用例，与以 root 运行时挡不住权限的用例（既有跳过条件）。

## 七、与施工说明或决策的偏离

- 无与决策冲突之处。
- 施工说明第 5 点"有条数上限"：沿用检索的 20。
- search_sessions 去掉了 role 参数（原 user/assistant/toolResult）。说明未要求删；工具输出改由 includeToolOutput 打开后，role=toolResult 与之重叠，保留会让模型面对两种打开方式。/search 命令保留 --role（人用），并让 --role toolResult 隐含打开工具输出。见"待确认的取舍"第 2 条。

## 八、待确认的取舍

1. 参数名 includeToolOutput（布尔，缺省 false）。选项：scope 枚举（conversation / all）。理由：只有"开 / 关"两态，布尔最直接。
2. search_sessions 去掉 role 参数。选项：保留 role（user / assistant）作范围内的筛选。理由：见上节；需要时加回不影响缓存与排序。
3. 思考内容在任何参数下都不搜，只能经 read_session_entry 读到。选项：另加参数打开。理由：339 ② 写明正文不含思考内容，打开的只有工具输出。
4. 对话正文只算 user 与 assistant 两种角色；compactionSummary、branchSummary、custom 等上游扩展消息不搜（Pigeon 运行面不写这类消息）。工具输出只算 toolResult。
5. "同数按新到旧"按消息时间，不按会话先后；同一时刻按会话从新到旧、会话内从后到前。理由：说明写"按新到旧"，消息时间最贴近字面。
6. 排除当前会话按会话号：worker 的检索排除 worker 自己的会话，不排除派它的父会话（父会话也在进行中）。理由：339 ① 只说当前会话；父会话里有父 agent 的讨论，对 worker 可能有用。
7. /search 命令（人用）不排除当前会话。理由：339 针对 agent 的工具；人在终端里查到当前会话不构成自我命中的问题。改法：runSearchCommand 收当前会话号即可。
8. 会话目录的"改动过的文件"只取成功的 edit_file 与成功的 run_command 结果；超时或出错的 run_command（结果里没有 details）不计，take_worker 叠加回来的改动不计（文件变化在 worker 自己的会话里）。
9. 路径筛选为大小写敏感的字面子串（前缀是其特例）；路径按记录原样（相对或绝对）比较，只把反斜杠换成正斜杠、去掉开头 ./。
10. 时间参数 YYYY-MM-DD 按 UTC 当天；输出时间也用 UTC 并在标题注明。理由：与其余输出（ISO 时间）一致，不依赖本机时区。
11. 缓存按会话号命名（会话号限于字母数字与 . _ -，可直接作文件名）；同号文件路径不同时以来源戳里的路径区分，必要时重抽。会话文件被移出会话根（跑批器作废尝试）后，其缓存文件不清理，留在原处不再被读。理由：清理须列缓存目录、与并发检索交错，收益小；删整个目录即可重建。
12. 每次缓存未命中时两份一起重抽重写（只搜正文时也写工具输出那一份），使下一次打开工具输出时也能命中。代价是首次检索多写一份。
13. 写缓存沿用 writeFileAtomic（含 fsync）。选项：不 fsync 只改名。理由：复用现有原子写入，首次多出的耗时一次性；缓存丢失只需重建，若觉首次偏慢可改为不 fsync。
14. 缓存不设总量上限（量测中 150 个会话约 68 MiB，与会话文件同量级）。

## 九、待过目的文字

三件工具说明的最终全文（逐字）：

search_sessions：

> 检索本项目以前会话里的对话（不含当前会话）。能找到的：以前会话里的讨论、试过的做法及其结果、使用者说过的话（要求、偏好、纠正）。找不到的：当前任务的背景（以当前任务的说明为准）、最新的代码（以前会话里看到的代码可能已经过时）。代码现状请直接读代码，代码的来历用 git log 与 git blame。缺省只搜对话正文（使用者的话与模型回复的文字，不含思考内容与工具调用）；要连同以前的工具输出（命令输出、读过的文件内容等）一起搜，给 includeToolOutput: true。关键词大小写不敏感、按字面子串匹配、不支持正则，最多 8 个，任一命中即列出；结果按命中的关键词数从多到少、同数从新到旧排序，每条标出命中了哪些关键词，最多 20 条。命中片段只是线索，结论必须用 read_session_entry 按 entryId 回查原文；想先浏览以前有哪些会话、哪些会话改过某个文件，用 list_sessions。

read_session_entry：

> 按 entryId 读取以前会话里一条消息的完整原文（含思考内容与工具输出）。entryId 来自 search_sessions 的命中；可附 sessionId 加速定位。原文是当时的记录，其中的代码与文件内容可能已经过时：代码现状请直接读代码，代码的来历用 git log 与 git blame。

list_sessions：

> 列出本项目以前的会话（不含当前会话），从新到旧，每个给出会话编号、开始时间（UTC）、第一句使用者的话（截断到 60 字）与改动过的文件（edit_file 的写入与 run_command 报告的文件变化）。可按开始时间筛选（since、until，写 YYYY-MM-DD 或 ISO 时间，含两端），也可按文件路径筛选（path：改动过的文件路径里含这一段即算，写前缀亦可）；最多 20 个，超出时说明共有多少个。用来先浏览以前做过什么、哪些会话动过某个文件，再用 search_sessions 检索、read_session_entry 读原文。能找到的：以前会话里的讨论、试过的做法及其结果、使用者说过的话（要求、偏好、纠正）。找不到的：当前任务的背景（以当前任务的说明为准）、最新的代码（以前会话里看到的代码可能已经过时）。代码现状请直接读代码，代码的来历用 git log 与 git blame。

注册描述（审批面板等处的短说明）：

- search_sessions：检索本项目以前会话的对话（关键词字面匹配，缺省不含工具输出）
- read_session_entry：按 entryId 读取以前会话的消息原文
- list_sessions：列出本项目以前的会话（可按时间与改动过的文件筛选）

系统提示里提到检索的那一句（检索开着时）：

> 需要以前会话里的信息时，可用 list_sessions 浏览本项目以前的会话，用 search_sessions 按关键词检索以前会话里的对话，再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。

## 十、顺带发现（未修）

- 夹具写者（及其背后的会话写者）在第一条助手消息之前延迟落盘，条目时间是写入时刻而非调用时刻；依赖跨会话条目时间先后的用例须逐段关闭再写（见第四节末）。运行中的会话在第一条助手消息之前，文件里也还没有本次任务的内容。
- src/memory/index.ts 的模块头注释仍写"两个 read 档工具"；该桶文件可能由记忆一段改动，本段未动，也未导出 session-directory.ts（生产代码经 search-tools.ts 使用）。
- tui/command-table.ts 中 /search 的用法提示仍为"/search <关键词>"，未列 --tool-output 等选项（命令无参数时打印的完整用法已更新）。

## 十一、未做的事

- 写缓存非原子时的并发损坏未能用用例稳定复现（见第四节最后一行）。
- 量测脚本不入库（按说明不进 verify）；造数据的规模与计时方式见第五节。
- 未清理会话文件已不在会话根下的旧缓存文件（见"待确认的取舍"第 11 条）。
