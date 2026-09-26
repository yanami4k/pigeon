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
| 095 | 跨进程锁统一撞锁即拒绝不排队，报错须说明占用者与其动作；回放的跨进程全局上限留到 M9 | 并发收口 | M8 |
| 096 | 引入容器执行这一批只允许替换不允许并存：同能力只走一套接口，同数据只留一个来源，旧的降级到窄用途或删除 | M9 前置第 1 件 | M9 |
| 097 | 正式度量改用 SWE-bench Verified，先跑 50 题子集打通管道再扩到 100–150 题；只报同模型下的相对差异，不报绝对分数 | M9 前置第 2 件 | M9 |
| 098 | 工具不感知工作区形状：抽出执行端接口（工作区内读写文件与执行命令），本地与容器各一份实现，快照与分叉挂同一层 | M9 前置第 3 件 | M9 |
| 099 | 对照条件为三类经验条件加一条最简 harness 基线；基线对跑只在扩量后的正式测量做，管道验证阶段不做 | M9 前置第 4 件 | M9 |
| 100 | 自造题集降为冒烟用途只留三道（快、中等、会撞预算上限各一），其余连同验证脚本删除 | M9 前置第 5 件 | M9 |
| 101 | 度量统计：每题每条件跑一次、预算优先投向题数；二值配对用 McNemar 精确检验；回放验证仍按 N 次，两处口径不同是设计 | M9 前置第 6 件 | M9 |
| 102 | 抽出任务源接口：实例清单、环境准备、判据命令与元数据由实现提供，跑批设施不感知题目来源 | M9 前置第 7 件 | M9 |
| 103 | 判分阶段的评测容器可接代理，agent 的工作区容器不接；两侧网络配置不得互相复用 | M9 第一阶段 | M9 |
| 104 | agent 的工作区容器无网络，不提供开关；因断网无法进行的题记基础设施错误，不为此打开网络 | M9 第一阶段 | M9 |
| 105 | 四道依赖外网的 sphinx 题留在正式题集，判分启用代理 | M9 第一阶段 | M9 |
| 106 | 错误行范围不变；验证器超时是真实结果不补跑；内容审核类拒答为独立状态，不补跑、不计入成败统计 | M9 第一阶段 | M9 |
| 107 | 空补丁仍判失败，结果行加标注以区分“改了没改对”与“根本没改” | M9 第一阶段 | M9 |
| 108 | 外部基准不设 token 上限；撞上限但判分通过计为通过，结果行标注并在报告里单列 | M9 第一阶段 | M9 |
| 109 | 工作区容器的环境准备清掉基准提交之后的仓库历史，只留 HEAD 可达的部分；判分侧不动 | M9 第一阶段收口 | M9 |
| 110 | 评测固定采样温度为 0，并冻结进注入快照随 run.started 落盘 | M9 第一阶段收口 | M9 |
| 111 | 任务说明冻结为纯英文 issue 原文，不加包装；中文指令加英文任务的混合语境如实写明 | M9 第一阶段收口 | M9 |
| 112 | 容器工作区的路径放权暂不处理，但加护栏：交互场景与路径限定规则装配即报错，不许静默失配 | M9 第一阶段收口 | M9 |
| 113 | 结果行：整次墙钟新写必带、读侧容忍旧文件缺失；难度随任务源可选 | M9 第一阶段收口 | M9 |
| 114 | 口径变化靠新记录表达，不追溯改写历史数据：按旧口径写下的结果行保留不改 | M9 第一阶段收口 | M9 |
| 115 | M9 第一阶段此前各轮外部基准数据整体作废，不计入任何统计口径；可信基线自断网、清历史、固定采样之后算起 | M9 第一阶段收口 | M9 |
| 116 | 外部基准的 system prompt 补一句工作方式指令：只说工作方式、措辞对齐公开最简实现、冻结进注入快照 | M9 第一阶段收口 | M9 |
| 117 | 结果行记录两组测试各自的通过条数与总条数作为连续指标；判据不变，仍以全过为准 | M9 第一阶段 | M9 |
| 118 | 本阶段只衡量"同一代码库上越用越好"：来源集与测量集同为 django、题目互不重叠，测量集分层随机抽样并预先落盘，测量集效果为结论、来源题效果仅为上界 | M9 第二阶段 | M9 |
| 119 | 确定性错误不进错误行、不补跑：照常判分，结果行标注类别；目前只认上下文超长 | M9 第一阶段 | M9 |
| 120 | 提炼器不设 token 上限；轮数与墙钟仍按缺省，并记录实际撞的是哪一项 | M9 第一阶段 | M9 |
| 121 | 提炼器跳过材料的缺陷修掉：冻结对比快照直接放进首轮输入，空结果必须附理由；轮数 40、墙钟同比放宽 | M9 第一阶段 | M9 |
| 122 | 评估学习闭环只修缺陷让系统按原设计工作，不由人分析结果引导系统学什么；测量集在带经验一轮跑完前只看汇总数字 | M9 第一阶段 | M9 |
| 123 | 学习闭环第一版结论：四个根因与实测失败模式；主张一改为"同一代码库上越用越省"，解决率降为次要指标 | M9 第一阶段 | M9 |
| 124 | 基线账本的浪费分析否定"越用越省"在知名仓库上的余量；第二版暂缓，待换题域先量浪费；本轮来源集不补、基线不续跑 | M9 第一阶段 | M9 |
| 125 | SWE-bench 题目在时间与空间上零局部性，结构上不适合评估"同一代码库上越用越好"；测试床改为连续工作流，先用本仓库提交流跑通，再以外部仓库的连续提交流复现 | 连续工作流前置第 1 件 | M9 |
| 126 | 主张一改为长时程一致性：agent 在同一代码库上延续式连续工作能否不把它搞坏；在本仓库 71 题提交流上以三条件（完整 Pigeon / 去掉记忆 / 最简 agent；修订后为四个条件，见修订行）比较代码库健康度随步数的曲线；更省降为次要指标 | 连续工作流前置第 2 件 | M9 |
| 127 | 提交流成题：题面为提交信息加该提交新增或修改的测试文件全文；成题条件为测试改动打到父提交上失败、打到提交本身上通过；逾 20 文件的提交排除；红测试对合并为一题 | 连续工作流前置第 3 件 | M9 |
| 128 | 账本剪去无读者与重复的记录：提炼跳过、放权升格与配置移除、候选筛查四种记录停写并退役，候选状态改由提出记录内嵌的扫描结果现算；删除 M3 旧账本一次性转换 | 账本盘点 2026-09-22 | M9 |
| 129 | 记忆系统重做的范围：人写层（偏好、项目 memory、Skill）保留且独立；新建程序产出的结构化记忆层，不写入人写层、不走候选审批 | 记忆第二版第 1 件 | M9 |
| 130 | 裁决详情文件（docs/decisions）改回只留本地、不入库；决策索引仍入库 | 文档规范裁决 2026-09-22 | 仓库规范 |
| 131 | 新记忆层只记两类摩擦事实：回归与约束的红转绿、被撤回的尝试；工具报错与每步改动摘要不记（认定与判不清时的细则见修订行） | 记忆第二版第 2 件 | M9 |
| 132 | 结构化记忆从账本派生、不单独存：记忆是账本事实的跨会话视图，配可删可重建的增量缓存 | 记忆第二版第 3 件上 | M9 |
| 133 | 结构化记忆挂在文件上；报错自带的函数名、测试名作为附带文字存，不解析代码 | 记忆第二版第 3 件下 | M9 |
| 134 | 结构化记忆在开局与回炉时由程序推送，不做模型自取的查询工具；开局设严格门槛、允许不给 | 记忆第二版第 4 件上 | M9 |
| 135 | 开局只按题面直接指到的文件挑记忆，最多 2 条、允许不给；从账本学习题面与文件关联留作以后在日常使用场景下单独研究 | 记忆第二版第 4 件下 | M9 |
| 136 | 结构化记忆使用前由程序核验锚点文件与报错名字仍在，不过即不给；改动幅度只用于排序；不按使用时间淘汰；同文件同指纹的多条合并并附出现次数 | 记忆第二版第 5 件 | M9 |
| 137 | 第一版学习闭环整套退役：Reviewer、提炼器、候选暂存与扫描、回放验证、审批与激活；删除范围先盘点、待评测方法定后施工 | 记忆第二版第 6 件 | M9 |
| 138 | 记忆评测分两层：定点对照为记忆的主判据，四条件整流实验报整体一致性；回放执行机制保留作评测工具 | 记忆第二版第 7 件上 | M9 |
| 139 | 定点对照：取无记忆流中本能挑到记忆的全部步骤，带记忆、不带、带无关记忆三组各重跑 5 遍；主判据为按步骤配对的变红比例差 | 记忆第二版第 7 件下之一 | M9 |
| 140 | 整流实验四条件各先跑 1 遍，按开跑前写死的门槛补跑：终值差距不足以区分运气的两条件各补到 3 遍；定点对照在无记忆流第一遍后即开始 | 记忆第二版第 7 件下之二 | M9 |
| 141 | 提交流中的非题提交按类型处理：测试类套用人的版本、纯格式跳过、有代码无测试的作维护步交 agent 做并只用验证门判、中途大搬迁处重置一次；形成 53 题与 17 题两条延续流 | 连续工作流前置 | M9 |
| 142 | 一题回炉到上限仍不过即整题撤回，撤回后该题留空、后续照常；因此失败的题单列为"缺前置"，不补人的版本 | 连续工作流前置 | M9 |
| 143 | 回炉上限 3 轮：修 3 轮仍不过即整题撤回；开跑前定死，对有回炉的条件一视同仁 | 连续工作流前置 | M9 |
| 144 | 跑批按限额类型分别处理：短时限流沿用双 key 轮换与退避；额度用完整批暂停、窗口刷新后从断点续跑，被打断的题作废重做；并发受限先降一路、不行则暂停并告警 | 连续工作流前置 | M9 |
| 145 | 整流实验主指标为全量测试通过率：每步用截至该步人写的全部测试跑 agent 的代码（分母为人在该步代码上通过的用例，见修订行），画成随步数的曲线、比较终点值；回归数、静态检查错误数、撤回次数、按题通过率与失败归因作次要 | 连续工作流前置 | M9 |
| 146 | 补跑门槛：两条件全量测试通过率终点差距小于 10 个百分点即各补跑到 3 遍；结论用全部遍数并报波动范围（修订后取消补跑，只用第一遍，见修订行） | 连续工作流前置 | M9 |
| 147 | 各条件每一步同一个总预算，回炉消耗计入其中，最简 agent 同额自行支配；数字先按 150 轮、30 分钟估，正式开跑前试跑校准后定死（校准判据见修订行） | 连续工作流前置 | M9 |
| 148 | 延续式实验环境：每条流一个断网容器，起点为人在该处的代码并清理未来历史，预装最全依赖，每步覆盖人写测试；落地的步骤由程序以题面提交信息提交进 git 历史（环境与验证门按人当时的 CI 还原，见修订行） | 连续工作流前置 | M9 |
| 149 | 延续式实验的主测试床改为更大、更难的外部仓库；127、141 至 148 的规则按同一原则套用，仓库相关事实在新仓库上重测；选仓标准另议 | 连续工作流前置 | M9 |
| 150 | 外部仓库选仓标准七条：模型没见过、机检齐全且全套测试数分钟内跑完、测试纪律好、规模更大、历史直线或压合、许可证宽松、TypeScript 或 Python | 连续工作流前置 | M9 |
| 151 | 分工：外部大仓库上跑四条件整流实验测一致性；记忆的定点对照在本仓库提交流上做（局部性强），结论限定于连贯的持续开发 | 连续工作流前置 | M9 |
| 152 | 外部测试床选定 strands-agents/harness-sdk 的 Python 部分，窗口 2026-08-18 至 09-10；pydantic-ai 排除，openai-agents-js 为备选 | 连续工作流前置 | M9 |
| 153 | 外部仓库上大提交按源代码改动行数处理：超过 3,000 行才重置；其余带题测试的当题（20 文件上限只数源文件），不带的当维护步，不碰源代码的跳过 | 连续工作流前置 | M9 |
| 154 | 回炉落地三处口径：开启回炉且最后一次验证失败即推断为已撤回；本次只支持本地 git 工作区、无快照即报错，容器执行端的"回到这一步起点"另立项紧随其后；逐字一致的范围为快照覆盖的范围（撤回的删除集按开工时的忽略清单判定，见修订行） | 回炉施工前置 | M9 |
| 155 | 延续式实验的模型请求一律经跑批进程内置的本地网关：四个条件同一条限额处理路径，用量在同一处计量，真 key 只在网关里 | 跑批器施工 | M9 |
| 156 | 定点对照做成跑批器的单步重跑：从某步落地的代码包恢复容器、按组别跑完整一步（agent、验证门、回炉）；保留回放的一致性核对，旧回放执行体与验证者角色随第一版退役 | 退役盘点第 1 件 | M9 |
| 157 | 定点对照三组的记忆走结构化记忆的正常推送路径（开局与回炉两个时机、同一套代码），只把挑选固定为指定条目，不另开注入口 | 退役盘点第 2 件 | M9 |
| 158 | 退役的四项推论：重跑结果写结果行、不新增账本记录；验证者角色停用但保留取值以读旧记录；SWE-bench 复核命令与容器重跑模块删除；评测条件名 none、candidate、approved 不变 | 退役盘点第 3 至 6 件 | M9 |
| 159 | 验证配置支持命名分步：每步各跑各出结论、不因前一步失败而停；验证记录加可选的各步结论字段（加法式）；回炉反馈与结构化记忆按步取用；单条命令的旧配置视为一步（实验中本仓库流的验证门去掉格式步，见修订行） | 记忆施工前置 | M9 |
| 160 | 回炉撤回推断的残余窗口接受为已知限制：墙钟在最后一次验证中到点与验证落盘后进程被硬杀在账本中不可区分，均推为已撤回；跑批器对被打断的步骤整步重做，不依赖此推断 | 回炉复核 | M9 |
| 161 | 容器模式下每步的起点进账本：run.started 加可选的 stepStart {commit, baseCommit}（加法式，不新增记录种类），供结构化记忆认定开工时已在工作区的文件 | 记忆接入容器 | M9 |
| 162 | 结构化记忆本轮实验沿用现实现；实验后若定点对照显示记忆有作用，则重构为从工具的结构化输出读报错、由调用方显式声明题面测试，推断只作兜底；若无作用则不再投入 | 记忆实现复盘 | M9 |
| 163 | 模型接口的可用容量低于路数时按剩余容量放行：各流在步与步之间等空位，不开步、不作废；容量下降时排队超过阈值的在途步立即中止作废，等到空位后重做；开跑前路数超过各账号并发之和即拒绝开跑 | 网关复核 | M9 |
| 164 | 定点对照的主判据按记忆给出时机拆开、分开报：开局事件看首轮验证是否在题面以外变红；回炉事件只取首轮验证未过、进入回炉的遍次，看给出记忆后的下一次验证是否仍在题面以外变红；回炉轮数与最终结论为辅助指标 | 定点对照复核 | M9 |
| 165 | 整流实验判据：本次按 145 原判据照报；从本次结果中挖掘区分度高的判据（探索性），在外部复现开跑前定为主判据、由外部复现确证 | 整流实验中途盘点 | M9 |

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
- 修订（2026-09-22）：已由 128 取代——M3 旧账本一次性转换删除，启动不再检测旧账本。

### 019 固化规则回指稳定身份，升格与移除留痕（事实）

- 结论：配置规则命中的账本回指用规则的 promotedFrom.grantId，位置序号只作展示与 /revoke 输入；/grants save 落 grant.promoted，/revoke config#N 落 grant.config-removed；Event Log 版本 4→5 纯版本推进。留痕顺序不对称：扩权先留证后生效，缩权先生效后留证。
- 理由：位置序号随移除前移，历史回指会漂移；稳定身份已在文件里；留证失败时宁可少一条痕迹，不可让账本说"已撤"而规则仍在生效。
- 锚点：src/tools/grants.ts、src/application/grants.ts、src/state/event-log.ts；ROADMAP §3.9 留证段。
- 详情：docs/decisions/m4-closeout-decisions.md。
- 修订（2026-09-22）：升格与移除两种留痕记录已由 128 取代——停写并退役；配置规则命中的回指口径不变，规则来源仍由放权配置文件中的 promotedFrom.grantId 承载。

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
- 修订（2026-09-22）："原样保留，不拆"收窄为"主体保留，无读者或与其他记录重复的记录可剪"，见 128。

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
- 修订（2026-09-22）：docs/decisions 入库的部分已由 130 取代——改为只留本地；其余不变。

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
- 修订（2026-09-22）：候选筛查一族已由 128 取代——停写并退役；扫描拒绝与已筛查两种状态改由候选提出记录内嵌的扫描结果现算。

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
- 修订（2026-09-22，补记）：2026-09-20 裁决，撞上限观察记录只在运行确因上限被中止时才写；恰好用满最后一轮、自然收尾的运行不写。起因是 M9 前置的自造题基线测量：轮数用满时先写撞上限记录再中止，而终态只在上游确以中止收尾时才记为轮次上限，于是出现"账本有撞上限记录、终态为正常完成"的运行（path-dotdot-name 一次 30 轮跑满、判决通过）；按本条"撞上限算失败"，一次无验证结论、恰好在最后一轮做完的成功运行会被标为失败，污染分叉选对与提炼样本。另一方案（改标签判定顺序，撞上限且终态为中止才判失败）未采纳：该记录的语义本应是"因撞上限而没做完"，在判定侧补会让每个读这条记录的人都要重新理解它。当时应记为本条修订而漏记，100 理由中的"（072 修订）"指此。落实状态：截至 2026-09-22，headless 与 worker 两处上限中止路径仍在中止前写记录，尚未按此修改（src/application/headless-core.ts、src/orchestration/workers.ts）。
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
- 修订（2026-09-22）：M7 收口修订中"记一条带原因的提炼跳过记录"已由 128 取代——提炼跳过记录停写并退役；手动提炼命令的跳过原因仍在命令输出中给出。

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
- 修订（2026-09-22，补记）：提炼器输入的交付方式由 121 修订（2026-09-22）：冻结对比快照直接附在提炼器任务说明末尾、放进首轮输入，不再只经 `distill_snapshot` 工具由模型自行拉取；截断或省略的内容仍用 `distill_entry` 回查。起因是首次重新提炼时 11 组里 5 组第 1 轮不调读取工具即交空结果。本条的截断口径、每侧 24,000 字符与共享前缀 12,000 字符上限不变。
- 详情：docs/decisions/m7-prep-decisions.md。

### 077 会话树在分叉发生时才建立：账本先记分叉记录，树放 `.pigeon/trees/` 为可重建的派生缓存，写穿不阻塞主循环（事实）

