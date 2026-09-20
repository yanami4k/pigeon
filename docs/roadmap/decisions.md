# Pigeon 已落定设计索引

> 每条只写结论、理由、代码锚点与所属路线图章节；盘问过程、备选方案与否决理由在本地 docs/decisions/（gitignored）。编号按裁决时间顺序，稳定不重排；"旧称"列保留代码注释与本地文档里的原编号，便于交叉查找。

## 维护约定（硬约定）

- 任何技术裁决在项目负责人裁决后，同一次提交内必须同步本索引：新增一条或修订既有条目的结论。裁决记录只写本地文件而不更新本索引，视为未完成。
- 条目一旦落定不删除；被推翻时在原条目追加"已由 NNN 取代"，新结论另起条目。
- 锚点只写文件路径，不写行号。

## 索引

| 编号 | 标题 | 旧称 | 阶段 |
|---|---|---|---|
| 001 | 审批动作集只有批准与拒绝 | M3 决策 1 | M3 |
| 002 | 工具执行串行写死，run() 互斥 | M3 决策 2 | M3 |
| 003 | 审批交互内联于 CLI REPL | M3 决策 3 | M3 |
| 004 | yolo 是人事先批发授权，证据链不断 | M3 决策 4 | M3 |
| 005 | 上游拦截循环靠事件级计数熔断 | M3 遗留决策 ① | M3 |
| 006 | 拒绝决定落 decision 记录族 | M3 遗留决策 ② | M3 |
| 007 | Receipt v1→v2 占位迁移保留 | M3 遗留决策 ③ | M3 |
| 008 | 证据链按副作用分层 | M4 决策 1 | M4 |
| 009 | 账本归并进 Event Log，不双写 | M4 决策 2 | M4 |
| 010 | Grant 体系：六档排律与五条约束 | M4 决策 3（含 3a/3b/3c） | M4 |
| 011 | Event Log 每会话一文件 | D1 | M4 |
| 012 | 逐条同步写、治理族 fsync、缺口冷侧可见 | D2 | M4 |
| 013 | entry 映射：message_end 自封 EntryId，(runId, runSeq) 权威键 | D3 | M4 |
| 014 | Replay 一次性渲染；只读重建与沙箱回放是两件事 | D4 | M4 |
| 015 | 派生不落库；列表安静；哈希三方比对自动确证 | D5 | M4 |
| 016 | grants.json 项目级、版本化 schema | D6 | M4 |
| 017 | 失败四分类判据表，默认桶为未知 | D7 | M4 |
| 018 | M3 旧账本启动时一次性迁移 | D8 | M4 |
| 019 | 固化规则回指稳定身份，升格与移除留痕 | M4 收口决策 ① | M4 收口 |
| 020 | 同一 grant 只允许升格一次 | M4 收口决策 ② | M4 收口 |
| 021 | D2 冷视图三处全补，措辞精确化 | M4 收口决策 ③ | M4 收口 |
| 022 | 模块归位：有限重整与六条分层规则 | M4 模块布局决策 | M4 收口 |
| 023 | 崩溃残留 Run 恒为未知；resume 与 trace 计崩溃残留 | M4 验收 O-1 / O-3 | M4 验收 |
| 024 | Adapter 提供只读流式文本观察口；消息文本不持久化 | M2 开工裁决第 4 件 | M2 |
| 025 | 装配根与恢复流程抽到 application/，cli 与 tui 共用 | M2 开工裁决第 2 件 | M2 |
| 026 | M2 终端 UI 采用 pi-tui 0.84.4，spike 判过 | M2 开工 §5a 第 1 件 | M2 |
| 027 | TUI busy 语义：运行中拒绝提交、保留缓冲、不排队 | M2 S2 壳裁决 | M2 |
| 028 | 消息区结构与 streamFn 加载归位 | M2 S2 壳裁决 | M2 |
| 029 | TUI 审批面板语义：四键挂起、普通输入吞掉、取消 fail-closed | M2 S3 面板裁决 | M2 |
| 030 | grant 命令层归位 application/，cli 与 tui 共用 | M2 S3 面板裁决 | M2 |
| 031 | TUI 会话列表与恢复入口口径；崩溃残留列表呈现偏差 | M2 S4 会话入口裁决 | M2 |
| 032 | TUI 取消键 Esc 与模态优先；failureBadge 措辞归位 | M2 S5 取消裁决 | M2 |
| 033 | TUI 退出三层形态：Esc 取消 / Ctrl+C 清缓冲 / 双击退出 + /quit | M2 S5+ 退出裁决 | M2 |
| 034 | 工作区准备与恢复种子归 application；Actor 不触碰 persistence 写侧 | M2 审计 note-1 / note-8 | M2 收口 |
| 035 | 流式尾巴懒创建：纯工具调用轮不留占位子组件 | M2 审计 note-2 | M2 收口 |
| 036 | 半信任内容在两个 Actor 的终端边界统一净化 | M2 审计 P2-1 | M2 收口 |
| 037 | 消息文本旁置内容文件持久化，entry 带内容哈希回指 | M5 开工裁决第 1 件 | M5 |
| 038 | Session Search 内容级检索：全文扫描先行，搜索与读原文两个 read 档工具 | M5 开工裁决第 2 件 | M5 |
| 039 | 项目定位改写：卖点是无人值守并行与从历史学习，治理闭环是地基不是招牌 | 定位裁决 2026-09-13 | 路线图 |
| 040 | 并行 worker 编排轻档：同进程多 Adapter、工作树隔离、审批汇聚、四动作接口；M5.5 紧接 M5 | 并行编排裁决 2026-09-13 | M5.5 |
| 041 | 外部工具链只经 MCP 接入，内部工具直接注册；新增 M5.7 | 工具链接入裁决 2026-09-13 | M5.7 |
| 042 | 常驻 Memory 两层存储、system prompt 冻结注入、字符预算、超预算列名 | M5 开工裁决第 3 件 | M5 |
| 043 | Skill Catalog 标准目录、自写加载器、load_skill 三重约束 fail-closed、哈希清单冻结 | M5 开工裁决第 4 件 | M5 |
| 044 | run.started 快照摘要、llm.request 上下文指纹、turn.completed 加 usage，Event Log v6 一次升 | M5 开工裁决第 5 件 | M5 |
| 045 | TUI 历史渲染全部正文加安全上限；thinking 流式转发、持久化并渲染 | M5 开工裁决第 6 件 | M5 |
| 046 | Eval 自建薄 runner，任务格式对齐公开基准，外部 harness 只作可选适配 | Eval 方向裁决 2026-09-13 | M6.5 / M9 |
| 047 | 文档规范：audit / decision / spikes 入库，notes 本地；探针脚本入库 spikes/ | 文档规范裁决 2026-09-13 | 仓库规范 |
| 048 | exec 工具：自由命令加逐次审批，[a] 精确命令串会话 grant，commands.json 可选，沙箱后置 | M5.5 前置二 | M5.5 |
| 049 | 治理编排整体搬到 application/，Adapter 只转发 decide；零行为变化作 M5.5 S0 | M5.5 前置一 | M5.5 |
| 050 | 推理档位两级来源进快照冻结、Memory 按文件名排序、域错误看标记、reasoning_content 待测 | M5 遗留四小件 | M5.5 |
| 051 | MCP 配置：server 定义读 .mcp.json，风险档覆盖写旁置 .pigeon/mcp.json，未列工具缺省 write | M5.7 开工第 1 件 | M5.7 |
| 052 | MCP 注解与配置冲突记进 run.started 工具集摘要，按更严执行 | M5.7 开工第 2 件 | M5.7 |
| 053 | Receipt 加第三个证据块 mcp：参数与返回哈希、截断标记、serverEvidence 约定；治理链不动 | M5.7 开工第 3 件 | M5.7 |
| 054 | 隔离单位接口已由 M5.5 的 WorkspaceProvider 满足；形状封顶三种，领域隔离归工具链 | M5.7 开工第 4 件 | M5.7 |
| 055 | M5.7 验收用两个官方参考 server：filesystem 走真实链路，everything 走协议一致性 | M5.7 开工第 5 件 | M5.7 |
| 056 | headless 运行入口：进程内 API 加 `pigeon run` 薄壳；无人值守审批只有 yolo 或 fail-closed；需审批次数从回执反推 | M6.5 开工第 1 件 | M6.5 |
| 057 | Eval 任务目录格式：一任务一目录、快照为 git 引用经工作树、验证器由 runner 在收工后独立运行 | M6.5 开工第 2 件 | M6.5 |
| 058 | 验证器接口：退出码三值判决加可选 JSON、误成功取"自报完成但验证失败"、判决记 eval.verified 观察族 | M6.5 开工第 3 件 | M6.5 |
| 059 | 冒烟对照：候选 Skill 放暂存目录、headless 传 skillRoots 切三条件、Skill 从真实失败手写、任务集含 holdout | M6.5 开工第 4 件 | M6.5 |
| 060 | Eval 结果落 docs/audits/eval/<日期>-<基线>/：results.jsonl 与 report.md 入库，实验会话用该目录下独立治理根不入库 | M6.5 开工第 5、6 件 | M6.5 |
| 061 | 编辑格式对照：只加一组 replace 式编辑工具，hashline 基线复用 M6.5 冒烟无 Skill 24 次；锚点容错搁置 | 编辑格式对照裁决 2026-09-15 | Eval / 编辑工具 |
| 062 | 编辑工具默认改用 replace，hashline 保留为可选并留作后续优化方向 | 编辑格式对照裁决 2026-09-15 第 2 件 | 编辑工具 |
| 063 | 失控止损：单轮输出上限缺省 16,384 可配、system prompt 加截断后拆小引导；流式重复检测暂不做 | 失控止损裁决 2026-09-15 | 运行时 / 无人值守 |
| 064 | Reviewer 复用 worker 编排：工作区加"无工作区"成员、补只读快照工具、候选由 Controller 从收尾结果落盘，另加 `pigeon review` 薄壳 | M6 前置第 1 件 | M6 |
| 065 | 候选暂存：正文按哈希不可变写入暂存目录，状态由账本记录现算，改内容即新候选并标记取代 | M6 前置第 2 件 | M6 |
| 066 | TUI 新增 [r] 拒绝并说明；决定记录加理由来源字段（人写 / 系统默认），不升 Event Log 版本 | M6 前置第 3 件 | M6 前置 |
| 067 | tui/shell.ts 按职责拆五个文件；抽启动参数与会话运行面两个装配模块，三入口模型占位缺省统一、cli 补 PIGEON_STREAM_FN 回退 | M6 前置第 4 件 | M6 前置 |
| 068 | 对比素材：同任务独立尝试与会话树分叉都做，先比对后分叉；分叉基于上游 Session 存储，Pigeon 补写穿与分叉续跑，账本为唯一权威 | M7 前置第 1 件 | M7 |
| 069 | 同任务认定用显式任务标识：Eval 用任务编号，并行派发同一任务时生成共享标识写入派出记录 | M7 前置第 2 件 | M7 |
| 070 | Episode 边界按来源定：同任务比对取尝试会话首个 Run，分叉取分叉点到叶子、共享前缀只算一次 | M7 前置第 3 件 | M7 |
| 071 | Eval 之外的成功判定：配置验证命令，尝试收尾后由程序独立执行并落通用验证记录，未配置标未知 | M7 前置第 4 件 | M7 |
| 072 | 五个标签边界：成功只认验证通过；撞上限与熔断算失败；人主动取消算放弃；放弃与基础设施错误不进成败对比 | M7 前置第 5 件 | M7 |
| 073 | Run 内局部对只取人写拒绝理由与域错误后成功重试，只产出教训候选 | M7 前置第 6 件 | M7 |
| 074 | 提炼器复用 worker 机制新增角色，并行同任务收尾后与分叉叶子验证后自动触发，另有 `pigeon distill`；预算单设、共用全局并发闸 | M7 前置第 7 件 | M7 |
| 075 | 候选升 v3，加法式新增对比来源块 | M7 前置第 8 件 | M7 |
| 076 | 提炼器输入沿用 M6 截断，每侧 24,000 字符，共享前缀与任务描述只喂一次，独立尝试不做分歧步对齐 | M7 前置第 9 件 | M7 |
| 077 | 会话树在分叉发生时才建立：账本先记分叉记录，树放 `.pigeon/trees/` 为可重建的派生缓存，写穿不阻塞主循环 | M7 前置第 10 件 | M7 |
| 078 | 文件变化后用 git 底层命令生成快照挂到 `refs/pigeon/checkpoints/`，分叉从快照开独立工作树，非 git 工作区报错 | M7 前置第 11 件 | M7 |
| 079 | 分叉由人手动发起，另有缺省关闭的 `--retry-on-fail <K>` 失败自动分叉重试 | M7 前置第 12 件 | M7 |
| 080 | 运行时内部故障不进账本，改为按故障类别去重的标准错误告警 | M7 收口 | M7 |
| 081 | 验证命令改为项目级配置：人配一次本项目所有会话继承，启动参数可覆盖，不做自动推断 | M8 前置第 1 件 | M8 |
| 082 | 回放执行体复用 worker 机制新增验证器角色，起点用快照回到任务开始处，统计沿用 Eval 结果行 | M8 前置第 2 件 | M8 |
| 083 | 回放权限形态用固化命令规则，容器沙箱排入 M9 前置并先跑三个探针 | M8 前置第 3 件 | M8 |
| 084 | 回放判定为三值加大效应门槛，四组固定 N 全跑不中途停，区间只进回执不作判据 | M8 前置第 4 件 | M8 |
| 085 | 回放在临时治理根里按正常格式装载经验，走与真激活相同的装载路径 | M8 前置第 5 件 | M8 |
| 086 | 回放缺省人工触发 `pigeon verify`，另给显式开关供无人值守时自动验证 | M8 前置第 6 件 | M8 |
| 087 | 回放单设并发闸缺省 1 可配；每次回放的预算与模型沿用被验证那次尝试 | M8 前置第 7 件 | M8 |
| 088 | 候选审批走 CLI 子命令，TUI 只在状态行提示待审数量 | M8 前置第 8 件 | M8 |
| 089 | 候选新增三个记录族：验证回执、带动作与理由来源的决定、激活 | M8 前置第 9 件 | M8 |
| 090 | Policy 候选只落只读建议文件，永不自动改放权文件，物理分离由分层规则机检 | M8 前置第 10 件 | M8 |
| 091 | 验证回执摘要记全，批准失效只看模型、经验集合哈希、预算、验证命令四项封闭清单 | M8 前置第 11 件 | M8 |
| 092 | 回归的候选一律不可批准；未测出可人工批准但理由必填，激活记录标注未经回放证实 | M8 前置第 12 件 | M8 |
| 093 | 激活为复制到正常目录、人仍可编辑，启动时比对哈希标注漂移；撤销不追溯，取代与候选取代同构 | M8 前置第 13 件 | M8 |
| 094 | Policy 候选停止产出并删除其激活机制，枚举值仅保留读旧记录；机检收敛为激活器不得依赖放权写入模块 | M8 收口 | M8 |

## 条目

### 001 审批动作集只有批准与拒绝（事实）

- 结论：人工审批只有批准与拒绝两态，不提供"人工修改参数后放行"。
- 理由：beforeToolCall 的阻断理由逐字回到模型，拒绝并写明原因比人改参数更能形成模型的自我修正闭环；执行参数恒等于模型原始参数，绑定证据退化为一元。
- 锚点：src/approvals/handler.ts、src/cli/approval-ui.ts；ROADMAP §3.9 第 6 档。
- 详情：docs/decisions/m3-key-decisions.md。

### 002 工具执行串行写死，run() 互斥（事实）

- 结论：toolExecution 固定 sequential，Adapter 对并发 run() 互斥，不变量"任何时刻最多一个待审批或执行中的调用"。
- 理由：上游 parallel 模式审批整批前置、被阻断者的结束事件早于放行者执行，交错观感错乱；审批瓶颈是人，并行省的毫秒没有意义。演进路径是 per-tool shared/exclusive（只读并发、写串行），账本按调用粒度设计，届时不需重建。
- 锚点：src/pi-runtime/adapter.ts；ROADMAP §M5.5 前置。
- 详情：docs/decisions/m3-key-decisions.md。

### 003 审批交互内联于 CLI REPL（事实）

- 结论：审批展示 diff 并在同一进程内批准或拒绝，不依赖 M2 TUI；跨进程审批留给 Remote 形态。
- 理由：ROADMAP §M3 明确 M3 不依赖完整 TUI；单进程闭环是最小可验证形态。
- 锚点：src/cli/repl.ts、src/cli/approval-ui.ts；ROADMAP §M3。
- 详情：docs/decisions/m3-key-decisions.md。

### 004 yolo 是人事先批发授权，证据链不断（事实）

- 结论：注入快照的 ToolPolicy 带 approvalMode ∈ {prompt, yolo}，深冻结；yolo 下 Receipt 照写，approvedBy 记 policy:yolo；deny 清单绝对且工具名级精确匹配，参数内容模式识别归 M6。
- 理由：批发授权也是人授的，证据链不能因它断开；做不好的模式识别是虚假安全感。
- 锚点：src/pi-runtime/snapshot.ts、src/tools/policy.ts、src/state/tool-execution.ts；ROADMAP §3.9 第 1、4 档。
- 详情：docs/decisions/m3-key-decisions.md。

### 005 上游拦截循环靠事件级计数熔断（事实）

- 结论：幽灵工具名与参数畸形被上游在 hook 之前拦截，hook 不可见；判据取"tool.settled 且 isError 且账本无此调用记录"，同名连续计数达阈值即 abort。
- 理由：spike 实证 not-found 时 tool_execution 事件照常发出而 hook 零调用，无熔断则循环永续。
- 锚点：src/pi-runtime/adapter.ts；ROADMAP §5 上游硬事实。
- 详情：docs/decisions/m3-leftover-fixes-decisions.md。

### 006 拒绝决定落 decision 记录族（事实）

- 结论：三个拒绝点（deny、无审批通道 fail-closed、人工拒绝）全部落 decision 记录，含 approvedBy 与逐字理由；对账把 rejected 归闭环，永不入 OutcomeUnknown。
- 理由：拒绝理由是 M6 以后蒸馏的负样本监督信号；Receipt 的职责是副作用对账，不塞理由。
- 锚点：src/state/event-log.ts、src/pi-runtime/adapter.ts；ROADMAP §4 状态流。
- 详情：docs/decisions/m3-leftover-fixes-decisions.md。

### 007 Receipt v1→v2 占位迁移保留（事实）

- 结论：v1 从未持久化，占位迁移不删。
- 理由：它是迁移管线的保活装置，JSONL 冷读是管线首个真实消费方。
- 锚点：src/state/receipt.ts、src/state/migration.ts。
- 详情：docs/decisions/m3-leftover-fixes-decisions.md。

### 008 证据链按副作用分层（事实）

- 结论：写与 exec 类调用持久化 intent、decision、receipt 三族；只读调用只留 tool.proposed 与 tool.settled 事件级记录。
- 理由：§3.2 是写调用的红线不可砍；只读调用无副作用，OutcomeUnknown 对账对其无意义，事件级已满足 Trace 与学习用途。
- 锚点：src/pi-runtime/adapter.ts；ROADMAP §4 状态流。
- 详情：docs/decisions/m4-pre-decisions.md。

### 009 账本归并进 Event Log，不双写（事实）

- 结论：M3 的 JSONL 账本成为 Event Log 的事件族，JsonlLedger 退役为只读解析器；不存在"账本一套、事件日志一套"。
- 理由：单一事实链是 §3.5 的直接推论，双写意味着两套事实要互相对账。
- 锚点：src/persistence/event-log.ts、src/persistence/ledger.ts。
- 详情：docs/decisions/m4-pre-decisions.md。

### 010 Grant 体系：六档排律与五条约束（事实）

- 结论：放行按 deny → 会话 grant → 固化规则 → yolo → read 自动 → prompt 求值；审批提示四键 [y/n/a/d]；会话 grant 可带目录限定，崩溃恢复后静默续命；升格只能由人经 /grants save，带 promotedFrom 出处；五条不可破约束见 ROADMAP §3.9。
- 理由：逐调用询问与批发 yolo 之间需要中间档；信任的自然形态是"这个工具在这个范围"；权限扩大必须有可审计的外部批准主体（§3.1）。
- 锚点：src/tools/policy.ts、src/tools/grants.ts、src/approvals/grant-store.ts、src/application/grants.ts、src/cli/approval-ui.ts；ROADMAP §3.9。
- 详情：docs/decisions/m4-pre-decisions.md。

### 011 Event Log 每会话一文件（事实）

- 结论：.pigeon/sessions/sess_<ulid>.jsonl，项目内、gitignored。
- 理由：冷物化边界等于文件边界；列目录即时间序；单会话损坏不影响全局。
- 锚点：src/persistence/event-log.ts。
- 详情：docs/decisions/m4-design-decisions.md。

### 012 逐条同步写、治理族 fsync、缺口冷侧可见（事实）

- 结论：事件产生即同步写盘；intent、decision、receipt、breaker、resolution、grant 各族写后 fsync，观察族不 fsync；写盘失败进 listenerErrors 不改运行结果，进程内即时警告；跨进程的既往缺口以文件形态派生（撕裂尾巴、entry 断号、孤儿记录）在 trace、replay、resume 标注。
- 理由：事件频率低，同步写成本可忽略；写盘失败的记录不可能靠写盘持久化，跨进程只能从文件形态推断。
- 锚点：src/persistence/event-log.ts、src/cli/repl.ts、src/state/materialize.ts；ROADMAP §M4 完成证据。
- 详情：docs/decisions/m4-design-decisions.md（D2，含 021 的措辞精确化）。

### 013 entry 映射：message_end 自封 EntryId，(runId, runSeq) 权威键（事实）

- 结论：每条 message_end 落地时分配 EntryId，记 (runId, runSeq)；abort 与上游合成失败消息也占序号；timestamp 永不当键；流式阶段不锚身份。
- 理由：上游消息无稳定 id，timestamp 撞毫秒；transcript append-only 但 reset 可整组替换，全局下标不可靠。
- 锚点：src/state/event-log.ts、src/pi-runtime/adapter.ts；docs/spikes/spike-pi-transcript.zh-CN.md。
- 详情：docs/decisions/m4-design-decisions.md。

### 014 Replay 一次性渲染；只读重建与沙箱回放是两件事（事实）

- 结论：pigeon replay 将重建时间线静态打印；M4 的 Replay 是黑匣子只读重建，默认不重新执行副作用；沙箱重执行是 M8 的另一件事。
- 理由：交互步进是 M2 TUI 的职责；语义锁定防止 M8 复用命令名造成混淆。
- 锚点：src/state/replay.ts、src/cli/replay.ts；ROADMAP §4 目录图 replay/ 注释。
- 详情：docs/decisions/m4-design-decisions.md。

### 015 派生不落库；列表安静；哈希三方比对自动确证（事实）

- 结论：session 聚合状态每次从 Event Log 现算；列表默认只给时间与 Run 数，唯一突出项是待对账；冷恢复读目标文件现状哈希与 intent 的改前、预期改后比对，匹配即写 resolution 销账，不匹配留人三选一；任何路径不自动重执行。
- 理由：无第二套事实（§3.5）；待对账是唯一 actionable 项；确证只销账不重放（§3.2）。
- 锚点：src/state/session-summary.ts、src/execution/recovery.ts、src/application/session-list.ts。
- 详情：docs/decisions/m4-design-decisions.md。

