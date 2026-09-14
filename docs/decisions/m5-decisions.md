# M5 开工裁决（2026-09-13）

- 定位：M5 开工前六件待盘裁决：1 消息文本持久化形态、2 Session Search 内容级检索、3 Memory 形态与预算、4 Skill Catalog 与资源约束、5 llmContext 摘要与 usage 落盘、6 TUI 历史渲染。逐件盘、逐件裁决
- 裁决：项目负责人；每件先列事实、选项、权衡、推荐，裁决后落本文件与 docs/roadmap/decisions.md（037 起，先标"设计"，施工落地后改"事实"）
- 既定事项（不盘）：注入快照冻结（InjectionSnapshot v2 memory / skills 占位数组，M5 填实升 v3 走 M0 迁移管线）；Skill 不得扩大 Tool Policy（§3.1，权限只经 §3.9 六档）；历史进 Session Search 不进 system prompt；学习产物默认暂存（§3.4）
- 基线：ba94b53（dev = main = origin），verify 323 测试全绿

## 第 1 件：消息文本持久化形态 = B（旁置内容文件 + entry 哈希回指）（索引 037）

### 事实

- Event Log v5，每会话一文件，13 记录族；entry 族只存 (runId, runSeq) 与 role，不存文本（013）。Adapter 在 message_end 时刻持有完整消息对象，user / assistant / toolResult 三种角色都经过这一点，深拷贝纪律已有
- 上游 0.84.4 消息形状：UserMessage.content 为 string 或 (Text|Image)[]；AssistantMessage.content 为 (Text|Thinking|ToolCall)[] 加 usage、stopReason、model 等；ToolResultMessage.content 为 (Text|Image)[] 加 isError、details
- 已落盘的文本：intent.rawArgs 与 tool.proposed.args（edit_file 新内容本已在日志里）。新增敏感面 = 用户输入、模型正文、read_file / exec 输出
- 读路径：整文件 readFileSync、逐行 JSON.parse、逐条 typebox 校验。listSessionSummaries 对每个会话完整物化；JsonlEventLog 构造时整读恢复治理幂等索引
- ROADMAP §6 SkillCandidate 预留 sourceEntryIds 与 sourceContentDigests；§3.3 要求结论回查原始消息与工具结果，截断的不得支撑确定性结论
- 上游自带 harness/session/jsonl（JsonlSessionRepo）与 search/scanning（基于上游 Entry 类型的 SessionSearch），属 harness 层，Pigeon 只经 Agent 核心公开面接入（§2）
- 体积估算（未实测）：单会话治理与骨架约 300 条 / 150 KB；正文含工具输出约 0.5 到 1 MB；正文约为治理记录 4 到 6 倍

### 选项

- A 同文件加法式：v6 给 entry 加可选 content，或新增 message 族同键写同一 jsonl。好处：字面单一文件、身份与内容原子同写、崩溃语义与迁移管线现成、trace / replay 渲染零新增 IO。坏处：每条冷路径与会话打开都为用不到的文本付解析与校验成本，随工具输出线性增长；止损手段是固定字段顺序做前缀跳读，但读侧与序列化字段顺序耦合
- B 旁置内容文件：`<sessionId>.messages.jsonl` 存正文，entry 加法式加 contentHash 回指；Event Log 仍是唯一状态权威。好处：冷启动结构上零增量、Session Search 有单一记录类型的扫描面、内容可清除或迁走而证据链靠哈希仍可校验。坏处：多一个持久化模块（约 150 到 200 行加测试）、两个文件写序要定规矩、冷侧多派生一类"内容缺失"缺口并在三处标注
- C 只存哈希与截断摘要：违反 M5"完整历史进入 Session Search"与 §3.3，排除
- D 启用上游 harness 会话存储：违反 §2、§3.5（Pi transcript 不能成事实源）、009 不双写，且绑定上游格式跨升级，排除

### 权衡要点