- 结论：会话树在分叉发生时才建立。账本先记分叉记录（分叉点的 Run 与序号、新分支标识、分叉点快照引用），再把分叉点之前的历史导入树，此后该会话实时写穿。树文件放治理根 `.pigeon/trees/`，为派生缓存，不 fsync、不阻塞主循环，可由账本重建。施工补写穿耗时基准。
- 理由：不分叉的会话零额外写入；账本中的分叉记录是会话树的权威来源，树文件丢失或损坏只需重建，不形成第二事实源（§3.5）。与 037 否决"启用上游会话存储"不冲突：037 否决的是以上游会话文件承载正文事实，此处树文件不承载任何权威状态，可由账本与内容文件重建，性质同 038 的可重建缓存口径，也不构成 009 所禁的双写；上游会话模块按 §2 只经 src/pi-runtime 引用。
- 锚点：src/state/event-log.ts（session.forked、branch.header）、src/persistence/event-log.ts（onEntry、appendSessionForked、appendBranchHeader）、src/pi-runtime/session-tree.ts、src/application/session-tree.ts（acquireSessionTree、rebuildSessionTree、attachTreeWriteThrough、bindSessionTree、runTreeRebuildCommand）、src/application/fork.ts（prepareFork、runForkBranch）、src/pi-runtime/adapter.ts（initialMessages、continueRun）、src/application/workers.ts 与 src/application/headless-core.ts（分支续跑装配）、src/application/worker-scope.ts（分支会话回到自己的工作树）、src/cli/index.ts（pigeon tree rebuild）；测试 src/application/fork.test.ts、src/application/fork-session.test.ts、src/persistence/contrast-families.test.ts；写穿耗时基准 spikes/m7-tree-write-bench.ts。
- 修订（2026-09-19，M7 收口）：分支会话的首条记录用独立的分支会话头族，不复用 worker 会话头。分叉与委派是两种父子关系，068 的事实已区分二者；合并为一族需靠标记位在投影与查询时分流，省下的一个族会在读侧还回去。
- 修订（2026-09-20，并发收口）：会话树的跨进程保护只加在重建侧（按根会话号取锁，取不到明确报错），写穿侧不取锁。理由：写穿每批取锁只能防单批被撕开，挡不住真正的错乱来源——重建把树整棵换掉后，写穿仍按内存中的旧序号继续追加；撞锁即拒会使该批写穿被丢，而写穿失败只告警不入账本（080），等于把"可能错乱"换成"确定丢几批"；树是派生缓存，错乱可由重建补齐。另：写穿位于主循环热路径，为只在人工重建时出现的场景引入每批一次的跨进程文件系统开销，代价与收益不成比例。前提条件：若日后写穿改为对树做增量更新而非尾部追加，本取舍须重新裁决。
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

### 095 跨进程锁统一撞锁即拒绝不排队，报错须说明占用者与其动作；回放的跨进程全局上限留到 M9（设计）

- 结论：本项目的四把跨进程锁（会话打开锁、候选操作锁、会话树重建锁、放权配置锁）统一采用撞锁即拒绝、不排队的口径；报错信息须说明占用者及其正在进行的动作（例如"该候选正在验证中"），而非仅提示锁被占用。回放的跨进程全局上限本轮不做，留到 M9 与批量运行的资源口径一并裁定。
- 理由：四把锁行为一致才可被预期，混用拒绝与排队会使人无法判断命令是在等待还是已挂起；排队需配套超时、重试上限与死锁检测，为毫秒级的读改写操作引入这套机制不成比例。持锁时间长的只有候选验证（四组交错串行，N=5 时约 15 至 40 分钟），撞上概率不低，故要求报错文案指明占用动作，使人能判断重试时机。跨进程上限属资源约束而非正确性约束——每条候选各有其锁，不会互相写坏；批量运行成为常态是 M9 的事，此时设计上限是猜需求。
- 锚点：src/persistence/exclusive-lock.ts（临时文件加硬链接建锁、撞锁即拒）、src/persistence/session-lock.ts（同口径）、src/application/candidate-lookup.ts 与 src/application/candidate-decision.ts（候选操作锁）、src/application/session-tree.ts（重建锁）、src/persistence/grants-config.ts（放权配置锁）；证据 docs/audits/2026-09-20-concurrency-a4a5ca8.md。
- 修订（2026-09-22）："跨进程全局上限留到 M9"在 M9 前置重排时未列入、始终未裁。改为挂到记忆重做第六件之后（Reviewer、提炼器与候选审批链路的去留，见 129 待裁）：该上限目前唯一的使用方是候选回放验证，链路退役则本项作废，保留则届时再定。跑批并发由评测器自身参数控制，撞接口限额靠换 key 与退避。
- 修订（2026-09-22）：候选审批链路已定为退役（137），跨进程全局上限随之作废。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 096 引入容器执行这一批只允许替换不允许并存：同能力只走一套接口，同数据只留一个来源，旧的降级到窄用途或删除（设计）

- 结论：M9 引入容器执行与外部基准时，遵守"只替换、不并存"原则。具体三条：① 同一能力出现第二套实现时必须走同一个接口——工作区快照与分叉挂在 054 已定的工作区接口下，由工作区形状决定实现，调用方不得判断形状；② 同一判据只保留一个形状——沿用既有的"执行一条命令、三值判决"接口，外部基准的判分脚本即为该命令，不新开判据路径；③ 同一份数据不保留两个来源——自造题集降级为冒烟用途、只保留验证链路所需的少量题目，其余连同验证脚本删除；固化命令规则在容器提供隔离后降级为可选的第二道防线，不再作为主防线维护。
- 理由：容器执行会同时带来两种工作区形状、两套快照与分叉实现、两套任务来源与两套判据；若不主动收敛，每一样都是加法而非替换，代码量与维护面将快速膨胀。横向对比显示本项目生产代码量在同类中偏轻（32 个同类项目中排第 27，约为中位数的六分之一），而这正是当前能维持高测试密度与零分层违规的前提；维持这一优势的价值高于多保留几条并行实现。
- 附带事实：M9 前置的容器调研表明，快照与分叉在容器中为平移而非重做——每轮在容器内以独立 GIT_DIR 打快照（与宿主实现一一对应），分叉点做一次镜像提交后起多个容器，单次分叉约 5 秒级；进程级检查点（CRIU）不予采用，其在 Docker 中长期为实验特性、不支持带终端的容器，且在 WSL2 上有失败报告。
- 更正（2026-09-22）：原写"挂在 041、054 已定的工作区接口下"，应为"挂在 054 已定的工作区接口下"，依据：041 定的是外部工具链只经 MCP 接入，工作区接口（WorkspaceProvider）的形状与封顶由 054 判定。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 097 正式度量改用 SWE-bench Verified，先跑 50 题子集打通管道再扩到 100–150 题；只报同模型下的相对差异，不报绝对分数（设计）

- 结论：M9 的正式度量改用外部基准 SWE-bench Verified，分两阶段：第一阶段用现成的 50 题子集（镜像约 5GB）打通全链路，目标是暴露工程问题而非取得结论，其中必须先以标准答案补丁做一次自检（预期接近全绿）以证明判分管道本身可信；第二阶段扩到 100–150 题的固定抽样做正式测量。结论一律以同模型下的相对差异呈现（带经验对不带经验、本 harness 对最简基线），不对外报绝对分数。自造题集降级为冒烟用途（096）。
- 理由：本项目自造的 8 道题经实测全部触顶（40 次运行全部通过，通过率方差为零），原因是题面把每条分支与边界穷举写死，模型只需逐条转写，而经验能提供的正是"知道该怎么做"；继续改造自造题无法消除三个系统性缺陷——出题人知道答案、题目同源、数量不足以支撑统计。外部基准的判据是纯数据（基准提交、测试补丁、两组测试清单），可脱离其官方执行器独立使用。数据集存在训练数据污染（官方已于 2026 年 2 月因此弃用该数据集衡量前沿能力，另有研究显示模型在不给仓库时仍能高比例猜中应改文件），但污染与坏测试对两个对照条件是共模项，做差分时抵消，因此相对结论仍然成立——代价是绝对分数不得对外作为能力指标。难度方面，中档模型在该数据集上的合理预期为 40%–70%，离地板与天花板均有距离；另一个子集 SWE-bench Lite（300 题）从原版全集筛出、未经可解性筛选，含不可解样本，同一系统在其上通常低 8 到 10 个百分点，不予采用。
- 附带事实：50 题规模下相差 3 道即为 6 个百分点，只适合回归与冒烟，正式结论须在扩量后给出。
- 锚点（第一阶段管道）：src/eval/swebench-source.ts（外部基准任务源：实例清单、评测镜像当工作区、相对初始树取 diff、测试文件排除）、eval/swebench/judge.py 与 eval/swebench/README.md（判据命令与退出码约定、标准答案自检步骤）、src/cli/index.ts（pigeon eval swebench）；测试 src/eval/swebench-source.test.ts；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md。
- 修订（2026-09-22，补记）：第二阶段"扩到 100–150 题的固定抽样"已由 118（2026-09-21）改变：只衡量主张一，来源集 50 道与测量集 100 道同取自 django、题目互不重叠，按难度档分层随机抽样并预先落盘。随后 125（2026-09-22）把主张一的测试床从 SWE-bench Verified 改为连续工作流（先本仓库提交流，再以外部仓库的连续提交流复现），SWE-bench 上的测量停在测量集无经验基线 70/99 道（124）。"只报同模型下的相对差异、不报绝对分数"的口径未变。
- 更正（2026-09-22）：理由原写"其精简版本因未经可解性筛选而更难"，应为"另一个子集 SWE-bench Lite 从原版全集筛出、未经可解性筛选"，依据 M9 前置的外部基准调研：Lite 不是 Verified 的精简版，与第一阶段所用的第三方 Verified 50 题子集也不是同一物。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 098 工具不感知工作区形状：抽出执行端接口（工作区内读写文件与执行命令），本地与容器各一份实现，快照与分叉挂同一层（设计）

- 结论：把"在工作区内读写文件、执行命令"抽成一个执行端接口，本地进程与容器各提供一份实现，由工作区形状决定注入哪一份；工具只调接口，不判断自己运行在何处。工作区快照与分叉同样挂在这一层——它们与执行命令同属"在该工作区上做事"，由实现决定是宿主 git 底层命令还是容器内 git 加镜像提交。
- 理由：096 定的"同能力只走一套接口"在此首次应用。若让工具各自分流（判断当前工作区是否为容器），"我在哪执行"这一知识会散落到每个工具中，每新增工具都要重复该判断，且判断错误不会立即暴露。让整个 harness 迁入容器的方案被否决：账本、会话锁、提炼器与终端界面均在宿主，整体迁入等于重做部署形态，收益仅为免除跨边界。
- 已知代价：跨边界会引入新的失败模式——超时的可靠终止（容器内由 PID namespace 保证，但经 exec 起的进程在杀客户端后会留下孤儿，须终止整个容器）、退出码保真、输出截断与路径映射。这些在宿主侧已踩过一轮（M7 收口的超时后孙进程占用管道），容器边界须重新验证。
- 锚点：src/tools/workspace-host.ts（执行端接口、写保护包装、快照与分叉占位）、src/tools/local-host.ts（本地实现：进程执行、文件清单与 .cmd / .bat 解析自 run_command 平移）、src/execution/container-host.ts（容器实现：超时与中止一律重启整个容器、OCI 起不来还原为 ENOENT / EACCES、守护进程失败按环境错误上抛、容器内路径围栏）、src/tools/read-file.ts 与 src/tools/edit-file.ts 与 src/tools/replace-edit.ts 与 src/tools/run-command.ts（只调接口）、src/application/runtime.ts 与 src/application/workers.ts 与 src/application/headless-core.ts（执行端注入）；测试 src/tools/workspace-host.test.ts、src/execution/container-host.test.ts（替身层任何机器都跑，真容器层需本机有 docker 守护进程与测试镜像）；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md。
- 现状说明：快照与分叉在接口上只留占位——宿主侧仍由 orchestration/checkpoint.ts 直接调宿主 git，尚未迁到该接口；容器实现未提供。按路径限定的 grant 以宿主路径判定，对容器工作区不会命中（不匹配即回落后续排律，不放宽）。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 099 对照条件为三类经验条件加一条最简 harness 基线；基线对跑只在扩量后的正式测量做，管道验证阶段不做（设计）

- 结论：正式测量设四组条件——无经验、候选经验、已激活经验（路线图原定三类），外加一条最简 harness 基线：同一模型、同一批题，本 harness 对跑一个公开的最简实现（百行量级、单一命令工具的循环，外部基准官方榜单即采用此类实现）。基线对跑只在扩量后的正式测量执行一次，第一阶段的 50 题管道验证不做。
- 理由：三类条件回答的是"经验有没有用"，但存在一个天然质疑——改善可能只是因为自身基线偏弱。与公开的最简实现对跑可直接堵住该质疑：差值即整套机制（账本、审阅、提炼、编排）的净贡献，且该差值免疫数据污染，因为两侧面对同样被污染的题目。代价是条件数增加即运行次数成倍增加（50 题下三类条件约 150 次运行，加基线约 200 次，按每实例十分钟量级计约三十余小时机时），故限定只在管道稳定后执行。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 100 自造题集降为冒烟用途只留三道（快、中等、会撞预算上限各一），其余连同验证脚本删除（设计）

- 结论：自造题集不再用于度量，降级为冒烟用途，保留三道覆盖面互补的题——耗时最短的一道、中等规模的一道、以及会触到预算上限的一道；其余题目连同其验证脚本一并删除。冒烟的职责是在改动跑批设施后于数分钟内确认链路未坏（能开工作区、能调模型、能执行验证器、能写结果行），不产出任何结论。
- 理由：八道题实测全部触顶，作为度量题已无区分度（097）；按 096 的"旧数据源降级到窄用途或删除"，留全套等于让每次改动跑批设施时都要验八道无人使用的题。冒烟不改用外部基准题目，因为其价值正在于便宜且不依赖容器——外部基准题需拉镜像起容器，与"两分钟内知道有没有坏"的目标冲突。保留会撞预算上限的一道另有用处：撞上限的观察记录与运行终态语义此前不一致（072 修订），保留可触发该路径的冒烟题便于回归时盯住。
- 锚点：eval/tasks/tool-error-codes（耗时最短，基线中位 74 秒）、eval/tasks/session-day-groups（中等，基线中位 111 秒，八题居中）、eval/tasks/path-dotdot-name（基线五次里出现撞轮次上限）；其余五道（fmt-duration、insert-after-diff、candidate-evidence、args-summary-surrogate、skill-block-scalar）连同验证脚本与验证资产已删除。docs/audits 下的历史评测结果按只追加原则保留，其中出现的已删题目 id 指向当时的任务目录。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 101 度量统计：每题每条件跑一次、预算优先投向题数；二值配对用 McNemar 精确检验；回放验证仍按 N 次，两处口径不同是设计（设计）

- 结论：三条。① 每道题在每个条件下的结果为三值——通过、失败、未完成（基础设施错误、撞上限等），未完成不计为模型失败，口径同 058 与 084。② 报告主体是同一道题在两个条件上的配对四格表，用 McNemar 精确检验，不报两侧各自的平均通过率。③ 每题每条件只跑一次，重复次数的预算改投向题数；配对因此天然为二值，无需额外统计假设。回放验证（M8 定的四组各 N 次）不受本条影响——那里比较的是同一道题的两个版本，题数天然为一，只能靠重复取得分辨率；两处口径不同是设计而非矛盾。
- 理由：噪声主要来自模型自身的随机性，而题目之间的差异远大于同题重复之间的差异，故同等预算下"50 题各跑一次"的统计力强于"25 题各跑两次"。多数表决会丢掉"五次过三次"与"五次过五次"的区别；改报通过率则需换用配对 t 检验一类方法，小样本下其分布假设站不住。保持二值配对使方法最简且无额外假设。

- 修订（2026-09-21，M9 第一阶段实测）：三点。① 实测噪声：完全同条件的两轮最终基线（断网、清理仓库历史、采样温度固定、工作方式指令与任务说明均冻结），50 对中翻转 7 题，占 14%。已排查人为造成的中途断网：第一轮因断网补跑、晚数小时的 14 题中翻转 1 题，未受影响的 36 题中翻转 6 题，断网未抬高噪声；限额触发后的退避重试与两轮跨时段的服务端差异属真实使用条件，计入噪声。② 灵敏度下限：两轮通过数为 31 与 34，相差 3 题即 6 个百分点，全部来自噪声；50 题单次运行的设计下，6 个百分点以内的差异无意义，按配对检验粗算 10 个百分点的真实效应亦达不到显著，测出 10 个百分点量级的效应需把题数扩到 100–150。③ 理由修正：原理由"题目之间的差异远大于同题重复之间的差异"被实测反证——若所有题难度相同、纯由随机决定，按两轮通过率 0.84 预期翻转约 11.8 题，实测 10 题（早期默认温度两轮的可比 44 题），与同质假设几乎重合，未观察到显著的题间异质性。"每题每条件跑一次"的做法保留，理由改为泛化覆盖面：不同题目覆盖不同的代码库与缺陷类型，所要回答的是经验是否普遍有效，而非对少数题目是否有效。原理由为推理所得、未经数据检验，保留错误理由的风险高于保留错误结论——下次遇到同类问题时错误推理会把判断带偏，故明确更正。
- 修订（2026-09-22，补记）：① 中"未完成（基础设施错误、撞上限等），不计为模型失败"的范围已由后续条目改变，原文保留：撞上限的运行照常判分，判分通过计为通过、未通过计为失败，结果行只作标注（108，2026-09-21）；上下文超长一类确定性错误不进错误行、不补跑，照常判分并计入成败（106 修订与 119，2026-09-21）；认证失败、泛化 400、模型不存在归为配置错误，整批停止、不记结果行（119 修订，2026-09-22）；内容审核类拒答为独立状态，不计入成败统计（106）。补跑的错误行只剩环境准备失败、模型服务故障、判据设施出错三类非确定性故障（106）。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。
### 102 抽出任务源接口：实例清单、环境准备、判据命令与元数据由实现提供，跑批设施不感知题目来源（设计）

- 结论：把"跑什么题"抽成任务源接口，由实现提供四样东西——实例清单、该实例的环境准备方式、判据命令、以及元数据（难度、holdout 标记、对应能力）。跑批设施、结果行、统计、报告与账本记录一律不感知题目来源。冒烟用的自造题与外部基准各为一个实现。
- 理由：与 098 抽执行端接口同一思路——那条管"在哪执行"，本条管"跑什么题"。换题集时真正变化的只有上述四样，其余（结果行的键为任务、条件、次序，以及统计与报告）本就与题源无关；不抽接口则外部基准的细节会渗入跑批各处（数据文件读取、镜像命名、测试清单拼装），日后更换题集成为外科手术。同时这正是 096 要防的局面：冒烟题与外部基准若无接口分隔，会在跑批设施内互相缠绕。
- 已知边界：换题集的代码代价约为新增一份实现，但非代码代价躲不掉——新题集的环境需重新准备，难度与污染需重新评估，且历史数字作废：不同题集上的提升幅度不可比，更换题集等于重新积累证据。
- 锚点：src/eval/task-source.ts（任务源接口与判据命令形状）、src/eval/local-source.ts（自造冒烟题实现）、src/eval/swebench-source.ts（外部基准实现）、src/eval/runner.ts（只认任务源；并行上限；错误行口径）、src/eval/verify.ts（判据命令的通用执行：备料失败与约定的出错退出码记未判定）、src/eval/results.ts（续跑键只由非错误行占用，读侧同键取最后一条非错误行）；测试 src/eval/task-source.test.ts、src/eval/results.test.ts、src/eval/runner.test.ts、src/eval/verify.test.ts；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md。
- 详情：docs/decisions/m9-prep-decisions.md（本地）。