### 016 grants.json 项目级、版本化 schema（事实）

- 结论：JSON + typebox schema 带 version；正规写入方只有 /grants save 与 /revoke config#N；随 .pigeon/ gitignored；团队共享是将来的显式决策。
- 理由：权限作用域天然是项目；文件正规写入方是程序，YAML 的注释需求为假。
- 锚点：src/state/grants.ts、src/persistence/grants-config.ts。
- 详情：docs/decisions/m4-design-decisions.md。

### 017 失败四分类判据表，默认桶为未知（事实）

- 结论：取消（子类治理熔断）、业务失败、基础设施错误、未知；Run 级与 ToolExecution 级各有判据；活侧与冷侧共用同一纯函数；判据不匹配一律未知。
- 理由：标签要喂蒸馏，贴错是毒信号；provider 故障归基础设施，否则污染 Eval 的任务失败率。
- 锚点：src/state/classification.ts；ROADMAP §4 状态流。
- 详情：docs/decisions/m4-design-decisions.md。
- 修订：023 增加 hasRunEnded 事实——run.ended 缺失恒为未知，优先于 stopReason。

### 018 M3 旧账本启动时一次性迁移（事实）

- 结论：首次启动检测旧 JSONL 账本，逐行转事件格式写入对应会话文件，旧文件改名 *.legacy.jsonl 物理保留、逻辑退役。
- 理由：并存读后归并让读层长期背复杂度；不迁移则 M3 验收记录失效。
- 锚点：src/persistence/legacy-migration.ts。
- 详情：docs/decisions/m4-design-decisions.md。

### 019 固化规则回指稳定身份，升格与移除留痕（事实）

- 结论：配置规则命中的账本回指用规则的 promotedFrom.grantId，位置序号只作展示与 /revoke 输入；/grants save 落 grant.promoted，/revoke config#N 落 grant.config-removed；Event Log 版本 4→5 纯版本推进。留痕顺序不对称：扩权先留证后生效，缩权先生效后留证。
- 理由：位置序号随移除前移，历史回指会漂移；稳定身份已在文件里；留证失败时宁可少一条痕迹，不可让账本说"已撤"而规则仍在生效。
- 锚点：src/tools/grants.ts、src/application/grants.ts、src/state/event-log.ts；ROADMAP §3.9 留证段。
- 详情：docs/decisions/m4-closeout-decisions.md。

### 020 同一 grant 只允许升格一次（事实）

- 结论：/grants save 时若文件里已有同 promotedFrom.grantId 的规则，响亮报错并指出已存在的序号，文件不改写。
- 理由：019 以 grantId 为身份，重复规则会让身份不唯一；语义重复（不同 grant 同范围）是噪声不是歧义，不去重以保留各自出处。
- 锚点：src/persistence/grants-config.ts、src/application/grants.ts。
- 详情：docs/decisions/m4-closeout-decisions.md。

### 021 D2 冷视图三处全补，措辞精确化（事实）

- 结论：entry 断号判据放进冷物化（末尾缺失由 run.ended.messageCount 推出，无 run.ended 的崩溃残留不推）；trace 在 Run 头下标注撕裂尾巴与断号并在会话头计数；replay 原位标注加尾部总账；resume 汇总既往缺口，有缺口不说"证据链完整"。D2 措辞改为"进程内即时警告 + 冷侧文件形态派生标注"。
- 理由：trace 缺标注直接违反"绝不假装证据链完整"；启动即查进程内数组跨重启恒空，字面承诺不成立。
- 锚点：src/state/materialize.ts、src/state/trace.ts、src/cli/trace.ts、src/cli/replay.ts、src/application/resume.ts。
- 详情：docs/decisions/m4-closeout-decisions.md。

### 022 模块归位：有限重整与六条分层规则（事实）

- 结论：schema、纯判据、冷物化与投影归 state（叶子）；存储引擎与配置文件读写归 persistence（只依赖 state）；grant 匹配归 tools；会话 grant 存储归 approvals；冷恢复归 execution；pi-runtime 经结构类型接收落盘口，不触达 persistence。六条 dependency-cruiser 分层规则只约束生产代码。两条记账的过渡债：cli 直连 execution（M2 重审）、adapter 内治理编排（M5.5 前挪到 application/）。
- 理由：重整前 persistence 与 pi-runtime 目录级成环、一个文件七种职责；全面按原图重整要造空 Controller，是假架构。
- 锚点：.dependency-cruiser.js；ROADMAP §4 目录图。
- 详情：docs/decisions/m4-module-layout-decisions.md。
- 修订（2026-09-13，M5 施工，038 / 043）：分层规则新增 memory-below-controller（memory/ 只依赖 state / persistence / tools）与 skills-only-state-tools（skills/ 只依赖 state / tools）；application-is-controller 放行 memory 与 skills。
- 修订（2026-09-14，M5.7 施工，041 / 051）：分层规则新增 mcp-only-state-tools（mcp/ 只依赖 state / tools，不触达 persistence / pi-runtime / application / Actor 层，由 application 装配）；application-is-controller 放行 mcp。
- 修订（2026-09-14，M6.5 施工，046 / 057）：分层规则新增 eval-below-actors（eval/ 可依赖 state / persistence / tools / orchestration / application 及以下，不触达 Actor 层，由 cli 调用）；application-is-controller 不放行 eval，Controller 不反向依赖评测层；边界元测试补 eval→cli 探针。
- 修订（2026-09-16，健康修整）：pi-runtime、execution、orchestration 三条规则由"只列禁止目标"改为允许清单（pi-runtime 只依赖 state / tools；execution 只依赖 state / persistence / tools；orchestration 只依赖 state / tools / approvals / memory / mcp）；新增 actors-not-each-other（cli 与 tui 互不引用，共用逻辑下沉 application）、actors-no-event-log-direct（Actor 只经 persistence/session-read.ts 的只读面读会话，不直连 event-log.ts）与 placeholders-only-state-tools（context / review / distillation / replay 暂只依赖 state / tools，review 的放行范围 M6 开工另裁）；边界元测试补 pi-runtime→application、cli→tui、Actor→event-log.ts 三个探针。

### 023 崩溃残留 Run 恒为未知；resume 与 trace 计崩溃残留（事实）

- 结论：Run 级失败分类的事实新增 hasRunEnded；run.ended 缺失即"未知"，优先于末条 turn.completed 的 stopReason（017 判据表修订）。冷物化新增 unfinishedRuns 清单（有记录但无 run.ended 的 Run），resume 恢复屏在既往缺口里列"崩溃残留：N 个 Run 无 run.ended"，有则不说"证据链完整"；trace 会话头加"崩溃残留 N 个 Run"计数，与落盘缺口分开计。
- 理由：真实链路验收中三个死于中途的 Run 被判"正常"，只靠头部标注提示，`--class unknown` 找不到它们，resume 还声称证据链完整，同时违反 017"不确定就不贴标签"与 012"绝不假装证据链完整"。abort 路径上游照常发 agent_end，所以"无 run.ended"只出现在真崩溃与 D8 迁移会话，判据不会误伤取消。
- 锚点：src/state/classification.ts、src/state/materialize.ts、src/application/resume.ts、src/cli/trace.ts；ROADMAP §4 状态流。
- 详情：docs/decisions/m4-closeout-decisions.md 决策 ④；证据 docs/audits/2026-09-12-m4-real-provider-acceptance.md 复验段。

### 024 Adapter 提供只读流式文本观察口；消息文本不持久化（事实）

- 结论：PiRuntimeAdapter 新增 subscribeStream 观察口，在上游 message_update 携带 text_delta 时把增量文本连同 runId 转发给订阅者；三条纪律：不进 Event Log、不进 events()、不锚身份（013 禁忌：流式载荷是浅拷贝）；listener 自包 try/catch 进 listenerErrors。thinking 增量第一版不转发。消息文本不持久化：历史会话在 TUI 渲染治理投影（工具、审批、Receipt、分类），文本持久化与 M5 Session Search 一起裁决。
- 理由：M2 目标是最小可用交互界面，只按 turn 刷新是状态面板不是对话界面；观察口是派生显示态、非权威状态，重启不可重建，与 §3.5 不冲突；TUI 直连上游 Agent 违反 §2 边界规则。
- 锚点：src/pi-runtime/adapter.ts subscribeStream（M2 S1 落地，2026-09-12）、src/pi-runtime/adapter-stream.test.ts；ROADMAP §M2。
- 详情：docs/decisions/m2-decisions.md。
- 修订（2026-09-13，045）："thinking 增量第一版不转发"与"消息文本不持久化"两条子裁决由 037 与 045 取代：subscribeStream 增量载荷加 kind 字段区分 text 与 thinking，thinking_delta 一并转发；消息正文与 thinking 均持久化到旁置内容文件。观察口三条纪律（不进 Event Log、不进 events()、不锚身份）不变。

### 025 装配根与恢复流程抽到 application/，cli 与 tui 共用（事实）

- 结论：cli/index.ts 的 buildRuntime 搬到 application/runtime.ts，审批 handler 改由调用方注入（cli 传 REPL 问答版，tui 传面板版）；cli/session.ts 的"哈希确证 + 人工确认写 resolution"流程搬到 application/resume.ts，问答与输出仍注入。巡航规则补：application 可依赖 state / tools / approvals / persistence / execution / pi-runtime；cli 与 tui 不得依赖 execution，只经 application。治理编排仍留在 Adapter（M5.5 前置，022 记账的债不在本条结清）。
- 理由：M2 是第二个 Actor，正是 022 写明的"cli 直连 execution 过渡豁免"重审时机；Actor 依赖 Actor 方向别扭；抽完后"TUI 只通过 Application API 提交意图"有了实体。放在 S1，先于任何 TUI 代码。
- 锚点：src/application/runtime.ts、src/application/resume.ts、src/application/format.ts（M2 S1 落地，2026-09-12）、.dependency-cruiser.js（application-is-controller / actors-no-execution 规则）；ROADMAP §4 目录图、§M2 完成证据。
- 详情：docs/decisions/m2-decisions.md。

### 026 M2 终端 UI 采用 pi-tui 0.84.4；spike 判过，结论绑定版本（事实）