- 路线图杠杆可以让抉择变简单但各有代价：收窄"完整历史"为对话正文完整、工具输出有界，代价在 M6 / M7 蒸馏质量；允许派生索引落盘，引入缓存失效且每会话仍两个文件，不比 B 简单。均不采纳
- 冷启动延迟不是持久化本身带来的，而是"文本与治理记录同文件且冷路径整读"带来的：B 零增量；A 加前缀跳读只多读字节；A 纯粹版随文本线性增长
- 选 B 的理由：冷启动零增量靠结构保证而非实测或脆弱约定；隐私与证据链可分离；第 2 件直接受益；工程量差异约半天不构成理由。不跑体积探针

### 裁决（同 037 结论，含 045 修订）

1. 存 text 块与 toolResult 文本；thinking 块与 text 同形态持久化、默认开可关（045 修订，原为不存只记 hasThinking）；图片只记 mimeType、字节数、哈希
2. 按内容块设大小上限，超出截断并标 truncated 加全文哈希，绝不静默丢弃；阈值施工侧给默认值
3. entry 无条件带 contentHash（内容块规范序列化 sha256），Event Log 升 v6 加法式；旧会话缺省视为"M5 前会话，无文本"
4. 观察族耐久，同步写不 fsync；先写内容文件再写 entry；entry 有哈希而内容缺失由冷侧派生为缺口，trace / replay / resume 按 012 / 021 口径标注
5. 写入口径：EventLogSink.appendEntry 入参带 content，JsonlEventLog 决定落盘位置；Adapter 改动最小；034 约束不变

### 对后续裁决的影响

- 第 2 件 Session Search：扫描面 = 内容文件，命中以 EntryId 回接治理记录
- 第 6 件 TUI 历史渲染：读的是内容文件
- 可逆性：哈希定下后，A / B 互转是一次性文件级搬迁（同 018 处理旧账本），不是不可逆决定

### 施工后待补

- 037 由"设计"改"事实"，补锚点与测试文件；证据落 docs/audits/（新路径，带基线 commit 后缀）
- 变异反向验证：内容缺失缺口派生、截断可见标记、写序（先内容后 entry）三处精确变红

## 第 2 件：Session Search 内容级检索 = C（全文扫描先行，接口为命中流）（索引 038）

### 事实

- M4 的 Session Search 只有会话列表加四个过滤器（tool / class / since / until，state/session-summary.ts SessionListFilters），无内容级检索，无模型查询通道
- 037 后检索面 = `<sessionId>.messages.jsonl`，每条带 EntryId、runId、runSeq、role、内容块、truncated、哈希
- M5 交付"完整历史进入 Session Search 而不是塞 system prompt"意味着模型必须能主动查，即需要工具；§3.3 命中只是线索，结论回查原文
- 已注册工具只有 read_file / edit_file；六档排律 read 档自动放行（tools/policy.ts tier === "read"）
- 上游 0.84.4 search/scanning：逐会话流式扫 entry、match / createHit 可注入、命中带 snippet、AsyncIterable 返回；绑定上游 Entry / SessionStorage 类型不能直用，形态可参照
- 本机 Node 24.12 自带 node:sqlite（experimental 警告），FTS5 默认分词不切中文需 trigram

### 选项

- A 全文扫描：成本随总正文线性，百 MB 秒级
- B 建索引（node:sqlite FTS5 或自建倒排）：派生存储触碰 015，需失效与重建，experimental 依赖
- C 先扫描后索引：接口做成命中流，索引作为可重建缓存等实测慢了再加

### 权衡要点