### 103 判分阶段的评测容器可接代理，agent 的工作区容器不接；两侧网络配置不得互相复用（设计）

- 结论：部分外部基准实例的官方测试要访问外网，访问不到时连标准答案补丁都判不过。只给判分阶段的评测容器配代理（http_proxy / https_proxy / no_proxy，no_proxy 排除本机回环与容器网段）；代理地址在每次判分时现取默认路由的网关，不写死。agent 一侧的网络设置不因此改动，两侧的容器配置不得互相复用。
- 理由：断网防的是模型联网下载或外传内容；判分跑的是官方测试脚本、没有模型参与，两者性质不同。宿主地址在重启后可能变化，写死会在某次重启后静默失效。
- 锚点：eval/swebench/judge.py（--proxy，只作用于判据进程内由官方判分器创建的评测容器）、src/eval/swebench-source.ts（judgeProxy 只进判据命令）、src/cli/index.ts（--judge-proxy）；测试 src/eval/swebench-source.test.ts「判分代理只出现在判据命令里」；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十节。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 104 agent 的工作区容器无网络，不提供开关；因断网无法进行的题记基础设施错误，不为此打开网络（设计）

- 结论：外部基准的工作区容器恒以无网络模式创建（只留本机回环），调用方的附加参数里出现网络类或代理类选项即拒绝。某道题若因断网无法进行，记为基础设施错误并单列，不算任务失败，也不为此打开网络。此前在联网条件下跑出的 50 题数据保留，其中 django__django-12209 与 sphinx-doc__sphinx-9229 的通过属于运行期联网取回被修仓库的上游发布版本，不计入任何统计口径。
- 理由：任务说明里的“不要联网”只是一句话，没有机制拦；实测有运行用软件包下载命令取回了被修仓库的后续版本。联网与否若不受控，会成为经验对照之外的干扰变量。
- 锚点：src/eval/swebench-source.ts（WORKSPACE_NETWORK_ARGS 与附加参数校验）；测试 src/eval/swebench-source.test.ts「agent 的工作区容器无网络」；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十一节。
- 修订（2026-09-22，补记）：2026-09-21 的裁决只定了工作区容器断网、因断网无法进行的题记基础设施错误且不为此开网、两题通过不计入统计；标题与结论中的"不提供开关"和"附加参数里出现网络类或代理类选项即拒绝"是落实时的做法，裁决时未作讨论。附加参数校验此后在入库前修复（2026-09-21）中补拦了与取值粘连的端口映射写法与 `--env-file`（审计第十三节）。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 105 四道依赖外网的 sphinx 题留在正式题集，判分启用代理（设计）

- 结论：sphinx-doc__sphinx-7985、8269、8475、10435 留在 50 题正式题集；正式跑批时判分启用代理（103）。
- 理由：判分容器接代理后，四题的标准答案补丁两轮重判均判已解决、逐用例计数一致，判分约一分钟。已知代价：这四题的判分结果依赖代理与第三方站点的可用性。
- 锚点：证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十节、第十一节。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 106 错误行范围不变；验证器超时是真实结果不补跑；内容审核类拒答为独立状态，不补跑、不计入成败统计（设计）

- 结论：补跑的错误行限于三类——环境准备失败、模型服务故障（含流内以错误收尾）、判据设施出错。验证器超时维持为该次运行的真实结果，不补跑。内容审核类拒答新增为独立状态：不判分、不补跑、不计入成败统计，报告里单列。
- 理由：验证器超时可能正是改动把测试改挂了；拒答重跑大概率重复，按错误行补跑只会空转，而把它计为任务失败又会把 provider 的内容策略混进能力结论。
- 锚点：src/eval/runner.ts（isContentRefusal 与结果行状态）、src/eval/results.ts（refused 状态）、src/eval/report.ts（成败统计不含拒答）；测试 src/eval/task-source.test.ts、src/eval/report.test.ts；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十一节。

- 修订（2026-09-21）：确定性错误（上下文超长一类，重跑必然再次发生）计为任务失败——实现细节与错误类别的判据见 119，不列入错误行、不补跑。原实现把任何终态失败都视为模型服务故障，这类题每次重跑都作为错误行补跑、永不计入成败，会悄然从分母中消失。理由：上下文被撑爆通常源于模型读取过量或在循环中反复读取同一批文件，属于该次运行的真实结果，与空补丁、撞上限同类，且恰是经验可能改善的失败模式；单列为独立状态会把一类真实失败排除出统计。错误行只保留非确定性的设施类故障（环境准备失败、模型服务故障、判据设施出错）。
- 修订（2026-09-22，口径确认为照常判分）：上条修订中"计为任务失败"的判分口径已改为照常判分，见 119 的同日修订。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。
### 107 空补丁仍判失败，结果行加标注以区分“改了没改对”与“根本没改”（设计）

- 结论：交来的改动为空时判决仍为失败；结果行新增空补丁标注，报告里单列。
- 理由：两种失败的成因不同（定位或动手不了，对修复思路不对），混在一起会丢掉对失败分类有用的信号；判决本身不因此放宽。
- 锚点：eval/swebench/judge.py（尾行 JSON 的 emptyPatch）、src/eval/task-source.ts（判据命令尾行 JSON 的约定）、src/eval/runner.ts、src/eval/results.ts、src/eval/report.ts；测试 src/eval/task-source.test.ts、src/eval/report.test.ts。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 108 外部基准不设 token 上限；撞上限但判分通过计为通过，结果行标注并在报告里单列（设计）

- 结论：外部基准靠轮次与墙钟控长尾，不设 token 上限。撞上限而判分通过的运行计为通过（072 的推论：有验证结论时验证压过运行终态）；结果行标注撞的是哪个上限，报告单列撞上限次数与其中判分通过数。
- 理由：判决来自确定性验证器，与运行怎么收尾无关；把撞上限一律计失败会丢掉已经修好的运行，而标注与单列计数保留了成本侧的信号。
- 锚点：src/eval/runner.ts（limitHit）、src/eval/results.ts、src/eval/report.ts；测试 src/eval/task-source.test.ts「撞上限但判分通过计为通过」、src/eval/report.test.ts。

- 修订（2026-09-21）：外部基准的预算保持轮次上限 100、墙钟 20 分钟不变，不重测基线。最终基线每轮约五分之一的题目到达预算边界（两轮分别 11 与 9 题撞上限，其中 3 与 2 题仍判通过）。理由：预算边界是经验最可能显效之处——经验更可能让模型少走弯路而非想通原本无头绪的题目，其结果表现为原本撞上限失败的题在预算内完成；放宽预算会抹掉这一效应并使更多题目触顶、缩小测量余量，收紧预算则会让结论更多反映预算而非能力。反向风险须承认：促使模型做得更多的经验（例如要求改后跑完整测试）可能使原本刚好在预算内完成的题目转为撞上限失败，这是有限预算下的真实代价而非测量缺陷。撞上限比例因此作为固定报告项并双向呈现（减少与增加分别列出）；是否列为主指标，在正式对照开跑前随主指标一并预先指定。
- 修订（2026-09-22）：撞上限比例是否列为主指标的待定事项，随 SWE-bench 测量线停止（124、125）而随测量线停止而失效；若该线重启，届时再定。长时程一致性实验（126）的主指标已预先指定为代码库健康度，撞上限比例在其中作为次要的过程指标照常记录，撞预算导致的整步撤回已计入回退次数。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。
### 109 工作区容器的环境准备清掉基准提交之后的仓库历史，只留 HEAD 可达的部分；判分侧不动（设计）

- 结论：外部基准的环境准备阶段，在工作区容器内删除全部标签与 HEAD 所在分支之外的一切引用、删远端、过期 reflog、清理不可达对象，只留 HEAD 可达的历史；清完自验（无标签、全部可达提交数等于 HEAD 可达数、清理前取的一个后续提交对象已不存在），不过即准备失败。先清理、再建取 diff 用的初始树。判分在由同一镜像另起的干净容器里做，需要完整镜像，不动。
- 理由：官方评测镜像是整仓克隆再检出基准提交，仓库里带着之后多年的全部历史，修复提交本身就在容器里，断网挡不住；实测两轮各有 17/50 题的会话翻过后续历史。清理后这 17 题的通过数由 16 降到 7，而未翻过的 33 题基本不变，说明此前的分数被该通道抬高。
- 锚点：src/eval/swebench-source.ts（PRUNE_HISTORY_SCRIPT、historyPruneVerified）；测试 src/eval/swebench-source.test.ts「环境准备先清掉基准提交之后的仓库历史再建初始树」与真容器层；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十二节。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 110 评测固定采样温度为 0，并冻结进注入快照随 run.started 落盘（设计）

- 结论：外部基准的评测运行把采样温度固定为 0；温度作为注入快照 model 段的可选字段冻结，并随 run.started 落盘，事后可证每次运行用的温度。缺省不设（由 provider 决定），既有运行逐字不变。
- 理由：同一道题在不同条件下的差异不应来自采样随机性；默认温度下相邻两轮的逐题翻转率在四分之一上下，盖过了几个百分点量级的条件差异。
- 已知边界：上游只在未请求推理时把温度交给 provider；温度目前只接到无父会话的运行面（headless 与 Eval），worker、分叉重试与回放未接。
- 锚点：src/pi-runtime/sampling.ts、src/pi-runtime/snapshot.ts（注入快照 v9）、src/state/runtime-events.ts 与 src/state/event-log.ts（Event Log v13）、src/application/runtime.ts、src/application/launch-flags.ts（--temperature）、src/eval/runner.ts；测试 src/application/sampling-e2e.test.ts、src/pi-runtime/snapshot.test.ts、src/eval/task-source.test.ts；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十二节。
- 修订（2026-09-22，补记）：入库前复核（2026-09-21）查出温度的落实违背本条，修复后（审计第十三节）"缺省不设"与"已知边界"两处现状改为：① 外部基准入口（`pigeon eval swebench`）缺省温度 0，只能经 `--temperature` 显式改；自造冒烟题的 Eval 入口仍缺省不设；其余入口不接受 `--temperature`，按未知参数拒绝、不静默忽略。② 回放的验证器运行面与失败自动分叉重试沿用原尝试的温度与工作方式指令；原尝试没设温度就不带，取不到原尝试 run.started 的照旧拒绝验证；普通 worker 仍缺省不设。③ 推理开启时上游不把温度交给 provider，run.started 的模型段如实记"温度未生效"与请求值，不再记为温度 0。温度未纳入 091 的失效判定封闭清单，记为已知缺口。锚点 src/cli/index.ts 与 src/eval/swebench-source.ts（swebenchTemperature）、src/replay/plan.ts、src/application/rerun.ts、src/application/headless.ts（重试沿用）、src/application/runtime.ts（temperatureIgnored）。
- 修订（2026-09-22，补记）：代码核实，当日落实清单中"其余采样参数（如 top_p）一并显式固定、不再依赖服务端默认"未落实：src/ 只设温度一项，未设 top_p、seed 等参数，注入快照与 run.started 也只冻结温度；上游 pi-ai 的调用选项另有 samplingParams 透传字段（只对 OpenAI 兼容接口生效），本项目未使用。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 111 任务说明冻结为纯英文 issue 原文，不加包装；中文指令加英文任务的混合语境如实写明（设计）

- 结论：外部基准交给 agent 的任务说明逐字等于数据集的 issue 原文，不加任何包装文字。system prompt 与工具说明仍是中文，模型处在中文指令加英文任务的混合语境——这是本 harness 的真实特性，在报告与审计里写明，不用包装掩盖。
- 理由：任务说明的措辞是被测条件的一部分，正式测量前必须冻结；包装文字越多，测到的越是包装而不是 harness。不要改测试文件这一约束由执行端的写保护与取 diff 时的排除兜住，不依赖说明。
- 锚点：src/eval/swebench-source.ts（instructions 取 problem_statement）；测试 src/eval/swebench-source.test.ts「任务说明冻结为 issue 原文」；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十二节。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 112 容器工作区的路径放权暂不处理，但加护栏：交互场景与路径限定规则装配即报错，不许静默失配（设计）

- 结论：按路径限定的放权以宿主路径判定，对容器工作区只会静默失配。本阶段不做容器工作区下的路径放权；拿到非本地执行端的运行面，凡带审批通道（交互场景）或装了按路径限定的固化放权规则，装配时明确报错说暂不支持。无审批通道、无路径规则的无人值守运行照常。
- 理由：静默失配比明确拒绝危险——人以为某目录已放行，实际每次都回落到后续排律，且没有任何提示。039 之后权限侧非必要不新增功能，护栏是最小代价的收口。
- 锚点：src/application/runtime.ts（buildRuntime 的两处护栏）；测试 src/application/container-workspace-guard.test.ts。
- 修订（2026-09-22，补记）：护栏在落实与复核中两次扩展，均未单独裁决。一是落实时（2026-09-21）把"装了按路径限定的固化放权规则"加为触发条件，裁决原文只定了交互场景拿到容器工作区时装配即报错。二是入库前复核（2026-09-21）发现原护栏按"是否注入了执行端"判断，拦不住 headless 下把容器占位目录当真工作区用的路径，修复为注入了执行端时，失败自动分叉重试、会话验证命令与分支会话一律在装配前拒绝、不写账本；这一扩展作为次要问题顺手修掉（审计第十三节）。锚点 src/application/headless-core.ts（runHeadlessOnce 的装配前护栏）。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 113 结果行：整次墙钟新写必带、读侧容忍旧文件缺失；难度随任务源可选（设计）

- 结论：结果行的整次墙钟 wallMs 列入必有字段清单，新写的行一律带；读侧容忍此前写下的文件缺这个字段。难度标记 difficulty 随任务源可选，不列入必有字段。
- 理由：耗时分布要按整次墙钟（环境准备、agent 运行、判分与清理）统计；难度只有外部基准有，自造冒烟题没有，强制会逼出占位值。
- 锚点：src/eval/results.ts（EVAL_RESULT_FIELDS）；测试 src/eval/results.test.ts「必有字段清单」。

- 修订（2026-09-21，补记原裁决内容）：报告模板只维持一套，条件数参数化，同时支持单条件与多条件，不为单条件的外部基准另出模板（096 的"同一份内容不保留两个来源"）。此项在 2026-09-21 原裁决时即已定下，条目初立时漏写，此行为补记，不是后来的修订。该项到入库前修复（审计第十三节）才实际落实。
- 更正（2026-09-22）：原写"修订（2026-09-21）"，把模板一项标成了原裁决之后的修订，应为原裁决内容的补记，依据 M9 第一阶段裁决记录：113 的原裁决同时定了结果行字段与报告模板两半。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。
### 114 口径变化靠新记录表达，不追溯改写历史数据：按旧口径写下的结果行保留不改（设计）

- 结论：结果文件里按旧口径写下的行保留不改、不删，读侧也不重新解释（例如终态 failed 而带判决的旧行读回来仍是非错误行、照旧占续跑键）；统计时对个别旧行的处置写在结果目录旁的清单里。口径变化只体现在此后新写的行上。
- 理由：让读侧按新口径重解释旧行，会同时改变全部历史结果文件的复算结果，且无从审计；追加式的数据只有不回改才可信。
- 锚点：src/eval/results.ts；测试 src/eval/results.test.ts「按旧口径写下的行不追溯改写」。
- 修订（2026-09-22，补记）：补记原裁决（2026-09-21）选定的具体处置，条目初立时漏写：引发本条的 sphinx-doc__sphinx-8475 那条按旧口径写下的"终态 failed、判决失败"结果行（模型流中途断开却被照常判分）保留原样，统计时按基础设施错误计。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 115 M9 第一阶段此前各轮外部基准数据整体作废，不计入任何统计口径；可信基线自断网、清历史、固定采样之后算起（设计）

- 结论：在工作区断网、仓库历史清理、采样固定与任务说明冻结全部到位之前跑出的各轮外部基准数据保留，但整体标注作废，不计入任何统计口径；排除清单照旧维护。
- 理由：这些轮次里无法区分哪些题抄到了答案（联网取回上游版本、翻镜像内的后续历史），也就无法从中得到任何关于能力的结论；它们的价值是暴露了管道问题。
- 锚点：证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十二节。
- 修订（2026-09-22，补记）：可信基线的起点此后还要求带有 116 的工作方式指令：纯 issue 原文、无工作方式指令条件下的部分观测（12 题）标注条件另存，不作基线；作废范围也扩到清历史加温度 0、任务说明仍为旧中文包装的过渡轮。本阶段基线为最终条件下同条件跑的两轮。无指令部分的排除随 116 的裁决（2026-09-21）写入执行口径，作废范围的扩展未见单独裁决。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 116 外部基准的 system prompt 补一句工作方式指令：只说工作方式、措辞对齐公开最简实现、冻结进注入快照（设计）

- 结论：外部基准的运行在 system prompt 末尾追加一句工作方式指令，告诉模型它的工作是修改仓库代码来解决用户消息里描述的问题。三条约束：只说工作方式，不对 issue 内容做任何归纳或翻译——任务说明（111）与这句系统指令分属两处，不得混；措辞与公开的最简实现对齐，以免将来对跑时措辞差异让对比失真；这句话属于被测条件，随整段 system prompt 冻结进注入快照，并在审计里逐字记录。
- 理由：任务说明冻结为纯 issue 原文后，模型会把 issue 当成提问来回答而不动手——实测该条件下 12 题里 4 题 1 轮收工、均为空补丁。带指令重跑这 4 题，全部正常开工；两轮各 50 题的基线里没有一题 1 轮收工。
- 锚点：src/eval/swebench-source.ts（SWEBENCH_WORK_DIRECTIVE）、src/eval/task-source.ts（systemDirective）、src/eval/runner.ts、src/application/runtime.ts（taskDirective 追加进 system prompt）；测试 src/eval/swebench-source.test.ts「工作方式指令」、src/eval/task-source.test.ts「任务源给的系统指令进模型实际看到的 system prompt」；证据与逐字措辞 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十二节。
- 详情：docs/decisions/m9-stage1-decisions.md（本地）。

### 117 结果行记录两组测试各自的通过条数与总条数作为连续指标；判据不变，仍以全过为准（设计）

- 结论：外部基准的每条结果行额外记录"修复后应从失败转通过"与"修复前后都应通过"两组测试各自的通过条数与总条数。解决与否的判据不变，仍以两组全过为准；连续指标只作辅助观测，不改变判决。
- 理由：二值判决下"31 条过 30 条"与"31 条过 3 条"同为失败，而二者含义完全不同；连续指标噪声天然小于二值，且能观察到"更接近正确"这类二值看不见的改善。实测最终基线的失败题中，目标用例（修复后应从失败转通过的那组）一条没过的占多数（第一轮 19 题中 12 题、第二轮 16 题中 10 题），目标用例全过、只差回归用例的只有 2 题，这一分布本身即为二值判决无法呈现的信息。
- 已知边界：连续指标只在判决相同的题目内比较才有意义；作为过程指标之一，正式测量前须预先指定主指标，其余作探索性描述，避免在多个指标中事后挑选显著者。
- 更正（2026-09-22）：标题标签原写"（事实）"，应为"（设计）"，依据：本条是 2026-09-21 随 110 的执行顺序一并作出的设计裁决，条目于同日补立。理由原写"两组测试全未通过的占多数"，应为"目标用例一条没过的占多数"，依据审计第十二节的分档：第一轮 19 道失败题中 12 题、第二轮 16 题中 10 题目标用例一条没过，回归用例并非全未通过。
- 详情：docs/audits/2026-09-20-m9-pipeline-c63a0bf.md；裁决过程见 docs/decisions/m9-stage1-decisions.md（本地）。