- 结论：M2 TUI 以 @earendil-works/pi-tui 0.84.4 实现，无需切 ink。施工纪律（spike 实证推出）：每消息一个 Text 组件，禁止单 Text 装全部历史（A5a 实测线性退化，50000 格 p95 超帧预算）；自有 chrome 只用 ASCII，歧义宽字符留给内容区；不设计依赖 CPR/DSR 应答的探测（本机 ConPTY 不应答 \x1b[6n）；resize 重绘交给 pi-tui，M2 不自持宽度缓存副本。pi-tui 是纯 UI 库（依赖仅 get-east-asian-width + marked，与 agent 运行交互无关），不设桥接文件：巡航豁免精确到 pi-tui 一个包且只限 src/tui/（tui-pi-tui-only），pi-agent-core / pi-ai 在 tui 仍禁。结论绑定 0.84.4：升级 pi-tui 时按 ROADMAP §2 第 3 条与 beforeToolCall / transcript 两个 spike 一起重跑本 spike。
- 理由：三层证据对拍——库自洽（Part A：CJK 感知虚拟屏幕仿真器逐 chunk 断言，1291 项全过）、真实 ConPTY（Part B：宽度推进与光标定位逐格精确，含宽标点/全半角/emoji）、端到端（Part C：60 chunk 流式 + 真实 ConPTY resize 触发全量重绘）；中文长文本流式渲染、光标定位、resize 重绘全部判过。
- 锚点：docs/spikes/spike-pi-tui.zh-CN.md（复现脚本 spikes/spike-pi-tui/）；package.json（锁定 0.84.4）；.dependency-cruiser.js tui-pi-tui-only；ROADMAP §4 tui 注释。
- 详情：docs/decisions/m2-decisions.md（按推荐直接执行，事后补本索引）。

### 027 TUI busy 语义：运行中拒绝提交、保留缓冲、不排队（事实）

- 结论：Run 进行中按回车提交非空输入时，TUI 拒绝本次提交——不调 application API、输入缓冲保留、消息区落一行 [busy] 提示；空输入（纯空白）静默忽略（不回显、不提交、不提示）。
- 理由：排队意味着未设计的意图顺序与持久化语义（排队的意图是否进 Event Log、崩溃后是否重放全是新问题）；拒绝让 002 的 run() 互斥在 UI 层可见且零新状态；缓冲保留把重提时机交还给人，拒绝痕迹留消息区不静默。取消（S5）落地后 busy 窗口可被主动打断，排队需求届时重审。
- 锚点：src/tui/shell.ts（handleSubmit）；ROADMAP §M2 完成证据。
- 详情：docs/decisions/m2-decisions.md。

### 028 消息区结构与 streamFn 加载归位（事实）

- 结论：消息流每消息一个 Text 组件（spike A5a 反模式禁令），外层包 ScrollView follow:"end"——TuiMainScreen 的 main-screen 模式不走 layout.js 布局引擎，ScrollView 的裁剪/follow 不激活，follow-end 由终端 scrollback 天然实现（内容超高流入回卷、差分渲染器重写尾部），包装声明意图并在 alt-screen 布局引擎下自动生效；chrome（标题/状态栏）纯 ASCII，sessionId 原样展示（shortId 的省略号是歧义宽字符，不进 chrome）。loadStreamFn 从 cli/index.ts 归位 application/runtime.ts：模型接入装载件属装配职责，cli 与 tui 两个 Actor 都从 Controller 层取，避免 Actor 互依（025 的收尾）。
- 理由：ScrollView 不包装则消息流只是一堆裸 Text，语义意图（这是一个可滚动的消息区）在代码里不可见；shortId 用于 chrome 会把 U+2026 引入状态栏宽度账目，违反 spike chrome 纪律第 6 条。
- 锚点：src/tui/shell.ts、src/tui/main.ts、src/application/runtime.ts；docs/spikes/spike-pi-tui.zh-CN.md。
- 详情：docs/decisions/m2-decisions.md。

### 029 TUI 审批面板语义：四键挂起、普通输入吞掉、取消 fail-closed（事实）

- 结论：面板把 ApprovalHandler 的 Promise 挂起，addInputListener 接管 [y/n/a/d] 四键（大小写等效）决议，接口形状不动；面板期间普通输入一律吞掉——不进输入缓冲、不提交、不回显（输入区已有内容保留，面板关闭后继续编辑）。无墙钟审批超时（与 cli 版一致：等人是审批语义本身）；取消路径一律 fail-closed 按拒绝处理、理由逐字回模型——壳停止（APPROVAL_CANCEL_CLOSED）、面板未装配（APPROVAL_CANCEL_DETACHED）、并发审批防御（APPROVAL_CANCEL_BUSY）。[n] 无拒绝理由输入通道（四键单按即决议），reason 缺省由 Adapter 落默认文案「人工拒绝」；[d] 无 path 时提示不提供该键，仍按下与 cli 版同语义退化为工具级（同 [a]）。busy 期间斜杠命令与普通提交同样被拒绝（027 语义不开旁路）。
- 理由：审批动作集仍只有批准/拒绝（001）加 [a]/[d] 放权键（010），面板只是按键来源；输入挂起选吞掉而非排队，与 027 同一理由——排队意味着未设计的意图顺序语义；超时是新增治理语义，cli 没有 TUI 也不造；理由输入通道是 REPL 的多轮问答形态，四键面板不移植，拒绝闭环由 Adapter 默认文案维持。
- 锚点：src/tui/approval.ts、src/tui/shell.ts（askApproval/handleApprovalKey/stop）；ROADMAP §M2 交付第 5 件。
- 详情：docs/decisions/m2-decisions.md。
- 修订（2026-09-13，M2 审计 note-6）：[n] 单键拒绝使 TUI 路径的拒绝理由恒为默认文案，006 写明的负样本监督信号在此退化为常量；M2 不补多轮问答，M6 蒸馏接入前须补 TUI 拒绝理由通道或在蒸馏侧按来源 Actor 标注信号强度（ROADMAP §M6 前置）。

### 030 grant 命令层归位 application/，cli 与 tui 共用（事实）

- 结论：/grants /revoke /grants save 的命令层从 cli/grants.ts 归位 application/grants.ts（025 的方向收尾）：两个 Actor 共用同一份命令逻辑，write 回调是内联结构类型（REPL 写终端、TUI 写消息区），命令层不 import 任何 Actor；extractPathArg 一并归位 approvals/handler.ts（cli 与 tui 审批共用同一路径参数口径）。零新增治理语义：放权/撤销/升格全部走 SessionGrantStore 与既有命令逻辑，TUI 只是投影与按键来源。
- 理由：TUI 直 import cli/grants.ts 是 Actor 依赖 Actor（025 写明方向别扭）；命令层只有一份，输出经 write 投影到各自界面。
- 锚点：src/application/grants.ts、src/approvals/handler.ts、src/cli/repl.ts、src/tui/shell.ts（handleSlashCommand）。
- 详情：docs/decisions/m2-decisions.md。

### 031 TUI 会话列表与恢复入口口径；崩溃残留列表呈现偏差（事实）

- 结论：/sessions 与 /resume <sessionId> 的命令层与 cli 同一份——session list 查询与渲染自 cli/session.ts 归位 application/session-list.ts（同 030 方向收尾 025），恢复对账复用 application/resume.ts（human-confirmed resolution 写盘路径唯一，TUI 只换问答与输出注入）；恢复的人工确认用面板式单键（1/2/3 键即答案，其余键吞掉，与 029 审批面板同一输入语义），不用顺序问答。/resume 对账收口后经装配方注入的 rebind 换绑运行面（restoredGrants 种子物化、buildRuntime、旧运行面释放按 cli resume 的 enterRepl 配方），同 sessionId 续跑；恢复当前会话响亮拒绝（恢复流程与运行中日志会同文件双写）。偏差：崩溃残留不在会话列表单独突出——开工口径是列表呈现「N 个 Run 无 run.ended」，落地核对 SessionSummary 投影只有 pendingReconcile；materialize 虽有 unfinishedRuns，但把它提进列表投影等于给 015「唯一突出项是待对账」开第二个突出项并改变 cli 列表输出，超出 S4「TUI 只渲染、cli 零回归」边界，故按开工授权回落为 pendingReconcile 口径（与 cli 一致）。崩溃残留的既有呈现面是 resume 恢复屏「既往缺口」与 trace 会话头（023）；若要把崩溃残留提进列表，需先修订 015。
- 理由：逐行问答会穿过 busy 判定与斜杠分发，需要第三种输入模式；单键决议复用 029 已裁决的模态键控，零新输入语义。列表口径回落保住 015 的裁决与 cli 输出冻结，偏差显式记录留人翻盘。
- 锚点：src/tui/shell.ts、src/tui/main.ts、src/application/session-list.ts、src/application/resume.ts、src/state/session-summary.ts。
- 详情：docs/decisions/m2-decisions.md。
- 修订（2026-09-13，M2 审计 note-4）：裁决维持 015，崩溃残留不提进会话列表；理由是崩溃残留不是 actionable 项，且 023 之后 `--class unknown` 可筛出、resume 屏会说明。偏差闭合。

### 032 TUI 取消键 Esc 与模态优先；failureBadge 措辞归位（事实）

- 结论：运行中按 Esc（裸 "\x1b"）触发 adapter.interrupt()（固定姿势 abort → waitForIdle，注释约束 5）；Ctrl+C 不绑定取消，保留进程退出语义（main.ts 的 OS 信号处理）。模态键控优先：审批面板/恢复菜单挂起期间 Esc 与非决议键同待遇吞掉（029/031 语义不开旁路）——审批挂起即 Run 阻塞在 beforeToolCall 的人工决议上，此时 interrupt 的 waitForIdle 会吊在挂起 Promise 上直到人按键，「取消」名不副实；模态先决议再 Esc 取消是唯一次序。中断飞行中重复 Esc 不再触发（不 double-abort、不悬挂）；running 清算在 run() 决议。终态摘要带四分类徽章（取消/治理熔断/业务失败/基础设施错误/未知）+ errorMessage + syntheticFailure 标注；failureBadge 自 state/trace.ts 归位 application/format.ts（Actor 共用措辞层，025 方向——state 只留判据，措辞归 Controller 层），cli trace/replay 改指新位置，无 re-export。listenerErrors 警告上 TUI 消息区：措辞与增量报数口径同 cli repl（启动即查 + 每次 run 收尾复查，新故障以累计数提醒）。
- 理由：取消是 027 busy 语义的主动出口（027 记账"取消落地后排队需求重审"）；措辞单一约定禁止各视图自造第二套（format.ts 头注）；模态期间取消 Run 名不副实且引入挂起 Promise 竞态。
- 锚点：src/tui/shell.ts（handleShellKey/requestInterrupt/handleRunEnd/warnEvidenceGaps）、src/application/format.ts、src/state/trace.ts（移除）、src/cli/trace.ts、src/cli/replay.ts。
- 详情：docs/decisions/m2-decisions.md。

### 033 TUI 退出三层形态：Esc 取消 / Ctrl+C 清缓冲 / 双击退出 + /quit（事实）

- 结论：参照 omp 键位模型——Esc 取消 Run（032 不动，模态吞掉照旧）；Ctrl+C 永不取消 Run，单击（非模态）清输入缓冲并留 [cleared] 提示行（无历史召回语义），模态期间不清缓冲但仍计退出布防第一次；双击（窗口约 1 秒内两次 \x03，任意模式含模态）与 /quit 走同一优雅退出——先 shell.stop()（dispose 对称；挂起审批 fail-closed 按拒绝处理、理由逐字 APPROVAL_CANCEL_CLOSED，证据链不断）再回调注入的 onExit（main.ts 注入运行面 dispose + process.exit；测试注入探针，绝不真退进程）。退出恰好一次（幂等）；窗口过期的两次按键按两次单击处理，第二次重新布防。
- 理由：omp 键位模型是已验证的退出手感——取消（Esc）与退出（Ctrl+C）分层，清缓冲给出可见反馈避免误触即退；模态吞键语义（029/031）不得吃掉退出布防，故 Ctrl+C 路由在模态判定之前；退出必经 stop() 保证 fail-closed 与证据链完整，onExit 注入使退出路径可离屏测试。
- 锚点：src/tui/shell.ts（handleShellKey/handleCtrlC/requestExit/handleSlashCommand）、src/tui/main.ts（onExit/release）、src/tui/exit.test.ts。
- 详情：docs/decisions/m2-decisions.md。

### 034 工作区准备与恢复种子归 application；Actor 不触碰 persistence 写侧（事实）

- 结论：新增 application/workspace.ts——prepareWorkspace（realpath 规范化 + D8 旧账本一次性迁移）、restoreGrantSeed（物化目标会话的生效 grant 作 buildRuntime 的 restoredGrants 种子）、sessionsDirOf（会话目录唯一约定）；cli/index.ts 与 tui/main.ts 改为共用，不再各写一份。巡航新增 actors-no-persistence-writes：cli / tui 不得 import persistence/legacy-migration.ts 与 persistence/grants-config.ts，Actor 对 persistence 只剩只读物化。顺手（note-8）：运行中的 [busy] 提示补"exit: Ctrl+C twice"。
- 理由：025 只抽了 buildRuntime 与 resume 对账，两个入口各自保留了会改文件的启动装配，tui 因此直接依赖 persistence 写侧，与"Actor 只提交意图、渲染投影"有距离；M2 审计 note-1 登记，裁决修。
- 锚点：src/application/workspace.ts、src/cli/index.ts、src/tui/main.ts、.dependency-cruiser.js。
- 详情：docs/decisions/m2-decisions.md；证据 docs/audits/2026-09-12-m2-fixes.md。

### 035 流式尾巴懒创建：纯工具调用轮不留占位子组件（事实）

- 结论：MessageFlow.openStream 在 turn.started 只重置流式状态（streamTail=null、streamText=""），首个 text_delta 到达才 append 尾巴并 setText；closeStream 对从未开过尾巴的轮次不追加任何行；无 turn.started 的 delta 防御性开出不变（024 的 runId 校验不动）。不变式字面化：尾巴存在 ⟺ 本轮已流式文本。实证复核（M2 审计 note-2）：pi-tui 0.84.4 的 Text("") 渲染零行（components/text.js 空文本早退，paddingY 也不产生），恒开尾巴在屏幕上本就不可见——审计登记的"工具轮空行"是代码阅读推断，在 0.84.4 上不作为可见行存在（离屏探针逐行布局 + 恒开/懒创建两版输出逐字节 diff 仅差会话号）。本次改动按裁决（2026-09-13，工具轮空行一并修）照常落地，性质是不变式卫生而非观感修复；shell.test.ts 新增合同用例（工具行两侧间距一致），占位尾巴可见化或库升级改变空文本语义时变红。
- 理由：懒创建使"无文本的轮次无尾巴组件"成为结构事实，不再依赖库的空文本渲染行为兜底；库升级（026 要求重跑 spike）若改变 Text("") 语义，合同用例直接变红。
- 锚点：src/tui/shell.ts（MessageFlow.openStream/appendDelta/closeStream）、src/tui/shell.test.ts。
- 详情：docs/decisions/m2-decisions.md；证据 docs/audits/2026-09-12-m2-fixes.md。

### 036 半信任内容在两个 Actor 的终端边界统一净化（事实）

- 结论：模型流式文本、工具参数、审批块 diff 预览（工作区文件内容）、错误消息等半信任内容，在进入终端前统一经 sanitizeTerminalText 净化——所有 ESC 引导序列（CSI/OSC/DCS/APC/PM/SOS/双字符/裸 ESC）失去 ESC 引导字节而惰性化，ESC 替换为可见标记 ␛（U+241B），序列其余可打印字节保留在屏上作审计痕迹（绝不静默丢弃）；其余 C0 控制符替换为控制图形（U+2400+码位），DEL → ␡；保留 \n \t，\r → ␍（CRLF 差异如实呈现）。不做 SGR 白名单。净化函数幂等（流式累积 setText 每帧重净化为前提）。两个终端边界：TUI 侧 MessageFlow 是消息区唯一 Text 创建/setText 入口（append、appendDelta、settleToolCall 三处调用），chrome（标题/状态栏）不含模型内容不动；cli 侧 index.ts 的 write 闭包与 trace/replay/session list 的 stdout 写出统一经 sanitizedWriter 一个净化写出口，approval-ui、repl 与只读视图随之全部覆盖，不做逐调用点修补。pi-tui 库不修改。
- 理由：M2 审计 P2-1 实证 pi-tui Text 与 cli stdout 把控制序列原样直通真实终端（OSC 52 剪贴板劫持、OSC 8 伪装链接、CSI 光标/擦除伪造审批屏、打乱差分渲染器行跟踪）；审批屏是安全相关 UI，「人看到的屏」这条审批证据通道必须完整。可见化而非剥离：控制内容留在屏上即审计痕迹；白名单 SGR 保色是额外攻击面，模型没有业务理由发颜色。壳边界统一净化优于各调用点自处理（审计后续验证边界的书面意见），且新增内容路径自动落入边界。
- 锚点：src/application/format.ts（sanitizeTerminalText）、src/tui/shell.ts（MessageFlow）、src/cli/index.ts（writeOut）、src/cli/repl.ts（sanitizedWriter）。
- 详情：docs/decisions/m2-decisions.md；证据 docs/audits/2026-09-12-m2-fixes.md。

### 037 消息文本旁置内容文件持久化，entry 带内容哈希回指（事实）

- 结论：消息正文（user 输入、assistant text 块、toolResult 文本）持久化到每会话一份的旁置内容文件 `.pigeon/sessions/<sessionId>.messages.jsonl`，记录以 (runId, runSeq) 与 EntryId 对齐 entry 族；Event Log 升 v6 加法式：entry 族新增可选 contentHash（内容块规范序列化的 sha256），旧记录缺省视为"M5 前会话，无文本"。Event Log 仍是唯一状态权威，内容文件是被哈希回指的证据材料，不承载任何状态。四个子项：thinking 第一版不存，只记 hasThinking；图片只记 mimeType、字节数与哈希，不存数据；按内容块设大小上限，超出截断并标 truncated 加全文哈希，绝不静默丢弃，阈值由施工侧给默认值；耐久为观察族（同步写不 fsync），写序先内容后 entry，entry 有 contentHash 而内容缺失由冷侧派生为缺口，在 trace、replay、resume 按 012/021 口径标注。写入口径：EventLogSink.appendEntry 入参携带 content，由 JsonlEventLog 决定落盘位置，Adapter 改动最小，034 的 Actor 不触碰写侧约束不变。
- 理由：正文体积约为治理记录的数倍并随工具输出线性增长，而 Event Log 在每条冷路径（会话列表整读物化、resume 种子恢复、JsonlEventLog 打开时的幂等索引恢复）上；同文件承载会让这些路径永远为用不到的文本付解析与校验成本，旁置文件使冷启动零增量且不依赖字段顺序跳读之类的脆弱约定。哈希回指同时满足 §3.3 结论回查原文与 §6 SkillCandidate.sourceContentDigests 的需要；内容可单独清除或迁走而证据链靠哈希仍可校验，是诚实的"内容已清除"状态而非断链。否决：同文件加法式（冷路径成本）、只存哈希与截断摘要（违反 M5"完整历史进入 Session Search"与 §3.3）、启用上游 harness/session/jsonl（违反 §2 只经 Agent 核心、§3.5 单一权威与 009 不双写）。
- 锚点：src/state/message-content.ts（记录形状、内容块抽取、规范序列化哈希、UTF-8 按块截断）、src/state/event-log.ts（EVENT_LOG_VERSION 6、entry.contentHash、v5 → v6 恒等迁移）、src/persistence/event-log.ts（appendEntry 先内容后 entry、readMessageContentFileDetailed、listSessionIds 排除内容文件、materializeSession 的 content 选项）、src/state/materialize.ts（detectContentGaps）、src/pi-runtime/adapter.ts（message_end 交深拷贝消息）、src/state/trace.ts / src/state/replay.ts / src/application/resume.ts / src/application/format.ts（三处缺口呈现）；测试 src/state/message-content.test.ts、src/persistence/message-content-log.test.ts、src/pi-runtime/adapter-content.test.ts、src/cli/content-gap.test.ts；ROADMAP §M5。
- 详情：docs/decisions/m5-decisions.md；证据 docs/audits/2026-09-13-m5-ba94b53.md（S1）。
- 落地（2026-09-13）：内容块联合为 text / thinking / image / toolCall / unknown，toolCall 只记 id 与 name（参数已在 tool.proposed 与 intent），未知块类型记原始类型与哈希不静默丢弃；toolResult 记录另带 toolCallId / toolName / isError 供历史渲染与检索命中；单块上限默认 64 KiB（UTF-8 字节，不劈字符与代理对）。缺口判据比对内容文件按现有正文重算的哈希，而非记录自报字段，正文被改而字段未改同样现形；内容文件中段坏行只计数不抛，对应 entry 落缺口。会话列表冷路径以 content:false 跳过内容文件。写盘接缝 EventLogIo 使写序可由崩溃点测试观测。044 起内容文件首条可以是 role 为 system、runSeq 为 0 的 system prompt 记录（不对应 entry）。
- 修订（同日，045）：子项"thinking 第一版不存只记 hasThinking"改为 thinking 块与 text 块同形态持久化（同大小上限、可见截断、哈希），默认开，配置开关可关；被 provider 编辑掉的块记 redacted 标记。理由：TUI 要画 thinking（流式与历史），且思维链是 M7 蒸馏"失败前在想什么"的直接原料；§3.8 口径不变，thinking 只是线索不是证据。

### 038 Session Search 内容级检索：全文扫描先行，搜索与读原文两个 read 档工具（事实）

- 结论：内容级检索第一版为全文扫描：按会话目录从新到旧逐文件流式逐行读 037 的内容文件，关键词大小写不敏感子串匹配、多词为与，不接受正则；对外只暴露命中流接口（search(query, options) 返回 AsyncIterable 命中），命中含 sessionId、EntryId、runId、runSeq、role、时间、匹配窗口约 200 字的片段、truncated 标记与可选 score 字段；查询输入为结构化对象（关键词、角色过滤、复用 SessionListFilters 的工具/分类/时间过滤）。模型入口是两个 read 档工具（§3.9 第 5 档自动放行）：搜索工具返回命中列表，默认上限 20 条并有总字节上限，超限提示收窄不做分页状态；读原文工具按 EntryId 返回完整内容块加同 Run 的治理邻居（intent / decision / receipt 状态），两者合起来满足 §3.3 回查原文。人的入口 /search 命令层在 application/，cli 与 tui 各接渲染面，命中片段经 sanitizeTerminalText。范围只限本项目 .pigeon/sessions。索引不做：真实数据下单次搜索超过约 2 秒再盘，届时索引定性为按内容哈希判过期的可重建缓存，需补裁决与 015 对齐；语义检索归 M10 外部 Memory Provider。扫描器与两个工具落 memory/，分层规则补一条：memory/ 可依赖 state / persistence / tools，不触达 pi-runtime / application / Actor 层（022 修订）。
- 理由：当前零会话数据，索引是为未测过的规模提前付复杂度且与 015"派生不落库"打架；上游 0.84.4 search/scanning 是同一形态，Claude Code / Aider / Cody 对代码库也选扫描不建索引；§3.3 决定检索必须两步（线索再原文）；模型给正则是 ReDoS 面；工具调用天然落 tool.proposed / tool.settled，模型翻了哪些旧账在 trace 可见；结构化输入与 score 字段是为语义检索铺路的零成本预留，届时换实现不换调用方。
- 锚点：src/memory/session-search.ts（createSessionSearch 命中流、字面子串匹配、片段、上限即停）、src/memory/search-tools.ts（search_sessions、read_session_entry、sessionToolRegistrations）、src/application/search.ts（runSearchCommand）、src/application/runtime.ts（注册与广告）、src/cli/repl.ts 与 src/tui/shell.ts（/search 渲染面）、.dependency-cruiser.js（memory-below-controller）；测试 src/memory/session-search.test.ts、src/memory/search-tools.test.ts、src/application/search.test.ts；ROADMAP §M5。
- 详情：docs/decisions/m5-decisions.md；证据 docs/audits/2026-09-13-m5-ba94b53.md（S2）。
- 落地（2026-09-13）：搜索工具总字节上限默认 16 KiB；角色过滤缺省排除 system 记录；tool / class 过滤只物化事件文件。已知限制：tools 层不能依赖 memory，read_session_entry 的域错误进不了 tools/error-kind.ts 判据，失败调用的冷分类落「未知」默认桶。

### 039 项目定位改写：卖点是无人值守并行与从历史学习，治理闭环是地基不是招牌（事实）

- 结论：ROADMAP §1 改写。Pigeon 对外的两样卖点是可无人值守的并行执行与从自己的运行历史里学习；治理闭环（审批、六档放权、证据链、OutcomeUnknown 不盲重放、单一权威源、学习产物默认暂存）是这两样能力成立的原因，不是卖点本身。叙事与验收的主角是并行编排（§M5.5）与学习闭环（§M7 到 §M9），治理只在"崩溃或中断之后能对账能恢复"与"学到东西之后能审能回滚"两个场景露面；里程碑排期以尽早让两个主角出场为准，治理管道不再单独立项，只随主角所需补齐。架构与 §3 不可妥协约束一字不改。
- 理由：对坐在终端前的开发者，权限与审批是摩擦不是招牌，市面上 yolo 模式与跳过审批的开关是最常用选项，Cursor / Codex / Claude Code 的竞争全在模型效果、上下文工程与速度，没有人拿审批做宣传，allow / deny 清单是及格线；能卖的是治理换来的东西：敢把 worker 派出去自己睡觉（Claude Code 的 hooks、沙箱、带分类器的自动模式同样是为了让人少盯着，标题是"自主"不是"权限"），以及自我改进不翻车。真实风险是若时间继续全砸治理管道而并行与学习迟迟不出场，项目看起来只是带审批的 pi-agent-core 包装。裁决：改。
- 锚点：docs/roadmap/ROADMAP.md §1。
- 详情：docs/decisions/positioning-2026-09-13.md。
- 修订（同日）：Event Log 账本原样保留，不拆；其后续消费者优先是学习闭环（§M7、§M9）、Session Search 与并行编排；权限、审批、放权、固化留痕类功能非必要不新增，只在两个主角明确需要时补（如 exec 工具到来时补命令级模式规则与沙箱）。

### 040 并行 worker 编排轻档：同进程多 Adapter、工作树隔离、审批汇聚、四动作接口；M5.5 紧接 M5（事实）

- 结论：M5.5 重写为轻档并行 worker 编排，排在 M5 之后。worker = 一整套完整 agent（上游 Agent 循环 + PiRuntimeAdapter + 自己的上下文、策略、会话文件、隔离工作区），同进程多 Adapter，装配根每 worker 调一次 buildRuntime；隔离工作区第一版为 git 工作树，路径围栏根即工作树，治理根（.pigeon/）恒在主仓库根；每 worker 一个会话文件记 parentSessionId / parentRunId，父会话记 child.spawned / child.settled 两族，任何文件只有一个写入者；审批汇聚到父级面板带 worker 标签、一次一个，决定绑定该 worker 的 executionId，worker 内会话 grant 随其结束作废；worker 策略由父策略子集构造，深度 1；第一版只有轮次与墙钟上限，/cancel 走 abort；结果为结构化（分支、文件清单、receipt、自述），合并由人用 git 做；orchestration/ 只暴露 spawn / cancel / status / awaitResult 四动作加审批回调（§3.6 Job 边界，只留接口不做第二实现）；多窗口各自独立，窗口内治理加编排，窗口间只保安全不保协调（会话打开锁、grants.json 原子替换、工作树目录名带会话编号）。演进：父 agent 经受治理的 spawn 工具自派；脚本流水线。§5 顺序表改为 M5 → M5.5 → M5.7 → M6.5 → M6 → M7–M9；时间盒改为"规划参考，超盒是否砍范围由项目负责人裁决"；§7 加 v0.2 演示截止线；§8 加"不做多窗口跨进程协调"。
- 理由：项目负责人明确要做并行，且时间盒不作为高权重项；同进程审批无需额外工作、buildRuntime 已支持多实例、故障隔离差距被每 worker 会话文件冷恢复兜住，多进程要 IPC / 存活 / 鉴权 / Windows 信号，复杂度两到三倍且当前无跨机器需求；工作树隔离使 §8"同一工作区禁止并行写入者"原样成立；轻档比 Claude Code 子代理多出会话级证据链与审批绑定，是差异化最小形态，两档接口一致不返工；四动作接口让三阶段演进换实现不换调用方。
- 锚点：src/orchestration/worktree.ts（工作树增删列与改动清单）、src/orchestration/workers.ts（spawn / cancel / status / awaitResult、轮次与墙钟上限、深度 1、审批回调）、src/orchestration/roles.ts（角色表与委派子集构造、子集校验）、src/application/runtime.ts（治理根与工作区根分离、委派策略）、src/application/workers.ts（worker 运行面工厂与按会话装配编排器）、src/application/worker-scope.ts（worker 会话恢复回到自己的工作树与委派策略）、src/application/workers-commands.ts（/spawn /cancel /workers 命令层）、src/approvals/queue.ts（审批排队）、src/approvals/handler.ts（来源会话、worker 标签、放权落点）、src/state/event-log.ts（v7 session.header / child.spawned / child.settled）、src/state/materialize.ts（父子配对）、src/state/session-summary.ts 与 src/application/session-list.ts（父子后缀）、src/persistence/session-lock.ts（会话打开锁）、src/persistence/atomic-write.ts 与 src/persistence/grants-config.ts（grants.json 原子替换）、src/tui/shell.ts 与 src/tui/main.ts（命令、状态行、关窗先取消 worker）、src/cli/trace.ts（从主会话进入 worker 会话）、src/cli/index.ts（resume worker 会话）、.dependency-cruiser.js（orchestration-below-controller）；测试 src/orchestration/workers.test.ts、src/orchestration/worktree.test.ts、src/application/workers-e2e.test.ts、src/application/workers-approvals-e2e.test.ts、src/application/workers-recovery-e2e.test.ts、src/persistence/session-lock.test.ts、src/persistence/grants-config-atomic.test.ts；ROADMAP §M5.5、§5、§7、§8；证据 docs/audits/2026-09-13-m5-5-8ac7266.md。
- 详情：docs/decisions/m5-5-orchestration-decisions.md。
- 修订（2026-09-14，M5.7 收口）：带 MCP 配置的 worker 装配失败按 worker 失败收尾，落 child.spawned 与 child.settled 两条记录。
- 修订（2026-09-16，M6）：reviewer 角色的两个只读快照工具（review_snapshot、review_entry）豁免"子策略必须在父 allow 里"的子集校验；它们只读、作用域只限父会话自己的那一次 Run、不在主会话工具清单里；父策略禁用清单照旧生效，其余工具照常受子集校验。锚点 src/orchestration/roles.ts（SCOPED_REVIEW_TOOLS 与委派子集构造、子集校验）。
- 修订（2026-09-19，M7 收口）：提炼器角色的两个只读工具（提炼快照、提炼条目）按同一口径豁免子集校验；同时第二道校验改为按角色取豁免集合，不再用合并集合。理由：第二道校验的意义是发放侧写错也能拦住，若它比发放侧更宽，拦不住的恰是发放侧最易犯的错（新增只读角色时把工具发串），而角色还会继续增加。

### 041 外部工具链只经 MCP 接入，内部工具直接注册；新增 M5.7（事实）

- 结论：仓库内工具直接注册 ToolRegistry（拿得到证据钩子）；外部工具链只经 MCP 接入（stdio 与 streamable HTTP 传输都算），不做私有插件 SDK，不做 OpenAPI 或子进程包装的第二种接入；经验规则：需要改前改后哈希级证据的工具做成内部工具，其余走 MCP。新增 M5.7 里程碑：MCP 客户端适配、注解只当线索且档位以本地配置为准、未配置一律 write 档审批、Receipt 证据泛化（无钩子工具记调用与返回摘要）、隔离单位泛化为可插拔接口；exec 沙箱、预算档、账本敏感数据脱敏、计划级审批按接入的工具链类型触发不单独立项。§8 加"不做私有插件 SDK，外部工具只经 MCP"；M10 补"语义检索归此处"。
- 理由：把垂直工具链拆成独立仓库作为独立项目，需要它能独立跑，MCP 是运行时中立的行业标准，可直接在 Claude Code 演示；Pigeon 侧只需一个标准协议客户端，自建插件 SDK 无"别人"来接且会被问"为什么不用 MCP"；MCP 协议明文注解不可作安全依据，与 Pigeon fail-closed 口径一致，"治理任意第三方 MCP server"比私有接口有分量；三个非 coding 场景（Unity 资产管线、数据分析）共同前置是证据泛化、隔离泛化、沙箱与预算档。
- 锚点：ROADMAP §M5.7、§8、§M10、§10；src/mcp/（client.ts、transport.ts、registry-bridge.ts）、src/application/mcp.ts、src/application/runtime.ts、src/persistence/mcp-config.ts、src/state/mcp-config.ts；@modelcontextprotocol/sdk 1.30.0 进 dependencies 作客户端。
- 详情：docs/decisions/m5-5-orchestration-decisions.md。
- 修订（同日）：server 配置兼容读取 Claude Code 的 .mcp.json 格式；oh-my-pi 的 MCP 桥接作为设计参考不引包（联网核实：omp 支持 stdio / HTTP / SSE 并继承 .claude 等目录配置；pi 本体无内置 MCP，走扩展）。
- 修订（2026-09-14，M5.7 收口）：只有 implementer 角色继承主会话的 MCP 工具，只读与测试角色暂不接。

### 042 常驻 Memory 两层存储、system prompt 冻结注入、字符预算、超预算列名（事实）

- 结论：常驻 Memory 两层存储：项目级 `.pigeon/memory/*.md` 与用户级 `~/.pigeon/preferences.md`，人可直接编辑的 markdown；M5 写入方只有人，M8 激活候选时程序写入同一目录。注入位置是 system prompt 追加段，会话开始拼一次即冻结，不走 transformContext；transformContext 只做只读观察（llm.request 摘要，第 5 件）并留给 M10 外部 Provider 的逐调用动态召回。预算单位字符数（约 4 字符 1 token），实际消耗由 usage 落盘事后校准；偏好永不截断，Memory 文件按配置顺序装到预算满，其余只列文件名，模型可用读工具按需读（与 Skill 渐进加载同口径）。冻结身份：每文件 sha256 与字节数，整体哈希写入 InjectionSnapshot v3 的 memory 字段；会话中途改文件下个会话生效。M1 在 snapshot.ts 留的"Memory 注入在 M5 经 transformContext 落地"注释随施工改掉。
- 理由：Memory 是背景常识，语义上属于 system prompt；走 transformContext 要伪装成 user 消息，模型看到的是"用户说了"而非"环境如此"，Claude Code 也把 CLAUDE.md 放 system prompt、只把每轮变化的提醒塞进消息；system prompt 是最稳定的前缀，prompt cache 命中率最高；钩子职责单一，观察与改写不混在一个钩子里。两条路都满足冻结，代码量相当，差别只在上述三点；M1 注释把静态常驻 Memory 与动态召回想成了一种。
- 锚点：src/memory/resident.ts（loadResidentMemory）、src/state/injection-manifest.ts（MemoryManifestEntry）、src/pi-runtime/snapshot.ts（INJECTION_SNAPSHOT_VERSION 3、v2 → v3 迁移）、src/application/runtime.ts（会话开始拼 system prompt、homeDir 与 memoryBudgetChars）、src/cli/index.ts 与 src/tui/main.ts（--memory-budget）；测试 src/memory/resident.test.ts、src/application/runtime-memory.test.ts、src/pi-runtime/snapshot.test.ts；ROADMAP §M5、§M10。
- 详情：docs/decisions/m5-decisions.md；证据 docs/audits/2026-09-13-m5-ba94b53.md（S3）。
- 落地（2026-09-13）：默认预算 8000 字符；偏好占用预算且排最前；预算边界上的文件只装入前半并标 truncated，其余 included=false 只列文件名。「配置顺序」目前只是 loadResidentMemory 的 order 选项，装配根尚未接配置来源，缺省按文件名字典序。v1 → v2 快照迁移函数的输出版本改为写死 2（原引用当前版本常量，推进到 3 后会跳级）。

### 043 Skill Catalog 标准目录、自写加载器、load_skill 三重约束 fail-closed、哈希清单冻结（事实）

- 结论：目录格式采用标准 SKILL.md 加前言（name / description），`.pigeon/skills/<name>/` 下可选 references、scripts、templates，用户级 `~/.pigeon/skills/` 同构，与 Claude Code / pi 的 Skill 格式兼容。加载器自写不借上游 harness 层。启动只把名称、简介、路径追加进 system prompt，与 Memory 同段冻结。按需读取走专用 read 档工具 load_skill(name, resource?)：路径 realpath 后必须在该 Skill 目录内（防符号链接逃逸）、单文件上限默认 64 KiB 超出截断且可见、来源只认登记过的 Skill 名；任一不满足即报错说明理由，什么都不注入。开会话时给每个 Skill 目录下全部文件算哈希清单写入 InjectionSnapshot v3 的 skills 字段，load_skill 读取时比对，不一致即拒绝并提示"该 Skill 已变更，下个会话生效"。每次读取除 tool.proposed / tool.settled 外另落 skill.loaded 观察记录（名、资源路径、哈希、是否截断）。scripts 在 M5 只读不执行。Skill 是文本，工具照旧经六档排律，不扩权由构造保证，测试以"Skill 文本要求使用被 deny 的工具"用例证明拦得住。
- 理由：标准格式让公开 Skill 直接可用；上游加载器在 dependency-cruiser 边界外且只有百行，不为它放宽边界；read_file 围栏在工作区而用户级 Skill 在工作区外，专用工具既解决围栏又天然留痕，Claude Code 的 Skill 工具是同一形态；哈希清单是 §2 规则 4"会话内新增或修改只能下个会话生效"的直接落实，也让"冻结版本"有证据；exec 语义未裁决前不给 scripts 执行路径。局限：开会话遍历 Skill 目录算哈希，几百文件毫秒级；64 KiB 截断可配。
- 锚点：src/skills/catalog.ts（loadSkillCatalog、前言解析、哈希清单、目录段）、src/skills/load-skill-tool.ts（createLoadSkillTool、loadSkillRegistration）、src/state/injection-manifest.ts（SkillManifestEntry）、src/pi-runtime/snapshot.ts（skills 字段）、src/state/event-log.ts 与 src/persistence/event-log.ts（skill.loaded 族、appendObservation）、src/pi-runtime/adapter.ts（recordObservation）、src/application/runtime.ts（登记、注册、晚绑定留痕）、.dependency-cruiser.js（skills-only-state-tools）；测试 src/skills/catalog.test.ts、src/skills/load-skill-tool.test.ts、src/skills/skill-governance.test.ts、src/application/runtime-skills.test.ts；ROADMAP §M5。
- 详情：docs/decisions/m5-decisions.md；证据 docs/audits/2026-09-13-m5-ba94b53.md（S4）。
- 落地（2026-09-13）：同名 Skill 项目级优先，冲突与缺 SKILL.md 的目录记入 problems 不登记；符号链接与目录联接不跟随、不进清单；有 Skill 才注册并广告 load_skill。load_skill 检查顺序为来源、realpath 围栏、非文件、清单哈希，通过后才按 64 KiB 截断并回调 skill.loaded；任一拒绝不返回内容也不留读取记录。skill.loaded 由 Adapter 的 recordObservation 盖当前 runId 落盘，工具先于 Adapter 构造，装配根以晚绑定接线。

### 044 run.started 快照摘要、llm.request 上下文指纹、turn.completed 加 usage，Event Log v6 一次升（事实）

- 结论：InjectionSnapshot 此前从未落盘（只在 Adapter 内存），运行事件族无 run.started，M5 补上。快照拆两处落：system prompt 全文以 role 为 system 的记录写进 037 的内容文件，每会话一次带哈希；新增观察族 run.started 只带模型、策略、广告工具集、system prompt 哈希、memory 与 skills 哈希清单。新增观察族 llm.request，每次模型调用一条：消息条数、各角色条数、估算字符数、全部消息内容哈希（037 规范序列化）的滚动哈希、system prompt 哈希；观察点是 transformContext，只读不改，自包 try/catch，出错原样返回消息数组。turn.completed 载荷加法式加 usage（input / output / cacheRead / cacheWrite / totalTokens / cost），源自上游 AssistantMessage.usage；会话摘要算每会话总 token 与成本，trace 每轮显示。037 entry contentHash、043 skill.loaded、本条 run.started / llm.request / usage 合并为 Event Log v6 一次升，迁移全部加法式。下游：040 worker token 预算、M6.5 Eval 固定模型固定预算对照、trace 回答"用的哪版 Memory"、复现 Run 靠内容文件的 system prompt 全文加消息正文。
- 理由：治理日志保持小，全文归旁置内容文件，与 037 分工一致；指纹（条数加滚动哈希）能与内容文件按哈希对上而不至每次几十 KB；transformContext 是实际上下文唯一观察点，与 042 的"钩子只观察"口径一致；usage 上游现成，turn.completed 归一化时手里就有；字符估算与 provider 计费有偏差（prompt cache），所以 usage 必须落盘。先例：pi 与 Claude Code 会话文件在每条 assistant 消息存 usage，OpenTelemetry 给每次模型调用打 span。局限：指纹非全文，精确复现要联合内容文件；transformContext 到 entry 的映射靠内容哈希不靠位置。
- 锚点：src/state/runtime-events.ts（TurnUsage、ObservationKind 与三个观察族 payload）、src/state/event-log.ts（观察族记录并集、ObservationInput）、src/pi-runtime/events.ts（turn.completed 带 usage）、src/pi-runtime/adapter.ts（#recordRunStarted、#observeContext、messageContent 选项）、src/persistence/event-log.ts（appendSystemPrompt、appendObservation）、src/state/session-summary.ts 与 src/application/session-list.ts（总 token 与成本）、src/state/trace.ts 与 src/cli/trace.ts（Run 头启动快照、每轮 usage）、src/cli/replay.ts（观察族时间线）；测试 src/pi-runtime/adapter-observe.test.ts、src/cli/usage-view.test.ts、src/pi-runtime/adapter-content.test.ts（usage）；ROADMAP §M5。
- 详情：docs/decisions/m5-decisions.md；证据 docs/audits/2026-09-13-m5-ba94b53.md（S5）。
- 落地（2026-09-13）：systemPromptHash 是 system prompt 原文的 sha256；llm.request 的滚动哈希是本次全部消息内容哈希按序以换行连接后的 sha256，估算字符数是 text 与 thinking 块长度之和；指纹的内容抽取选项经 Adapter 的 messageContent 选项与内容记录保持一致（装配根传同一份 persistThinking）。system prompt 全文按 Adapter 生命周期写一次，resume 换绑出新 Adapter 时再写一次（当时的冻结版本可能已变，照写即证据）。run.started 先于本 Run 任何其他记录。

### 045 TUI 历史渲染全部正文加安全上限；thinking 流式转发、持久化并渲染（事实）

- 结论：/resume 与重启后默认渲染全部历史，正文（含 thinking）与治理投影按 (runId, runSeq) 与事件序时序交织；安全上限默认 500 条可配，超过时最早部分折叠为一行"更早 N 条未展开，/search 可查"；单条正文有渲染上限，超长折叠并标"已截断"；toolResult 默认折叠只显示工具名与摘要；无 contentHash 的旧会话头部提示"M5 前会话，无正文"，治理投影照画；cli 的 trace 与 replay 带正文加开关默认关；全部文本经 sanitizeTerminalText（036 同边界）。thinking：subscribeStream 增量载荷加 kind 字段，thinking_delta 一并转发，TUI 流式与历史都把 thinking 画成单独一段、视觉弱化（前缀标记加暗色）；持久化与 text 同形态、默认开（037 修订）；开源模型经 OpenAI 兼容口的 reasoning_content 能否映射为 thinking 块，施工时用 Kimi 真实链路验证。
- 理由：spike A5b 实测每消息一个 Text 200 条加流式尾巴均值 1.0ms、p95 1.8ms，余量 16 倍，退化只在"单 Text 装全部历史"形态（A5a），TUI 自 M2 起即每消息一个 Text，故 20 条上限无依据；Claude Code 的 --resume / --continue 与 Cursor 均整段重画，条数上限不是主流做法；500 条是为极端会话留的保险不是产品上限。thinking：TUI 要展示开源模型的思维链；思维链是 M7 蒸馏原料；诚实提醒 thinking 是模型自述不是可靠过程记录，§3.8 不变。
- 锚点：src/pi-runtime/adapter.ts（StreamTextDelta.kind、thinking_delta 转发）、src/application/history.ts（loadSessionHistory、contentRecordLines）、src/tui/shell.ts（MessageFlow thinking 段与历史行、renderHistory）、src/tui/main.ts（--history-limit、--no-persist-thinking）、src/cli/trace.ts 与 src/cli/replay.ts（--with-content）、spikes/m5-thinking-probe.mjs；测试 src/application/history.test.ts、src/tui/history.test.ts、src/cli/content-view.test.ts、src/pi-runtime/adapter-stream.test.ts；ROADMAP §M2 as-built、§M5。
- 详情：docs/decisions/m5-decisions.md；证据 docs/audits/2026-09-13-m5-ba94b53.md（S2 渲染部分与真实链路验收）。
- 落地（2026-09-13）：历史安全上限按渲染行计，默认 500；单条渲染上限默认 4000 字符；thinking 段在 036 净化之后由壳的受信逐行样式函数加暗色。thinking 映射实测（Kimi For Coding，anthropic-messages 线路）：不设推理档位时只有 text 块；reasoning=medium 时流出 thinking_start / thinking_delta / thinking_end，终态块为 thinking 与 text，usage 带 reasoning 计数——思维链映射为标准 thinking 块，前提是请求带推理档位。Adapter 与装配根目前不设推理档位，生产路径要看到 thinking 需由 streamFn 传入档位（验收探针 spikes/m5-reasoning-stream-fn.mjs 如此做）；推理档位配置未裁决。OpenAI 兼容端点对现用 key 返回 401，reasoning_content 那条线路未实测。

### 046 Eval 自建薄 runner，任务格式对齐公开基准，外部 harness 只作可选适配（事实）

- 结论：M6.5 / M9 的 Eval 用自建薄 runner，不引入外部评测框架（promptfoo、Inspect AI 等）作主干。runner 四件事：读任务目录、准备仓库快照、经 headless 运行入口跑 Pigeon 若干次、调确定性验证器并从账本出 JSONL 结果。三向对照（无 Skill / 候选 / 已批准）靠 042 / 043 的注入冻结开关；指标全部从 Event Log 算：成功率与误成功率来自验证器回执，工具调用与审批次数来自事件族与治理族，恢复结果来自 resolution，成本来自 044 的 usage。统计按 M9 规范（per-task 三元结果、pairwise delta、Wilson 区间、McNemar exact）自写；报告先出 markdown 表。任务目录格式对齐公开基准（说明 + 验证脚本 + 环境声明，Terminal-Bench 形态），公开任务可导入；Terminal-Bench / SWE-bench 适配器为可选项。M6.5 在本机工作树跑，容器隔离随 exec 沙箱考虑。headless 入口与 M5.5 worker 共用。
- 理由：Pigeon 的 Eval 是"学习有没有带来提升"的对照实验，外部框架面向输入到输出、读不到账本、默认 LLM 打分（§3.8 禁止当判决），主干上帮不上；公开基准 harness 只测完成率测不了学习增益；runner 核心是 headless 入口，M5.5 反正要做；M9 统计规范已明确到公式，自写比在他人断言体系里绕更清楚；任务格式对齐公开基准保住可比性又不让外部成主干依赖；§2 第 6 条：上游与外部都缺"测学习增益"这个语义。先例：SWE-bench / Terminal-Bench 都是自家 harness 加数据集、agent 经适配器接入；Claude Code plugin eval 是自带 JSON 套件的小 runner。局限：无报告界面；M6.5 样本量只能证"可测"，显著性靠 M9 的区间与配对检验；外部工具现状以联网核实为准。粗估 M6.5 阶段约 500 行加测试。
- 锚点：src/eval/（task.ts、snapshot.ts、verify.ts、runner.ts、results.ts、report.ts）、src/application/headless.ts、src/cli/index.ts（run 与 eval 子命令）、eval/tasks/、eval/skills/、docs/audits/eval/；ROADMAP §M6.5、§M9；证据 docs/audits/2026-09-14-m6-5-8e76567.md。
- 落地（2026-09-14，M6.5）：统计只做 per-task 三元结果与 pairwise delta，Wilson 区间与 McNemar exact 留 M9；外部 harness 适配器未做。
- 详情：docs/decisions/m5-5-orchestration-decisions.md。

### 047 文档规范：audit / decision / spikes 入库，notes 本地；探针脚本入库 spikes/（事实）

- 结论：docs/roadmap、docs/decisions、docs/audits、docs/spikes 入库；只有 docs/notes（交接状态、学习材料、上游源码注释）本地不入库。上游行为探针与真实链路验收驱动从本地 tmp/ 迁入仓库根 spikes/，保持原目录层级使 `../src` 相对引用有效，附 README 说明用途、运行前提、PtyHost 编译命令与升级后重跑要求；日志、工作区目录与二进制不入库。spikes/ 不参与 `npm run verify`，并从 biome 检查范围排除（一次性证据脚本，改写以过 lint 的行为风险大于收益）。入库文档写作口径：只写事实、选项、权衡、裁决与证据；不逐字引用对话，不写对人或其他 agent 工作的评价（评价只口头给）；不含本地绝对路径与密钥；审计文件只追加不覆盖，不同会话用带基线 commit 后缀的不同路径。
- 理由：audit 是 §2 复用注意事项第 2 条所说"证据在攻击面测试里"的叙述层，decision 回答"为什么不选另外的方案"，spike 笔记是 §2 上游硬事实的唯一来源且升级后要重跑，脚本不入库则"重跑"对他人是空话；三者不入库时仓库只剩测试文件与结论，最有说服力的部分被挡在外面。此前"三个目录永不入库"的口径把"做了什么、为什么、怎么验证"与"当时怎么想、和谁聊了什么"一并挡住，本条只放行前者。
- 锚点：.gitignore、biome.json、docs/roadmap/README.md（文档目录规范表）、spikes/README.md。

### 048 exec 工具：自由命令加逐次审批，[a] 精确命令串会话 grant，commands.json 可选，沙箱后置（事实）

- 结论：一个 exec 档工具 run_command，参数是命令字符串，模型自由提出；exec 档永不走 read 自动放行，默认逐次审批，面板显示完整命令；[a] 对 exec 档收窄为"本会话放行这条一模一样的命令"，精确字符串匹配（§3.9 第五条"确定性匹配、无自由文本模式"不动），/grants save 升格固化、/revoke 撤销，与既有六档流程同一套；yolo 照旧免审。执行不经 shell 解释器，参数数组直接 spawn；工作目录固定为 worker 工作树；环境变量白名单；墙钟超时；输出按字节截断并标记。Receipt 记命令、退出码、输出哈希与截断输出，加执行前后工作树文件清单差异。`.pigeon/commands.json` 可选：给常用命令起短名，并作 tester 等角色的默认权限清单，主会话不受其限制。沙箱后置：按平台适配（macOS sandbox-exec、Linux bubblewrap、Windows Docker），Sandbox 接口只有 run 一个动作；探测不到沙箱时不改变 run_command 的审批语义。面板加"[a] 加 /grants save 一键完成"的键留作后续 UX 改进（改 029 需修订）。
- 理由：否决"固定命令名单"方案：主会话跑临时命令要先改配置，日常体验过重；Claude Code 在 Windows 上同样无沙箱、靠逐次审批显示完整命令，体验可接受；精确字符串匹配既保住 §3.9 又避免一键放行所有命令，也不会被 `&&` 绕过（代价是 `npm test` 与带参数版本各放行一次）；yolo 改的是审批不是能力，无人值守跑任意命令的风险由拨档者承担，工作树隔离兜住仓库不兜住机器；固定名单降为角色策略正合 tester 定义"只跑固定测试命令"，M5.5 完成证据不变。exec 无路径可围，这是它区别于读写工具的根本；Windows 无轻量沙箱原语，Docker 路线约三天加运行时代价，原生 AppContainer 一到两周且易做成假安全，故沙箱等真实需求再排。先例：sudoers 精确命令放行、npm scripts / CI 命名步骤、MCP 命名操作是"没沙箱时"的标准做法；主流 coding agent 的自由 shell 加前缀规则依赖其平台的轻量沙箱。
- 锚点：src/tools/run-command.ts（不经 shell 的参数数组执行、环境变量白名单、超时、截断、文件清单差异、短名与角色清单）、src/tools/grants.ts（精确命令匹配）、src/approvals/handler.ts（grantScopeFor：exec 档 [a] 收窄为命令串）、src/approvals/grant-store.ts、src/state/receipt.ts（v4 exec 证据）、src/state/grants.ts 与 src/state/event-log.ts（grant 族与固化规则的 command 字段）、src/state/commands.ts 与 src/persistence/commands-config.ts（commands.json schema 与读取）、src/application/governance.ts（审批请求带风险分层、exec 证据落 receipt）、src/application/runtime.ts（注册与角色允许清单）、src/application/grants.ts（/grants 展示、升格与移除携带命令）、src/orchestration/roles.ts（tester 角色）、src/tui/approval.ts 与 src/cli/approval-ui.ts（精确命令放权键）、src/cli/trace.ts（exec 证据投影）；测试 src/tools/run-command.test.ts、src/tools/grants-command.test.ts、src/persistence/commands-config.test.ts、src/orchestration/roles-tester.test.ts、src/application/run-command-e2e.test.ts；ROADMAP §M5.5 exec 段与角色表。
- 详情：docs/decisions/m5-5-orchestration-decisions.md。
- 修订（2026-09-14）：Windows 上解析到 .cmd / .bat 时，参数逐个匹配保守字符集（字母、数字与 _ . - / : = @），全部通过则经 cmd.exe /d /s /c 作启动器运行，任一不通过则拒绝并指出是哪个参数；字符集不因任何模式放宽。需要 shell 语义的命令（管道、串联、白名单外参数）只在人确认后以 shell 运行，确认来源三种：审批面板对精确命令串的批准、[a] 会话 grant、/grants save 固化规则；grant 与固化规则带 shell 标记（加法式，旧记录缺省为 false，只有带标记的才能免审需 shell 的命令），匹配仍是精确字符串。yolo 下需 shell 的命令照 004 免审，无例外；Receipt 的执行证据标明经 shell。面板显示的命令串与实际执行的字节一致，不做改写，文案含"经 shell"，显示前经 036 净化。commands.json 只做短名与角色允许清单，不是 shell 授权来源。理由：npm、npx 与 node_modules/.bin 在 Windows 上全是 .cmd 垫片，如实拒绝使 tester 在 Windows 不可用；BatBadBut 一类参数注入依赖的字符全在白名单之外，cmd.exe 只当启动器；shell 授权的关键是人看到一模一样的命令并点头，与手写清单同等信任；yolo 是批发授权，按 004 无例外。锚点：src/tools/run-command.ts（inspectCommand 三路判定、启动器字符集、authorizeShell 一次一用）、src/application/governance.ts（需 shell 判定、放行时授予 shell）、src/tools/grants.ts 与 src/approvals/grant-store.ts（shell 标记匹配）、src/approvals/handler.ts（面板命令行与 [a] 的 shell 标记）、src/state/grants.ts、src/state/event-log.ts、src/state/receipt.ts（shell 字段）；测试 src/tools/run-command-shell.test.ts、src/tools/grants-shell.test.ts、src/application/run-command-shell-e2e.test.ts、src/tui/approval-shell.test.ts。

### 049 治理编排整体搬到 application/，Adapter 只转发 decide；零行为变化作 M5.5 S0（事实）

- 结论：Adapter 内约 400 行治理编排（六档排律求值、会话 grant 匹配与命中计数、固化规则匹配、审批 handler 调用、拒绝理由回模型、熔断计数、intent / decision / receipt / breaker 四族落盘）整体搬到 application/governance.ts；ToolGovernance 接口定义在 pi-runtime（Adapter 是消费者），实现在 application，分层方向合规；Adapter 的 beforeToolCall 钩子只做 decide(ctx) 转发，把 block 理由原样交回上游。作 M5.5 的 S0 切片，零行为变化：现有测试断言不改全过，adapter 七个测试文件只换注入面；接缝变异为篡改 governance 返回的拒绝理由一字，"理由逐字回模型"测试精确变红。
- 理由：M5.5 的 childPolicy ⊆ delegatedParentPolicy 校验只能在 Controller 做，Adapter 里没有"父"的概念；§2 规则 3 要求 Adapter 不自行决定权限，022 记账的债到此清；M6 Reviewer 同样要经 Controller。否决"只加子集校验"（债继续挂）与"搬一半"（决定与落盘分居两处难测）。
- 锚点：src/pi-runtime/governance.ts（ToolGovernance 接口、宿主能力、落盘口类型）、src/application/governance.ts（审批闸整族实现：排律、grant 求值、人工审批、账本、四族落盘、熔断、上游拦截计数）、src/pi-runtime/adapter.ts（beforeToolCall 转发 decide 并原样交回理由，tool_execution_end 转发 settle）、src/application/runtime.ts（装配根组装后注入）；测试 adapter 七个测试文件只换注入面，src/pi-runtime/adapter-persistence.test.ts「decision 写盘失败不改变拒绝结果」补模型侧逐字断言作接缝证据；ROADMAP §M5.5 前置。
- 详情：docs/decisions/m5-5-orchestration-decisions.md。

### 050 推理档位两级来源进快照冻结、Memory 按文件名排序、域错误看标记、reasoning_content 待测（事实）

- 结论：推理档位（thinking level）进 InjectionSnapshot 的 model 段作冻结字段，随 run.started 落盘；来源两级：启动参数为全局值，worker 角色配置可覆盖，缺省不请求推理；Run 开始时定、Run 内不变。运行时自动调整（按任务难度或上一轮失败升档、模型请求下一轮加深）列为 M9 之后的候选，触发条件以 Eval 数据为准，现在不做。常驻 Memory 的装载顺序按文件名排序为既定口径，需控制顺序用数字前缀，不造配置文件。read_session_entry 与 load_skill 的域错误分类改为看错误对象上的标记而非 import 类型，tools 层不依赖 memory，失败不再落"未知"默认桶，随 M5.5 S5 施工。OpenAI 兼容端点的 reasoning_content 映射线路等有效 key 再测，审计保持"未测"。
- 理由：M5 施工登记的四个未裁决项。推理档位属于"实际给了模型什么"，该随快照冻结并可在 trace 回答；它是成本旋钮不是权限，§3.1 不管它，但自动调整现在没有收益数据（044 usage 落盘正是为此）、会破坏 Eval 的固定预算对照、也没有可靠的"任务难"判据，故先人定与角色定，自动调等 M7 失败分类与 M9 Eval 出数据。文件名排序已足够且零机制；错误分类是分层规则下的施工细节；第四项受外部条件限制。
- 锚点：src/state/runtime-events.ts（ThinkingLevel 字面量与 run.started 的档位字段）、src/pi-runtime/snapshot.ts（InjectionSnapshot v4、v3 → v4 迁移）、src/pi-runtime/adapter.ts（档位交给上游 Agent 并落 run.started）、src/application/runtime.ts（全局值进快照）、src/application/workers.ts 与 src/orchestration/roles.ts（角色表档位列覆盖全局值）、src/cli/index.ts 与 src/tui/main.ts（--thinking）、src/memory/resident.ts（文件名字典序口径，删除无来源的 order 参数）、src/tools/error-kind.ts（先读错误对象标记）、src/memory/search-tools.ts 与 src/skills/load-skill-tool.ts（错误类带 domain 标记）；测试 src/application/runtime-thinking.test.ts、src/pi-runtime/snapshot.test.ts、src/memory/resident.test.ts、src/tools/error-kind-marker.test.ts；reasoning_content 线路仍未测；ROADMAP §M5.5 前置。
- 详情：docs/decisions/m5-5-orchestration-decisions.md。

### 051 MCP 配置：server 定义读 .mcp.json，风险档覆盖写旁置 .pigeon/mcp.json，未列工具缺省 write（事实）

- 结论：MCP server 的启动定义（command / args / env 或 type http 加 url）兼容读取 Claude Code 的 `.mcp.json`；Pigeon 独有的工具风险档（read / write / exec）覆盖写在旁置的 `.pigeon/mcp.json`，版本化 schema 与 grants.json 同款：servers 按名字，每个可选 defaultTier 缺省 write，tools 按工具名给 tier，read 工具可带 pathConfinement 声明；未列出的工具按 defaultTier；没有 `.mcp.json` 时允许在 `.pigeon/mcp.json` 里直接定义 server。启动时两份合并，冲突以 `.pigeon/mcp.json` 为准。MCP 注解只当线索，与配置不一致按更严执行，留痕形态见 052。术语：风险档是工具属性，回答"多危险、留什么证据"；放权六档排律（§3.9）回答"这次调用凭什么放行"，两者只在"read 档第五档自动放行"一处相交，本条不动六档排律。
- 理由：往 `.mcp.json` 里塞私有字段依赖 Claude Code 忽略未知字段，不可控，也把 Pigeon 语义混进别人的文件；写进 grants.json 是概念错位，风险档是工具属性不是人对调用的授权；旁置文件各管各的语义，缺省 write 是 fail-closed。先例：oh-my-pi 读 .claude 等目录的 MCP 配置再叠自己的设置。
- 锚点：ROADMAP §M5.7 交付；src/state/mcp-config.ts（schema 与合并判据）、src/persistence/mcp-config.ts（两份文件读取，畸形响亮失败）、src/application/mcp.ts（会话开始时启动）、src/application/runtime.ts（按档注册）。
- 详情：docs/decisions/m5-7-decisions.md。

### 052 MCP 注解与配置冲突记进 run.started 工具集摘要，按更严执行（事实）

- 结论：run.started 的工具集摘要里每个 MCP 工具带两个可选字段：declaredHint（server 注解摘要：readOnlyHint / destructiveHint 等）与 effectiveTier（Pigeon 实际采用的风险档），不一致的标 conflict；加法式不升版本。更严执行规则写死：声明只读但配置 write 或 exec，按配置；声明 destructive 但配置 read，按 write 并标 conflict；未配置一律 write（051）。trace 的 Run 头列出冲突项；resume 与会话摘要不动；启动时进程内同时警告。
- 理由：冲突是"工具集"层面的事实，run.started 正是记"实际暴露给模型的工具集"的落点（044），零新记录族且冷侧可查；只在进程内警告违反"缺口冷侧可见"的一贯口径；每次 tool.proposed 重复记同一件事是冗余；新开 mcp.catalog 族与 run.started 信息重叠。
- 锚点：ROADMAP §M5.7 交付；src/state/mcp-toolset.ts（更严规则与摘要 schema）、src/state/runtime-events.ts（run.started 载荷加 mcpTools / mcpServers）、src/mcp/registry-bridge.ts（按实际档位注册）、src/application/mcp.ts（摘要）、src/pi-runtime/adapter.ts（每个 Run 开始时取摘要）、src/cli/trace.ts（Run 头列冲突；state/trace.ts 已持有 run.started 记录，不需改动）、src/cli/index.ts 与 src/tui/main.ts（启动时进程内警告）。
- 详情：docs/decisions/m5-7-decisions.md。

### 053 Receipt 加第三个证据块 mcp：参数与返回哈希、截断标记、serverEvidence 约定；治理链不动（事实）

- 结论：Receipt 升 v5 加法式，新增可选块 mcp，与 contentAfterHash（write）、exec（exec）并列，各对应一类工具：argsHash（与 intent 原始参数哈希对上）、resultSummary 与 resultHash（返回文本摘要与全文哈希）、resultBytes 与 truncated（§3.3 截断不支撑确定性结论）、structuredHash（结构化返回的哈希）、serverEvidence（server 主动交的证据：MCP 返回的 structuredContent 若含 `evidence` 键，原样收入，上限 16 KiB 超出截断并标记，整体算哈希）。冷侧对账对 mcp 块只判"回执在不在"，不做哈希三方比对。六档排律、审批、intent / decision / receipt 三族、对账规则一律不动，不加新记录族，不解析 server 返回的语义。
- 理由：每个字段都是既有回执所答问题在第三类工具上的投影：执行参数是否审批时那份、实际发生了什么、证据是否完整、崩后怎么对账；serverEvidence 对应 write 工具"改前改后哈希"的位置，只是这次只有 server 知道。否决塞进 exec 块（退出码与文件清单对 MCP 无意义）与三块合成通用联合（重构已落地形状，收益只是形式统一）。命名取 mcp 而非 call / external：与 exec 同风格、一眼可读，041 已定外部只经 MCP，不存在第二种协议。
- 锚点：ROADMAP §M5.7 交付；src/state/receipt.ts（v5）、src/state/mcp-evidence.ts（证据计算与 16 KiB 上限）、src/mcp/registry-bridge.ts（执行时暂存证据）、src/application/governance.ts（settle 落 mcp 块）、src/state/event-log.ts（v8：读路径把内嵌 receipt 升到当前版本）、src/cli/replay.ts（mcp 摘要）。
- 施工补记（2026-09-14）：receipt 升版要求 Event Log 同步升 v8，否则 v7 记录里的 v4 receipt 读回即被判损坏；同一处缺口在 M5.5 已存在（v6 记录里的 v3 receipt 读回报损坏，探针实测），v7 → v8 迁移一并补上。
- 详情：docs/decisions/m5-7-decisions.md。

### 054 隔离单位接口已由 M5.5 的 WorkspaceProvider 满足；形状封顶三种，领域隔离归工具链（事实）

- 结论：041 交付里的"隔离单位泛化为可插拔接口"判定为已由 M5.5 的 WorkspaceProvider（plan / create / changedFiles，git 工作树实现，测试注入内存实现）满足，M5.7 不动；事件记录里工作区 kind 仍为字面量 git-worktree，第二种形状出现时改为联合类型（加法式），接口的 release 动作届时一并加。Pigeon 侧的工作区形状封顶三种：git 工作树（已有）、普通目录（首个非 git 工具链来时加）、容器（走 Docker 沙箱时与 Sandbox 实现共用一个容器句柄）。领域层面的隔离（Unity Library 缓存复用、数据库只读连接、临时表命名等）不是 Pigeon 的职责：Pigeon 经 MCP roots 把 worker 目录路径告诉 server，server 在该目录内自行安置领域状态。工作区隔离（文件放哪）与沙箱（进程能干什么，048 的 Sandbox.run）是两个正交的轴，靠"Sandbox.run 以工作区路径为唯一可写路径"这一个参数相连。
- 理由：接口在代码层已可插拔，M5.7 验收仍在 coding 场景用 git 工作树，无第二种消费者，提前预留 kind 联合与 release 只换来"看起来更通用"，按"非必要不新增"不做；形状数量跟"Pigeon 管的东西"走而非跟工具链走，Pigeon 只管给 worker 一个目录，与 041"Pigeon 管路径与治理、工具链管领域"同一分工。
- 锚点：src/orchestration/workers.ts（WorkspaceProvider，未改）、src/state/event-log.ts（WorkerWorkspaceSchema，未改）、src/mcp/client.ts（roots 广告为工作区根）、src/application/workers.ts（worker 以其工作树为工作区根启动自己的 MCP 会话）；ROADMAP §M5.7 交付。
- 详情：docs/decisions/m5-7-decisions.md。

### 055 M5.7 验收用两个官方参考 server：filesystem 走真实链路，everything 走协议一致性（事实）

- 结论：验收用 @modelcontextprotocol/server-filesystem 与 @modelcontextprotocol/server-everything，均锁 2026.8.31 写进 devDependencies，验收夹具的 .mcp.json 与 .pigeon/mcp.json 放 spikes/ 下。filesystem 指向 worker 工作树，走 Kimi 真实链路：两个 worker 各自用它写文件，write 档逐次审批且面板分来源，read 档自动放行，回执带 mcp 块，changedFiles 与 serverEvidence 对得上。everything 走自动化测试：注解与配置冲突落 run.started（052）、prompts 被 Skill Catalog 吃进（043 口径）、工具清单变更通知、server 掉线时核心 Coding Run 照跑并留痕（M5.7 完成证据）。server 启动命令来自人写的 .mcp.json，Windows 上 npx 是 .cmd，按 048 口径经启动器或 shell 拉起，复用 048 的实现，不另裁决。
- 理由：filesystem 有真副作用且与 Pigeon 自有读写工具功能重叠，正好验证"外部会写盘的工具被同等治理"；everything 是协议测试专用，覆盖注解、prompts、resources、长任务与故障面；只用其一各缺一半；memory 这次不需要。MCP server 只提供可调用的操作，何时调、能否调、留什么账全在 Pigeon，server 看不见审批与账本。
- 锚点：ROADMAP §M5.7 完成证据；package.json（devDependencies 锁 2026.8.31）、spikes/mcp-acc/（.mcp.json、.pigeon/mcp.json 夹具，run-everything.mjs 自动化剧本，run-filesystem.mjs 真实链路剧本）、src/tools/run-command.ts（planMcpLaunch 复用 048 启动器）、src/mcp/transport.ts；证据 docs/audits/2026-09-14-m5-7-d99d693.md。
- 详情：docs/decisions/m5-7-decisions.md。

### 056 headless 运行入口：进程内 API 加 `pigeon run` 薄壳；无人值守审批只有 yolo 或 fail-closed；需审批次数从回执反推（事实）

- 结论：headless 入口分两层。进程内 API 复用 M5.5 的 worker 运行面工厂（createWorkerRuntimeFactory），以无父会话的方式装出完整运行面跑到收尾，带轮次与墙钟上限，供 Eval runner 与将来的脚本流水线调用；cli 新子命令 `pigeon run` 只是它的薄壳：任务描述从参数或 stdin 读，沿用 --root、--stream-fn、--yolo、--thinking，加 --max-turns、--wall-clock 与 --json（退出时打印一行结构化结果：sessionId、runId、终态、失败分类、轮次、usage、需审批次数），退出码按终态映射。每次运行是一个普通会话，账本、trace、search 照旧。无人值守下的审批只有三种合法形态且由参数决定：缺省 prompt 模式下一律 fail-closed 拒绝（006 既有）；显式 --yolo；grants.json 固化规则加 yolo。"有人在场时会被问几次"不新增记录，从回执反推：write 与 exec 档且 approvedBy 为 policy:yolo 的调用数，即 M9 的"审批次数"指标来源。
- 理由：无人值守时"问人"这一档没有人可问，fail-closed 是唯一诚实的落法，yolo 是人的显式拨档；worker 工厂已是不经 Actor 的完整运行面，API 几乎现成；子命令壳给人和外部 harness 适配器用，API 给 runner 用，两者分离避免 runner 起子进程。先例：Claude Code 的 `claude -p` 与 Codex 的 `codex exec`，一段提示、跑完退出、可选 JSON 输出。复杂度约 API 80 行、壳 120 行、测试 150 行。
- 锚点：src/application/headless.ts（runHeadless、summarizeRunMetrics、HEADLESS_EXIT_CODES）、src/application/workers.ts（openRuntimeSurface 装配内核、createDetachedRuntime）、src/application/runtime.ts（createApprovalHandler 可缺省、skillRoots / memoryRoots）、src/cli/index.ts（run 子命令）；测试 src/application/headless.test.ts、src/cli/run-cli.test.ts；ROADMAP §M6.5。
- 落地（2026-09-14）：worker 工厂的请求形状要求父会话与角色，headless 与它共用抽出的装配内核（不写 session.header、run_command 不套角色清单、不传审批通道），worker 路径行为不变；终态除四种 Run 终态外有 turn-limit / wall-clock-limit / token-limit（累计 totalTokens 达上限即中止）；退出码 completed 0、failed 2、aborted 3、unknown 4、turn-limit 5、wall-clock-limit 6、token-limit 7，1 为参数与装配错误；结果另带工具调用数与耗时，全部从 Event Log 算。
- 详情：docs/decisions/m6-5-decisions.md。

### 057 Eval 任务目录格式：一任务一目录、快照为 git 引用经工作树、验证器由 runner 在收工后独立运行（事实）

- 结论：任务放在仓库 `eval/tasks/<id>/`，入库，一任务一目录：task.md 任务说明、task.json 元数据（id、说明文件、repo 与 ref、预算 maxTurns / wallClockMs / 可选 token 上限、验证器命令与超时、tags、holdout 标记）、verify 脚本、README（测什么能力、来源与许可）。代码快照以 git 引用给出（仓库加提交号），runner 用 M5.5 的 WorkspaceProvider 从该提交开工作树，零新机制；M6.5 的任务直接用 Pigeon 自己的仓库在锁定提交上。验证器由 runner 在 agent 收工后作为独立子进程在工作区内执行，带超时，模型看不见也改不了；验证脚本只看工作区最终文件，不依赖模型留下的临时状态。公开基准（Terminal-Bench 目录形态、SWE-bench 总表形态）导入时转成同一布局。
- 理由：说明、快照、验证器三件套是公开基准的共同点，差别只在快照怎么给；git 引用与工作树隔离同一机制，比复制目录与镜像都轻且确定；验证器由 runner 跑是 §3.3 与"确定性验证器"的落法，模型自己跑的测试只是它的反馈不是判决；自托管在本仓库的任务真实且免费。复杂度约 schema 与加载器 100 行、快照准备 40 行、验证器执行 60 行、测试 100 行。
- 锚点：src/eval/task.ts（EvalTaskSchema、loadEvalTask / loadEvalTasks）、src/eval/snapshot.ts（prepareTaskWorkspace）、src/orchestration/workers.ts（WorkspaceProvider 的 baseRef、gitWorktreeWorkspaces 分传仓库根与治理根）、src/orchestration/worktree.ts（addWorktree 治理根、deleteBranch、mainRepoRoot）、eval/tasks/、.gitignore（资产例外）、.dependency-cruiser.js（eval-below-actors）；测试 src/eval/task.test.ts、src/eval/snapshot.test.ts、src/eval/snapshot-stale.test.ts（崩溃残留续跑前清理）；ROADMAP §M6.5。
- 落地（2026-09-14）：task.json 带 version；repo.path 为 "." 时取主仓库根；id 与目录名一致、最长 24；验证资产放 assets/ 下按工作区相对路径排布，不得越出工作区根；验证器命令为参数数组，`{TASK_DIR}` 替换为任务目录；工作树开在治理根（输出目录）的 .pigeon/worktrees 下，worker 名 `<taskId>-<condition>-<n>`，挂 node_modules 目录联接，跑完先拆联接再删工作树与分支；首批任务集 8 个在 8e76567 上。
- 详情：docs/decisions/m6-5-decisions.md。

### 058 验证器接口：退出码三值判决加可选 JSON、误成功取"自报完成但验证失败"、判决记 eval.verified 观察族（事实）

- 结论：验证器返回以退出码为主：0 通过、非 0 失败、超时或脚本自身崩溃为"未判定"，三值直接对上 M9 的 per-task 三元结果；stdout 最后一行若是 JSON 则原样记进结果供报告展示子项，字段不约束。误成功分两层：第一层"agent 自报完成但验证器失败"记为误报，自报完成由账本现成信息判定（末轮 assistant 消息以正常 stop 结束且无未闭合的工具错误），不让模型输出特殊标记；第二层任务可选带反向断言脚本（如未改测试文件、未删文件），反向断言失败即使正向通过也判失败并标"越界"，M6.5 只做第一层、留第二层接口。验证器自身的证据记一条观察族 eval.verified（任务 id、命令、退出码、输出哈希与截断输出、耗时、三值结论），落在该次运行的会话文件里，trace 可见，形态同 exec 回执但不是工具调用。
- 理由：成功率与误成功率两个指标全靠验证器，返回形状与误成功定义必须先定死；三值而非二值是 §3.3 "缺失结果不得支撑确定性结论"与 M9 统计规范的直接要求；判决落账本才能让 trace 回答"这次跑的判决是什么"，也让 M7 拿到干净的结果标签；公开基准都是退出码判决加测试日志，"误成功"是路线图自提的指标，按最小可算的定义来。复杂度约验证器执行与三值判定 60 行、记录族 40 行、误报判定 30 行、测试 100 行。
- 锚点：src/eval/verify.ts（restoreAssets、runVerifier、judgeVerdict、selfReportedDone、verifyTaskRun）、src/state/runtime-events.ts（EvalVerifiedPayloadSchema）、src/state/event-log.ts（v9、eval.verified 族）、src/state/materialize.ts（evalVerifieds）、src/state/trace.ts 与 src/cli/trace.ts（Run 头验证判决）、src/cli/replay.ts、src/application/format.ts（evalVerdictLabel）；测试 src/eval/verify.test.ts；ROADMAP §M6.5。
- 落地（2026-09-14）：Event Log 升 v9 加法式；未判定包括超时、被信号终止、验证器拉不起来与回填失败；输出按到达顺序计字节与哈希，只留尾部 16 KiB；首参 node 换成当前 Node 可执行文件，超时终止整棵进程树；自报完成的判据为 run.ended 在场、末轮正常 stop 且非合成失败、每个提议的工具调用都已落定、末个工具结果不是错误；运行面没装起来（无 runId）时照样判决但不落 eval.verified。
- 详情：docs/decisions/m6-5-decisions.md。
- 修订（2026-09-14）：验证器的输入资产以任务目录为准：验证用的测试文件与脚本放在任务目录里，runner 在跑验证器前先把它们覆盖写回工作区，工作区里被 agent 改动或删除的同名文件不作数；"验证脚本只看工作区最终文件"精确为"只看回填后的工作区"。理由：yolo 下 agent 可以改掉或删掉测试让验证通过，第一层误报判定抓不到；回填是 SWE-bench 评测时才打测试补丁的同一做法，约 30 行；按路径 deny 是新治理语义、反向断言是事后发现，均不取。

### 059 冒烟对照：候选 Skill 放暂存目录、headless 传 skillRoots 切三条件、Skill 从真实失败手写、任务集含 holdout（事实）

- 结论：候选 Skill 放独立暂存目录 `.pigeon/candidates/skills/<name>/`，缺省不加载，与 §3.4 "候选默认进持久化暂存区"一致；M8 的激活即把目录搬进 .pigeon/skills 并落记录。三向对照（无 Skill、候选、已批准）由 headless API 的 skillRoots 参数切换：空、只含暂存目录、只含正式目录；043 的哈希清单随之进 run.started，事后可证每次跑用的是哪一版。M6.5 的"候选"与"已批准"是同一份文件在两个位置，该对照验证注入管线，"无对有"才验证经验效果。Skill 由人手写，内容从 M5 与 M5.5 审计里模型真实踩过的坑提炼（如 Windows 上 .cmd 的处理、改动后先跑对应测试文件再收工），不经自动管线，这正是 M6.5 "手工编写"的定义；自动提炼按 §5 顺序在 M6（Reviewer 出候选）与 M7（对比式蒸馏）做，手写 Skill 届时成为对照基线。任务集 5 到 10 个，全部在 Pigeon 自己的仓库锁定提交上，其中 2 到 3 个标 holdout，写 Skill 时不看，holdout 上的指标变化才说明经验会迁移而非背题。每任务每条件跑 3 次，成本由 044 的 usage 算出进报告。
- 理由：M6.5 原文"在蒸馏链全自动完成前先证明论断可测、不依赖 M5.5 或 M6"，runner、任务集、指标是 M7 到 M9 反正要用的设施，手写 Skill 是它的第一个使用者；若人写的经验都测不出变化，自动生成要先回头看指标。暂存目录优于前言 status 字段：与 §3.4 字面一致，激活动作可见。holdout 是评测的标准做法。复杂度约暂存目录与 skillRoots 参数 60 行、runner 条件循环 80 行，任务与 Skill 是内容编写约一天。
- 锚点：src/skills/catalog.ts（SkillRoot 显式根）、src/memory/resident.ts（MemoryRoot 显式根）、src/application/headless.ts（skillRoots / memoryRoots）、src/eval/runner.ts（skillRootsFor、条件循环）、eval/skills/pigeon-coding-pitfalls/、eval/tasks/；测试 src/skills/catalog-roots.test.ts、src/application/headless.test.ts、src/eval/runner.test.ts；ROADMAP §M6.5。
- 落地（2026-09-14）：Skill Catalog 显式根在场时只扫给定的根（空数组不登记任何本地 Skill），根目录自身有 SKILL.md 即一个 Skill，展示路径为给定标签；`.pigeon/candidates/skills/` 缺省不加载、显式列出才加载；显式 Memory 根在场时连用户级偏好也不读；runner 按"第几次 → 任务 → 条件"交错。
- 详情：docs/decisions/m6-5-decisions.md。
- 修订（2026-09-14）：Eval 用的候选与已批准 Skill 放入库的 `eval/skills/<name>/candidate/` 与 `eval/skills/<name>/approved/`，runner 三个条件的 skillRoots 直接指向它们，memoryRoots 三个条件一律为空；`.pigeon/candidates/skills/` 仍是日常使用的暂存区约定，M8 的激活动作不变。理由：.gitignore 忽略整个 .pigeon/，否则 results.jsonl 与 report.md 入库而被对照的 Skill 不在仓库里，只能靠 run.started 的哈希对上；Memory 不是本轮实验变量。

### 060 Eval 结果落 docs/audits/eval/<日期>-<基线>/：results.jsonl 与 report.md 入库，实验会话用该目录下独立治理根不入库（事实）

- 结论：每次 Eval 运行一个目录 `docs/audits/eval/<日期>-<基线号>/`。results.jsonl 入库，每次运行一行：任务 id、条件、第几次、sessionId、runId、三值判决、是否误报、轮次、工具调用数、需审批次数、usage、耗时、失败分类，是 M9 统计的原始数据。report.md 入库：任务乘条件的成功率表、误报、成本、holdout 单列；M6.5 只做 per-task 三元结果与 pairwise delta，Wilson 区间与 McNemar exact 在 M9 补。实验会话文件落该目录下的 `.pigeon/`（独立治理根，被 .gitignore 的 .pigeon/ 规则忽略，本地保留供 trace / replay 以 --root 回查），不与日常会话混放。runner 的输出目录参数决定三样落点；工作区仍是从任务快照开出的工作树。此条顺带处理 M6.5 前置第 6 件"会话数膨胀"：实验会话不进日常会话列表，015 的重审推迟到日常会话数真实变多时。
- 理由：047 文档规范下证据进 docs/audits、运行时数据不入库；结果表几十 KB 且必须可复算，会话文件几十 MB 且既有审计已接受"号在、文件在本机"的形态；独立治理根让几十个实验会话不污染日常列表，比现在就改会话列表的读法便宜且正确。复杂度约结果写出与报告生成 150 行，目录约定零代码。
- 锚点：src/eval/results.ts（EvalResultLine、EVAL_RESULT_FIELDS、readResultLines）、src/eval/runner.ts（runEval）、src/eval/report.ts（renderEvalReport）、src/cli/index.ts（eval 子命令）、docs/audits/eval/2026-09-14-8e76567/；测试 src/eval/runner.test.ts、src/eval/report.test.ts；ROADMAP §M6.5。
- 落地（2026-09-14）：结果行另带 holdout、终态与出错时的 error；每次运行结束立即追加一行，重跑同一输出目录跳过已有的（任务、条件、第几次）；报告另列按条件汇总的成本与过程、运行异常清单。
- 详情：docs/decisions/m6-5-decisions.md。

### 061 编辑格式对照：只加一组 replace 式编辑工具，hashline 基线复用 M6.5 冒烟无 Skill 24 次；锚点容错搁置（事实）

- 结论：M6.5 冒烟里 edit_file 报错率 21.5%（209 次调用 45 次报错，大头是锚点行号不对与锚点格式错），为判断"对 Kimi 与本仓库这类小改任务，hashline 与 replace 哪种编辑摩擦更小"，只加一组 replace 式编辑工具（给出原文与新文、原文在文件里必须恰好出现一次）与 hashline 对照。Eval 条件在 Skill 维度之外加编辑模式维度，运行面按编辑模式装配编辑工具，缺省仍为 hashline；比较以过程指标为主：编辑报错率与报错分类、轮次、输出 token、输出上限截断次数，成功率顺带列出。锚点容错（按唯一标签重定位、窗口查找、报错给候选）、仿 oh-my-pi 新形态、按模型选编辑模式本轮不做，锚点容错搁置到对照结果出来后再议；编辑工具默认是否改用 replace，按对照数据另行裁决。
- 理由：成功率在现有任务集上已触顶，过程指标仍能区分编辑方式；外部测评结论有分歧，而本仓库编辑工具的设计出处 oh-my-pi 已对 Kimi 等模型默认改用 replace，事前证据指向 replace 在本组合上不差于 hashline，一组对照即可回答核心问题；锚点容错的前提是继续使用 hashline，先定去留再定规则可避免白做；多组对照中仿新形态工作量大且对 Kimi 不看好。
- 修订（同日）：只跑 replace 一组，hashline 基线复用 M6.5 冒烟无 Skill 条件的 24 次运行，不在新版本上重跑；两组之间的 harness 版本差与时间先后差异作为已知局限写进审计与报告，hashline 基线的过程指标用与新一组相同的代码从保留的会话账本复算。
- 修订（同日）：replace 式编辑工具口径参照 str_replace 惯例——原文恰好出现一次、精确匹配不做空白宽松、不带快照参数、工具名沿用 edit_file、replace 模式下 read_file 每行为 `行号| 内容` 不带标签、成功回执与 hashline 版对齐不回传 diff。理由：对照的是编辑方式本身，工具名、回执形状与治理接入保持一致，差异只落在参数形态与寻址方式上；read_file 去掉标签避免模型把前缀抄进原文。
- 锚点：src/tools/edit-mode.ts（EditMode）、src/tools/replace-edit.ts（replace 式 edit_file：唯一匹配、保留 BOM 与行尾、预览与内容证据）、src/tools/read-file.ts（replace 模式输出 `行号| 内容`）、src/application/runtime.ts 与 src/application/headless.ts、src/application/workers.ts（编辑模式装配与透传）、src/eval/process.ts（过程指标汇总与编辑报错分类）、src/eval/results.ts 与 src/eval/runner.ts（运行键加编辑模式，结果行加 editMode / harnessRef / process）、src/eval/compare.ts 与 src/cli/index.ts（`pigeon eval compare`、`--edit-mode`）、src/orchestration/worktree.ts（describeHead）、docs/audits/eval/2026-09-15-81e37bc/；测试 src/tools/replace-edit.test.ts、src/tools/read-file-replace.test.ts、src/application/replace-edit-e2e.test.ts、src/application/runtime-edit-mode.test.ts、src/eval/process.test.ts、src/eval/compare.test.ts；ROADMAP 编辑工具参考条目不动；证据 docs/audits/2026-09-15-edit-format-81e37bc.md。
- 落地（2026-09-15）：Event Log schema 未改，编辑模式靠结果行与 run.started 已有的 system prompt 哈希、工具集摘要区分；缺省 hashline 时发给模型的 system prompt、edit_file 与 read_file 的描述和参数逐字不变；过程指标按 tool.settled 计各工具调用与报错、按 stopReason 为 length 计撞输出上限轮数，编辑报错按报错文案的稳定前缀分类（口径见审计）；hashline 基线的过程指标由同一汇总函数从保留的会话账本复算，无 Skill 24 次复算为 edit_file 调用 66、报错 16、撞输出上限 0。
- 详情：docs/decisions/edit-format-decisions.md。
- 后续：缺省编辑模式的裁决见 062。

### 062 编辑工具默认改用 replace，hashline 保留为可选并留作后续优化方向（事实）

- 结论：编辑工具的缺省编辑模式改为 replace，hashline 保留为可选编辑模式（cli、tui、headless、worker、`pigeon run` 与 `pigeon eval` 不指定编辑模式时一律为 replace，`--edit-mode hashline` 仍可用）；hashline 当前维持现有严格规则；锚点容错、编辑后回传新锚点、参数改为字符串补丁、参考 oh-my-pi 的过期恢复与块操作等 hashline 优化本轮不做，留作后续优化方向，在有使用方（接入行号定位能力强的模型、大文件或大块移动类任务、并行编排下文件被外部改动）时再盘，优化后以 Eval 对照验证。Eval 旧结果行没有编辑模式字段的仍按 hashline 读，不跟随缺省值。resume 沿用当前缺省值，不追溯原会话的编辑模式（Event Log schema 不改）。
- 理由：061 对照（条件 none，Kimi For Coding，各 24 次）编辑报错率 hashline 24.2%（66 次调用 16 次报错）、replace 4.7%（64 次 3 次）；按运行算至少出一次编辑错误的运行 9/24 对 2/24。成功率都是 24/24，未测出差异；replace 平均多 1.5 轮、总 token 多约 15%，多出部分集中在一道题的命令循环。设计出处 oh-my-pi 也对 Kimi 等模型默认用 replace。hashline 的主要报错是锚点格式错与锚点未命中，replace 下这两类不再出现。局限：单一模型、8 道小改题、两组 harness 版本与运行时间不同；以后接入其他模型或 M9 任务集建成后复核。
- 锚点：src/tools/edit-mode.ts（DEFAULT_EDIT_MODE 为 replace、LEGACY_RESULT_EDIT_MODE）、src/eval/results.ts、src/eval/runner.ts、src/eval/compare.ts、src/eval/report.ts（旧结果行按 hashline 补齐）、src/application/workers.ts（worker 工厂接受编辑模式）；测试 src/application/runtime-edit-mode.test.ts；ROADMAP §4、§M3 编辑工具条目；证据 docs/audits/2026-09-15-edit-format-81e37bc.md（S4 节）。
- 落地（2026-09-15）：依赖缺省 hashline 的既有测试改为显式传 hashline，断言不删；已知边界：旧会话历史里有 hashline 格式的读取输出，resume 后模型拿到的是 replace 版工具；eval/skills/pigeon-coding-pitfalls/ 第 1 节讲 hashline 用法，在新缺省下已不适用，本轮不改。
- 详情：docs/decisions/edit-format-decisions.md 裁决第 4 条。

### 063 失控止损：单轮输出上限缺省 16,384 可配、system prompt 加截断后拆小引导；流式重复检测暂不做（事实）

- 结论：单轮输出上限缺省 16,384 token，可配置（cli、tui、headless、`pigeon run`、`pigeon eval` 以参数覆盖，worker 继承父运行面的值），由 Pigeon 在装配层包装 streamFn、以 maxTokens 传入，模型定义值更小时取更小者；上限值写进注入快照的 model 段（加法式升版），事后可证每次运行用的上限。system prompt 在两种编辑模式下都加一句截断引导：工具调用若因输出上限未执行，把改动拆成几次较小的调用重发，不要原样重发；单次编辑只改需要改的那一段。流式重复检测与提前掐断本轮不做，以 Eval 结果行的撞输出上限轮数观察失控频率，明显上升时再议。
- 理由：两次 Eval 保留的 1,396 轮中正常轮次输出最大 3,406 token，超过 4,000 的只有 2 轮失控且恰为模型上限 32,768；按约每秒 46 token，16,384 把失控一次的最长耗时从约 11.8 分钟降到约 6 分钟，相对正常最大轮次留约 4.8 倍余量，项目负责人明确要求正常输出不得被截断。上游对 length 停止的消息不执行其中工具调用并提示重发，截断不会造成残缺写入；固定文案不可改，静态 prompt 指引对缓存友好，动态插入提示只能以 user 角色出现，与 042 冲突。生成中途 abort 会结束整个 Run，合成 length 停止原因会改写证据，失控样本只有 2 个且集中在同一位置，重复检测的误报代价高于收益。
- 锚点：src/pi-runtime/output-limit.ts（streamFn 包装）；src/application/runtime.ts（装配、`TRUNCATION_GUIDANCE`、快照 model 段）；src/pi-runtime/snapshot.ts（注入快照 v5）；src/state/runtime-events.ts 与 src/pi-runtime/adapter.ts（run.started 的 model 摘要）；src/application/workers.ts（worker 继承）；src/application/headless.ts、src/eval/runner.ts、src/cli/index.ts、src/tui/main.ts（`maxOutputTokens` 与 `--max-output-tokens`）；测试 src/pi-runtime/output-limit.test.ts、src/application/runtime-output-limit.test.ts、src/application/workers-output-limit.test.ts、src/application/runtime-edit-mode.test.ts、src/application/output-limit-truncation-e2e.test.ts。
- 详情：docs/decisions/output-limit-decisions.md；施工与验证证据：docs/audits/2026-09-15-output-limit-7818dee.md。

### 064 Reviewer 复用 worker 编排：工作区加"无工作区"成员、补只读快照工具、候选由 Controller 从收尾结果落盘，另加 `pigeon review` 薄壳（事实）

- 结论：后台 Reviewer 复用 M5.5 的 worker 编排与四动作接口。工作区类型以加法式联合新增"无工作区"成员（054 的形状封顶口径不变），Reviewer 不开工作树；reviewer 角色补只读的本次运行快照工具（对话、Trace、Receipt），不给任何写档工具；worker 收尾结果允许携带结构化内容，候选由 Controller 从收尾结果落盘，模型侧只产出结论。另加 `pigeon review <sessionId>` 薄壳，复用 headless 装配内核，供事后补审冷会话与实验会话。
- 理由：ROADMAP §M6 与术语段已把 Reviewer 定为只读、无工作树的 worker，复用既有编排可直接获得会话文件、派出与收尾配对记录、取消、trace 入口与冷恢复；"模型交结果、程序落盘"使 Reviewer 天然只读，避免新增写档工具带来的审批通道与策略子集问题，也不新增放权语义（039 后的方向）。进程内直跑与 §3.5 冲突，独立进程重演 040 已否决的多进程代价。先例：oh-my-pi 的 task 以结构化结果交回；Claude Code 子代理独立上下文加工具白名单、结果回交主会话；Hermes 后台 review 的产物先落待审目录、由 harness 写入。
- 锚点：src/state/event-log.ts（工作区联合、child.settled 结果放宽与结构化内容、worker 上限的 token 项与 token-limit 收尾状态、review.skipped 观察族，Event Log v10）；src/state/review.ts（审阅工具名、审阅配置与审阅目标）；src/orchestration/roles.ts（reviewer 白名单、只读快照工具的子集豁免、模型接入覆盖列）；src/orchestration/workers.ts（无工作区规划、结构化收尾结果、token 上限）；src/review/snapshot.ts 与 src/review/tools.ts（冻结快照与两个只读工具）；src/review/scheduler.ts（触发、全局并发、预算缺省）；src/review/prompt.ts（Reviewer 任务说明）；src/application/review-runtime.ts（派发器与主会话调度挂载）、src/application/session-runtime.ts（挂载点）、src/application/runtime.ts（审阅配置进注入快照、Reviewer 运行面注册只读工具）、src/application/workers.ts（无工作区的工作区根、覆盖列生效、结构化结果解析）、src/application/launch-flags.ts（--review-every / --no-review）、src/application/review-command.ts 与 src/cli/index.ts（pigeon review）；src/pi-runtime/snapshot.ts（注入快照 v6）；测试 src/orchestration/reviewer-workspace.test.ts、src/state/worker-workspace.test.ts、src/application/worker-model-override.test.ts、src/review/snapshot.test.ts、src/review/tools.test.ts、src/review/scheduler.test.ts、src/application/review-runtime.test.ts、src/application/review-command.test.ts、src/application/launch-flags.test.ts。
- 修订（2026-09-16，M6 开工前六件子裁决）：① 触发按轮次，缺省每 8 轮一次并在 Run 结束固定补一次，`--review-every <N>` 可配、0 表示只在 Run 结束审、`--no-review` 关闭；值按会话冻结并随注入快照与 run.started 落盘；同一会话同一时刻只跑一个，未收尾则跳过本次并记录；每次只喂上次审阅点之后的增量加一小段前情。② 自动审阅范围只含 cli 与 tui 的主会话；worker、headless 与 Eval 实验会话不自动审，需要时以 `pigeon review` 手动补审；Reviewer 自身会话永不被审。③ 模型路由做通用最小形态：角色表新增可选的模型接入覆盖列（插件路径与模型标识），四个角色缺省留空、继承主会话，行为不变；Reviewer 需要辅助模型时在 reviewer 一格填入。输入为增量，单条工具结果超限按头尾保留并标注省略，整份增量超限从最早处丢弃并标注，省略处可按条目号回查原文；完整 digest 推迟到真有辅助模型与质量基线时再做。④ Reviewer 预算专设：12 轮、3 分钟、40,000 token，全局同时只跑 1 个；超限按中止处理、不产出候选、主 Run 不受影响；四项均可配。⑤ 只读范围绑定被审的那一次 Run 的冻结快照（对话增量、Trace 投影、Receipt 摘要，含按条目号回查原文），不给跨会话检索；整棵会话树归 M7，跨会话更靠后。⑥ 派出与收尾复用现有 child.* 两族，靠角色字段区分 Reviewer，不新增记录族；候选另记 065 定的两族。
- 理由（子裁决）：路线图目标句本就写"完成若干轮交互或工具调用后"，按轮次触发是既定方向，参数化让 N 很大时退化为只在 Run 结束审；先只审主会话是先窄后宽，放开范围只改判据不动架构；角色表加覆盖列与 050 的推理档位按角色覆盖同构，不引入新概念；实测 98 个会话的 8 轮增量中位约 9.2k 字符（约 2.3k–3.1k token）、p90 约 22k 字符，正文里 89% 是工具结果，故按条截断即可控住输入，无需模型压缩；只读范围越小越容易验收 §M6 的"不读不该读的东西"；复用 child.* 可直接获得配对校验、崩溃残留可见、trace 入口与取消。
- 修订（2026-09-16，M6 收口）：Run 结束补审遇忙改为排队，每会话最多一个，新请求覆盖旧请求，上一次审阅收尾后立即执行；中途按轮次触发遇忙仍跳过；会话退出或释放时取消排队中与进行中的审阅，并以带原因的跳过记录留痕（review.skipped 加法式新增可选 reason 字段，取值 busy 或 exit，缺省视为 busy，Event Log 版本不变）。取代子裁决 ① 中 Run 结束补审"未收尾则跳过"的部分。理由：结束那段往往是教训最集中的收尾阶段，模型越快越容易因上一次审阅未收尾而漏审。锚点 src/review/scheduler.ts（排队、覆盖、闸释放后执行、shutdown）、src/application/review-runtime.ts（跳过记录带原因、释放时先关停调度再取消审阅）、src/state/runtime-events.ts（reason 字段）、src/cli/trace.ts 与 src/cli/replay.ts（按原因渲染）；测试 src/review/scheduler.test.ts。
- 详情：docs/decisions/m6-prep-decisions.md。

### 065 候选暂存：正文按哈希不可变写入暂存目录，状态由账本记录现算，改内容即新候选并标记取代（事实）

- 结论：候选正文写入 `.pigeon/candidates/<种类>/<名字>-<内容哈希>/`，写入后不可变；同哈希即同候选（天然去重）；内容修订产生新候选并在记录中标记取代关系。候选状态不落在候选目录里，由账本记录现算。M6 阶段状态只走到提出、已扫描、证据已核，回放验证与审批归 M8。安全扫描用确定性规则（不可见字符、注入与外泄模式、可执行脚本目录标记），模型筛查只作建议不作判决。账本新增提出与筛查两族记录；批准、拒绝、激活归 M8，本轮不新增审批或放权语义。
- 理由：§3.5 要求 Candidate 状态能从 Event Log 与快照重新物化且 Controller 是唯一权威写入者，把可变状态写进候选文件会制造第二事实源；正文不可变与会话文件只追加同构，账本记录可直接供 M7 与 M9 消费；§8 禁止后台流程写 grants.json，Policy 候选按 §M8 与 Skill 路径物理分离。
- 锚点：src/state/candidate.ts（候选 schema v2 与 v1 迁移）、src/state/candidate-status.ts（状态现算）、src/state/event-log.ts（candidate.proposed / candidate.screened 两族与 review.unparsable 观察族）、src/state/materialize.ts 与 src/state/trace.ts（投影同步）、src/persistence/event-log.ts（两族落盘）；src/review/scan.ts（确定性扫描）、src/review/candidates.ts（解析、按哈希原子落盘、去重、取代）；src/application/candidates-list.ts 与 src/cli/index.ts（pigeon candidates）；测试 src/review/scan.test.ts、src/review/candidates.test.ts、src/state/candidate.test.ts、src/state/trace-review.test.ts、src/migration-completeness.test.ts。
- 修订（2026-09-16，M6 开工前五件子裁决）：① 候选 schema 升 v2 只放写一次即不可变的元数据——种类（Memory / Skill / Policy）、名字、内容哈希与字节数、来源（会话号、Run 号、审阅会话号、来源条目号清单、来源内容摘要哈希）、一句话摘要、Reviewer 判断强度（只表判断强度，不表权限或生效资格）、扫描结果（扫描器版本与命中项）、取代关系；正文按种类各自格式（Skill 用 SKILL.md、Memory 用 markdown 文件、Policy 用文本），状态不入 schema、由账本现算；状态枚举新增"扫描拒收"。§6 草案里的成败分支字段归 M7、验证回执字段归 M8，本轮不加。② Policy 候选在 M6 只出自然语言建议加来源条目，不落结构化规则。③ Memory 候选以完整 markdown 文件为粒度，激活时整文件放入 memory 目录，不做段落追加。④ 扫描命中的候选暂存并标记拒收，永不参与激活、缺省不出现在列表里；暂存目录本就缺省不加载。⑤ 提供只读命令 `pigeon candidates` 列出候选（种类、名字、哈希前缀、状态、来源与时间），缺省隐藏拒收项；TUI 候选面板作为必要时的演进方向，本轮不做。
- 理由（子裁决）：元数据与正文分离使 schema 稳定，M7 与 M8 各自补字段时互不牵连；结构化的 Policy 候选唯一好处是便于自动套用，而 §8 恰恰禁止后台流程写 grants.json，且 M8 尚无消费方；整文件粒度让激活成为一次原子放置，与 042 的"按文件装载、人可直接编辑"对齐，段落追加会与人工编辑冲突且难回滚；命中内容的原始素材本就在会话账本里，丢弃候选正文并不能消除它，反而失去复查与改进扫描规则的素材；候选是 M6 的产出，没有列表则无法评估成果，而 TUI 面板会撑大本轮改动面。
- 修订（2026-09-19，M7 收口）：结构化结果不可解析记录族的产出会话字段一并改为同一中性命名，在 v10 → v11 迁移中改写。该族为 M6 已入库形状，提炼器出同类问题时写入同一族，保留审阅命名会与候选侧不一致；v11 尚未入库，此时改写零额外迁移成本。
- 修订（2026-09-19，M7 收口）：候选来源里记产出会话的字段改为中性命名（原名以审阅命名，现同时承载提炼器会话），在 v2 → v3 迁移中一并改写，产出方类别仍由来源字段区分。理由：v3 尚未入库、迁移本就要跑一遍，此时改名零额外成本；M8 将加入验证器一类产出方，届时仍以审阅命名会是第三层误导。
- 修订（2026-09-19，M7 收口）：候选提出、候选筛查与结构化结果不可解析三族属引用型记录——它们引用的 Run 在被提炼或被审阅的会话里（可能在另一个治理根下），投影时不在宿主会话中造出 Run。理由：造出的会是没有开始与结束记录的残缺 Run，会被会话列表与 trace 显示为崩溃残留，污染 012、021 定下的可见性信号；宿主会话里"提炼或审阅发生过"已由有始有终的派出与收尾记录表达。
- 详情：docs/decisions/m6-prep-decisions.md。

### 066 TUI 新增 [r] 拒绝并说明；决定记录加理由来源字段（人写 / 系统默认），不升 Event Log 版本（事实）

- 结论：TUI 审批面板保留 [n] 单按拒绝，新增 [r] 拒绝并说明——打开理由行，Esc 回面板不算拒绝，回车提交，理由逐字回模型；双击 Ctrl+C 的退出布防在理由行期间照旧生效。决定记录加可选的理由来源字段（人写 / 系统默认），加法式加入、不升 Event Log 版本（口径同 052），迁移完整性机检同步覆盖；CLI 留空理由同样标为系统默认。
- 理由：006 把逐字拒绝理由定为蒸馏的负样本监督信号，而 TUI 恒落默认文案、CLI 留空也落同一文案，账本无法区分真实理由与兜底文案，M7 会学到噪声。来源字段解决数据可信，[r] 提供真实信号，两者都不新增审批语义；[r] 相对 029 的四键单按为加法式修订，不改原有手感。先例：Claude Code 与 Codex 的审批交互均把"拒绝"与"拒绝并说明"分为两个动作。
- 锚点：src/tui/modal.ts（理由行输入模式与按键路由）、src/tui/approval.ts（[r] 键与面板提示）、src/tui/shell.ts（理由行提交）、src/cli/approval-ui.ts（留空与人写的标注）、src/approvals/handler.ts（ApprovalDecision.reasonSource）、src/state/tool-execution.ts（决定记录字段）、src/application/governance.ts（三处拒绝分支落来源）；测试 src/tui/approval-reason.test.ts、src/application/approval-reason-source.test.ts、src/state/tool-execution.test.ts、src/cli/approval-ui.test.ts、src/migration-completeness.test.ts。
- 详情：docs/decisions/m6-prep-decisions.md。

### 067 tui/shell.ts 按职责拆五个文件；抽启动参数与会话运行面两个装配模块，三入口模型占位缺省统一、cli 补 PIGEON_STREAM_FN 回退（事实）

- 结论：tui/shell.ts 按职责拆为消息流、模态与按键、斜杠命令、worker 视图、resume 视图五个文件，壳本体保留布局、启停、提交与事件渲染并重新导出原有公开符号（测试导入不变，零行为变化）。新增启动参数模块与会话运行面模块：前者统一三个入口的参数解析，后者统一新建与 resume 的装配（作用域、grant 种子、MCP 启动、运行面构建），并作为 M6 挂后台 Reviewer 调度的落点。三入口的模型占位缺省统一为同一常量（provider 与 model 均为 custom），真实模型元数据由 streamFn 插件提供，历史会话标签不做映射；cli 补 `PIGEON_STREAM_FN` 回退，使行为与既有报错文案一致。不给 cli 与 headless 装 worker 编排器。施工顺序：先拆分（零行为变化），再落 066 的理由行（只改模态文件），装配收拢与前两者不相干可并行。
- 理由：shell.ts 已 937 行，M6 的 Reviewer 视图与候选面板会使其破千行，先拆出落点再加；三入口缺省漂移（custom/cli、unknown/unknown、custom/headless）会进注入快照与 run.started，使同一模型按入口分成三组，影响 Eval 与学习侧按模型分组；`PIGEON_STREAM_FN` 只有 tui 读取而 cli 报错文案称支持，属实现与文案不一致的缺陷。
- 锚点：src/tui/message-flow.ts、src/tui/modal.ts、src/tui/commands.ts、src/tui/workers-view.ts、src/tui/resume-view.ts 与瘦身后的 src/tui/shell.ts；src/application/launch-flags.ts 与 src/application/session-runtime.ts；接线方 src/cli/index.ts、src/tui/main.ts、src/application/headless.ts；测试 src/application/launch-flags.test.ts、src/application/session-runtime.test.ts 与 tui 既有 10 个测试文件（断言未改）。
- 详情：docs/decisions/m6-prep-decisions.md。

### 068 对比素材：同任务独立尝试与会话树分叉都做，先比对后分叉；分叉基于上游 Session 存储，Pigeon 补写穿与分叉续跑，账本为唯一权威（事实）

- 结论：M7 的对比素材有两类，均在本里程碑完成，施工顺序为先同任务比对、后分叉。同任务独立尝试指同一任务的多次独立运行（Eval 同任务多次运行、并行派发同一任务的多个 worker）；分叉指会话树上从同一分叉点长出的多条分支。会话树以上游 pi-agent-core 0.84.4 的 `Session`、`JsonlSessionRepo` 与 `buildSessionContext` 为存储与上下文还原基础，由 Pigeon 补运行写穿与分叉续跑接线；Pigeon Event Log 仍是唯一权威事实源，会话树为派生结构。契约测试对象为 core 0.84.4 的 v4 JSONL 格式，使用上游 `createSessionBackendConformance`。
- 理由：Pigeon 持久化数据中原本没有会话树（entry 只有线性序号，resume 从零重建上下文），上游会话层有真实实现但把 Agent 运行接入会话树的 AgentHarness 为桩实现，主要工作量在接线而非存储。两类素材互补：独立尝试回答整体做法差在哪，分叉回答从哪一步走岔。外部先例 ExpeL、AutoGuide、ETO 的成败对比对均来自同一任务的独立多次尝试，先做比对可最早获得可验证的对比产出。
- 锚点：src/pi-runtime/session-tree.ts（上游 Session / JsonlSessionRepo / buildSessionContext 只经 pi-runtime 引用；树存储、通道、账本投影）、src/pi-runtime/upstream-version.ts（启动时上游版本探测与告警）、src/application/session-tree.ts（由账本重建、实时写穿、进程内共享树句柄）、src/application/fork.ts（分叉与续跑）；测试 src/pi-runtime/session-tree-conformance.test.ts（createSessionBackendConformance，core 0.84.4 v4 JSONL）、src/pi-runtime/session-tree.test.ts、src/pi-runtime/upstream-version.test.ts、src/application/fork.test.ts。
- 详情：docs/decisions/m7-prep-decisions.md。

### 069 同任务认定用显式任务标识：Eval 用任务编号，并行派发同一任务时生成共享标识写入派出记录（事实）

- 结论：同任务只按显式任务标识认定。Eval 用任务编号；并行派发同一任务的多个 worker 时生成共享任务标识，加法式写入派出记录；普通会话不自动归组，需要对比时走分叉。
- 理由：按任务原文哈希认定对措辞差异过于敏感，模型判断引入不可复现的噪声；显式标识在两个现成来源处都能零歧义获得。
- 锚点：src/state/event-log.ts（child.spawned 可选 taskKey，Event Log v11）、src/orchestration/workers.ts（SpawnRequest.taskKey）、src/application/attempt-group.ts（并行同任务派发、共享任务标识生成）、src/application/workers-commands.ts、src/tui/workers-view.ts 与 src/tui/main.ts（/spawn --attempts）、src/application/distill-command.ts（--task 按派出记录找宿主会话、--eval-results 按任务编号成组）；测试 src/state/contrast-records.test.ts、src/persistence/contrast-families.test.ts、src/application/attempt-group.test.ts、src/application/workers-commands.test.ts、src/application/distill-command.test.ts。
- 详情：docs/decisions/m7-prep-decisions.md。

### 070 Episode 边界按来源定：同任务比对取尝试会话首个 Run，分叉取分叉点到叶子、共享前缀只算一次（事实）

- 结论：同任务比对的 Episode 取尝试会话的首个 Run；分叉的 Episode 取分叉点到叶子的路径，共享前缀单独记录、只算一次；恢复后追加的 Run 不计入。
- 理由：尝试会话首个 Run 与一次任务尝试一一对应，恢复追加的 Run 已掺入人的后续干预；共享前缀按分支数重复计入会使相同步骤被重复强化，与 §M7 完成证据冲突。
- 锚点：src/state/episode.ts（firstRunOf、buildTaskAttempt、buildForkGroup、selectContrast）、src/distillation/target.ts（提炼目标组装与强制提炼的单侧选取）；测试 src/state/episode.test.ts。
- 修订（2026-09-19，M7 收口）：一组同任务尝试里有多个成功或多个失败时，每侧只取一个进对比——成功侧取总轮数最少的，失败侧取最早收尾的，其余尝试记入候选对比来源块的其余同组尝试。理由：判据确定、结果可复现，未选中的尝试有据可查，将来判据改动可按来源块重新提炼。全配对（成功与失败的每个组合各提炼一次）被否决：成本按乘积增长，且同一条做法会被反复强化，与本条"共享前缀只算一次"的取向冲突；由模型自选对比对被否决，因其不可复现。
- 详情：docs/decisions/m7-prep-decisions.md。

### 071 Eval 之外的成功判定：配置验证命令，尝试收尾后由程序独立执行并落通用验证记录，未配置标未知（事实）

- 结论：任务或会话可配置验证命令；尝试收尾后由程序作为独立子进程在该次尝试的工作区执行，三值口径同 058，结果落通用验证观察记录。未配置验证命令则标未知。人工确认暂不做。
- 理由：成功只认确定性验证是 §M7 完成证据"当前叶子没有验证时不会被标为成功"的直接落实；由模型自己运行的验证命令其证据受模型控制，不取；独立执行与 Eval 验证器同构，零新概念。
- 锚点：src/execution/check-command.ts（独立子进程、超时终止进程树、尾部截断与哈希、三值判决；与 Eval 验证器共用）、src/eval/verify.ts、src/state/attempt-config.ts、src/state/event-log.ts（attempt.verified）、src/application/attempt-verify.ts、src/application/launch-flags.ts（--verify-command / --verify-timeout）、src/application/session-runtime.ts、src/application/headless-core.ts、src/application/attempt-group.ts、src/pi-runtime/snapshot.ts（注入快照 v7）、src/state/runtime-events.ts 与 src/pi-runtime/adapter.ts（run.started 的 verify）；测试 src/execution/check-command.test.ts、src/application/attempt-verify.test.ts、src/pi-runtime/snapshot.test.ts、src/eval/verify.test.ts。
- 详情：docs/decisions/m7-prep-decisions.md。

### 072 五个标签边界：成功只认验证通过；撞上限与熔断算失败；人主动取消算放弃；放弃与基础设施错误不进成败对比（事实）

- 结论：成功只认验证通过，验证结论压过运行终态。失败为验证失败，或无验证但属业务失败、撞任一上限、治理熔断。放弃为人主动取消（熔断不算）。基础设施错误取失败分类中的基础设施错误。未知为缺运行结束记录、有悬账、验证未判定、无验证且正常完成。放弃与基础设施错误不进成败对比。
- 理由：撞上限与熔断说明做法本身走不通，属于可学习的失败；人主动取消与基础设施错误不反映做法优劣，混入对比会污染信号；无验证而正常完成不等于做对，标未知避免把未证实的结果当成功样本。
- 锚点：src/state/outcome-label.ts（labelAttempt、attemptOutcomeFacts）、src/state/runtime-events.ts 与 src/state/event-log.ts（run.limit-hit 观察族）、src/orchestration/workers.ts 与 src/application/headless-core.ts（撞上限先留痕再中止）；测试 src/state/outcome-label.test.ts、src/orchestration/workers.test.ts、src/application/headless.test.ts。
- 修订（2026-09-19，M7 收口）：新增撞上限观察族。上限中止在运行终态上只表现为中止，与人主动取消无法区分，缺此记录会把撞上限误判为放弃，与本条"撞上限算失败"冲突。
- 修订（2026-09-19，M7 收口）：账本完整性优先于验证结论——缺运行结束记录或有悬账时一律标未知，即使验证结论为通过。原条目只定了"验证结论压过运行终态"，未定它与未知条件的先后。理由：标未知不判失败，只是不进对比；而进入对比的尝试必须轨迹完整，否则提炼出的做法可能缺步骤，这类错误比少一个样本更难发现。按崩溃与悬账分别定性的方案被否决：判据增多会使每新增一种账本异常都要重裁。
- 详情：docs/decisions/m7-prep-decisions.md。

### 073 Run 内局部对只取人写拒绝理由与域错误后成功重试，只产出教训候选（事实）

- 结论：Run 内局部对纳入提炼，但只取两种：理由来源为人写的拒绝，与域错误后紧跟的成功重试；只产出教训候选。系统默认文案、策略拒绝、环境异常与无理由来源字段的旧记录不用。
- 理由：人写的拒绝理由是 006 定的负样本监督信号，066 的理由来源字段正是为区分真实理由与兜底文案而设；产出限定为教训，满足 §M7"失败分支只产生失败案例"。
- 锚点：src/state/episode.ts（collectLocalPairs）、src/distillation/snapshot.ts（局部对按侧单列）、src/distillation/candidates.ts（只由失败侧支撑的条目只能是教训）；测试 src/state/episode.test.ts、src/distillation/snapshot.test.ts、src/distillation/candidates.test.ts。
- 详情：docs/decisions/m7-prep-decisions.md。

### 074 提炼器复用 worker 机制新增角色，并行同任务收尾后与分叉叶子验证后自动触发，另有 `pigeon distill`；预算单设、共用全局并发闸（事实）

- 结论：提炼器复用 worker 机制，作为新增角色：只读、无工作区，只读工具作用域绑定一组尝试；候选走 M6 的暂存、扫描与账本链路。并行同任务全部收尾后、分叉叶子完成验证后自动触发；另有 `pigeon distill`，可指定任务标识或 Eval 结果目录，只读读取其他治理根下的会话。Eval 不自动触发。预算单设，缺省 16 轮、5 分钟、80,000 token，均可配；与 Reviewer 共用全局并发闸。
- 理由：064 已验证 worker 机制可承载只读、无工作区的后台角色，复用即获得派出与收尾配对、取消、trace 入口与冷恢复；与 Reviewer 合并会让单次运行审阅与跨尝试对比两种输入形态混在一个角色里。Eval 批量运行以测量为目的，提炼的时机与花费由人以 `pigeon distill` 指定结果目录显式发起。对比输入是两侧加共享前缀，预算按 Reviewer 的量级放大。
- 锚点：src/state/distill.ts（工具名与提炼目标）、src/orchestration/roles.ts（distiller 角色与 SCOPED_DISTILL_TOOLS）、src/orchestration/workers.ts（无工作区规划、提炼目标必填）、src/distillation/tools.ts、src/distillation/prompt.ts、src/distillation/candidates.ts、src/application/distill-runtime.ts（派发器、预算 16 轮 / 5 分钟 / 80,000 token、共用全局并发闸排队）、src/application/attempt-group.ts（并行同任务全部收尾后自动触发）、src/application/fork.ts（distillForkGroup，叶子验证后自动触发）、src/application/distill-command.ts 与 src/cli/index.ts（pigeon distill）、src/application/runtime.ts（提炼器运行面注册只读工具）、.dependency-cruiser.js（distillation-below-controller）；测试 src/orchestration/distiller-role.test.ts、src/application/attempt-group.test.ts、src/application/distill-command.test.ts、src/application/fork.test.ts、src/application/fork-session.test.ts。
- 修订（2026-09-19，M7 收口）：§M7"失败分支不会被写成长期事实"的落地口径为三条——只有失败侧证据支撑的条目不得产出流程或步骤集，只能是教训；这类条目不得落成 Memory 种类的候选，教训落 Policy 种类（自然语言建议加来源条目，同 065）；提炼结果逐项校验，单项不合格只丢该项并留痕，不使整份作废。理由：Memory 每次会话都装载进 system prompt，把一次失败里观察到的结论放进去等于让未经证实的结论影响其后所有会话；教训落 Policy 候选仍须经 M8 验证与审批才能激活，不影响运行；整份作废会使一次提炼因模型的单项笔误全部丢失，且失败是静默的。
- 修订（2026-09-19，M7 收口）：一组同任务尝试全为成功或全为失败时不自动提炼，记一条带原因的提炼跳过记录；`pigeon distill --force` 保留人工口子，全失败时只取最早收尾的失败侧且只产出教训，全成功时取总轮数最少的成功侧。理由：单来源提炼由 M6 的 Reviewer 承担（按轮次与 Run 结束触发），M7 的增量价值在对比；放开单侧自动提炼会与 Reviewer 产出重复候选、各吃一份预算，而候选的语义级去重尚未具备。
- 详情：docs/decisions/m7-prep-decisions.md。

### 075 候选升 v3，加法式新增对比来源块（事实）

- 结论：候选 schema 升 v3，v2 字段不变，加法式新增对比来源块：成功侧与失败侧各自的尝试引用（治理根、会话、Run、条目范围）、分叉共享前缀范围、各侧标签与验证记录引用、产物形态（教训 / 流程 / 步骤集）。单来源候选该块为空。
- 理由：065 已预留"成败分支字段归 M7"；独立字段块使 M8 回放验证与 M9 评测可直接按来源取证，写进正文则需要解析，另建候选种类会让激活链路分叉。
- 锚点：src/state/candidate.ts（候选 v3、OutcomeLabelSchema、AttemptRefSchema、ContrastSourceSchema、v2 → v3 迁移）、src/state/event-log.ts（v10 → v11 升级候选提出内嵌的候选）、src/review/candidates.ts（stageCandidate 暂存口径复用）、src/distillation/candidates.ts（对比来源块落盘）、src/state/materialize.ts（引用型记录不在宿主会话造 Run）；测试 src/state/candidate.test.ts、src/state/contrast-records.test.ts、src/distillation/candidates.test.ts、src/migration-completeness.test.ts。
- 修订（2026-09-19，M7 收口）：对比来源块不记 Trace 与 Receipt 的标识，二者由会话与 Run 现算。理由同 015、038：能从权威事实现算的派生量不另存副本，否则多出一份可能过期的证据；会话、Run 与条目范围已能唯一定位这段证据，Trace 是该区间的投影、Receipt 挂在具体工具调用上。ROADMAP §M7 相应措辞一并对齐。
- 详情：docs/decisions/m7-prep-decisions.md。

### 076 提炼器输入沿用 M6 截断，每侧 24,000 字符，共享前缀与任务描述只喂一次，独立尝试不做分歧步对齐（事实）

- 结论：沿用 M6 的单条工具结果截断口径；每侧上限 24,000 字符，超出从最早处丢弃并标注；任务描述只喂一次；分叉场景以分叉点为界，共享前缀只喂一次；独立尝试不做分歧步对齐。提炼器模型沿用角色表的模型接入覆盖列。
- 理由：98 个真实会话中一次完整尝试正文中位约 19,800 字符、p90 约 51,300 字符，89% 为工具结果，按条截断后每侧 24,000 字符可覆盖大多数尝试；独立尝试的步骤序列本不对应，强行对齐易产生伪分歧点，分叉场景的分歧点则天然确定。
- 锚点：src/distillation/snapshot.ts（DISTILL_SIDE_MAX_CHARS、任务描述与共享前缀只喂一次）、src/review/snapshot.ts（clampText、renderBlocks 复用 M6 截断口径）、src/distillation/tools.ts（distill_snapshot / distill_entry 作用域）、src/application/workers.ts（角色表覆盖列对提炼器生效）；测试 src/distillation/snapshot.test.ts。
- 修订（2026-09-19，M7 收口）：24,000 字符为每侧上限，共享前缀另设 12,000 字符上限（原条目未定前缀的算法，实现按段各给一份）。理由：两侧是对照物本身，削任一侧都使对比失真；前缀是背景，削它最安全。最坏总量由约 72,000 字符降至约 60,000，给提炼器的推理与产出留出余量。按总量封顶再等比削两侧的方案被否决：长的一侧通常是失败侧，恰是教训最密集处。
- 详情：docs/decisions/m7-prep-decisions.md。

### 077 会话树在分叉发生时才建立：账本先记分叉记录，树放 `.pigeon/trees/` 为可重建的派生缓存，写穿不阻塞主循环（事实）

- 结论：会话树在分叉发生时才建立。账本先记分叉记录（分叉点的 Run 与序号、新分支标识、分叉点快照引用），再把分叉点之前的历史导入树，此后该会话实时写穿。树文件放治理根 `.pigeon/trees/`，为派生缓存，不 fsync、不阻塞主循环，可由账本重建。施工补写穿耗时基准。
- 理由：不分叉的会话零额外写入；账本中的分叉记录是会话树的权威来源，树文件丢失或损坏只需重建，不形成第二事实源（§3.5）。与 037 否决"启用上游会话存储"不冲突：037 否决的是以上游会话文件承载正文事实，此处树文件不承载任何权威状态，可由账本与内容文件重建，性质同 038 的可重建缓存口径，也不构成 009 所禁的双写；上游会话模块按 §2 只经 src/pi-runtime 引用。
- 锚点：src/state/event-log.ts（session.forked、branch.header）、src/persistence/event-log.ts（onEntry、appendSessionForked、appendBranchHeader）、src/pi-runtime/session-tree.ts、src/application/session-tree.ts（acquireSessionTree、rebuildSessionTree、attachTreeWriteThrough、bindSessionTree、runTreeRebuildCommand）、src/application/fork.ts（prepareFork、runForkBranch）、src/pi-runtime/adapter.ts（initialMessages、continueRun）、src/application/workers.ts 与 src/application/headless-core.ts（分支续跑装配）、src/application/worker-scope.ts（分支会话回到自己的工作树）、src/cli/index.ts（pigeon tree rebuild）；测试 src/application/fork.test.ts、src/application/fork-session.test.ts、src/persistence/contrast-families.test.ts；写穿耗时基准 spikes/m7-tree-write-bench.ts。
- 修订（2026-09-19，M7 收口）：分支会话的首条记录用独立的分支会话头族，不复用 worker 会话头。分叉与委派是两种父子关系，068 的事实已区分二者；合并为一族需靠标记位在投影与查询时分流，省下的一个族会在读侧还回去。
- 修订（2026-09-19，M7 收口）：写穿失败不记账本观察族，改走 080 的去重标准错误告警，原结论中的"失败只记观察记录"随之作废（不影响"失败不影响运行"）。理由：会话树是可重建的派生缓存，写穿失败的后果是树落后于账本，可由重建入口随时补齐，不需要事后从账本取证；Event Log v11 尚未入库，此时去掉记录族为零迁移成本。
- 详情：docs/decisions/m7-prep-decisions.md。

### 078 文件变化后用 git 底层命令生成快照挂到 `refs/pigeon/checkpoints/`，分叉从快照开独立工作树，非 git 工作区报错（事实）

- 结论：仅在写操作或命令确实改变文件后，用 git 底层命令在临时索引上生成快照提交，挂到 `refs/pigeon/checkpoints/<会话>/`，不触碰用户的工作区、暂存区与分支。分叉时从分叉点之前最近的快照开独立工作树续跑。非 git 工作区发起分叉时明确报错，不降级。
- 理由：只退对话不退文件会让分支在错误的文件状态上续跑，靠回执反推无法覆盖命令产生的改动；每轮快照在无改动轮次上是纯开销。临时索引加独立 ref 使快照对用户的 git 操作不可见，独立工作树沿用 M5.5 的 WorkspaceProvider。
- 锚点：src/orchestration/checkpoint.ts（临时索引 write-tree / commit-tree / update-ref、改前基线、非 git 报错）、src/application/checkpoints.ts（写档与命令档工具前后挂载、条目号对应）、src/state/runtime-events.ts（workspace.checkpoint）、src/state/materialize.ts（checkpointAtOrBefore）、src/application/fork.ts（resolveForkCheckpoint、从快照开独立工作树）、src/pi-runtime/adapter.ts（entrySeq）、src/application/runtime.ts（toolTiers）；测试 src/orchestration/checkpoint.test.ts、src/application/checkpoints.test.ts、src/application/fork.test.ts。
- 修订（2026-09-19，M7 收口）：快照与条目号的对应关系落在独立的快照观察族（ref、提交、树、改前基线、工具调用号与对应条目号），不挂进回执。回执写在快照之前、且有自己的迁移链，快照失败或工作区不是 git 时也不应牵动回执。
- 详情：docs/decisions/m7-prep-decisions.md。

### 079 分叉由人手动发起，另有缺省关闭的 `--retry-on-fail <K>` 失败自动分叉重试（事实）

- 结论：cli 与 tui 主会话支持手动分叉。另有可选的失败自动分叉重试 `--retry-on-fail <K>`，缺省 0 即关闭，按会话冻结并随注入快照与 run.started 落盘；尝试被标为失败时从本次任务开始处分叉重试，最多 K 次，不注入任何提示，共用预算与全局并发闸。适用主会话与 `pigeon run`；并行同任务派发不叠加此项。智能选择分叉点不做。
- 理由：从任务开始处分叉使分叉点确定；不注入提示是为避免与 042 冲突，并避免两条分支的差异混入"是否看到提示"；缺省关闭使额外的尝试花费由人显式开启。并行同任务派发本身已产生多次独立尝试，不再叠加。
- 锚点：src/application/fork-command.ts（/fork 与 --at 定位）、src/cli/repl.ts 与 src/cli/index.ts、src/tui/commands.ts、src/tui/workers-view.ts 与 src/tui/main.ts（手动分叉入口）、src/application/launch-flags.ts（--retry-on-fail）、src/application/fork.ts（runRetryOnFail）、src/application/headless.ts（pigeon run 失败自动分叉重试）、src/application/session-runtime.ts（主会话后台重试）、src/pi-runtime/snapshot.ts 与 src/pi-runtime/adapter.ts（retryOnFail 冻结并随 run.started 落盘）；测试 src/application/fork-session.test.ts、src/application/fork.test.ts。
- 修订（2026-09-19，M7 收口）：手动分叉的形态为主会话斜杠命令 `/fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]`，cli REPL 与 tui 共用一份实现；缺省分叉点为最近一次 Run 的任务开始处；分叉点落在助手消息上时必须给新输入。理由：与 029 以来主会话操作走斜杠命令的手感一致；两种 `--at` 格式分别覆盖本次 Run 内定位与跨 Run 定位；缺省值对应最常见意图。独立的冷会话分叉子命令不做：resume 后 `/fork` 已可达成，多一个入口即多一套参数解析与错误路径。
- 详情：docs/decisions/m7-prep-decisions.md。

### 080 运行时内部故障不进账本，改为按故障类别去重的标准错误告警（事实）

- 结论：后台组件的内部故障（快照生成失败、提炼候选落盘失败这类）不新增账本记录族，改为向标准错误输出告警：文案说明后果，一次运行里同一类故障只说一次，故障类别取错误类型与摘要、不含一次性内容（临时索引路径等）。口径与上游版本探测的启动告警一致。账本只记运行事实，运行时诊断不是运行事实。
- 理由：039 之后账本的新消费者优先是学习闭环与并行编排，不再以证据链更完整为由新增记录族；这类故障不改变运行事实，也不被任何冷路径消费，落账本只会增加记录族与迁移负担。但故障完全静默同样不可接受——快照缺失会让之后从该点分叉回退到更早的快照，候选落盘失败会让一次提炼无声消失，二者都需要人当场看见。去重是必要的：同一类故障往往每次工具调用都复发，不去重会刷屏盖住正常输出。
- 锚点：src/application/warnings.ts（去重告警器与故障类别）、src/application/checkpoints.ts 与 src/application/distill-runtime.ts（接上告警）；测试 src/application/closeout-fixes.test.ts。
- 适用范围：会话树写穿失败一并按本条处理（077 修订），不再记账本观察族。
- 已知边界：tui 在壳接管终端后收到的标准错误告警可能干扰渲染。
- 详情：docs/audits/2026-09-16-m7-9f440fe.md 收口修复一节。

### 081 验证命令改为项目级配置：人配一次本项目所有会话继承，启动参数可覆盖，不做自动推断（设计）

- 结论：验证命令与超时改为项目级配置文件，人配一次后本项目所有会话继承，启动参数仍可覆盖单次运行；不做自动推断（例如从包管理脚本猜测测试命令）。Eval 继续用任务目录里的验证器。
- 理由：日常会话不配验证命令即一律标未知，M7 的对比与 M8 的回放判定都取不到成败；配置文件机制在命令规则、放权、MCP 三处已有先例，零新概念。自动推断的风险不对称：推断出的命令若未覆盖本次改动却照常通过，会把失败尝试标成成功，污染学习素材的标签，而 072 的口径是宁可标未知、不可标错。
- 锚点：src/state/attempt-config.ts（VERIFY_CONFIG_VERSION、配置文件 schema、来源字段）、src/persistence/verify-config.ts（.pigeon/verify.json 只读加载，畸形响亮失败）、src/application/launch-flags.ts（resolveVerifyConfig 三级来源）、src/pi-runtime/snapshot.ts（v8 按会话冻结）、src/cli/index.ts 与 src/tui/main.ts（入口接线）；测试 src/persistence/verify-config.test.ts、src/application/launch-flags-verify.test.ts、src/migration-completeness.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 082 回放执行体复用 worker 机制新增验证器角色，起点用快照回到任务开始处，统计沿用 Eval 结果行（设计）

- 结论：回放验证复用 worker 编排新增验证器角色，在独立工作树中真执行；起点用 M7 的快照回到任务开始处，成败由验证命令判定，统计沿用 Eval 结果行的形状（任务、条件、次序）。命名遵守 014：M4 的只读重建仍叫 replay，回放验证另起名字。
- 理由：回放所需的三样能力 M7 已具备（从任务起点分叉、独立工作树、验证命令判成败），剩余增量只有装载经验与重复 N 次。Eval runner 按任务目录组织，把会话分支转成任务会丢掉分叉点之前的上下文，转换本身即失真来源。
- 锚点：src/replay/plan.ts（从账本解出任务、起点提交、预算、模型与工具集；四条都拿不到即拒绝回放）、src/application/rerun.ts（验证器 worker、独立工作树、会话文件收回宿主、工作树释放）、src/orchestration/roles.ts（verifier 角色与工具上限）、src/orchestration/workers.ts（工作树起点提交写进派出记录）、src/state/checkpoint-ref.ts（任务开始处之前最近的快照）、src/state/event-log.ts（git 工作树的 baseCommit）；测试 src/replay/plan.test.ts、src/application/rerun.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 083 回放权限形态用固化命令规则，容器沙箱排入 M9 前置并先跑三个探针（设计）

- 结论：M8 的回放在独立工作树中运行，命令档工具只在预先固化的命令规则内放行，规则外直接拒绝、不询问人；不引入沙箱。容器沙箱明确排入 M9 前置（而非含糊后置），选型前先跑三个探针：容器 exec 的单次往返延迟、WSL2 内虚拟化设备是否可见、跨边界调用的退出码保真度。
- 理由：M8 的价值是判据，把容器隔离纳入会使重心偏移，且"工作副本放哪"一项就牵涉挂载开销、拷贝进出与快照配合，需单独一轮裁决。同时须明确：固化命令规则是缩小开口而非隔离——放行一条脚本命令即放行该脚本能做的一切，网络亦不受限；真正的断网与文件白名单只有沙箱能提供，而无人值守的大批量回放迟早需要它。
- 锚点：src/orchestration/roles.ts（ROLE_TOOLS.verifier）、src/application/rerun.ts（verifierParentPolicy 与被验证那次尝试的工具集取交集）、src/application/runtime.ts（commandRole → .pigeon/commands.json 的角色允许清单）、src/tools/run-command.ts（清单外一律拒绝）；测试 src/application/verifier-commands.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md，含沙箱选型调研与宿主平台的可行路径。

### 084 回放判定为三值加大效应门槛，四组固定 N 全跑不中途停，区间只进回执不作判据（设计）

- 结论：判定四组——失败分支带经验与不带经验、成功兄弟分支带经验与不带经验——每组固定 N 次（缺省 5），不中途查看结果决定是否继续。结论为三值：通过（正回放呈大效应且负回放无回归）、未测出（差异未达门槛）、回归（负回放显示变差）。pass@k 与 pass^k 分开报告，Wilson 区间计入验证回执但不作判据。N 可配，低于 3 禁用。
- 理由：N=5 时置信区间宽到只有极端分布才不重叠，以区间不重叠为判据实质就是大效应门槛，却披着统计外观，不如直接写明。中途查看再决定是否续跑会抬高假阳性率，除非引入序贯检验修正，不值得。"未测出"必须与"无效"分开：候选无效与该任务集测不出差异是两回事，同 Eval 基线触顶时的结论口径。
- 锚点：src/replay/verdict.ts（四组统计、pass@k 与 pass^k 分开算、Wilson 区间只进回执、三值加大效应门槛、少跑即拒绝出结论）、src/application/verify-command.ts（四组交错跑满 N 次）；测试 src/replay/verdict.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 085 回放在临时治理根里按正常格式装载经验，走与真激活相同的装载路径（设计）

- 结论：回放时在该次运行的工作区内造临时治理根，把候选正文按种类的正常格式放入（Memory 为 markdown 文件、Skill 为标准目录、Policy 为文本），走与真激活完全相同的装载路径；宿主的经验目录一个字节都不写。多条经验联合验证时向临时治理根多放文件即可。
- 理由：§M8 完成证据要求批准内容与最终激活内容摘要一致，前提是验证形态与激活形态同为一条路径。运行面注入会造出第二条装载路径，两条路径在装载顺序、前言解析、并存时的位置等细节上的差异最难发现，因为两边都能跑通。真激活后撤销的方案在崩溃时会留下已激活的经验，与"不能跳过审批"的完成证据冲突。
- 锚点：src/replay/materials.ts（回放工作区内造临时治理根、固化命令规则与放权规则随行、宿主经验目录只读、经验集合明细）、src/activation/paths.ts 与 src/activation/experience.ts、src/activation/policy.ts（与真激活同一条落点与写入）；测试 src/replay/materials.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 086 回放缺省人工触发 `pigeon verify`，另给显式开关供无人值守时自动验证（设计）

- 结论：回放验证缺省由人显式触发（`pigeon verify`），另提供开关在无人值守运行时自动验证落库的候选。
- 理由：按 084 的口径一条候选要跑 4×N 次完整运行，无人值守一夜产出的候选可达数十条，全自动即为数小时的模型花费且发生在人不知情时。候选目前也没有语义级去重，自动验证会把成本花在内容相近的候选上；待 M8 运行一段时间、重复率可观测后再议是否改为缺省开启。
- 锚点：src/cli/index.ts（pigeon verify）、src/application/verify-command.ts（前置校验、四组编排、回执落盘）、src/application/auto-verify.ts（无人值守开关与去重告警）、src/application/launch-flags.ts（--auto-verify，缺省关）、src/application/attempt-group.ts 与 src/application/fork.ts（自动触发挂点）。
- 详情：docs/decisions/m8-prep-decisions.md。

### 087 回放单设并发闸缺省 1 可配；每次回放的预算与模型沿用被验证那次尝试（设计）

- 结论：回放单设并发闸，缺省并发 1、可配置调高，不与 Reviewer 及提炼器共用的闸合并。每次回放运行的预算（轮数、墙钟、token 上限）与模型接入一律沿用被验证那次尝试，不得放宽。
- 理由：回放是重执行，单条候选可占用数十分钟，若与只读的审阅、提炼共用一个闸会把轻量后台长时间堵死；瓶颈主要在模型接口与磁盘而非 CPU，故保留调高并发的口子。预算若放宽，成功率提升将来自预算而非经验，且这种失效隐蔽——指标确实变好，结论却是错的；同理模型必须一致，换模型重跑测的就不是经验。
- 锚点：src/application/rerun.ts（effectiveLimits 逐项核对放宽即拒、回放单设并发闸）、src/application/workers.ts（派出上限冻结为本次尝试预算）、src/application/headless-core.ts 与 src/application/runtime.ts、src/pi-runtime/adapter.ts（预算进注入快照 v8 与 run.started）；测试 src/application/rerun.test.ts、src/replay/plan.test.ts、src/pi-runtime/snapshot.test.ts。
- 修订（2026-09-20，M8 收口）：回放的模型、预算与工具集三者都必须与被验证那次尝试一致，任一放宽即拒绝。工具集原不在本条约束内（083 只要求命令档收口），但若回放能使用原尝试没有的工具，通过率变化就可能来自工具而非经验——例如原尝试无命令工具、跑不了测试，回放有命令工具并据此改对，判定会把结果错误归功于该条经验。三者是同一不变式的三个面；日后新增同类维度（如 MCP 服务器）按本条推定。
- 修订（2026-09-20，M8 收口）：两侧尝试的模型或预算不一致时拒绝验证，并指明是哪一项不一致，不提供强制开关。理由不止于环境摘要只有一份：两侧环境不同则对比本身不成立，差异中混入了模型或预算差异，判定结果无意义；此类偏差的表现是数字正常而含义错误，一旦提供开关必会在赶工时被使用，且该回执在账本中与正常回执无异，M9 的整体测量也无法分辨。此类候选改走人工批准加必填理由。
- 详情：docs/decisions/m8-prep-decisions.md。

### 088 候选审批走 CLI 子命令，TUI 只在状态行提示待审数量（设计）

- 结论：批准、拒绝、撤销、取代四个动作与候选详情查看均落 CLI 子命令；TUI 只在状态行提示待审数量，不做审批面板。
- 理由：候选审批要读候选正文、diff、来源链、扫描结果与四组回放回执，是长文离线决策；TUI 的模态面板是为"单个工具调用批或不批"这类在线短决策设计的（029），长文塞进面板只能截断或滚动。候选躺在暂存目录里，审批不必打断会话；CLI 形态也便于与 `pigeon verify` 串联或批量处理。将来确有需要再补面板，届时已有实际使用经验。
- 锚点：src/cli/index.ts（candidates show / approve / reject / revoke / supersede 子命令）、src/application/candidates-list.ts（列表、详情、与落点的行级 diff、待审数量）、src/tui/shell.ts 与 src/tui/main.ts（状态行只提示待审数量）；测试 src/application/candidates-view.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 089 候选新增三个记录族：验证回执、带动作与理由来源的决定、激活（设计）

- 结论：账本新增三族——验证回执（四组通过次数、三值结论、区间、环境摘要、各次运行的会话号）；决定族（批准、拒绝、撤销、取代合成一族，带动作字段与理由来源字段，来源取值为人写或系统默认，同 066）；激活族（哪个版本在何时生效）。候选状态仍由账本现算，不落候选目录（065 不变）。
- 理由：分族依形状而非依动作数量——批准与拒绝的记录形状相同，拆族只是重复 schema；验证回执与激活事实与之毫无共同字段，合并则需大量可选字段并在投影处到处判空。拒绝理由的来源字段尤为必要：006 把人写的拒绝理由定为负样本监督信号，候选被拒的理由直接说明这条经验错在哪，是提炼侧最有价值的素材之一，缺来源字段则无法与系统默认文案区分。
- 锚点：src/state/event-log.ts（三族 schema 与 v11 → v12 加法式迁移）、src/persistence/event-log.ts（三个追加方法，治理族 fsync）、src/state/materialize.ts（三族进物化结果）、src/state/candidate.ts（状态枚举补齐）、src/state/candidate-status.ts（五族现算候选状态）、src/state/trace.ts 与 src/cli/replay.ts（只读视图渲染）；测试 src/persistence/candidate-families.test.ts、src/state/candidate-status-m8.test.ts、src/migration-completeness.test.ts。
- 修订（2026-09-20，M8 收口）：三族改为写进执行该命令的会话自己的文件，不写候选的来源会话；候选状态改由跨会话收集三族后按时间取最后一条现算。原落点会让审批与验证在来源会话仍被另一进程持锁时无法进行（候选的来源会话通常就是还在运行的那个），而排他的会话锁是单写者约束的实现手段，不应绕过。新形态下每个会话文件仍只有一个写入者。
- 已知边界（2026-09-20）：候选状态的跨会话聚合为全治理根扫描，代价随会话总数线性增长，`pigeon candidates`、批准与启动告警三条路径都会走。沿用 038 对 Session Search 的同一口径：不预先建索引，待 `pigeon candidates` 在真实数据下超过约 2 秒再设计按内容哈希判过期的可重建缓存；"只扫最近若干会话"一类的范围限制被否决，它会在某天静默漏掉旧候选的状态。
- 详情：docs/decisions/m8-prep-decisions.md。

### 090 Policy 候选只落只读建议文件，永不自动改放权文件，物理分离由分层规则机检（设计）

- 结论：Policy 候选批准后只落成只读的建议文件，目录与 Skill、Memory 分离，模型可在 system prompt 中看到该建议；激活路径永不自动修改放权文件或命令规则，权限变更仍由人手动编辑。激活器在代码层面不得依赖放权写入模块，由分层规则机检钉死。
- 理由：§8 禁止后台流程写放权文件，§M8 完成证据要求 Policy 的激活路径与 Skill 写入路径物理分离。生成权限补丁再由人点确认的方案被否决：人对机器生成的 diff 的实际审查强度低于亲手编辑，工具审批处已出现同类现象（单按拒绝导致账本充满默认文案，故有 066）。完成证据要的是"不能绕过"而非"承诺不绕"，故以机检而非约定落实。
- 锚点（随 094 收敛后）：src/activation/experience.ts 与 src/activation/paths.ts（落点只剩 Skill 与 Memory 两类）、.dependency-cruiser.js（activation-only-state 把放权写入模块挡在激活层的依赖之外，这是本条留下的那条不变式）；测试 src/activation/activate.test.ts（激活路径永不触碰放权文件与命令规则）、src/activation-boundary.test.ts（规则真会抓人、真实 src 零违规）。原锚点里的 src/activation/policy.ts 与 policy-activation-isolated 规则已随 094 删除。
- 修订（2026-09-19，M8 收口）：本条随 094 作废——Policy 候选停止产出，其只读建议文件、独立写入模块与专属分层规则一并删除；保留的是"激活器不得依赖放权写入模块"这条机检。结论中"模型可在 system prompt 中看到该建议"在实现中从未接通，核验时发现无任何模块读取该落点。
- 详情：docs/decisions/m8-prep-decisions.md。

### 091 验证回执摘要记全，批准失效只看模型、经验集合哈希、预算、验证命令四项封闭清单（设计）

- 结论：验证回执记全环境摘要——模型标识与版本、harness 提交号、Node 与平台、被验证尝试的预算参数、验证命令、同时装载的经验集合内容哈希、四组通过次数与三值结论、各次运行的会话号。批准失效的判据只看一份封闭清单的四项：模型标识、经验集合内容哈希、预算参数、验证命令；任一变化则批准失效、要求重验。清单之外的项只记录、不参与判定，增删清单须单独裁决。
- 理由：全项严格失效不可用——harness 提交号几乎每日变动，会使所有批准长期处于待重验状态，最终导致该机制被关闭。开放式分级判断同样被否决：判据一多，每新增一项环境信息都要重裁（同 072 修订处的取舍）。清单四项的共同点是一变则该次验证结论不再适用：模型换了经验未必仍有效，同时装载的经验集合变了可能互相干扰，预算或验证命令变了则判据本身已变。
- 锚点：src/state/event-log.ts（验证环境摘要 schema）、src/replay/environment.ts（经验集合内容哈希、封闭四项清单判据）、src/application/verify-command.ts（摘要组装、两侧模型与预算必须一致）、src/application/candidate-decision.ts（批准前比对经验集合）、src/application/activation-notes.ts（会话启动时的失效告警）；测试 src/replay/environment.test.ts、src/application/activation-notes.test.ts。
- 修订（2026-09-20，M8 收口）：封闭清单中的"预算参数"包含单轮输出上限（063），与轮次、墙钟、token 三项上限同列。理由：063 已把该上限写入注入快照以便事后可证，且实测撞上限会改变模型行为（须把编辑拆小重发），属会影响结果的运行参数；不计入则可能出现上限被大幅调低、模型频繁截断重发而既有批准照旧有效的情况。该值是配置缺省、变动频率低，与提交号一类高频变化项不同，计入不会造成批准频繁失效。
- 详情：docs/decisions/m8-prep-decisions.md。

### 092 回归的候选一律不可批准；未测出可人工批准但理由必填，激活记录标注未经回放证实（设计）

- 结论：判定为回归的候选一律不可批准，翻案只能靠重验推翻，不接受以理由覆盖。判定为未测出的候选可由人显式批准，但理由必填且来源记为人写；其激活记录标注未经回放证实，供 M9 的整体测量单独分组观察。
- 理由：负回放是唯一可直接观测到"经验有害"的证据，若可被一句理由覆盖，堵循环论证的这道门即失效。未测出一刀切禁止则会排除价值不体现在单任务通过率上的经验（例如促使改动后运行项目自带检查这类降低返工率的做法），而 Eval 基线触顶的经历表明未测出常常源于任务集而非候选本身。
- 锚点：src/application/candidate-decision.ts（扫描拒收与回归一律不可批准、未测出与未验证须人写理由、激活记录标注未经回放证实）、src/state/event-log.ts（决定族的理由来源字段）；测试 src/application/candidate-decision.test.ts、src/application/approval-bypass.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 093 激活为复制到正常目录、人仍可编辑，启动时比对哈希标注漂移；撤销不追溯，取代与候选取代同构（设计）

- 结论：批准后把候选正文按种类复制到治理根的正常目录，人仍可直接编辑（042、043 的可编辑性不变）。激活记录存内容哈希；会话启动时比对现状与哈希，不一致则标注该经验已脱离批准版本，但不阻止使用。撤销为移走文件并记录，不追溯既往会话。取代为新版本激活加取代关系，与 065 的候选取代同构。
- 理由：按哈希从不可变暂存目录装载或复制后锁只读，都会推翻 042 与 043 定下的"经验按文件装载、人可直接编辑"；完成证据中"批准内容与激活内容摘要一致"约束的是激活那一刻，不应读成禁止人后续编辑。以可见性而非锁定处理漂移，与项目对悬账、崩溃残留、截断标注的一贯做法一致。
- 锚点：src/activation/activate.ts（复制到正常目录、写盘后回读比对、漂移判定、撤销移走文件）、src/application/candidate-decision.ts（决定先落盘再动文件、撤销先留证后移文件）、src/application/activation-notes.ts（启动时比对哈希并标注已脱离批准版本，不阻止使用）、src/application/candidates-list.ts（列表与详情里的漂移标注）；测试 src/activation/activate.test.ts、src/application/candidate-decision.test.ts、src/application/activation-notes.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。

### 094 Policy 候选停止产出并删除其激活机制，枚举值仅保留读旧记录；机检收敛为激活器不得依赖放权写入模块（设计）

- 结论：提炼器与审阅器不再产出 Policy 候选，产出形态只剩 Memory 与 Skill；删除 Policy 的落点目录、独立写入模块、为其新增的分层规则，以及验证路径上对 Policy 的特判分支。候选 schema 的种类枚举保留 Policy 取值，仅为读取已入库的旧候选，写侧一律拒绝。保留"激活器不得依赖放权写入模块"的分层规则，删除"Policy 与 Skill 写入模块互不引用"的规则。ROADMAP 相应改为两类候选，§M8 完成证据中的物理分离一条改写为前述机检。
- 理由：Policy 的原定位是经人审批后影响工具权限的唯一通道，但 039 的方向转向、§8 禁止后台写放权文件、065 限定其只出自然语言、090 再定其永不自动改规则，逐层收窄后它与 Memory 的差别仅剩目录；施工核验进一步发现现有实现中无任何模块读取 Policy 落点，即它对模型完全不可见，连"建议文字"的作用也未接通。留存的成本是持续的——每次改候选 schema、动激活路径或写提炼器产出规则都要多考虑一种形态；而将来命令规则确需建议通道时，新增种类是一次加法式改动，加回比留着便宜。真实验收中提炼器稳定选择 Policy 形态，说明三类的语义边界对模型本就模糊，收敛为两类可望提升提炼质量。枚举值不删是因为 v3 已入库且本地已有该种类候选，删值会使旧数据不可读，违反加法式原则。
- 锚点：src/state/candidate.ts（种类枚举保留 policy 取值只为读旧记录，另出只含 memory 与 skill 的可产出种类）、src/review/candidates.ts 与 src/distillation/candidates.ts（结果 schema 收窄，落盘写侧拒收已停止产出的种类）、src/review/prompt.ts 与 src/distillation/prompt.ts（产出规则改为两类）、src/activation/paths.ts 与 src/activation/experience.ts（落点表只剩两类，Policy 的独立写入模块删除）、src/application/candidate-decision.ts（批准前按种类拦下，判据在决定记录之前）、src/application/candidates-list.ts（旧候选照常列出与展示，并说明它没有激活落点）、.dependency-cruiser.js（删 policy-activation-isolated，保留 activation-only-state）；测试 src/application/legacy-policy-candidate.test.ts、src/activation/activate.test.ts、src/review/candidates.test.ts、src/activation-boundary.test.ts。
- 详情：docs/decisions/m8-prep-decisions.md。