- 复杂度：无新依赖、无索引、无后台、无新状态，约 150 + 80×2 + 50 行加测试
- 先例：上游 scanning 同形态；Claude Code 对代码库只用 grep / glob 加 Read；Aider 的 repo map 不用向量；Sourcegraph Cody 曾上 embedding 后撤回。局限：关键词不懂同义词、延迟线性、需流式逐行读
- 语义检索演进形状：每条消息按 EntryId + 哈希嵌入向量存旁置索引，查询取最近邻仍返回 EntryId 命中流；不动的是内容文件、命中流接口、读原文工具、/search、片段非证据；新增的是增量索引器、向量文件、embedding 提供方、模式开关与 score。三处不顺：索引落盘与 015 冲突需补裁决；文本出机器是新治理面或几百 MB 本地运行时依赖；算向量的时机（写入时 / 搜索时 / 后台需 Job 抽象）。铺路：搜索输入结构化对象、命中预留 score
- 产品先例（截至 2026 年中，未联网核实）：代码库语义检索有 Cursor / Copilot / Windsurf / Continue / Roo Code，不做或撤掉的有 Claude Code / Aider / Cody；会话历史语义检索主流 coding agent 基本没做，做的是 Mem0 / Letta / Zep 这类记忆基础设施，对应 M10 外部 Memory Provider 定位；Pigeon 的差异在命中后能取回当时审批 / 回执 / 分类

### 裁决（同 038 结论）

1. 全文扫描，从新到旧逐文件流式逐行读，大小写不敏感子串、多词 AND、不接受正则
2. 命中流接口 search(query, options) → AsyncIterable；命中含 sessionId / EntryId / runId / runSeq / role / 时间 / 约 200 字片段 / truncated / 可选 score；查询为结构化对象，过滤复用 SessionListFilters
3. 两个 read 档工具：搜索（上限 20 条 + 总字节上限，超限提示收窄）、读原文（按 EntryId 返回完整内容块 + 同 Run 的 intent / decision / receipt 状态）
4. /search 命令层在 application/，cli 与 tui 各接渲染面；片段经 sanitizeTerminalText
5. 范围只限本项目 .pigeon/sessions；截断记录命中标 truncated
6. 索引触发：真实数据单次搜索超约 2 秒再盘，定性为按哈希判过期的可重建缓存并与 015 对齐；语义检索归 M10
7. 落位 memory/；分层规则补一条：memory/ 可依赖 state / persistence / tools，不触达 pi-runtime / application / Actor（022 修订）

### 施工后待补

- 038 由"设计"改"事实"，补锚点；证据落 docs/audits/
- 变异反向验证：命中上限、正则拒绝（输入含元字符按字面匹配）、片段净化三处精确变红

## 第 3 件：Memory 形态与预算 = 两层存储 + system prompt 冻结注入（索引 042）

### 事实

- system prompt 在 Agent 构造时一次传入（adapter.ts 按 snapshot.context.systemPrompt），之后不变，与"Session 开始冻结"吻合
- 上游 transformContext(messages) 在每次模型调用前可改消息数组，产物不进 transcript、不产生 message_end；M1 在 snapshot.ts 留的注释写"Memory 注入在 M5（transformContext）落地"
- InjectionSnapshot 从未落盘，只在 Adapter 内存里；运行事件族无 run.started（第 5 件补）
- §2 规则 4 与 M5 完成证据：会话内新增 Memory 不改已冻结 prompt

### 选项与权衡

- 存哪：项目级 / 用户级 / 两者。取两者：项目 Memory 项目级，用户偏好用户级
- 注入位置：system prompt 追加段 / 首条 user 消息 / transformContext。取 system prompt：语义对（背景常识不是用户发言；Claude Code 的 CLAUDE.md 也在 system prompt）、缓存友好（最稳定前缀）、钩子职责单一（transformContext 留给 llm.request 只读观察与 M10 动态召回）。transformContext 也能冻结（会话开始算好、每次原样前置），代价是 user 消息语义与字节级一致的额外约束。M1 注释把静态常驻 Memory 与动态召回想成了一种
- 预算单位：精确 token / 字符估算。取字符估算，usage 落盘事后校准
- 超预算：拒绝启动 / 截断。取偏好不截断、Memory 按序装满、其余列名按需读

### 落地

- ROADMAP §M5 加"既定口径"块（含 037 / 038 / 042），M10 加动态召回经 transformContext 一句；decisions.md 042