### 118 本阶段只衡量"同一代码库上越用越好"：来源集与测量集同为 django、题目互不重叠，测量集分层随机抽样并预先落盘，测量集效果为结论、来源题效果仅为上界（设计）

- 结论：M9 第二阶段的目标限定为主张一——经验能否让 agent 在同一代码库的**未见过的新任务**上做得更好；跨仓库迁移（主张二）不在本阶段。来源集与测量集同取自 SWE-bench Verified 的 django 题目，题目互不重叠：来源集 50 道（复用已有两轮干净基线的 25 道，另抽 25 道），测量集 100 道。两者均按数据集自带的难度档分层随机抽样、固定随机种子，**抽样结果在任何运行开始前落盘**，事后不得调整。测量集的无经验基线必须在任何经验激活之前跑完。报告同时给出测量集上的配对差（主张一的结论）与来源题上的效果（上界，含过拟合），两者之差作为经验中"针对具体题目的答案"所占比重的估计。
- 理由：主张一的真实使用情形是在自己的仓库里反复处理**不同的**任务，几乎不会把同一个缺陷修第二遍，因此必须测对未来任务的效果，来源集即"过去"，测量集即"未来"。若在来源题上测，从某题提炼出的经验可能直接写成该题的修法，分数上升来自答案而非能力，等于经由经验本身重新打开 104、109 刚堵上的答案泄漏通道。两个主张的差别不在是否留出，而在留出的维度——主张一留出题目，主张二留出仓库。选 django 是因其在该数据集中占比近半、题量足以切分。来源集扩到 50 道：已有 25 道中两轮都通过的 18 道提供不了失败侧，真正可提供对比素材的只有 7 道，经验过少会使"未测出改善"无法区分为"经验无效"还是"经验不足以起作用"。先测主张一还因为它更贴近本项目的实际用法；若主张一亦未测出，主张二不必再测。
- 已知边界：数据集经人工筛选只保留题面清晰、确实可解的题目，比真实 GitHub issue 干净，结论须限定为"在题面清晰的 django 修复任务上"；数据集存在训练数据污染，对两个条件为共模项，只影响绝对分数不影响配对差（097）；已有 50 题精简版按镜像存储成本挑选，其仓库构成不具代表性，其上测得的通过率与噪声不能外推到测量集，测量集基线须重测。
- 附带：已跑完的干净基线在修复后可复用，判据为行为相关的冻结项一致（模型、采样参数、预算、工具集、工作方式指令原文），而非整份注入快照的哈希——修复可能为快照增添字段，哈希随之改变而行为不变。
- 修订（2026-09-22，补记）：本条录入后（2026-09-21）另摆出以第二个仓库做复现的三个选项（只做 django / django 加 sympy / django 加 sphinx 且 sphinx 只作补充）。"本轮只做 django、sympy 复现留到 django 出结果之后"是在项目负责人回答同一条消息里另一件事（工作队列提速与时长更正）时一并采用的，未单独裁决。此后 125（2026-09-22）把主张一的测试床改为连续工作流，SWE-bench 上 django 与 sympy 的这套安排随之被取代。
- 详情：docs/decisions/m9-learning-loop-decisions.md（本地）。

### 119 确定性错误不进错误行、不补跑：照常判分，结果行标注类别；目前只认上下文超长（修订 106 的错误行范围）

- 结论：模型请求以"重跑必复现"的错误收尾时，这次运行不记错误行、不补跑：照常判分（中途改了什么判什么，与撞上限同理），终态仍是 failed，结果行带 `deterministicError` 标注类别，占续跑键；报告在"标注"一节单列次数与其中判分通过数。判据是"错误由请求内容本身决定、与服务端当时的状态无关"。目前只认上下文超长，识别直接用上游 pi-ai 按各 provider 报错文案的判定（含 kimi-for-coding 的 "exceeded model token limit"），限额类文案先排除。
- 理由：错误行的本意是"服务抽风、这次没有产出可用结果、换个时间重跑就好"；上下文超长是这次运行走到的真实状态，重跑同样的对话必然再超，补跑只会原样复现并白耗时间。把它当错误行，续跑会无休止地补跑同一题。
- 待裁（暂按服务故障记错误行、会被补跑）：认证失败（401/403）、泛化的 400 请求错误、模型不存在（404）。这几类重跑同样会复现，但原因在配置而不在这道题——按题记失败会把配置事故计成模型失败，按错误行补跑又会反复失败；更合适的处理可能是整批停止，留待项目负责人裁决。
- 锚点：src/eval/runner.ts（deterministicErrorOf）、src/pi-runtime/overflow.ts、src/eval/results.ts（deterministicError）、src/eval/report.ts；测试 src/eval/task-source.test.ts「确定性错误（上下文超长）」；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十三节。

- 修订（2026-09-22）：认证失败（401/403）、泛化的 400 请求错误、模型不存在（404）归为配置错误类：整批立即停止、不记结果行，由人修正配置后重新开跑。理由：这三类的原因在配置（密钥、模型名、请求格式）而不在题目或模型，重跑必然复现，继续跑只会让每一题同样失败，补跑只会原样复现、白耗时间；记为任务失败又冤枉了题目。实现待排入收尾，落地前暂按现状记错误行。
- 更正（2026-09-22）：标题原写"修订 101 ① 的错误行范围"，应为"修订 106 的错误行范围"，依据：2026-09-21 裁决时即以"106 修订"提出与记录（错误行的范围由 106 定），106 条目也已有指向本条的修订行。101 ① 中"未完成"范围的变化另见 101 的补记修订。
- 修订（2026-09-22，口径确认为照常判分）：确定性错误（目前只有上下文超长）的判分口径，由项目负责人确认为照常判分：中断前已做的改动照常判分，判分通过即计通过，终态仍记失败，结果行标注类别，报告中单列。取代 106 修订中"计为任务失败"的字面表述。理由：该裁决的依据是"与空补丁、撞上限同类"，而撞上限已定为判分通过计为通过（108）；两者同属被外力中断、代码可能已改对的情形，口径应一致；判分衡量的是代码是否改对。两种口径只在中断前已改对时结果不同，已跑的全部基线中未出现上下文超长。
- 详情：docs/decisions/m9-learning-loop-decisions.md（本地）。
### 120 提炼器不设 token 上限；轮数与墙钟仍按缺省，并记录实际撞的是哪一项（修订 074 的预算）

- 结论：提炼器的缺省预算去掉 token 上限，保留 16 轮、5 分钟；超限仍按中止处理、不产出候选。实际运行中提炼器撞的是轮数还是墙钟，逐组记录，供之后调整这两项。
- 理由：提炼器每轮都把整段上下文重送一遍，按累计 token（含缓存命中）计的 80,000 上限在 SWE-bench 规模的尝试上只够 5 到 8 轮——每轮只输出几十个 token 的读取调用，还没读完成败两侧材料就被中止。M9 第二阶段首次提炼时，来源集 4 对成败尝试全部撞 token 上限，噪声压力测试 7 对里 3 对撞上限，均未产出候选。token 上限在这里约束的不是产出而是阅读量，对"能不能从一对尝试里提炼出东西"起不到预算的作用。
- 锚点：src/application/distill-runtime.ts（DEFAULT_DISTILL_BUDGET）；测试 src/application/attempt-group.test.ts；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十四节。
- 详情：docs/decisions/m9-learning-loop-decisions.md（本地）。

### 121 修掉提炼器跳过材料的缺陷：冻结对比快照直接放进首轮输入，空结果必须附理由；轮数 40、墙钟同比放宽（修订 076）

- 结论：提炼器的任务说明末尾直接附上冻结对比快照，不再只经 `distill_snapshot` 工具给出；截断或省略的内容仍用 `distill_entry` 回查。提炼结果为空时必须附理由——读了哪几侧（存在的侧都要读）、为什么判断没有可学的；缺理由、理由为空或漏报某一侧，按不合格式留痕，不当作正常的空结果。合格的空结果理由随提炼结果交回、逐组列进报告，原文在提炼器会话里。预算改为 40 轮、12.5 分钟（墙钟按 40/16 同比放宽），不设 token 上限（120）。
- 理由：120 之后的首次重新提炼里，11 组里有 5 组第 1 轮就直接交空结果——不调用读取快照的工具、只输出 15 个 token；另有 5 组读满 16 轮仍没给结论。前者是提炼器可以不读材料就交差，空结果与"读过后判断没有可学的"在账本上无法区分；后者是 16 轮在 SWE-bench 规模的尝试上不够读完两侧。
- 锚点：src/distillation/prompt.ts（distillerTask 附快照、空结果格式）、src/distillation/candidates.ts（DistillerEmptyReasonSchema、空结果校验）、src/application/distill-runtime.ts（DEFAULT_DISTILL_BUDGET、首轮输入）、src/application/distill-command.ts（报告列出空结果理由）；测试 src/distillation/candidates.test.ts「空结果必须附理由」、src/application/distill-command.test.ts「快照直接放进提炼器的首轮输入」、src/application/attempt-group.test.ts；证据 docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十四节。
- 更正（2026-09-22）：标题原写"修订 074"，应为"修订 076"，依据：2026-09-22 裁决时"冻结对比快照放进首轮输入"即作为 076（提炼器输入）的修订提出，076 已补指向本条的修订行。轮数与墙钟的放宽改的是 074 定的提炼器缺省预算，与 120 去掉 token 上限同属预算一侧。
- 详情：docs/decisions/m9-learning-loop-decisions.md（本地）。

### 122 评估学习闭环只修缺陷让系统按原设计工作，不由人分析结果引导系统学什么；测量集在带经验一轮跑完前只看汇总数字（设计）

- 结论：评估学习闭环（提炼、验证、激活整条链）是否有效时，只允许修真正的缺陷——例如提炼器能跳过材料直接交空、预算按错误假设估算、轮数不足以读完材料——修完系统仍是原来的系统。不允许由人（或代为施工的会话）分析运行结果或失败轨迹，再据此引导系统学什么，包括选择从成功侧还是失败侧取素材、挑选"对主张最对口"的素材来源、按失败类型决定提炼策略。测量集在带经验的一轮跑完之前只看汇总数字（总通过率、撞上限比例），不看逐题失败内容来指导任何设计。系统按原设计跑出的结果（包括零候选）就是系统的真实表现，照实报告并写明原因。新的学习策略若要尝试，属于下一版设计：要么做成系统自己的能力，要么明确作为"人工干预"对照组与系统自主学习分开报告。
- 理由：主张一要证明的是系统自己能从运行历史里学到东西。若关键判断由人做出，测到的改善归功于人的分析，被测对象已被偷换；反复看结果、调策略、再看结果直到调出能测出改善的版本，在系统设计层面就是事后挑选。先在测量集上分类失败再设计经验，等于用考试题设计复习方案；改到来源集上分类同样是人在替系统学习。
- 详情：docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十四节；裁决过程见 docs/decisions/m9-learning-loop-decisions.md（本地）。

### 123 学习闭环第一版结论：四个根因与实测失败模式；主张一改为"同一代码库上越用越省"，解决率降为次要指标（设计）

- 结论：第一版学习闭环（M6 后台审阅器、M7 对比式提炼、M8 逐条回放验证）在 SWE-bench Verified 的 django 题上按原设计运行后判定为不可用，根因四个：① 学习单位错了——以单道题为单位学，学到的必然是该题的内容；② 反馈信号承载不了因果归因——整题成败只有一个比特且实测 14% 为随机，让模型从中反推"哪一步走错"只能编造；③ 知识形态错了——自然语言行为建议要么是强模型本就会的通用话，要么是具体题目的答案，中间几乎没有既有用又可迁移的地带；④ 逐条验证在统计上不可行——外部研究用 111 题乘 4 个随机种子仍测不出单条经验的效果，M8 建立在每条经验都可被验证的前提上，该前提不成立。实测复现的失败模式见审计第十四节：为噪声差异编造因果、经验退化为答案、同一材料两次提炼不同、编造引用、含修法的经验回放判回归。主张一据此从"做得更好"改为"在同一代码库上越用越省"（省时间与 token、降低工具错误率与摩擦、定位更准、步数更少、环境类失误更少），解决率作为预先指定的次要指标照实报告；主指标须在正式对照开跑前书面预先指定，其余标为探索性。
- 理由：外部证据在"同一代码库、严格留出新题"这一设定上最干净的三项研究，解决率增益均在 0 到 5 个百分点且统计上不稳，低于本项目约 10 个百分点的测量灵敏度；而定位准确率、步数、成本类指标有一致的正向证据且噪声更小。在看到自身实验结果之前基于外部证据调整主张，是正当的预先指定而非事后挑选。此外 M6 审阅器与 M7 提炼器按证据形状拆成两个学习角色是里程碑历史造成的，两者有同一病根（让模型从结果反推行为建议），且下游处理不一致（单来源候选无法自动验证），应当收敛。
- 修订（2026-09-22，补记）：主张一"同一代码库上越用越省"已由 126 取代。同日项目负责人指出更省不等于更好——省下的探索若换来更多回归，结果就是更差；主张一改为长时程一致性，"更省"降为次要观测。
- 修订（2026-09-22，补记）：同日项目负责人同意第二版学习闭环只学关于代码库的结构记忆（东西在哪、改 A 须连带改 B），放弃"任务教训"这一知识形态；该项当时未入索引，在此补记。此后同日的余量测量显示这两类知识在本仓库提交流上余量不足（共变预测与随机相当，"东西在哪"的提示只作用于成本），记忆系统重做的范围另由 129 裁定。
- 详情：docs/decisions/m8-prep-decisions.md 前置调研、docs/audits/2026-09-20-m9-pipeline-c63a0bf.md 第十四、十五节；裁决过程见 docs/decisions/m9-learning-loop-decisions.md（本地）。

### 124 基线账本的浪费分析否定"越用越省"在知名仓库上的余量；第二版暂缓，待换题域先量浪费；本轮来源集不补、基线不续跑（设计）

- 结论：对两轮最终基线的会话账本做浪费分析（审计第十五节）后，第二版"发现记忆"方向暂缓：不再为本轮补充来源集的成败对、不给提炼器加"区分可迁移做法与题目答案"的约束、测量集基线停在 70/99 道不续跑（逐题落盘，日后需要可续跑补齐）。下一步为工程收尾（M9 第一阶段入库、README、可用性、许可证），随后用同一套浪费分析在一两个模型不熟且结构复杂的候选仓库上先量浪费，有余量再决定第二版做不做、做什么。
- 理由：浪费分析显示"agent 在重新发现代码库事实上浪费很多"这一前提不成立——测试命令首次即用对（50 个会话零试错）；命令失败约 5% 且大头是 grep、find 无匹配的正常退出码，真失败集中在 agent 自写的复现脚本（12%–16%）；编辑报错约 15% 中八成以上是试图修改判分用测试文件被围栏拦下，锚点类错误每轮仅三四次；模型不熟的自建仓库上命令失败 1.4%、编辑报错 4.8%，更少。知名开源仓库在训练数据中已被充分覆盖，模型本就知道其结构与惯例，"发现记忆"在此无东西可发现。方法学教训：两版设计都先假设浪费所在再设计学什么，而账本里的数据半小时即可看清；此后任何"学习能带来收益"的设计，第一步都应先量收益上界。
- 附带：反复试图修改判分用测试文件（每 50 题被拦二十余次）属任务规则而非代码库知识，收尾时把提示写硬即可；本次浪费分析应做成评测报告的固定一节（命令失败按类型、编辑报错按原因、首次测试命令是否用对）。
- 修订（2026-09-22，补记）："浪费分析否定余量"的结论已被推翻：该分析只统计了失败类浪费，没有统计探索；同日补测显示读文件与 find/grep 类探索占全部工具调用的 45%–47%，首次编辑前中位 11 轮，余量在探索而不在失败（125）。"下一步为工程收尾"的安排同日被项目负责人否定（目的尚未达到），随后由 125 把测试床改为连续工作流。
- 修订（2026-09-22，补记）：结论中"不再为本轮补充来源集的成败对"与"不给提炼器加区分可迁移做法与题目答案的约束"两项，来自实施方交回时列出的待裁事项，记录时被认定为已由本条覆盖，未经项目负责人单独裁决；"测量集基线停在 70/99 道、不续跑"由项目负责人同日明确决定。
- 详情：docs/decisions/m9-learning-loop-decisions.md（本地）。

### 125 SWE-bench 题目在时间与空间上零局部性，结构上不适合评估"同一代码库上越用越好"；测试床改为连续工作流，先用本仓库提交流跑通，再以外部仓库的连续提交流复现（设计）

- 结论：主张一（同一代码库上越用越省）的测试床从 SWE-bench Verified 改为**连续工作流**——按时间顺序排列的、来自同一贡献者连续工作的任务序列。先用本仓库自身的提交流跑通并观察迹象（模型不熟此仓库、局部性强、87% 的提交自带测试改动可作判据；环境列为待裁，此后设计侧提出的方向是复用 M9 的容器、断网并清理未来引用），再以一个模型未见过的外部仓库的连续提交流复现；外部复现不是可选项，是本仓库上的结论能否对外陈述的前提。设计侧记录时将 124 中"待换题域先量浪费"归纳为已由本条的离线测量完成，项目负责人未就此表态。
- 理由（均为对已有数据的离线测量，未运行任何新会话）：① 主张一的余量不在失败而在探索——两轮最终基线中读文件与 find/grep 类探索占全部工具调用的 45%–47%，首次编辑前中位 11 轮、7–9 次读或探索；② 但 SWE-bench 的过去任务几乎不预测新任务要改哪里——25 道来源题按 issue 相似度检索最相似的 3–5 道，其编辑过的文件命中新题金文件仅 16%，与"推荐池内最热门 5 个文件"（7%–23%）相当，而 agent 自行探索命中 97%；③ 根因是数据集本身无局部性——231 道 django 题跨 6.7 年，时间相邻两题共享同一文件 0.9%（随机配对 1.5%）、共享模块目录 16%（随机 15%），与之前 5 题共享文件仅 8%；④ 对照本仓库 105 次改动 src/ 的提交：相邻共享同一文件 42%、共享模块目录 66%，与之前 5 次中任一共享文件 72%、目录 92%。主张一描述的是连续工作中的累积效应，SWE-bench 是数千贡献者数年间散落各处的 issue，二者结构不匹配；第一版与第二版在其上均无余量，应归因于测试床而非学习机制。此发现本身作为研究结论记录：SWE-bench 类基准不适合评估仓库级累积学习。
- 前置待裁：题面的出法（不得泄露修法，提交信息过简）；大提交（14 次逾 20 文件）的处理；任务流的切分与顺序（来源与测量的时间切分，或滚动的在线设定）；判据（该提交新增或修改的测试须通过、既有测试不回归）；环境隔离（本仓库在公开托管平台上有未来提交，须断网并清理未来引用）；"更省"的证据形态（按任务序位的过程指标曲线、逐题配对）；外部复现仓库的选择标准。
- 附带：本次使用的离线分析（工具调用构成、首次编辑前成本、检索命中、时间局部性、提交流局部性）应正式化为可复用的分析命令，作为评估任何新测试床前的固定步骤。
- 更正（2026-09-22）：前置待裁原写"大提交（12 次逾 20 文件）"，应为 14 次，依据产率测量的逐提交记录：105 次提交中改动文件数逾 20 的有 14 次，其中 13 次原本成题，与 126 的"排除 13 次"一致；12 是只数 src/ 下文件时的口径。
- 更正（2026-09-22）：结论原写"环境即本机"，应为环境待裁，依据：本条自己把环境隔离列为前置待裁，此后设计侧提出的计划为复用 M9 的容器、断网并清理未来引用（126 前置待裁同）；"环境即本机"是 A、B、C 三选一时对选项 A 的描述。结论原写"124 中'待换题域先量浪费'的动作由本条的离线测量完成，不再另做"，应标明为设计侧记录时的归纳，依据：裁决时未讨论此项，项目负责人未就此表态。
- 修订（2026-09-22）："本仓库先行"改为主实验在更大、更难的外部仓库上进行，见 149。
- 详情：docs/notes 下的证据目录（不入库）；离线分析方法见本条理由；裁决过程见 docs/decisions/stream-memory-decisions.md（本地）。

