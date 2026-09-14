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
- 锚点：src/tools/policy.ts、src/tools/grants.ts、src/approvals/grant-store.ts、src/cli/grants.ts、src/cli/approval-ui.ts；ROADMAP §3.9。
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
- 锚点：src/state/session-summary.ts、src/execution/recovery.ts、src/cli/session.ts。
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
- 锚点：src/tools/grants.ts、src/cli/grants.ts、src/state/event-log.ts；ROADMAP §3.9 留证段。
- 详情：docs/decisions/m4-closeout-decisions.md。

### 020 同一 grant 只允许升格一次（事实）

- 结论：/grants save 时若文件里已有同 promotedFrom.grantId 的规则，响亮报错并指出已存在的序号，文件不改写。
- 理由：019 以 grantId 为身份，重复规则会让身份不唯一；语义重复（不同 grant 同范围）是噪声不是歧义，不去重以保留各自出处。
- 锚点：src/persistence/grants-config.ts、src/cli/grants.ts。
- 详情：docs/decisions/m4-closeout-decisions.md。

### 021 D2 冷视图三处全补，措辞精确化（事实）

- 结论：entry 断号判据放进冷物化（末尾缺失由 run.ended.messageCount 推出，无 run.ended 的崩溃残留不推）；trace 在 Run 头下标注撕裂尾巴与断号并在会话头计数；replay 原位标注加尾部总账；resume 汇总既往缺口，有缺口不说"证据链完整"。D2 措辞改为"进程内即时警告 + 冷侧文件形态派生标注"。
- 理由：trace 缺标注直接违反"绝不假装证据链完整"；启动即查进程内数组跨重启恒空，字面承诺不成立。
- 锚点：src/state/materialize.ts、src/state/trace.ts、src/cli/trace.ts、src/cli/replay.ts、src/cli/session.ts。
- 详情：docs/decisions/m4-closeout-decisions.md。

### 022 模块归位：有限重整与六条分层规则（事实）

- 结论：schema、纯判据、冷物化与投影归 state（叶子）；存储引擎与配置文件读写归 persistence（只依赖 state）；grant 匹配归 tools；会话 grant 存储归 approvals；冷恢复归 execution；pi-runtime 经结构类型接收落盘口，不触达 persistence。六条 dependency-cruiser 分层规则只约束生产代码。两条记账的过渡债：cli 直连 execution（M2 重审）、adapter 内治理编排（M5.5 前挪到 application/）。
- 理由：重整前 persistence 与 pi-runtime 目录级成环、一个文件七种职责；全面按原图重整要造空 Controller，是假架构。
- 锚点：.dependency-cruiser.js；ROADMAP §4 目录图。
- 详情：docs/decisions/m4-module-layout-decisions.md。
- 修订（2026-09-13，M5 施工，038 / 043）：分层规则新增 memory-below-controller（memory/ 只依赖 state / persistence / tools）与 skills-only-state-tools（skills/ 只依赖 state / tools）；application-is-controller 放行 memory 与 skills。
- 修订（2026-09-14，M5.7 施工，041 / 051）：分层规则新增 mcp-only-state-tools（mcp/ 只依赖 state / tools，不触达 persistence / pi-runtime / application / Actor 层，由 application 装配）；application-is-controller 放行 mcp。

### 023 崩溃残留 Run 恒为未知；resume 与 trace 计崩溃残留（事实）

- 结论：Run 级失败分类的事实新增 hasRunEnded；run.ended 缺失即"未知"，优先于末条 turn.completed 的 stopReason（017 判据表修订）。冷物化新增 unfinishedRuns 清单（有记录但无 run.ended 的 Run），resume 恢复屏在既往缺口里列"崩溃残留：N 个 Run 无 run.ended"，有则不说"证据链完整"；trace 会话头加"崩溃残留 N 个 Run"计数，与落盘缺口分开计。
- 理由：真实链路验收中三个死于中途的 Run 被判"正常"，只靠头部标注提示，`--class unknown` 找不到它们，resume 还声称证据链完整，同时违反 017"不确定就不贴标签"与 012"绝不假装证据链完整"。abort 路径上游照常发 agent_end，所以"无 run.ended"只出现在真崩溃与 D8 迁移会话，判据不会误伤取消。
- 锚点：src/state/classification.ts、src/state/materialize.ts、src/cli/session.ts、src/cli/trace.ts；ROADMAP §4 状态流。
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

### 046 Eval 自建薄 runner，任务格式对齐公开基准，外部 harness 只作可选适配（设计）

- 结论：M6.5 / M9 的 Eval 用自建薄 runner，不引入外部评测框架（promptfoo、Inspect AI 等）作主干。runner 四件事：读任务目录、准备仓库快照、经 headless 运行入口跑 Pigeon 若干次、调确定性验证器并从账本出 JSONL 结果。三向对照（无 Skill / 候选 / 已批准）靠 042 / 043 的注入冻结开关；指标全部从 Event Log 算：成功率与误成功率来自验证器回执，工具调用与审批次数来自事件族与治理族，恢复结果来自 resolution，成本来自 044 的 usage。统计按 M9 规范（per-task 三元结果、pairwise delta、Wilson 区间、McNemar exact）自写；报告先出 markdown 表。任务目录格式对齐公开基准（说明 + 验证脚本 + 环境声明，Terminal-Bench 形态），公开任务可导入；Terminal-Bench / SWE-bench 适配器为可选项。M6.5 在本机工作树跑，容器隔离随 exec 沙箱考虑。headless 入口与 M5.5 worker 共用。
- 理由：Pigeon 的 Eval 是"学习有没有带来提升"的对照实验，外部框架面向输入到输出、读不到账本、默认 LLM 打分（§3.8 禁止当判决），主干上帮不上；公开基准 harness 只测完成率测不了学习增益；runner 核心是 headless 入口，M5.5 反正要做；M9 统计规范已明确到公式，自写比在他人断言体系里绕更清楚；任务格式对齐公开基准保住可比性又不让外部成主干依赖；§2 第 6 条：上游与外部都缺"测学习增益"这个语义。先例：SWE-bench / Terminal-Bench 都是自家 harness 加数据集、agent 经适配器接入；Claude Code plugin eval 是自带 JSON 套件的小 runner。局限：无报告界面；M6.5 样本量只能证"可测"，显著性靠 M9 的区间与配对检验；外部工具现状以联网核实为准。粗估 M6.5 阶段约 500 行加测试。
- 锚点：ROADMAP §M6.5 既定方向、§M9；施工落地后补 src/eval/、src/application/（headless 入口）。
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