## 第 4 件：Skill Catalog 与资源约束（索引 043）

- 七个子项：目录格式（标准 SKILL.md 加前言，与 Claude Code / pi 兼容）；加载器（自写，上游 harness 层在巡航边界外且格式百行）；启动注入（名称、简介、路径追加进 system prompt 与 Memory 同段冻结）；按需读取（三选一：放宽 read_file 围栏 / 专用 load_skill 工具 / 模型一提到就自动注入，取专用工具）；三重约束阈值（realpath 后在 Skill 目录内、单文件 64 KiB 可见截断、来源只认登记过的 Skill）；会话中途文件变更（三选一：读新的 / 拒绝 / 开会话全缓存，取拒绝，靠开会话时的哈希清单比对，落实 §2 规则 4）；scripts 只读不执行
- 复杂度：加载器加清单哈希约 120 行、system prompt 段约 30 行、load_skill 约 100 行，无新依赖；先例 Claude Code Skills / Agent Skills 规范 / pi skills

## 第 5 件：llmContext 摘要与 usage 落盘（索引 044）

- 事实补充：InjectionSnapshot 从未落盘，运行事件族无 run.started，Run 起点靠首条 turn.started 推断；transformContext 是实际上下文唯一观察点；usage 在上游 AssistantMessage 上现成
- 四个子项：快照落哪（完整含全文 / 只哈希 / 单独文件，取拆两处：全文进内容文件每会话一次，run.started 只带哈希清单）；上下文摘要（全部 id / 只条数 / 条数加指纹，取条数加滚动哈希）；观察点（transformContext / convertToLlm，取 transformContext 只读）；usage（新族 / turn.completed 加字段，取加字段）
- 复杂度约 200 行无新依赖

## 第 6 件：TUI 历史渲染与 thinking（索引 045；024 / 037 各加修订行）

- 历史渲染条数：候选"最近 N 条、N 默认 20"被 spike 数据否决。A5a 单 Text 无界 50000 格 p95 25.8ms 掉帧，A5b 每消息一 Text 200 条均值 1.0ms、p95 1.8ms；退化只在单 Text 形态，TUI 自 M2 起已是每消息一 Text，条数上限无依据。主流产品整段重画。裁决：默认全部、安全上限 500 可配
- thinking：024 不转发、037 不存的原因是 provider 不一致、非治理证据、体积大。按"账本给学习闭环消费"口径与"TUI 展示思维链"需求定为：流式转发（载荷加 kind）、持久化与 text 同形态默认开可关、流式与历史都画且视觉弱化；§3.8 不变，thinking 只是线索不是证据
- 落地：045、024 修订行、037 修订行、ROADMAP §M5 既定口径与 §M2 as-built 一句

## 施工落地（2026-09-13）

- 六件按裁决内容施工完成：decisions.md 037、038、042、043、044、045 由"设计"改"事实"，锚点与施工中的具体取值、偏差写在各条"落地"项；040、041 属 M5.5 与 M5.7，本轮未施工，仍为"设计"
- 各件"施工后待补"列出的变异点全部精确变红，另加 042 去预算判断、043 三重约束与哈希比对、044 钩子改写消息数组；逐项记录与 Kimi 真实链路验收见 docs/audits/2026-09-13-m5-ba94b53.md
- 施工中暴露、尚未裁决的事项：
  - 推理档位配置：Kimi For Coding 只在请求带推理档位时返回 thinking 块，生产装配目前不设档位，TUI 流式与历史里的 thinking 只在 streamFn 自行传档位时出现
  - 常驻 Memory 的"配置顺序"尚无配置来源，装配根缺省按文件名字典序
  - read_session_entry 与 load_skill 的域错误不进 tools/error-kind.ts 判据（tools 层不能依赖 memory / skills），失败调用冷分类落"未知"默认桶
  - OpenAI 兼容端点对现用 key 返回 401，经 reasoning_content 映射 thinking 的线路未实测