### 126 主张一改为长时程一致性：agent 在同一代码库上延续式连续工作能否不把它搞坏；在本仓库 71 题提交流上以三条件（修订后为四个条件，见修订行）比较代码库健康度随步数的曲线；更省降为次要指标（设计）

- 结论：主张一由 123 定的"同一代码库上越用越省"改为**长时程一致性**——agent 在同一代码库上延续式地连续完成多步任务，能否不让错误累积、不破坏既有约束、不因前面的设计拖累后面。实验为**延续式**：agent 的代码真正带到下一题（不再每题重置到人的父提交），记忆同样跨题延续。三个条件在同一条任务流上比较：完整的 Pigeon（账本、验证门、回退、记忆全开）、Pigeon 去掉记忆（消融）、公开的最简 agent（099 的基线）。比较对象是三条"代码库健康度随步数变化"的曲线。健康度指标预先指定：既有测试通过比例（回归累积）、分层规则违规数、类型与 lint 错误数、每步新增测试的通过率、回退次数；轮数、token、探索次数等过程指标作次要。"更省"不再是主张，只作免费带出的次要观测。
- 理由：项目负责人指出"更省不意味着更好"。对照架构：账本唯一权威、每步回执、崩溃恢复、回放与分叉、经验可追溯、改动须过验证门——这整套设计服务的场景正是"无人值守地在一个代码库上连续干很多步而不把它搞坏"（039 的定位）。"更省"只检验一个任何 agent 都能挂上的检索技巧，与账本、回执、验证门无关，测出来也说明不了这套架构的价值；长时程一致性直接检验整套 harness，且它是"更好"。现有延续式基准（SWE-Chain 的发布级链、EvoClaw 的里程碑）测的是粗粒度的长时程演进，仓库均为模型熟悉的知名项目，粒度上看不到逐题的局部性，且没有有记忆与无记忆的对照，不能直接用。
- 测试床事实（2026-09-22 离线测量，未运行任何模型）：本仓库改动 src/ 的 105 次提交中，按"测试改动打到父提交上失败、打到提交本身上通过"的规则成题 84 次（80%；对照 SWE-Next 在合并 PR 上的 2.2%，差异源于本仓库测试先行与逐提交门禁），父提交上已通过的 6 次、无测试改动 14 次、标准答案亦不过的 1 次（一次故意先提红测试的提交）。排除 13 次逾 20 文件的大提交后余 71 题，每题改动源文件中位 2 个、测试文件 1 个；相邻题共享同一源文件 32.9%（随机配对 17.4%）、共享模块目录 55.7%（随机 31.6%），与之前 5 题共享源文件 68.2%、目录 89.4%；判分（在提交上跑其测试）中位 2.2 秒，71 题合计约 3 分钟。本仓库带机检的分层规则、类型检查、lint 与九百余条测试，`npm run verify` 即为客观的代码库健康判据，这是多数开源仓库不具备的条件，也是选它为第一站的理由之一。
- 已知难点：延续式下的接口绑定——第 k 题的测试按人的第 k−1 步代码编写，agent 若在前一步采用了不同的模块或函数命名，后续测试连加载都不能通过，合理的另一种设计会被判失败。现成的细粒度延续式基准 ChainSWE 平均链长 3.04 步，调研对其原因只给出推测：成链要求相邻补丁可干净叠加，这一条件在 issue 级散点上很快失效。处理：题面给出该提交新增或修改的测试文件全文（127），agent 按测试要求的接口实现，从题面上消解大部分接口绑定；"接口偏离导致后续测试无法加载"仍单列为一类结果，与实现错误分开报告，其数量本身作为一致性的一个维度。此难题在细粒度上尚无人解决。
- 限定：本仓库带完整设计记录，agent 在父提交树中可读到路线图与决策，比一般仓库好做，结论限定于"文档齐全的单人仓库"；外部复现须专门选文档不全、模型未见过的仓库，且不是可选项。
- 前置待裁：题面与成题条件；延续式下每步的判据与失败后流的继续方式（重试、回退到上一步、或计失败继续）；三条件中最简 agent 的具体形态；健康度主指标的预先指定；第二版记忆机制在延续式里的最小形态；预算、噪声估计与总耗时；环境（容器内持久工作区、断网、清理未来引用）。

- 修订（2026-09-22）：第二版记忆（结构记忆，见 123 与后续条目）先做完再跑一致性实验；实验条件由三个改为四个——完整 Pigeon、去掉验证门与回退、去掉记忆、最简 agent——使记忆的贡献从第一轮起即可单独拆出。harness 加强一致性的手段盘点：已建的有验证门（071）、快照与失败重试（078、079）、围栏、会话搜索（038）、账本与回执；缺的是把验证门与回退串成"不干净不落地"的流控制（验证现只记结论、不拦改动），此为实验前置之一。结构记忆对一致性的贡献以"改 A 须连带改 B"一类的共变与惯例为主，"东西在哪"一类主要影响成本；在本仓库多数惯例已被机检覆盖，记忆的作用预计更多体现为减少回退次数而非改变最终健康度，此预期作为可检验的假设记录。
- 修订（2026-09-22，补记）：已知难点中接口绑定的处理由 127 改变：题面从"只给应通过的测试名单"改为给出该提交新增或修改的测试文件全文。改动由设计侧在记录 127 之前提出，理由是主张已改为一致性、不再需要对规格保密，而只给测试名会让新增接口无从猜测、失败沿后续依赖连锁、污染整条曲线；项目负责人同日认可。
- 更正（2026-09-22）：标题"三条件"后补注"（修订后为四个条件，见修订行）"。已知难点原写"处理：题面给出应通过的测试名单以传递接口信息，使 agent 向既定接口收敛"，应为给出测试文件全文，依据同日稍后裁定的 127；本条此后补修订时未同步这一处。
- 更正（2026-09-22）：已知难点原写"ChainSWE 链长止于 3 步即因此"，把接口绑定写成了已知原因，应为：调研对 3 步上限的原因只给出推测，推测的原因是相邻补丁难以干净叠加，依据现成基准调研的回报；归因于接口绑定是设计侧当时的判断。
- 修订（2026-09-22）：记忆的贡献改由两层评测回答（138）：定点对照为记忆的主判据；本条的四条件整流实验照常进行，报告整体一致性。
- 修订（2026-09-22）：71 题并非一条连续的链——它们是 105 次提交中筛出的题，中间夹着 34 次非题提交，连续的题段最长 14 题、中位 3 题。延续式实验改为两条延续流（141）：大搬迁之前 53 题、之后 17 题，非题提交按 141 的规则处理，M5 以后大提交区中的 1 题放弃。
- 修订（2026-09-22）：健康度的主指标定为全量测试通过率，见 145；本条所列其余指标降为次要。
- 修订（2026-09-22）：本条限定中"仓库带着完整设计记录、比一般仓库好做"对两条延续流不成立：设计文档在历史整理时从全部历史中移除、最后以一次提交统一加回，两条流起点处的仓库只有代码与配置，见 148。
- 修订（2026-09-22）：测试床改为外部仓库（149）；本条及 141 中关于本仓库 71 题与两条流的事实仅描述本仓库。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。
### 127 提交流成题：题面为提交信息加该提交新增或修改的测试文件全文；成题条件为测试改动打到父提交上失败、打到提交本身上通过；逾 20 文件的提交排除；红测试对合并为一题（设计）

- 结论：从连续提交流成题全部按机械规则，不由人判断"这算不算真任务"。题面 = 该次提交的信息（人写的主题与正文）+ 该提交新增或修改的测试文件全文；判据 = 这些测试通过，且全套既有测试与机检（分层规则、类型检查、lint）不回归。成题条件 = 该提交的测试改动打到父提交上会失败、打到提交本身上通过（纯重构与补测试自动出局）。逾 20 个文件的提交排除、不拆分。故意先提红测试再于下一提交修复的相邻对合并为一题。agent 不得修改判分用的测试文件（围栏已有），测试文件始终为人的版本、由 harness 按步覆盖。
- 理由：测试是行为规格而非实现，给全文即让 agent 按本仓库自身的测试先行流程工作。在延续式下这一条同时消解接口绑定难题：71 题多为"新增"，新增测试调用的是新函数名与新模块，只给测试名则 agent 无从猜测、会在该步失败并连锁到后续依赖该接口的题——那是猜名字失败而非一致性失败，会污染整条曲线；给出测试全文后 agent 按测试要求的接口实现，逐步对齐。主张已改为长时程一致性（126），不再需要对规格保密。父提交失败规则沿 Defects4J、SWE-bench、SWE-Next 一脉；红测试对合并沿 AtomicCommitBench 的连续段定义。
- 修订（2026-09-22）：题与题之间的非题提交如何进入延续式实验，见 141；本条的成题规则不变。
- 修订（2026-09-22）：外部仓库上"逾 20 文件排除"改为只数源文件，见 153；本仓库提交流仍按全部文件计。
- 详情：测试床事实见 126；裁决过程见 docs/decisions/stream-memory-decisions.md（本地）。

### 128 账本剪去无读者与重复的记录，删除 M3 旧账本一次性转换（设计）

- 结论：按账本全量盘点（35 种记录分 8 族，逐族核对写入方、读取方与依赖它的功能），剪去四种记录与一段旧代码。① 提炼跳过记录：三处写入均不带 Run 编号，trace 与 replay 都不显示，物化结果无人使用，停写。② 放权升格与配置移除两种留痕：同样不带 Run 编号、没有可达的读取方，规则来源已由放权配置文件承载，停写。③ 候选筛查记录：与紧挨其前写入的候选提出记录内嵌的扫描结果（扫描器版本与命中项）逐字重复，停写；扫描拒绝与已筛查两种状态改由候选提出记录内嵌的扫描结果现算。④ M3 旧账本一次性转换：删除转换模块与旧账本读取模块，启动不再检测旧账本，机检规则里对它的引用一并移除。四种退役记录在读路径上按退役种类跳过、不视为日志损坏，旧会话文件不改写；Event Log 版本随 schema 收窄推进一版（13 升 14）。这两处落地方式由设计侧提出并说明可改，项目负责人未单独表态。
- 理由：这四种记录写入后没有功能读取，或与另一条记录逐字重复，保留只增加 schema、迁移与测试负担。账本主体没有其他来源可以替代，原样保留：续跑与对账所需的意图、回执、对账结论与会话放权，以及成败标签、候选状态、回放计划、worker 与分支的续跑范围；验证不过即回炉的流程同样依赖验证记录、成败标签与快照。剪去部分不到账本相关代码（生产代码约 7,300 行、测试约 8,400 行）的一成，目的是去掉没有消费者的记录，而不是降低账本的复杂度。
- 取代：018 全部；019 中升格与移除留痕部分；065 中候选筛查一族；074 修订中提炼跳过记录部分；039 修订中"原样保留，不拆"的口径。
- 锚点：src/state/event-log.ts、src/persistence/event-log.ts、src/state/candidate-status.ts、src/application/grants.ts、src/review/candidates.ts、src/distillation/candidates.ts、src/application/workspace.ts。
- 更正（2026-09-22）：结论原把"读路径按退役种类跳过、旧会话文件不改写"与"Event Log 版本推进一版"写得如同裁决内容，应注明这两处落地方式由设计侧提出并告知可改、项目负责人未单独表态，依据：项目负责人裁决的只是"剪不剪"这一件。
- 修订（2026-09-22）：M3 旧账本读取模块一并删除：src/persistence/ledger.ts 与其测试、统一出口中的再导出、迁移完整性测试中的两条旧账本登记，以及引用已删类、早已无法运行的对账探针脚本与探针说明中的对应一行。仓库不再保留读取 M3 旧账本格式的代码，需要时从版本历史取回。理由：旧账本一次性转换删除后，该模块在生产代码中已无调用方，保留只剩测试与登记的维护负担；收据迁移链仍由事件日志使用，覆盖不受影响。
- 修订（2026-09-22）：候选状态枚举删去四个没有任何产生方的值：Proposed（本条之后不可达），以及 M6 之前遗留的 EvidenceChecked、ValidationFailed、AwaitingApproval。原注释以"历史值可读"为由保留后三者，但候选状态从不入盘、一律由账本现算；唯一存过状态字段的 v1 候选在迁移时丢弃状态且不做校验，删值不影响任何旧数据的读取。两处状态显示文字与 ROADMAP §4 的候选状态机同步更新。理由：永远不会出现的状态让每个按状态分情况处理的地方都要顾及它们，并误导读代码的人。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 129 记忆系统重做的范围：人写层保留且独立，新建程序产出的结构化记忆层，不写入人写层、不走候选审批（设计）

- 结论：记忆系统重做。人写层保留：用户级偏好文件、项目 .pigeon/memory 下的 markdown 与 Skill 由人维护，照旧在会话开始注入。另建一层结构化记忆，内容由程序产出；它与人写层分开存放、分开注入、各自计预算，不写入人写层，也不经候选、回放验证与人工审批流程。按 122，评测时人写层对所有条件冻结为同一份。现有 Reviewer、提炼器与候选审批、激活链路的去留另行裁决。
- 理由：原生产线（模型读会话写经验，候选经回放验证与人工审批后复制进人写层）在真实数据上失败（123）。逐层看：模型写的散文无法由程序核查真伪与是否过期；按文件名装满预算的投放与当前任务无关；每条都要人工审批的生命周期无法在无人值守的连续工作中自动更新，而由人挑选留下哪条又会混入 122 所禁止的人为引导。人写层承载意图、偏好与惯例，账本与代码推不出；程序产出的一层承载发生过的事实，人不会逐条去写；两者互不替代。调研：主流 coding agent 产品均保留人写指令文件（CLAUDE.md、AGENTS.md、规则文件），并与机器记忆分开存放；以写入时人工审批为核心的机器记忆方案多已撤回或改道（Cursor Memories 移除，Devin Knowledge 并入 Skills）；公开了对照数据的 GitHub Copilot Memory 采用结构化记录、带代码引用、使用时核验、按使用续期，报告有记忆时 PR 合并率 90%、无记忆时 83%。
- 待裁：记哪几类事实；形态与存储；投放时机与挑选；过期与冲突判定；Reviewer、提炼器与候选审批链路的去留；评测方法。
- 修订（2026-09-22）："现有 Reviewer、提炼器与候选审批、激活链路的去留另行裁决"已由 137 裁定：整套退役。
- 路线图同步（2026-09-23）：ROADMAP §1、学习链路图与 §3.4 按本条及 134、135、136、137 改写——学到的东西只来自程序从账本推出的事实，不经暂存与人工审批，每次给出前核验，不能授予工具权限；§3.8 保留，约束将来由模型产出、需要激活判决的经验；§M6 至 §M8 标注退役，§M9 补记 125 至 159 的方向。属既有裁决的同步，不另立编号。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 130 裁决详情文件改回只留本地、不入库；决策索引仍入库（事实）

- 结论：docs/decisions/（每次裁决的事实、选项、权衡与结论详情）不再入库，只在本地维护；已入库的详情文件从版本控制中移除，本地副本保留。决策索引 docs/roadmap/decisions.md 仍入库，是仓库内的裁决记录；索引条目中的"详情"指向本地文件。
- 理由（设计侧记录时的归纳，项目负责人裁决时未陈述理由）：索引已承载每条裁决的结论、理由与代码锚点；详情记录的是逐件摆出的备选与盘问过程，属于过程材料，与 docs/notes 同类，留在本地维护。
- 取代：047 中 docs/decisions 入库的部分。
- 锚点：.gitignore、docs/roadmap/README.md（文档目录规范表）。
- 修订（2026-09-22，补记）：同日后续裁决两点：已推送的历史保持原样，不重写历史、不重建仓库，历史提交中已入库的详情文件仍可见；095 至 130 的详情在本地补写。
- 更正（2026-09-22）：理由原写作裁决理由，应注明为设计侧记录时的归纳，依据：裁决时未摆出其他选项，项目负责人也未陈述理由。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 131 新记忆层只记两类摩擦事实：回归与约束的红转绿、被撤回的尝试；工具报错与每步改动摘要不记（设计）

- 结论：结构化记忆层（129）的内容只取两类由验证门机械判定、且在代码与版本历史中看不到的事实。① 回归与约束的红转绿：验证门在题面测试以外的检查项上变红（既有测试失败、类型检查、分层规则、格式），经回炉修正后变绿；记红在哪一项、报错指纹、变红时已改动的文件、回炉时补改的文件。题面测试本身未通过属正常工作进程，不记。② 被撤回的尝试：一步回炉到上限仍红而整步撤回；记尝试改动的文件与最终卡住的检查项。不记工具报错与围栏拒绝，也不记每步改动摘要。读过哪些文件不作为记忆内容，留作投放挑选的学习材料。
- 理由：只记"摩擦"，即吃过亏才知道、代码与版本历史中看不到的东西。工具报错与围栏拒绝属于环境问题，应修提示或工具本身，入记忆会反复注入同一内容；每步改动摘要与版本历史重复。调研：omp 的一种记忆后端只收出过回归、代码看不出的约束与被反复纠正的内容，一次性决定不记；研究证据显示写入把关是最稳的杠杆，内容体量造成的指令污染是记忆失效的主要原因，注入越多效果越差。两类事实均由验证门与回炉流程机械产生，不经模型总结。按人的提交估计，本仓库 71 题的提交流只会产生十几到几十条，少而准是有意为之。
- 依赖：两类事实都产生于回炉流程（验证不过即把报错发回同一会话修正，到上限则整步撤回），回炉须先于记忆落地。
- 待裁（129 其余）：形态与存储；投放时机与挑选；过期与冲突判定；Reviewer、提炼器与候选审批链路的去留；评测方法。
- 修订（2026-09-24）：落地细则。① 题面测试取三类文件的并集：本步改动的文件、开工时已在工作区的文件（含跑批器预置的人写测试）、题面文字直接点名的测试文件（事后改名仍算）；其中的失败按正常工作处理、不记。② 判不清即不记：步骤类型认不出且输出无法解析、失败清单不全（收集中断、提前停止、超出条数上限）时，只认整步通过为修好；取不到工作区或开工时的基线时，该会话测试步的红转绿不记、结果不进缓存；被撤回的尝试照记。③ 挑选时同一报错指纹只给一条，跨种类亦然，优先给带修法的红转绿（135）。④ 用前核验时，报错里的名字在报错所在的文件中查找，不论记忆从哪个锚点被挑出（136）。⑤ 定点对照的固定挑选成文超出篇幅预算即报错，不静默截断；留痕只记实际给出的条目（157）。理由：均为原裁决意图的落实，原则是宁可少记、不可记错。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 132 结构化记忆从账本派生、不单独存，配可删可重建的增量缓存（设计）

- 结论：结构化记忆层（129、131）不设独立的记忆存储，记忆是账本事实的跨会话视图，由程序从账本现算。为读取速度配一份缓存，按会话文件是否变动增量更新；缓存可随时删除，删除后从账本重建，缓存内容与账本不一致时以账本为准。不新增账本记录族。人写的 md 层不受本条影响。
- 理由：事实只有账本一处来源，不会出现记忆与账本对不上的情况；"什么算摩擦"与门槛划法在研究过程中会反复调整，派生方式下改了提取规则重算一遍即对全部历史生效，单独存储则每次调整都要迁移或重建旧文件；与现有做法一致（候选状态由账本现算，065；会话树是可重建的缓存；派生不落库，015）。未选的方案是回炉结束时把事实写入独立记忆文件：读取快，但形成第二套事实源，崩溃或出错时可能与账本不一致。往账本新增"知识记录"族此前已被否决。调研：Copilot、Codex、Letta 均单独存储，但它们没有事件账本；从账本派生是 Pigeon 特有的做法，也对应账本优先给学习闭环消费的方向（039 修订）。
- 代价：现有各视图每次重读全部会话文件，没有索引与缓存；本条的增量缓存是新增工作量。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 133 结构化记忆挂在文件上，报错自带的名字作为附带文字，不解析代码（设计）

- 结论：每条结构化记忆的锚点是文件路径（文件改名经版本历史追踪）。报错指纹里本来就带的函数名、测试名、分层规则名作为附带文字随事实存下，用来补充精度并为过期判定提供线索；不解析代码，不把事实挂到函数或类上，也不挂行号。
- 理由：外部复现是必做的（125），下一个仓库很可能是其他语言，挂到函数或类需要每种语言一个解析器；投放挑选所依据的信号本身是文件级的（前 5 题碰过的文件命中约七成，任务要碰哪些文件也只能在文件级预测）；行号在延续式工作中每一步都会漂移，Copilot 挂"文件加行号"是因为它在使用时让模型读引用核验，而本项目要由程序判过期；报错自带的名字不必解析即可取得，其是否仍在文件中可用文本查找确认。未选的方案：挂到函数或类，精度更高、函数改名会断、每种语言要解析器；挂到文件加行号，写入时最细、代码一改即失效。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 134 结构化记忆在开局与回炉时由程序推送，不做查询工具（设计）

- 结论：结构化记忆只在两个时机由程序推送给模型。开局：拼进系统提示，随注入快照冻结并记入 run.started，设严格门槛，允许一条都不给。回炉：验证不过、报错作为新一轮输入发回同一会话时，把匹配的记忆附在报错之后。不提供由模型自行决定调用的记忆查询工具。挑选方法另行裁决。
- 理由：开局推送能在变红之前提醒，省一轮回炉，风险是开局尚不知 agent 会碰哪些文件，故须设门槛；回炉时按真实报错与涉及文件匹配，最准，作用是修得更快、按上次修对的方式修。查询工具的证据最弱：让 agent 自主检索历史，研究中一组结果分数未涨、成本上升，检索摘要的一组分数下降；在对照实验里模型是否调用工具本身成为变量，记忆组实际接触了多少记忆随模型选择波动。两处都由程序推送，记忆组接触了哪些记忆是确定的、可从账本查到，也为按使用续期提供可靠数据。会话中途插话的通道当前不存在，不在考虑之列。未选：三处都用；只在回炉时；只在开局。查询工具待数据显示需要时再议。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 135 开局只按题面直接指到的文件挑记忆，最多 2 条、允许不给；学习式挑选留作以后研究（设计）

- 结论：开局挑选只用题面直接指到的文件：题面所附测试文件 import 的源文件，以及题面文字中写出的路径；取挂在这些文件上的记忆，最多 2 条，没有指到任何文件或指到的文件上没有记忆时一条都不给。回炉时的匹配随本件一并提出、项目负责人未提异议：报错指纹（同一检查项、同一错误码或测试名、同一文件）对上的优先，其次是挂在本次报错涉及文件上的记忆，最多 2 条。从账本学习"这类题面要碰哪些文件"的挑选方式留作以后在日常使用场景下单独研究，所需数据账本中一直保留。
- 理由：研究显示记忆的瓶颈在选对，给对的摘要显著提分、让 agent 自行检索摘要反而降分，注入 1 条最好、2 条与 4 条依次变差，故先用最确定的信号并压低条数。本仓库 71 题上，题面测试直接 import 的源文件覆盖 71% 的目标文件；前 5 题碰过的文件覆盖 69% 但一次给出约 9 个文件、只有 13% 真会改；题面相似的旧题碰过的文件覆盖 60%、23% 真会改。未选：加入近期碰过的文件，违背少而准；语义检索，记忆内容是文件名与报错而题面是需求，两者文字相似度弱，且要引入向量模型依赖；学习式挑选，需还原含大量探索噪声的读改标注、统一容器与工作树的路径、在独立的流上调参后冻结以免人替系统挑参数，流初期冷启动无信号，且在实验中边际收益小——题面已指到多数目标文件，而"忘了同步改"一类记忆的触发点通常就是被指到的主文件。限定：实验题面给全测试文件，本方式在实验中表现会好；日常使用中题面未必写到文件，开局常常不给，依靠回炉时补上。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 136 结构化记忆使用前由程序核验，不过即不给；不按使用时间淘汰（设计）

- 结论：每次挑选之后、给出之前，程序对每条记忆做两项核验：锚点文件仍存在（改名经版本历史追踪）；报错指纹里附带的函数名或测试名仍能在该文件中以文本找到。任一不过即不给。事发以来锚点文件的改动幅度只用于排序，改得越少越靠前。不按"多久没被用到"淘汰。记忆记的是事实而非规则，不存在逻辑冲突：新的在前；同一文件、同一指纹的多条合并为一条，并附"同类出现过 N 次"。
- 理由：代码有没有变才是记忆是否仍成立的证据；Copilot 按使用时间删除（28 天未用），是因为它不直接对照代码，本项目能直接查代码。一个文件多步无人碰，其上的记忆在再次被碰时依然成立；挑选按文件、最多 2 条，用不上的记忆不会被挑出，不删也不造成上下文污染。未选：只查文件是否存在，太粗，文件在不代表那段代码仍是当时的样子；让模型读记忆与当前代码判断是否成立，违背由程序判过期的原则（129）；在核验之外再加按使用时间淘汰，理由同上。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 137 第一版学习闭环整套退役；删除范围先盘点、待评测方法定后施工（设计）

- 结论：第一版学习闭环整套退役：Reviewer（运行中审阅会话提出候选）、提炼器（成败对比提出候选）、候选暂存与安全扫描、回放验证、审批命令与激活（复制进人写层），以及配套的待审提示与启动时漂移告警。账本中的候选相关记录照 128 的办法退役：读取时跳过、不改写旧文件。人写的 md 层与 Skill 不受影响，由人维护、照旧注入。本条只定方向：施工前须先做一次代码盘点，划清归属于这一套的代码与被他处借用的部分（例如 SWE-bench 复核命令借用了回放验证的部分机制）；并须等评测方法（129 待裁的最后一件）定下，因评测可能复用回放验证"同一题带与不带某样东西各跑几遍"的机制。盘点与评测方法定后另行确定删除范围，届时逐条在受影响的旧条目下补"已由 137 取代"。
- 连带：跨进程全局上限随之作废（095 修订）；trace 在候选审批后状态不更新的缺陷不再修复。
- 理由：这一套在真实数据上没有产出过一条通过验证并生效的经验（123 所列失败模式：为噪声编造因果、把答案写成经验、同材料多次提炼结果不稳、引用不存在的内容）；129 至 136 定下的结构化记忆由程序从账本取事实、不经模型总结与审批，完全绕开这一套。按文件名粗估约 5,400 行生产代码与 6,500 行测试，约占全仓六分之一，未计命令行与界面接线。未选：冻结——关自动触发、保留命令、不再加功能与修缺陷，代价是大块代码继续留在仓库、每次改账本与格式都要带着它；保留生产线、产出只给人参考——第一版产出质量本身不行，给人看同样误导。代码在版本历史中可随时取回。
- 修订（2026-09-22）：回放验证的执行机制（从某一步的快照出发、带与不带某样东西各重跑若干遍并判定）保留，改作记忆评测的定点对照工具（138）；退役的是候选专属的部分。
- 修订（2026-09-23）：此前修订所说"回放验证的执行机制保留、改作定点对照工具"，落地为保留其一致性核对（模型、预算、工具不得比原尝试更宽），执行改由跑批器的单步重跑承担；旧回放执行体（本地工作树、验证者角色、与候选的耦合）随第一版退役，见 156。
- 修订（2026-09-23）：退役范围的四项推论见 158。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 138 记忆评测分两层：定点对照为主判据，四条件整流实验报整体一致性；回放执行机制保留（设计）

- 结论：第一层定点对照，为记忆有无作用的主判据：先让"去掉记忆"条件跑完整条流；由程序找出记忆本可发挥作用的步骤——此前出现过的报错指纹在该步又出现，且按 135 的挑法该步本能挑到那条记忆；从该步开始时的快照出发，带与不带那条记忆各重跑若干遍，比较再次变红的比例与回炉轮数。第二层整流对照，即 126 的四条件延续式实验，照常进行并报告健康度曲线，回答记忆与验证门、回炉合起来之后的整体一致性。回放验证的执行机制保留，改作定点对照的工具（137 修订）。事件的具体取法、重跑次数、是否设校准组与预算另行裁决。
- 理由：延续式下两条件的代码很快分岔，第 10 步时面对的已是两个不同的仓库，整流比较中的差别无法归因于记忆还是此前某步走岔；且此前测量显示记忆对最终健康度的影响预计很小，整流比较多半淹没在噪声里。定点对照同起点、同一题、唯一差别是给不给那条记忆，最直接回答"记忆有没有让它不再犯同样的错"，也是"从运行历史学习"（039）最直接的检验。未选：只做整流对照，记忆的作用多半测不出；只做定点对照，回答不了 126 的整体一致性主张。代价：须保留回放执行机制；一条流上的可用事件可能只有个位数到十几个，统计把握取决于事件数。
- 修订（2026-09-22）：定点对照改在本仓库的提交流上进行（151）：事件取自本仓库两条延续流中"去掉记忆"条件的一遍跑；四条件整流实验在外部仓库上进行。
- 修订（2026-09-23）：定点对照的执行体为跑批器的单步重跑，见 156。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 139 定点对照：本能挑到记忆的全部步骤，三组各重跑 5 遍，主判据为配对的变红比例差（设计）

- 结论：事件取"去掉记忆"条件整流跑中，按 135 的挑法本能挑到某条记忆的全部步骤，不论该步在无记忆流中是否再次变红。每个事件从该步起点快照出发分三组重跑：带那条记忆；不带；带一条无关记忆（取自其他文件的真实记忆，格式与长度相同）。每组 5 遍，沿用回放验证的缺省次数。预先指定的判据：主判据为带记忆与不带相比的变红比例差，按事件配对；次要指标为回炉轮数、记忆帮倒忙的事件数、记忆是否被用上（agent 在验证前是否改了记忆提到的补改文件，由程序查得）。事件在重跑之前由程序按规则确定。
- 理由：只取"又红了"的步骤只能看到帮忙、看不到帮倒忙，而研究显示连验证过的经验也会在本可做对的题上拉低结果；带无关记忆的一组用于区分起作用的是记忆内容还是多出的一段文字。同起点重跑本身有波动（同题两轮约 14% 翻转），每组 5 遍在 10 到 20 个事件上约可分辨 15 到 20 个百分点以上的变红比例差；每组 3 遍只能分辨约 25 个百分点以上，而记忆的预期作用不大，省下的两三个小时相对整流一层（一条流约 12 到 24 小时）占比小，却很可能得不出结论。未选：只取又红了的步骤、两组各 5 遍；同 A 但每组 3 遍。粗估 150 到 300 遍重跑，每遍约 10 分钟、6 路并行约 4 到 8 小时；缩短时间优先提高并行度而非减少遍数。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 140 整流实验四条件各先跑 1 遍，按预先写死的门槛补跑到 3 遍（设计）

- 结论：126 的四条件（完整 Pigeon、去掉验证门与回退、去掉记忆、最简 agent）各先跑 1 遍整条流。任意两条件之间健康度终值的差距不足以与运气区分的，这两个条件各补跑到 3 遍；"足以区分"的门槛在开跑前与其他主指标一并预先写死，不得看了结果再定。定点对照（138、139）取用"去掉记忆"条件第一遍的步骤，第一遍跑完即可开始，不等补跑。并行度暂按 M9 实测可稳定运行的 4 路估算，以所用套餐的官方限额为准再调整。
- 理由：一条流只有一条轨迹，中途一次撤回即可引发连锁，只跑一遍的差别可能是运气；但大的差别（例如最简 agent 一路崩坏而 Pigeon 保持健康）一遍即可看见，不必一开始就付三倍时间。墙钟时间是稀缺资源，按规则补跑只在分不清的对比上多花时间。补跑规则须预先写死，否则等于看结果挑数据。按 4 路并行，一遍约 12 到 24 小时，补跑时再加 24 到 48 小时。未选：每条件一次跑 2 遍，约 24 到 48 小时；一次跑 3 遍，约 36 到 72 小时。
- 修订（2026-09-22）：补跑门槛定为全量测试通过率终点差距小于 10 个百分点，见 146。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 141 提交流中的非题提交按类型处理，形成两条延续流（设计）

- 结论：延续式实验按历史顺序推进，题与题之间的非题提交由程序按改动内容分类处理，规则在开跑前写死：① 只改测试文件与测试辅助文件（测试用的假模型、夹具等）的，直接套用人的版本，这些文件本就归 harness 管、agent 不许改；② 只有格式变化的（对父提交跑格式化后与该提交无差异），跳过；③ 改了代码但不带测试的（接线、抽取公共函数等），作为"维护步"交给 agent 按提交信息去做，只用验证门判定没有搞坏；④ 中途那次一次移动 51 个文件的分层目录搬迁，在该处把代码重置为人的版本一次，作为两条流的分界。由此形成两条真正延续的流：搬迁之前 53 题、之后 17 题；M5 以后的大提交区中仅有的 1 题放弃。红测试对仍按 127 合并为一题。失败归因在"自己没做好""缺前置"之外新增一类"维护步接口不同"：agent 在维护步中的做法与人不同（例如名字不同），导致后面用到它的题加载失败。
- 理由：71 题是 105 次提交中按规则筛出的题，中间夹着 34 次非题提交（13 次逾 20 文件的大提交，其中 1 次在中途、12 次集中在 M5 以后；21 次 1 到 7 个文件的小提交），连续的题段最长 14 题、中位 3 题。延续式下人在非题提交里写的东西 agent 的仓库里没有，后面的题可能正依赖它们；照搬人的改动又常会冲突——34 次中有 30 次碰到了此前题目改过的文件。未选：每遇非题提交即重置为人的版本、只在段内延续，干净但 18 段中只有两段超过 10 题，长时程基本测不到；非题提交一律套用人的改动、冲突交 agent 合并，最接近团队场景，但冲突多、合并失败的判定是新问题，大搬迁处几乎必然大面积冲突。
- 修订（2026-09-22）：本条"大提交处重置"只适用于本仓库提交流；外部仓库按源代码改动行数处理，见 153。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 142 回炉到上限仍不过即整题撤回，撤回后留空、后续照常，连带失败单列为"缺前置"（设计）

- 结论：延续式实验中，一题回炉到上限仍不通过验证，即把该题改动整体撤回到做题前的快照，该题记为失败，流继续下一题；被撤回题本应新建的文件与名字不补人的版本。后续题因此失败的，单列为"缺前置"，与"自己没做好""维护步接口不同"（141）分开报告；判别由程序完成：测试加载时找不到的，正是被撤回题本应新建的文件或名字。回炉的轮数上限另行确定。
- 理由：近一半的题（前 5 题窗口内 47%，只计新建文件的下限）直接用到前几题新建的文件，一次撤回会连带后续多题。补人的版本会使比较不公平：只有会撤回的条件（完整 Pigeon、去掉记忆）才会被补，不撤回的条件做坏的代码一直留着，等于给会撤回的条件白送人写的代码、成绩中掺入人的功劳，而这正是要比较的变量。撤回后留空使每个条件的代码完全出自 agent，连带失败是真实工作中会发生的后果，照实记录、分类报告。未选：撤回后补人的版本；不撤回、带着坏代码继续——这是"去掉验证门与回退"条件本身的做法，不适用于完整 Pigeon。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 143 回炉上限 3 轮（设计）

- 结论：一题做完验证不过，把报错发回同一会话修正、再验证，记为一轮；最多 3 轮，第 3 轮后仍不过即按 142 整题撤回。该上限在正式开跑前定死，对有回炉的条件（完整 Pigeon、去掉记忆）一视同仁。试跑时记录每题实际用了几轮才通过；若大量题恰在第 3 轮后未过，在正式开跑前带数据复议。
- 理由：轮数太少，本可再修一轮就好的题被撤回并连累后续，拉低一致性曲线却不反映真实能力；轮数太多，每轮都耗 agent 修改与全套检查的时间，且修到后面容易为过检查而放宽类型、删改代码。关于模型自我修复的研究普遍发现收益集中在头一两轮、之后递减。未选：5 轮，撤回更少但耗时更多、乱改风险更大；不设轮数只受单题总预算约束，轮数随题浮动、难以横向比较；1 轮，撤回过多、连锁失败会淹没其他信号。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 144 跑批按限额类型分别处理，额度用完即暂停、续跑时被打断的题作废重做（设计）

- 结论：模型服务返回的"不让用"类错误按类型处理。短时限流（429）：沿用双 key 轮换与退避。额度用完（403，5 小时、每周或每月额度）：整批暂停，等窗口刷新后自动从断点续跑；被打断的那一题整体作废，回到该题开始前的快照重新做，不留任何结果行、不计入成败与回炉轮数。并发受限（403）：先把并行度降一路重试，仍不行则整批暂停，并以去重的标准错误告警提示人来处理。不购买额度加油包。
- 理由：整流实验一跑十几到二十几个小时，现有处理只认短时限流，两种 403 会被当作普通错误记为出错，延续式的流断在半路、数据被污染；而在延续式中补跑不等于重跑一题，其后各题已在"该题出错"的代码上继续。限额是外部原因，不得变成 agent 的成绩，也不得让流断在半路，故被打断的题整题作废重做。未选：维持现状一律记出错、事后补跑；遇任何 403 即整批停下等人，最稳但无人值守时浪费墙钟时间。官方说明中购买加油包可使额度用完时自动改扣余额、不中断，项目负责人决定不买，额度用完即暂停。
- 修订（2026-09-22，实现要求，设计侧提出、项目负责人未提异议）：暂停与续跑由跑批程序自行完成，不需人值守。按 403 文案区分额度种类：5 小时窗口用完即暂停并定时探测；每周额度（仅老套餐）同样探测、等待更久；每月额度用完不探测，直接停下并告警。探测用极小请求（只要求回一个字），间隔由 5 分钟逐步拉长到每 20 至 30 分钟一次；总等待设上限（如 6 小时），超过即停下告警。恢复后从账本找到断点：已完成落地的步骤保留，被打断的步骤回到其开始前的快照整题重做；跑批进程自身中途崩溃或机器重启后同样从账本断点续跑。
- 修订（2026-09-23）：本条的限额处理在延续式实验中由本地模型网关统一实现，见 155。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 145 整流实验主指标为全量测试通过率曲线的终点值（设计）