## 补充：第 4、5 件的逐子项选项（2026-09-14）

### 第 4 件 Skill Catalog 的七个子项

| 子项 | 选项 | 取 | 理由 |
|---|---|---|---|
| 目录格式 | 标准 SKILL.md 加前言 / 自定义 | 标准 | 与 Claude Code、pi 同格式，公开 Skill 直接能用 |
| 加载器 | 自写 / 借上游 harness | 自写 | 上游的在巡航边界外，格式百行，不为它放宽边界 |
| 启动注入 | 名称加简介加路径 / 全文 | 名称加简介加路径 | 追加进 system prompt 与 Memory 同段冻结 |
| 按需读取 | 放宽 read_file 围栏 / 专用 load_skill 工具 / 模型一提到就自动注入 | 专用工具 | read_file 围栏在工作区而用户级 Skill 在工作区外；专用工具天然留痕，Claude Code 的 Skill 工具同形态 |
| 三重约束 | 各自阈值 | 路径 realpath 后在 Skill 目录内、单文件 64 KiB 可见截断、来源只认登记过的 Skill 名 | 任一不满足即报错说明理由，什么都不注入 |
| 会话中途文件变了 | 读新的 / 拒绝 / 开会话时全缓存 | 拒绝 | 开会话时给目录下全部文件算哈希清单，读取时比对，不一致提示下个会话生效；§2 规则 4 的直接落实，也让"冻结版本"有证据 |
| scripts | 可执行 / 只读 | 只读 | exec 语义当时未裁决 |

留痕与不扩权：load_skill 是工具调用天然留 tool 事件，另加 skill.loaded 观察记录带哈希；Skill 是文本，工具照旧走六档，构造上不可能扩权，测试放"Skill 文本要求用被 deny 的工具"用例。局限：开会话遍历 Skill 目录算哈希，几百文件毫秒级；64 KiB 截断可配。

### 第 5 件 llmContext 与 usage 的四个子项

| 子项 | 选项 | 取 | 理由 |
|---|---|---|---|
| 快照落哪 | run.started 带完整快照含 system prompt 全文 / 只带哈希 / 单独快照文件 | 拆两处：全文以 role 为 system 的记录进内容文件每会话一次，run.started 只带哈希清单 | 治理日志保持小，全文归旁置文件，与 037 分工一致 |
| 实际上下文摘要 | 记全部消息 id 列表 / 只记条数 / 条数加指纹 | 条数、各角色条数、估算字符数、消息内容哈希的滚动哈希、system prompt 哈希 | 指纹能与内容文件按哈希对上，又不会每次几十 KB |
| 观察点 | transformContext / convertToLlm | transformContext 只读 | 实际上下文的唯一观察点；只观察不改写，自包 try/catch 出错原样返回 |
| usage | 新记录族 / turn.completed 加字段 | turn.completed 加法式加六个字段 | 上游 AssistantMessage.usage 现成，归一化时手里就有 |

下游消费者：040 worker token 预算、M6.5 Eval 固定模型固定预算对照、trace 回答"用的哪版 Memory"、复现一个 Run 靠内容文件的 system prompt 全文加消息正文。局限：指纹非全文，精确复现要联合内容文件；字符估算与 provider 计费有偏差（prompt cache），所以 usage 必须落盘；transformContext 到 entry 的映射靠内容哈希不靠位置，abort 与合成失败消息也进指纹。

### 推理档位的三个层次（050 的来龙去脉）

"缺省不开"不是"不做"。三个层次：人定全局值（启动参数，现在做）；按角色给默认值（M5.5 角色表加一列，零机制）；运行时自动调（按任务难度或上一轮失败升档，或模型请求下一轮加深；能做但现在不做：花钱且无收益数据、破坏 Eval 固定预算对照、无可靠"任务难"判据；列为 M9 之后候选）。档位是成本旋钮不是权限，§3.1 不管它，但受 §2 规则 4 冻结约束：Run 开始定、Run 内不变。