- 结论：每条流每做完一步，用截至该步人写的全部测试在 agent 的代码上跑一遍，得全量测试通过率，按步数画成健康度曲线；条件之间比较终点值，140 的补跑门槛据此设定。次要指标：回归数（曾经通过、后来又挂的测试）、类型与格式错误及分层违规数、撤回次数、按题通过率（每题测试是否全过，用以抵消测试多的功能权重偏大）、失败归因（没做出来、搞坏了旧功能、缺前置、维护步接口不同）。没有验证门的条件每步同样跑全量测试，但结果只用于测量，不得反馈给 agent。
- 理由：有验证门的条件按构造不会留下回归与静态检查错误——坏了要么修好要么撤回，代价转为撤回多、部分功能缺失；没有验证门的条件相反，功能可能更多但会留下损坏。主指标必须同时计入两头才公平：功能没做出来其测试不过，旧功能被改坏其旧测试也不过。未选：回归数，有验证门的条件按构造为 0，只能说明验证门在工作；每题通过率，只看新功能是否做成、看不到旧东西是否被搞坏。限定：测试覆盖不到的质量问题（重复实现、死代码、风格漂移、功能未接入界面）本指标与验证门同样看不见；多种失败原因混在一个数中，由次要指标拆开；人写的测试依人的做法写成，agent 合理但不同的写法可能不过，题面给测试全文缓解一部分，维护步中的此类情况单列。
- 修订（2026-09-23）：全量通过率的分母为人在该步代码上实际跑出的通过用例，满分即与人持平；人在自己代码上也不过的用例（依赖网络或平台、人留下未修的等）不计入。分母在人一侧确定，agent 的代码上凡未通过者（含因收集错误而未运行的）均计为未通过，不缩小分母。以人在该步代码上收集出的全部用例为分母的一列同时记录，供对照；人在自己代码上时过时不过的用例单独标出。理由：各条件同一步用同一分母，条件间高低两种口径基本一致；人一侧不过的用例数逐步变化，计入分母会使所有条件的曲线出现与 agent 无关的起伏；满分即与人持平，含义清楚，与 SWE-bench 只以参考答案上通过的用例检查回归的做法一致。未选：以人在该步代码上收集出的全部用例为分母，即本条原文字面所指。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 146 补跑门槛为全量测试通过率终点差距 10 个百分点（设计）

- 结论：任意两个条件第一遍的全量测试通过率终点值（145）相差小于 10 个百分点的，这两个条件各补跑到 3 遍。门槛只决定补不补跑；最终结论使用全部已跑的遍数，并连同波动范围一起报告。补跑所得的同条件重跑波动作为实测数据保留，供以后同类实验按实测设门槛。
- 理由：只跑一遍时同一条件重跑的终点波动未知；可参考的只有 M9 同题两次重跑约 14% 的翻转率，延续式中一题的偶然失败还会连累后续，波动被放大，门槛只能事先取保守值。超过 10 个百分点的差距单靠一两题偶然失败很难造成。未选：5 个百分点，补跑少但容易把运气当作差别；15 个百分点，几乎每对都要补跑，接近一开始就每个条件跑 3 遍。
- 修订（2026-09-26）：取消补跑，整流实验的结论只用第一遍。事实：在 strands 流上，四个条件的全量测试通过率一直在 99% 到 100% 之间，任意两个条件的终点差距都远小于 10 个百分点，按原门槛须四个条件全部补跑到 3 遍；模型额度以现有三个账号为上限（其中两个有周额度，已有账号撞上），补跑约相当于再跑两遍整流实验，无法在额度内完成；补跑所得的健康度预期仍在 99% 到 100% 之间，不增加区分信息。代价：同条件重跑的波动未测，报告写明"单遍、重跑波动未测"，次要指标（回归数、静态检查错误数、撤回次数、按题通过率）上的差别不作显著性判断。整条流同条件的重跑波动登记为待测项，在外部复现（125、165）中按届时额度安排测量；测得之前，由机制决定的大差别（如无验证门时静态检查错误的累积）照常报告，几题之差的小差别只报方向、不下结论；单步层面的重跑波动以定点对照不带组的 5 遍重跑作参考。未选：按原门槛补跑（额度不足）；只对部分条件补跑（选哪几个本身会引入偏向）。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 147 各条件每一步同一个总预算，回炉消耗计入其中；数字试跑校准后定死（设计）

- 结论：四个条件每一步使用同一个总预算（对话轮数与墙钟时间），有回炉的条件其回炉轮次消耗从该总额中扣除，最简 agent 拿同样的总额、自行支配（可自行跑测试与修正）。暂按每步 150 轮、30 分钟估算；正式开跑前试跑几步，按实际用量校准一次后定死，正式跑中不再改动。各条件实际消耗的轮数、token 与墙钟时间作为次要指标报告。
- 理由：若回炉的轮数与时间另外追加，有回炉的条件就比最简 agent 多拿算力，成绩更好时无法区分是机制的作用还是算力给得多；总额相同，比出来的才是机制。估算依据：M9 在 SWE-bench 上约五分之一的题用满 100 轮、20 分钟；本仓库的题更小、测试给全，但多了回炉消耗。未选：首轮预算相同、回炉另加，有回炉的条件多拿算力；不设轮数上限只设单步墙钟兜底，每步耗费不稳定、整条流时长难估。
- 修订（2026-09-24）：校准判据定为：以"完整 Pigeon"条件（带回炉，消耗最大）在 strands 两条流的开头试跑 8 至 10 步（覆盖题与维护步），试跑时预算放宽，使消耗不被截断；取每步实际用掉的轮数与墙钟各自的第 90 百分位，乘以 1.5，且不低于 150 轮与 30 分钟，作为四个条件每步的同一预算；试跑步不计入正式结果。理由：预算须对四个条件一视同仁，按最耗的条件定，有回炉的条件不会被预算卡住；第 90 百分位加一半余量，兼顾少数难步与总墙钟。未选：四个条件各试跑几步取最大值，更稳妥但试跑时间约多一倍；不校准、维持 150 轮与 30 分钟，最快但回炉可能频繁撞墙钟上限。
- 校准结果（2026-09-24，事实）：以"完整 Pigeon"在 strands 两条流开头试跑 10 步（s1 的 6 道题与 1 个维护步、s2 的 3 道题），全部完成、无一撞上限；轮数第 90 百分位 82、墙钟第 90 百分位 30.4 分钟（含验证门），按判据定为每步 150 轮、46 分钟。10 步中仅 1 步回炉一轮，多轮回炉的样本很少，正式跑中回炉频繁时可能较紧，按 147 回炉消耗计入同一预算。
- 校准结果更新（2026-09-24，事实）：正式实验改在云服务器（16 vCPU、AMD EPYC）上运行，按同一判据在服务器上重新校准：同一组 10 步全部完成、无一撞上限，轮数第 90 百分位 78、墙钟第 90 百分位 14.3 分钟，定为每步 150 轮、30 分钟（均为下限起作用），取代此前在本地机器上得出的 46 分钟。服务器上同样的步约用本地一半的时间，验证门单次约 2 分钟。多轮回炉的样本仍很少。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 148 延续式实验环境；落地的步骤提交进 git 历史（设计）

- 结论：每条流一个容器，沿用 M9 的容器设施（098），断网（104）。起点为人在该流起点那次提交的代码，历史清理到只剩当前、看不到未来提交（同 109 的做法）。依赖预装历史上最全的一份（断网后无法安装，已核实对全部提交可用）。每一步由程序把该步人写的测试文件覆盖进工作区，agent 不能改（127）。验证门使用仓库自身的检查命令，该命令在整段历史中未变（格式、类型、全部测试、分层规则）。全量测试测量（145）在另一份副本中进行，结果不进 agent 的会话。落地的步骤由程序以题面的提交信息提交一次，agent 在后续题中可用 git log 查看自己此前的工作，四个条件相同。
- 理由：前几项多由已有决策确定。提交进 git 历史符合在真实仓库中连续工作的情形；同时它构成结构化记忆必须超越的基线——131 只记 git 里没有的摩擦，给所有条件都提供 git 历史，记忆的作用才须来自 git 历史之外。未选：只保留工作区代码、不留提交历史。事实：两条流起点处的仓库没有设计文档（历史整理时移除、最后统一加回）；105 次提交中改过 package.json 与锁文件的各只有 3 次。
- 修订（2026-09-24）：环境与验证门按人当时的 CI 还原。原结论中"预装最全的一份依赖、已核实对全部提交可用"经实测不成立：人的代码在容器里过不了验证门。改为：容器内以非 root 用户运行测试、验证门与 agent 的命令（root 下有依赖非 root 行为的测试恒失败）；依赖按各环境起始提交的日期解析，只取当时已发布的版本，各提交按依赖声明选用对应的环境（按今天最新版解析时，有包后来改名的接口使人写测试收集失败）；strands 的类型检查在 Python 3.10 的独立 lint 环境中执行，与其 CI 一致；验证门跟随仓库 CI：ruff 只做 check、不做格式检查（格式偏差计入次要指标），pytest 带 --reruns 2 与单条 90 秒超时（signal 方式），超时失败的用例不重跑（带重跑时超时对重跑那次不生效，会一直挂起；这是与仓库 CI 的唯一差别）；本仓库容器调大 Node 的堆上限，使类型检查不因内存耗尽失败。开跑前置检查为人的代码在每个要测的步上都须通过验证门。理由：验证门对人的代码也不过时，有验证门的条件会被平白罚为回炉与撤回，比较失真；还原人当时的环境是使各条件在同一合理环境中比较的前提。未选：去掉验证门中出问题的步骤（改变验证门的构成）；按人的基准剔除恒失败的用例（验证门随提交而变，靠人工维护清单）。
- 补记（2026-09-24，事实）：strands 的 lint 环境（ruff、mypy，Python 3.10）改为按每个要测的提交自己的提交时间解析依赖，去重后共 42 套，验证门按该步人的提交选用；原按各环境起始日期解析时，有 5 个提交的人写代码因 mypy 大版本不同（该区间内 mypy 约束由 <2.0.0 放宽到 <3.0.0，人的 CI 随之装 2.x）而过不了类型检查。按提交解析后，95 个要测提交的人写代码 ruff 与 mypy 全部通过。
- 修订（2026-09-24）：开跑前置检查的例外：人写代码本身即损坏、在原始代码上可复现（不是环境问题）的步，照常保留在流中由 agent 做，在清单与结果行中标记为人的代码过不了验证门，供分析与挑选定点对照事件时识别；agent 不必复现人的写法，写对即可通过验证门。本仓库流中有 3 个这样的步（测试导入不存在的导出、两处类型错误）。未选：改为重置点，用人修好之后的版本（多切出几段流）；跳过这些步（其功能被后续步依赖时出现缺前置）。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 149 延续式实验的主测试床改为更大、更难的外部仓库（设计）

- 结论：延续式实验的主测试床由本仓库的提交流改为一个更大、更难的外部仓库。此前按本仓库定下的规则——成题（127）、非题提交分类处理（141）、撤回后留空（142）、回炉 3 轮（143）、限额处理（144）、全量测试通过率主指标（145）、补跑门槛（146）、同额预算（147）、环境与提交历史（148）——按同一原则套用到新仓库；与仓库相关的事实（产率、连续题段、依赖、检查命令、有无设计文档等）在新仓库上重新测量。选仓标准另行裁决。
- 理由：本仓库的题偏简单：每题源代码改动中位 100 行、四分之三在 228 行以内；题面给出的测试中位 169 行，比要写的代码还长，接近一份详细规格；第一条流起点处源代码仅 282 行、终点约 6,700 行，第二条流终点约 8,300 行；M9 的 8 道自造题 40 次运行全过。四个条件的终点都接近满分、比不出差别的触顶风险高。未选：先试跑、按预先写死的规则决定是否合并步骤加难度；现在就合并步骤；照原设计跑、触顶如实报告。另一加难度办法"题面只给提交信息"会带回接口猜测造成的连锁失败，127 当初即因此改为给测试全文。
- 修订（2026-09-22）：外部仓库承担一致性的四条件整流实验；记忆的定点对照留在本仓库提交流上，见 151。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 150 外部仓库选仓标准（设计）

- 结论：按优先级：① 模型没见过——取 2026 年的提交区间，或不出名的仓库；② 机检齐全——严格的类型检查、代码检查与测试，最好有分层规则，全套测试数分钟内跑完；③ 测试纪律好——大多数提交同时改源代码与测试，成题率高；④ 规模更大——源代码约 2 万到 15 万行，每题改动约 100 到 500 行；⑤ 历史为直线或按合并请求压成单个提交，连续题段长；⑥ 许可证宽松；⑦ 语言为 TypeScript 或 Python，两种都找。候选由调研给出后，取两三个在本地实测成题率与连续题段，再定仓库。
- 理由：①来自 SWE-bench 的教训，知名仓库的答案模型已记住；②是验证门与主指标（每步跑全量测试）的前提；③决定能成多少题，随意选取的仓库在合并请求上的成题率可低至 2%；④是换仓库的目的；⑤决定延续式能否成立。已知取舍：①与③常冲突，测试纪律最好的多是大而知名的项目。TypeScript 可直接沿用现有的成题测量工具；Python 可沿用 M9 的容器设施、严格类型检查的项目多，但各历史提交的依赖环境更难准备。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 151 分工：外部大仓库测一致性，本仓库提交流测记忆（设计）

- 结论：四条件整流实验（126、140、145、146）在外部大仓库上进行，回答验证门与回炉能否让仓库在长期工作中保持健康。记忆的定点对照（138、139）在本仓库的提交流上进行：本仓库两条延续流（141）以"去掉记忆"条件各跑一遍，从中取事件做定点重跑。结论须写明适用范围：本仓库为单人持续开发、前后工作连贯，在此测得的记忆作用只适用于连贯的持续开发，不外推到多人各改各处的仓库。
- 理由：候选调研显示，多人协作的外部仓库中相邻两题碰同一源文件的比例为 3% 到 15%，与随机配对的 3% 到 12% 相当；本仓库为 33%（随机 17%），前 5 题内碰过的文件有 68% 会被再碰到。记忆挂在文件上（133），只有后续题再碰到锚点文件才会被挑出（135），定点对照也只取本能挑到记忆的步骤（139）；局部性弱则记忆几乎没有出场机会，事件太少下不了结论。被触发不等于有用，局部性只决定出场机会，是否有用仍由定点对照判定。同时调研发现，外部仓库同时改源代码与测试且不超过 20 个文件的提交，源代码改动中位只有 30 到 90 行，没有达到 100 到 500 行；外部仓库的难度来自 7 万到 15 万行的规模与陌生代码，而非单步规模。未选：都在外部仓库上测，记忆结果大概率未测出；改选局部性较高的外部仓库（mcp python-sdk 23%、narwhals 26%），但连续段只有 7 到 14 题、候选题 36 到 47 道，长时程测不出。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 152 外部测试床选定 strands-agents/harness-sdk 的 Python 部分（事实）

- 结论：四条件整流实验（151）的外部测试床为 strands-agents/harness-sdk 仓库中的 Python SDK（strands-py，Apache-2.0），窗口为主干 2026-08-18 至 2026-09-10。只取该包的源代码与测试，仓库中的 TypeScript 部分与网站、文档不纳入。openai-agents-js 作为备选；pydantic-ai 排除。
- 事实（本机实测，Windows 原生，与另两路测量并行、计时偏高）：窗口内主干 195 次提交，改 Python 源代码的 96 次，候选 84 次全部测完，成题 79 道（94%）；非题中 3 次父提交上已通过、2 次因整文件在 Windows 上跳过记环境错误，无"提交本身也不过"。每题源代码改动中位 71 行、四分之三位 213 行、最大 1,072 行，源文件中位 2 个；每题父提交加提交本身测试约 36 秒。全套检查：格式检查约 1 秒，类型检查热缓存约 30 秒，全量单测约 3 到 4.5 分钟（6,473 条）。依赖冻结后离线重建 13 秒，逐提交运行无外网请求；窗口内有 4 次依赖变更需要换装 1 到 6 个包。23 道题在父提交上是导入即失败，题面给测试全文（127）即可携带接口名；2 道题需先升级依赖，预装最全依赖可解。超过 20 个文件的提交 13 次：5 次不碰 Python 源代码（网站、文档、CI、Node 版本），7 次源代码改动 42 至 1,363 行且多带大量测试，1 次为 4,792 行的改名重构。
- 理由：成题率最高、流最干净（需作维护步的只有 3 次，巨型提交只有 1 次）；每步检查最轻，而每步要跑一次验证门与一次全量测量，检查耗时乘以步数直接决定墙钟时间；断网最容易；名气最小（约 7.6k 星）、窗口在 2026 年 8 至 9 月，模型见过的可能性最低。代价：源代码约 6.9 万行，约为另两候选的一半，仍为本仓库的 8 倍以上；需绕开仓库中的 TypeScript 部分。未选：openai-agents-js（约 14.5 万行、成题率约 88%、每题中位 71 行，但每步全套检查约 6 到 8 分钟、离线需缓存各锁文件版本的依赖、窗口内 22 次大提交需重置 5 次才能得到 88 步的最长段）；pydantic-ai（约 14.9 万行、2 万星、每题中位 33 行、全量测试 9,600 余条本机未能跑完、依赖 Temporal 服务与模型下载、39 道题中 12 道靠输出快照判定，噪声大）。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 153 外部仓库上大提交按源代码改动行数处理，超过 3,000 行才重置（设计）

- 结论：外部仓库（152）的延续流中，非题提交与大提交按以下规则处理，开跑前写死：只有源代码改动超过 3,000 行的提交处把代码重置为人的版本，作为段的分界；其余超过 20 个文件的提交，带题测试且源文件不超过 20 个的当题做（原"逾 20 文件排除"改为只数源文件），不带测试的当维护步交 agent 做、只用验证门判；不碰被测包源代码的提交（网站、文档、CI、其他语言部分）跳过。141 的其余规则（测试类套用人的版本、纯格式跳过、维护步只用验证门判）照常适用。strands 窗口中据此只在 4,792 行的改名重构处重置一次，形成 55 步与 35 步两段。此前被"逾 20 文件"排除、未测成题率的 7 次提交，在搭建该流时一并测定。
- 理由：141 的"逾 20 文件即重置"依据本仓库的情况——大提交是整块里程碑；外部仓库的大提交多为普通改动加大量测试或文档（strands 13 次中 5 次不碰 Python 源代码、7 次源代码改动 42 至 1,363 行），照原规则需重置 8 次、流被切成十余段、最长 18 到 25 步，长时程测不出。门槛 3,000 行为经验值，在 strands 上只卡住那次改名重构，取 1,500 行结果相同。未选：从不重置、改名重构也交 agent 做，得一条 91 步的流，但做不好即撤回，后续几乎所有题都要用到改过的名字，会全线连锁失败；保持原规则，流碎成十余段。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 154 回炉落地的三处口径（设计）

- 结论：① 账本中"这一步是否撤回"的推断：回炉开启、且这一步最后一次验证结论为失败，即推断为已撤回，不区分轮数用满还是预算耗尽；撤回原因只在结果行上现场标注，账本不负责推出原因。② 回炉本次只支持本地 git 工作区；开启回炉而没有可用快照时启动即报错并说明原因。容器执行端的"回到这一步起点"能力另立项、紧随回炉之后做：在执行端接口上加这一个能力，容器内用 git 实现（每步开始时记下当前提交，撤回时恢复到该提交），不迁移整套快照与分叉。③ 撤回后"逐字一致"的范围为快照覆盖的范围：受跟踪的文件，加未跟踪且未被忽略的文件；被 .gitignore 排除的文件与治理目录不在范围内。
- 理由：① 原推断规则以撞上限记录证明预算耗尽，但轮次恰在最后一轮自然收尾（按 072 修订不写撞上限记录）与墙钟耗在 Run 之外的验证上两种情况都不留该记录，会推出"未撤回"而工作区已恢复；开启回炉后以失败收尾只有轮数用满与预算耗尽两条路，二者都撤回，故放宽后推断必然正确。未选：按账本时间戳冷算预算，与运行时计时器在边界上可能不一致。② 容器执行时宿主侧工作区只是占位目录、不是 git 仓库，快照机制直接跳过；快照与分叉尚未迁到执行端接口（098 所定）。延续式实验（148）在容器中进行，回炉只需要"回到这一步起点"一个能力，不必搬整套快照。未选：本次顺带把快照迁到容器执行端，改动大。③ 快照不含被忽略的文件；依赖目录（node_modules、Python 虚拟环境）本身被忽略，撤回若连被忽略的文件一并清除会删掉已装好的依赖。
- 施工基线：回炉施工以 ledger-prune 分支的 aaa59a8 为基线（与合并剪边角后的 main 代码相同），不等 main 合并；剪边角补修的核查与之并行，查出问题则修复加在 ledger-prune 上、回炉变基。
- 修订（2026-09-23）：① 的推断收紧为"回炉开启，且这一步最后一个 Run 有验证记录、结论为失败"即已撤回。原表述在"某轮回炉 Run 结束之后、其验证落盘之前进程崩溃"时，会以上一轮的失败验证推出"已撤回"，而这一步实际未收尾、工作区未恢复；收紧后正常收尾的步骤结论不变，最后一个 Run 无验证记录即视为这一步未收尾、推为未撤回，续跑时由跑批器整步重做。成败标签不受影响（最后一个 Run 无运行结束记录或无验证时现算为未知）。未选：维持原表述、在审计中列为已知限制。
- 修订（2026-09-23）：收紧后仍存的残余窗口接受为已知限制，见 160。
- 修订（2026-09-23）：③ 补充撤回时删除集的判定依据。每一步开工打快照时，另记一份当时已被忽略的路径清单（按目录折叠列出，如依赖目录、虚拟环境、本地环境文件），与快照一起持久保存；撤回时先写回目标树，再删除不在目标树中的其余路径，但开工时已被忽略的路径及其下的一切、包含这类路径的目录本身与治理目录一律不动；agent 新建的路径不论是否被忽略（缓存、构建产物、自带忽略规则的目录）都删除。即开工前就有的一概不动，agent 新弄出来的一概清掉。"逐字一致"的范围不变；开工时已被忽略的内容若在这一步里被改动或删除，不在恢复范围内。理由：快照不含被忽略的文件，程序无从区分被忽略的东西是开工前就有还是 agent 新建；此前几轮修复各以一种推断替代这一信息，先后出现误删依赖目录、误删起点前就有的嵌套仓库、误删自带忽略规则的虚拟环境等问题；开工时记下忽略清单，补上所缺的信息，删除规则不再依赖推断。未选：退回只删未被忽略的新文件，agent 新建的缓存与构建产物留在工作区，且 agent 删去一份本身被忽略的忽略规则文件时，其原本护着的文件仍可能被误删；继续逐案修补（把本身被忽略的忽略规则文件强行收进快照），仍依赖推断。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 155 延续式实验的模型请求一律经跑批进程内置的本地网关（设计）

- 结论：跑批进程内置一个本地模型网关，只监听本机回环地址，说 Anthropic Messages 协议，由跑批进程自行起停。四个条件的模型请求都经网关：Pigeon 各条件把模型接入的地址指向网关，最简 agent（mini-swe-agent）把其模型库的接口地址指向网关。每个作业用独立的路径前缀，网关据此把用量与中断归到作业上。真正的 key 只在网关里注入，agent 进程与容器都拿不到。144 的限额处理全部在网关实现：429 用双 key 轮换加共享退避，这段逻辑从探针脚本提升进正式代码、只留一份；403 按文案区分 5 小时、每周、每月额度，命中后通知跑批的限额控制器，在途的步骤整题作废、中断 agent、回到该步起点，整批暂停并探测，每月额度直接停下告警；403 并发受限先降一路并行，不行再暂停告警。每步的轮数、token 与请求数由网关按作业计量，最简 agent 的步数上限设为同一轮数，墙钟由跑批器统一计时、到时中断。流式响应的错误在响应头阶段分类，中途断流的错误原样透传，由 agent 侧按失败处理。现有 M9 的 SWE-bench 跑批仍用探针脚本的轮换，本次不改。
- 理由：Pigeon 与最简 agent 调模型的路子不同，若只让最简 agent 经网关、Pigeon 照旧在进程内轮换，限额状态分在两处，整批暂停与降并行要跨两处协调，与 096 的"同一能力只走一套接口"相悖；四个条件都经网关则限额处理只有一条路径。更关键的是用量在同一处计量：147 要求各条件每步预算对等，同一处计量才能拿出对等的证据。代价是 Pigeon 的请求多一跳本机转发，可以忽略。未选：只有最简 agent 经网关、两边共用错误分类模块。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 156 定点对照做成跑批器的单步重跑，旧回放执行体随第一版退役（设计）

- 结论：定点对照（138、139）由跑批器的"单步重跑"模式执行：从某一步落地后导出的代码包恢复该流的断网容器工作区，按指定组别（带记忆、不带、带无关记忆）跑完整的一步——agent 工作、验证门、回炉——每组 5 遍；模型请求经本地网关（155），计量与限额处理与流中一致。旧回放中的一致性核对（从原尝试的起始记录取出任务、起点、预算、模型与工具名单，任何放宽即拒绝）保留，接到单步重跑上。旧回放执行体（本地 git 工作树、另派验证者角色、注入内容与分组与工作树命名与结果记录都绑在候选上）随第一版退役。
- 理由：定点对照要比较再次变红的比例与回炉轮数，重跑单元必须是含回炉的完整一步，且须与该步在流里的执行一致（同一断网容器、同一代码状态、同一网关）。跑批器每步落地后导出代码包，天然可作起点；旧执行体在本地工作树上只跑一次验证、不走网关、与候选深度耦合，改造后环境仍与流不同，测到的不是流里那一步。"回放要留下来"所指的能力——从某一步的起点、只改一样东西、重跑若干遍——由此保留，实现换为与实验同一套环境。未选：改造旧回放执行体，须先与候选拆开，再补回炉、容器与网关。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 157 定点对照三组的记忆走正常推送路径，只固定挑选结果（设计）

- 结论：定点对照（139、156）的三组差别只在给哪条记忆，给法完全沿用结构化记忆的正式推送路径——开局推送与回炉时附在报错之后两个时机（134）、同一套代码，只把挑选（135）固定为指定条目：带记忆组给那条相关记忆，在它按挑选规则本会出现的时机给出；带无关记忆组换成一条取自其他文件的真实记忆，时机不变；不带组不给。不另开注入口（如直接拼进题面或系统提示）。
- 理由：验证时若另走一条装载路径，验证形态与正式使用形态会有细微差异，而这种差异最难发现，测出的结论也就不作数；M8 时回放装载经验即按此原则走与真激活完全相同的路径（085）。走同一条路，测到的就是正式使用时的记忆。未选：另开专门的注入口。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 158 退役的四项推论（设计）

- 结论：① 定点对照的重跑结果写进跑批器的结果行，不新增账本记录；旧回放的结果记录类型随候选验证记录一起退役，照 128 读取时跳过、不改旧文件。② 验证者角色停用，不再派出；账本中角色名的取值保留，旧会话文件里记着它，删值会使其读不出；项目命令配置里写了该角色的照样能读，只是不再起作用。③ SWE-bench 复核命令与容器重跑模块一并删除：该命令本质是候选验证，容器重跑模块只被它调用；以后在 SWE-bench 上做同类的事用 156 的单步重跑。④ 评测中的 none、candidate、approved 三个条件名保持不变：它们指手写的 Skill 夹具，与第一版生产线无代码依赖，且已入库的结果行记着这些名字。
- 理由：四项都是 137（第一版整套退役）与 156（定点对照改由跑批器单步重跑）的直接推论，由退役盘点逐项核出。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 159 验证配置支持命名分步，各步结论记入验证记录（设计）

- 结论：项目验证配置支持命名分步：每一步有名字与命令（本仓库为格式、类型、测试、分层四步；strands 为 ruff、mypy、pytest 三步），全部执行、各出结论，不因前一步失败而跳过后续步骤；整体结论为各步的合取（任一步失败即失败，任一步无法判定而其余未失败即无法判定）。验证记录在已有记录上加一个可选的各步结论字段（步名、退出码、结论、输出末尾），不新增记录种类，账本格式随之按加法式推进一版。回炉反馈写明哪几步失败并附各步输出；结构化记忆按"哪一步、什么指纹"记录与挑选（131、135）。单条命令的旧配置照常可用，视为只有一步。施工在结构化记忆施工中作为第一步完成。
- 理由：131 定的记忆内容要记"红在哪一项检查、报错指纹是什么"，而现有验证只是一条以"前一项通过才跑下一项"串起的命令：只有一个总结论，看不出哪一项红；第一项红了后续不跑，其余问题要到下一轮才暴露。分步后回炉一轮即可看到全部检查的问题。未选：配置不动、从合并输出按各工具格式解析出哪一项失败——解析脆弱、工具升级即可能失效，且前项失败后续不跑的问题依旧。
- 修订（2026-09-24）：延续式实验中本仓库提交流（记忆定点对照所用）的验证门去掉格式步，只保留类型、测试、分层三步；格式偏差计入次要指标，与 strands 流一致（其 CI 的 lint 只做 ruff check）。日常使用本仓库时的验证配置仍为四步，不受影响。理由：开跑前置检查中，本仓库流 89 个要测的提交有 15 个人写代码本身格式不合规（版本与配置与当时一致，可在原始代码上复现），说明人在中间提交上并未逐次遵守格式检查；保留格式步，这些步即便写出与人相同的代码也会被判回炉、撤回。未选：保留格式步，把这些步从定点对照的候选事件中排除（验证门定义不变，但可用事件减少）。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 160 回炉撤回推断的残余窗口接受为已知限制（设计）

- 结论：154 修订后的推断规则不再改动。残余窗口为：回炉开启，这一步最后一个 Run 有验证记录且结论为失败，已用轮数未到上限，轮次与 token 未耗尽，该 Run 无撞上限记录，且设了墙钟。此时"墙钟在最后一次验证期间到点、工作区已恢复"与"验证落盘之后、下一轮 run.started 之前进程被硬杀、工作区未恢复"在账本中不可区分，一律推为已撤回。接受为已知限制，写入回炉审计。
- 理由：已用轮数、轮次与 token 是否耗尽、墙钟在 Run 内到点，均可由账本推出，真正不可区分的只剩上述一种。正常路径上两条记录之间只有一段同步代码，只有硬杀、断电或进程内异常能落入其中，回炉的附加内容注入点已要求兜住异常。延续式实验的跑批器对被打断的步骤整步作废重做，不读此推断；日常使用中误标时，工作区的实际状态可由 git 查看。未选：续跑时对推为已撤回的步骤再执行一次恢复（恢复可重复执行），不加记录，但续跑路径要多一段逻辑与测试；在验证记录上加可选的"本轮之后撤回"字段，账本格式推进一版，且标记落盘到恢复完成之间仍有更小的窗口。
- 锚点：src/state/repair-step.ts、src/application/repair-loop.ts。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 161 容器模式下每步的起点进账本，供认定开工时已在工作区的文件（设计）

- 结论：在容器执行端上开启回炉时，run.started 的负载带一个可选字段 stepStart：commit 为这一步开工时的提交，baseCommit 为执行端把开工时的工作树（含跑批器预置、尚未提交的人写测试）写成的、挂在该提交之下的提交。一步里各个 Run 同值；本地工作区不带这个字段。结构化记忆派生"开工时已在工作区的文件"时，先读快照的改前基线，没有再读 stepStart，两者都没有即判为未知。字段在账本 v17 内按加法式加入，不新增记录种类。
- 理由：结构化记忆把题面测试首轮失败视为正常、不记（131），认定题面测试的来源之一是开工时已在工作区的文件；本地模式由快照提供，容器模式没有宿主快照，缺这一信息时测试步的红转绿一律判为未知，记忆最主要的一类事实（改动弄坏他处已有测试）在实验里全部丢失。未选：复用快照记录（要求带工具调用编号，须放宽，改动面更大）。
- 锚点：src/state/event-log.ts、src/state/structured-memory.ts、src/application/headless-core.ts。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 162 结构化记忆实验后按结果决定是否重构为"读结构化输出、显式声明题面测试"（设计）

- 结论：现有实现——从检查工具面向人的文本输出中解析报错指纹、由本步改动、开工时的工作区与题面文字三个来源推断题面测试——用于本轮正式实验，不再改动。实验结束后：若定点对照（139）显示记忆有作用，则重构两处：① 报错指纹改从工具的结构化输出读取（pytest 与 node:test 的 JUnit XML、ruff 与 biome 与依赖巡航的 JSON、mypy 的 JUnit，或统一的 SARIF），文本解析只作兜底；② 题面测试由调用方显式声明（跑批器已知每步的题面测试文件），作为步的元数据交给 Pigeon，推断只在未声明时兜底。若记忆无作用，不再在这一层投入。
- 理由：确定性规则是 129、136"由程序判真伪、不靠模型"的代价，属于从工程数据中用程序挖掘事实的一类做法（如由版本历史挖连带修改、由持续集成记录挖时过时不过的测试）。现实现不够干净之处主要来自两处可避免的做法：从给人看的文本里抽取结构，工具改输出格式即可能认不出；用推断代替调用方本已知道的信息，三轮复核查出的问题多半在此。实验前重构要再走一轮施工与复核、推迟开跑；实验要回答的是记忆有没有用，现实现经三轮复核行为正确。未选：实验前重构；维持现状、实验后也不改。
- 锚点：src/state/verify-fingerprint.ts、src/state/structured-memory.ts、src/memory/structured-workspace.ts。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 163 模型接口的可用容量低于路数时按剩余容量放行（设计）

- 结论：本地网关按账号统计可用容量（未停用账号的当前并发上限之和；429 退避属秒级波动，不计入下降）。各流开始下一步的 agent 之前，须等到同时在跑的 agent 数小于可用容量；等待发生在步与步之间，不计入该步的墙钟预算，不作废、不耗额度，等待时长记入结果行。容量下降时已在跑的步照常继续，其中等空闲账号累计超过阈值（30 秒）的立即中止、回滚、作废，等到空位后重做，不再等 agent 跑完才判。开跑前路数超过各账号配置并发之和即拒绝开跑。全部账号不可用时沿用原有的整批暂停与停下规则。定点对照的单步重跑与跑批器共用同一套放行与作废判定。
- 理由：排队作废（一步等空闲账号累计超过 30 秒即作废重做，与限额信号同一口径）原以"路数不超过各账号并发之和、正常不排队"为前提。某个账号撞上 5 小时额度被停用，或并发上限被调低后，可用容量会在数小时内低于路数，几乎每步都排队超时作废；同一步作废满 10 次即停下该作业，并连锁停下全部作业；每次作废前该步仍跑满预算、消耗剩余账号的额度。按剩余容量放行是按下游容量调整放行数的常见做法（随容量伸缩的信号量、连接池），把等待移到步与步之间，使受影响的只剩容量下降那一刻在途的少数步。未选：只加开跑前校验、排队作废不计入停止上限（容量不足期间持续作废重做，浪费预算并加速额度消耗）；可用容量低于路数即整批暂停（剩余容量闲置数小时）；取消排队作废、只记排队时长事后剔除（判题的步混入被排队缩短有效时间的尝试，直接影响成败标签）。
- 锚点：src/eval/model-gateway.ts、src/eval/model-limits.ts、src/eval/stream-runner.ts、src/eval/stream-experiment.ts。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 164 定点对照的主判据按记忆给出时机拆开（设计）

- 结论：细化 139 的主判据。事件按记忆给出的时机分两类，各用一个判据、分开报，不合并成一个均值：开局事件（开局挑到记忆）看首轮验证是否在题面以外的检查上变红；回炉事件（回炉时挑到记忆）只取首轮验证未过、进入回炉的遍次，看给出记忆那一轮之后的下一次验证是否仍在题面以外变红。两个时机都挑到记忆的事件，两类都计入。配对差与"帮倒忙"的事件数按两类分别计算；回炉轮数与最终结论作为辅助指标。回炉时机的记忆在重跑中于每一轮回炉都给出。
- 理由：回炉时机的记忆在首轮验证之后才给出，与首轮验证的结果没有因果关系；把这类事件混入首轮判据，其配对差纯属随机，每组 5 遍时约一半会被计为帮倒忙，并把均值拉向 0，稀释开局记忆的效果。回炉判据以"首轮验证未过"为筛选条件，这一条件发生在三组出现差别之前，筛选不引入偏差。未选：只保留开局事件（放弃测回炉时机，而回炉是结构化记忆的两个给出时机之一）；维持现状混算。
- 锚点：src/eval/fixed-point-rerun.ts（结果行）、src/eval/fixed-point-report.ts（汇总）。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。

### 165 整流实验判据：本次照原判据报告，挖掘出的判据由外部复现确证（设计）

- 结论：本次整流实验按 145 的原判据报告（全量测试通过率为主指标，回归数、静态检查错误数、撤回次数、按题通过率与失败归因为次要），并照实写明主指标在测试齐全的仓库上饱和。同时从本次结果中挖掘区分度高的判据，连同挖掘过程一并记录，本次相关结论标为探索性发现；在外部复现（125）开跑之前把挖出的判据定为主判据，由外部复现的结果确证。同条件重跑的波动：本次不补跑（146 修订），单步层面的重跑波动取定点对照不带组的 5 遍重跑作参考；外部复现是否对部分条件跑多遍，按届时额度另定。
- 理由：一次实验可算的指标很多，看过结果再挑差别最大的作主判据，容易把偶然差别当作效应；把本次用于发现判据、把外部复现用于确证，既用上了本次的数据，又保住了结论的可信度；外部复现本就是 125 规定的必做项，确证不增加额外实验。未选：直接以挖掘出的判据作为本次结论（事后选判据，可信度最弱）；不改判据（主指标饱和，146 原门槛又要求全部补跑，额度不足）。
- 详情：docs/decisions/stream-memory-decisions.md（本地）。
