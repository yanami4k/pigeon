# Pigeon 项目路线图

> 状态：设计草案 v0.6  
> 更新日期：2026-09-13

路线图目录见 [`README.md`](README.md)。

## 1. 项目定位

Pigeon 是基于 Pi Agent Core 构建的 Coding Agent Harness。它卖两样东西：**可无人值守的并行执行**，以及**从自己的运行历史里学习**。治理闭环（人工审批、六档放权、ExecutionId + 意图 + Receipt 证据链、OutcomeUnknown 不盲重放、Event Log 单一权威源、学到的东西用前核验）是这两样能力成立的原因，不是卖点本身：没有证据链就不敢把 worker 派出去自己睡觉；学到的只是程序从账本推出的事实、每次给出前对照代码核验，才敢不经人工审批直接推给模型。权限与审批对坐在终端前的人是摩擦，不是招牌；Pigeon 拿它换的是少盯着与敢放手。

更具体地说：

- Pi Agent Core 负责底层 Agent 循环；
- Pigeon 负责 Session、运行状态、Coding 工具、上下文、记忆、Skill、并行 worker 编排、工具治理、人工审批、执行 Receipt、崩溃恢复、Trace、Replay 和 Eval；
- Pigeon 由程序从运行历史中派生结构化记忆（回归与约束的红转绿、被撤回的尝试这类摩擦事实），在开局与回炉时推送给模型；人写的偏好、项目 memory 与 Skill 另成一层，由人维护（decisions.md 129 至 136）；学到的东西不能获得执行权；
- 学习不等于授权，测试通过也不等于自动授权。

叙事与验收的主角是并行编排（§M5.5）与学习闭环（§M9；第一版 §M6 至 §M8 已退役，见 decisions.md 137）。治理只在两个场景露面：崩溃或中断之后能对账、能恢复；学到的东西每次用前由程序核验，不过即不给。演示顺序按此安排；里程碑排期以尽早让两个主角出场为准，治理管道不再单独立项，只随主角所需补齐（decisions.md 039）。

完整学习链路（decisions.md 129 至 136、159；第一版链路——Reviewer 与对比提炼产出候选，经安全扫描、回放验证与人工审批后激活——已由 137 整套退役）：

```text
Session / Run（Event Log）
    ↓
验证门逐步结论 + 回炉与撤回记录
    ↓
程序派生摩擦事实（回归与约束的红转绿、被撤回的尝试），挂在文件上
    ↓
用前核验：锚点文件仍在、报错里的名字仍能找到，不过即不给
    ↓
开局与回炉时由程序推送给模型
```

### 吸收的通用 Harness 原则与 Pigeon 的原创部分

本路线图吸收 Harness Playbook 对“权威状态、控制平面、执行边界、状态投影和有界任务”的提醒，但不复制其具体 DOM/XML、扩展语言或产品实现。

| 通用原则 | Pigeon 的落地 | Pigeon 保留的原创语义 |
|---|---|---|
| 一个权威状态源 | Controller + Event Log + Snapshot | Session/Run/Turn、Receipt、OutcomeUnknown 和 Candidate 状态模型 |
| Controller / Actor 分离 | TUI、CLI、Remote、Reviewer 读取投影并提交意图 | 审批主体、权限委派和候选激活的不可绕过规则 |
| 执行器只执行 | Durable Executor / Sandbox 接收有界请求 | ToolPolicy、审批与实际参数绑定、派发后不盲重放 |
| 工具是状态流 | `ToolExecution` 统一 proposal 到 verification | `toolCallId`、`executionId`、`receiptId` 三层关联和确定性验证 |
| 长任务有界执行 | Tool、Reviewer、Subagent 共享取消、预算和有界输出约束 | 父子 Run 权限子集、Session Tree 学习和对比式蒸馏 |
| 视图是投影 | Trace、Receipt、TUI、Eval、Replay 来自同一状态 | Memory/Skill Candidate 的验证、审批和后续 Session 激活 |

## 2. 依赖与所有权边界

推荐依赖：

```text
Pigeon Harness
├─ @earendil-works/pi-agent-core   Agent 循环
├─ @earendil-works/pi-ai           模型接入
└─ @earendil-works/pi-tui          终端渲染与基础控件
```

Pigeon 必须提供专门的 `PiRuntimeAdapter`，只通过 `pi-agent-core Agent` 公开的状态和 Hook 控制运行，并统一完成工具、上下文、记忆和 Skill 的注入。

```text
Pigeon Application Core
        │
        │ immutable RunSnapshot
        ▼
PiRuntimeAdapter
        │
        │ public state + public hooks
        ▼
pi-agent-core Agent
```

边界规则：

1. Pigeon 业务代码不得散落直接调用 Pi Agent；所有运行交互统一经过 `PiRuntimeAdapter`。
2. Adapter 不读取或修改 Pi 的私有字段，不依赖未公开内部事件。
3. Adapter 负责注入、事件归一化和执行治理结果，但不自行决定权限。
4. 当前 Run 使用不可变注入快照；运行中产生的新 Memory 或 Skill 只能从后续 Session 开始生效。
5. Trace 必须记录最终实际暴露给 Agent 的工具、上下文、记忆和 Skill 版本摘要，不能只记录配置意图。

### TUI 边界

Pigeon 复用 `@earendil-works/pi-tui` 的终端渲染、输入、布局和基础控件，但自己实现完整界面和交互模型。

- 不直接修改 `pi-coding-agent`；
- 不导入、继承或运行其完整 `InteractiveMode`；
- 不整体复制 `InteractiveMode` 后改名；
- 可以参考其行为，但 Pigeon 自己拥有 Application Shell、消息流、审批、Receipt、Trace、Replay、Eval、Memory 和 Skill 界面；
- TUI 只提交用户意图并渲染 Pigeon 状态，不能绕过治理层直接控制 Agent。

### 复用注意事项

1. "复用思想"的话术必须用实现细节兜底：引用上游机制前（如 reducer/lane 协议）必须先读完其实现，能讲清"上游做到哪、差异在第几层"。
2. 自有部分的证据在攻击面测试里，不在实现里：未审批写操作到不了执行器、伪造批准无效、崩溃后写操作不盲放——这组测试存在且通过才是差异化证据。
3. 复用越多版本绑定越深：@earendil-works/pi-agent-core 与 pi-ai 锁定 0.84.4，TypeScript 锁定 6.x（dependency-cruiser 18 不支持 TS7，TS7 下会静默巡航 0 模块导致 deps 假绿）。升级是显式决策；升级后必须重跑 beforeToolCall 与 transcript 两个 spike（spikes/spike-*/spike.mjs，笔记在 docs/spikes/），结论以实跑输出为准，不信声明文件；reuse/own 审计表重跑一遍。
4. 上游可能长出同类能力吃掉差异化：盯上游 changelog；治理语义设计为跨 harness 可迁移，Adapter 隔离保证上游变更不击穿治理层。
5. 归属诚实：README 致谢上游并划清边界；"我用了 X 因为 Y"是工程判断力，冒充自研被发现则项目可信度归零。
6. 自有决策的唯一合法理由是"上游缺这个语义"，不是"显得代码量大"。

### 上游 0.84.4 实证事实（行为判断的唯一依据）

以下事实由 spike 实跑确认，D3 的 (runId, runSeq) 权威键、熔断判据与审批闸设计均依赖它们；上游升级后逐条重验：

- beforeToolCall 返回 {block, reason} 阻断可靠，reason 逐字到达模型；改参唯一通道是 hook 内原地改写 ctx.args；上游无循环护栏；tool_execution_start 早于 hook 发出；hook 路径有 try/catch，subscribe listener 无防护，Pigeon 的监听必须自包且不抛。
- transcript 消息无稳定 id（timestamp 撞毫秒，responseId 不可靠）；append-only 零原地修改；abort 与合成失败消息占序号；reset 与 setter 整组替换数组；上游零防御拷贝，transcript() 的 structuredClone 与 listener 只读是承重的。
- 幽灵工具名与参数畸形在 hook 之前被上游拦截，tool_execution 事件照常发出且 isError 为 true。

## 3. 不可妥协的系统约束

### 3.1 Agent 不能自我授权

- Memory 和 Skill 不能授予工具权限；
- Eval 分数和 Candidate 置信度不能授予工具权限；
- Background Reviewer 不能充当批准者；
- 权限扩大必须有可审计的外部批准主体。

### 3.2 副作用不能盲目重放

- 每个可能产生副作用的调用必须有稳定执行 ID；
- 调用前持久化意图和权限依据；
- 调用后持久化 Receipt；
- 崩溃或超时后优先查询 Receipt 和真实业务状态；
- 无法确认结果时进入 `OutcomeUnknown`，不得自动重放原写操作；
- 以上五条约束的是产生副作用的调用（写 / exec 层）；只读调用无副作用，只留 tool.proposed 与 tool.settled 事件级记录，不进 OutcomeUnknown 对账（decisions.md 008）。

### 3.3 摘要不是事实证据

- Pi 的 `branch_summary` 和 compaction summary 仅作为检索线索；
- 最终结论必须回查原始消息、工具结果、Trace 和 Receipt；
- 被截断或缺失的工具结果不得支撑确定性结论；
- 当前叶子不自动代表成功路径。

### 3.4 学到的东西用前核验（decisions.md 129、134、135、136、137）

- 学到的东西只来自程序从账本推出的事实（结构化记忆）；记忆的产出与挑选都由程序完成，模型不参与；
- 结构化记忆不经暂存与人工审批，由程序在开局与回炉两个时机推送；每次给出前核验锚点文件仍在、报错里的名字仍能在该文件中找到，任一不过即不给；
- 结构化记忆不写入人写层（偏好、项目 memory、Skill），两层分开存放、分开注入、各自计预算；
- 学到的东西不能授予工具权限（§3.1）；
- 记忆的派生、挑选或核验出错，不得影响运行的完成状态。

第一版的约束（Reviewer 只能生成 Candidate、Candidate 默认暂存、激活前显示 diff 与来源）随第一版学习闭环一并退役（137）。

### 3.5 一个权威状态源

- Pigeon Controller 是 Session、Run、Turn、ToolExecution、Approval、Receipt、队列和 Candidate 状态的唯一权威写入者；
- 这些状态必须能从 Pigeon Event Log 和版本化 Snapshot 重新物化；内存对象、闭包、TUI 和 Pi transcript 不能成为唯一事实源；
- `PiRuntimeAdapter` 负责在 Pigeon 状态与 Pi 公开 API/事件之间映射，不把 Pi 私有状态提升为 Pigeon 权威状态；
- Trace、Receipt、TUI、CLI、Remote、Replay 和 Eval 都是同一状态的不同投影；
- Pigeon 的“权威状态源”是原创工程边界，不要求修改或 Fork Pi 的内部实现。

### 3.6 Controller、Actor 与执行边界

- Controller 拥有状态、策略、审批、调度、限制和日志；
- Actor（视图与客户端：TUI、CLI、Remote、Reviewer、子代理）只接收 Snapshot/patch 或结构化结果，并提交意图，不持有权威状态；
- Executor/Sandbox 只执行已批准、已绑定参数和权限依据的请求，不决定权限；
- 长任务（工具调用、Reviewer、子代理）不各自维护 spawn、cancel、timeout 和恢复协议；统一约束为可取消、有预算、有界输出、可观察、可恢复——约束先立，公共 `Job` 抽象等到第二个真实执行体出现再抽；
- 第一版仍可在本地进程实现这些边界，但接口必须保留未来的进程、Worker、容器或远程执行边界。

### 3.7 Lane 的限定语义

- `lane` 只表示同一 Session 会话树上从某个 `entryId` 分叉出的独立对话执行线；
- 每条 lane 同时最多运行一个 operation（`run`、`compaction` 或 `navigation`），并拥有自己的 `leafId`、队列和故障状态；
- lane 不是通用后台 Worker，也不是 Reviewer 或 Distiller 的别名；
- 后台 Reviewer 使用独立 Agent 实例和主 Session 的不可变快照，输出 Candidate，不通过 `createLane()` 往主会话树写入分析记录；
- Pigeon 如果实现 lane，应参考分支点、互斥和恢复形状，但不依赖当前 Pi Harness 的桩实现。

### 3.8 LLM 可筛查，不可判决

- LLM 可用于 Candidate 的质量筛查（覆盖度、自洽性等，过滤明显畸形产物）和运行轨迹诊断；
- Candidate 的激活判决只接受确定性验证与人工审批；LLM 的筛查结论不构成激活依据；
- 本条是 3.1 的执行细则：筛查是过滤，判决是授权，两者不得混用。

第一版候选链已退役（decisions.md 137）；本条保留，约束将来任何由模型产出、需要激活判决的经验。

### 3.9 放权只有六档，且每一档都留证（事实：decisions.md 004、010、019、020）

工具调用的放行判定按固定顺序求值，任何放行都必须落在其中一档，不得另起旁路：

1. deny 清单（工具名精确匹配）：绝对拒绝，任何档位不豁免；
2. 会话 grant：审批提示 [a] 本会话允许 / [d] 本会话允许仅限当前调用所在目录，运行态存在于本会话，崩溃恢复后静默继续有效，/revoke 立即失效；
3. 固化规则：.pigeon/grants.json，只能由人经 /grants save 把会话 grant 升格而来，带 promotedFrom 出处，下次会话生效，/revoke config#N 移除；
4. yolo：启动时显式拨档的批发授权，短寿命；
5. read 层自动放行：prompt 模式下只读工具不问人；
6. prompt：人工审批，动作集只有批准与拒绝，无"人工改参数"（拒绝理由逐字回模型，形成自我修正闭环）。

五条不可破约束：deny 绝对优先；grant 与固化放行照样过熔断计数；固化只能由人显式触发，agent、模型、后台流程无写配置文件的代码路径；grant 是治理面运行时状态，不进 InjectionSnapshot；匹配是确定性的（工具名 + 目录包含），无自由文本模式。

留证：每次自动放行的账本回指具体出处（approvedBy = human:grant 回指 grantId，policy:config 回指规则的 promotedFrom.grantId，位置序号不作身份）；会话 grant 的创建与撤销、固化规则的升格与移除各落一条 Event Log 记录。可审计的问题是"这次写操作凭什么没问人"，答案在移除规则之后仍然成立。

## 4. 目标架构

```text
src/（单 package，目录即模块边界；依赖方向由 dependency-cruiser 按路径强制——
      上游边界规则（含 src/tui 的 pi-tui 精确豁免）+ 目录分层规则（M2 S1 起含 application
      Controller 层；cli/tui 不得依赖 execution），测试文件可跨层搭夹具；事实：.dependency-cruiser.js）

已建（M0–M6.5 as-built，2026-09-14 回写）——依赖方向自下而上：
├─ state/             叶子，不依赖任何其他目录、无 IO：稳定 id、ToolExecution 状态机、
│                     Receipt（M5.5 起 v4，含 exec 证据；M5.7 起 v5，含 mcp 证据）、事件信封与运行时事件
│                     载荷 schema（M5.7 起 run.started 带 MCP 工具集摘要与 server 状态）、
│                     Event Log 记录族 schema（M5 起 v6，含 run.started / llm.request / skill.loaded
│                     观察族；M5.5 起 v7，含 session.header / child.spawned / child.settled worker 编排族；
│                     M5.7 起 v8，读路径把内嵌 receipt 升到当前版本；M6.5 起 v9，含 eval.verified 观察族；
│                     M9 起逐版推进至 v17：剪去无读者记录与第一版学习闭环的记录族（128、137，读取时跳过），
│                     验证记录加分步结论、run.started 加结构化记忆留痕与容器起点（159、161））
│                     与读路径迁移链、消息内容记录与规范序列化哈希（037）、Memory / Skill 注入清单
│                     schema、推理档位字面量、失败四分类判据（活冷共用）、冷物化与对账（纯函数，
│                     含正文缺口与父子配对）、trace / replay / session 摘要投影、固化 grant 规则与
│                     commands.json schema、成败标签与尝试引用（attempt-ref.ts；原 Candidate schema 随 137 退役）、
│                     结构化记忆的派生与指纹解析（131 至 136）、
│                     MCP 配置 schema 与合并判据、注解与配置冲突的更严规则、
│                     mcp 证据计算（M5.7）
├─ tools/             只依赖 state：Tool Registry（M5.7 起接受原样透传的 JSON Schema 参数）、Tool Policy
│                     排律、路径围栏、grant 确定性匹配（M5.5 起含精确命令串）、read_file / edit_file
│                     （缺省 replace，可选 hashline，062；模式字面量在 edit-mode.ts，两套实现在
│                     replace-edit.ts 与 hashline.ts）、run_command（exec 档，不经 shell，048）与 MCP server 启动计划
│                     （复用 048 启动器，M5.7）、错误归类（先读错误对象标记，050）；
│                     执行端接口 workspace-host.ts 与本地实现 local-host.ts（M9，098：三个工作区工具只调接口，
│                     不判断自己在哪执行；含写保护包装）；wrap.ts 是上游类型唯一桥接
├─ persistence/       只依赖 state（state 的存储实现）：JSONL Event Log 读写器（每会话一文件、
│                     治理族 fsync、幂等索引、撕裂尾巴容忍、M5.5 起会话打开锁）、旁置内容文件
│                     <sessionId>.messages.jsonl 读写（M5，037：先内容后 entry）、materializeSession =
│                     读文件 + 纯物化、grants.json 读写（M5.5 起原子替换）、commands.json 读取、
│                     .mcp.json 与 .pigeon/mcp.json 读取（M5.7）、会话列目录、M3 旧账本一次性迁移
├─ approvals/         依赖 state / tools：人工审批 handler 接口（M5.5 起带来源会话、worker 标签、
│                     放权落点与风险分层）、审批排队、会话 grant 运行态存储
├─ execution/         依赖 state / persistence / tools，不触达 pi-runtime 与 Actor 层：冷恢复
│                     recoverSession（哈希自动确证，唯一会写 resolution 的恢复动作）；
│                     执行端接口的容器实现 container-host.ts（M9，098：经 docker CLI 进容器读写与执行，
│                     超时与中止一律重启整个容器）；Durable Executor 待第二个真实执行体出现再抽（§3.6）
├─ memory/            依赖 state / persistence / tools，不触达 pi-runtime / application / execution /
│                     Actor 层（M5，decisions.md 038 / 042）：内容级 Session Search 扫描器与
│                     search_sessions / read_session_entry 两个 read 档工具、常驻 Memory 两层读取与
│                     字符预算
├─ skills/            只依赖 state / tools（M5，decisions.md 043）：Skill Catalog 扫描、哈希清单与
│                     目录段、load_skill 三重约束工具；读取留痕经装配根注入的回调写出；M5.7 起
│                     MCP server 的无参 prompt 以 server 为来源进同一目录（正文由装配根取好，结构类型传入）
├─ mcp/               只依赖 state / tools，由 application 装配（M5.7，decisions.md 041 / 051 / 052 / 053）：
│                     MCP 客户端连接（stdio 与 streamable HTTP、会话开始时拉清单后冻结、清单变更只记录、
│                     退避重启且有上限、超上限或启动失败 fail-closed 报环境错误、roots 广告为工作区根）、
│                     自有 stdio 传输（按 048 启动计划 spawn）、工具映射进注册表（mcp__<server>__<工具> 命名、
│                     按实际档位注册、执行时暂存 mcp 证据）
├─ pi-runtime/        依赖 state / tools，不触达 persistence / execution / Actor 层：
│                     PiRuntimeAdapter（注入快照、事件归一化、entry 映射、流式观察、推理档位交给
│                     上游）与 ToolGovernance 接口；beforeToolCall 只转发 decide 并原样交回理由，
│                     tool_execution_end 转发 settle；上游唯一入口。M4 记账的"治理编排住在
│                     Adapter"债已由 M5.5 S0 清掉（decisions.md 049）；M5.7 起 run.started 的附加摘要
│                     经装配根注入的结构回调取得
├─ orchestration/     依赖 application 以下各层，不触达 application 与 Actor 层（M5.5，decisions.md 040）：
│                     git 工作树管理、worker 编排器（spawn / cancel / status / awaitResult 四动作加
│                     审批回调、轮次与墙钟上限、深度 1）、角色表与委派子集构造（M5.7 起 implementer
│                     继承父策略里的 MCP 工具）；worker 运行面由装配根以工厂注入
├─ application/       Controller（M2 S1 落位，decisions.md 025）：装配根 runtime.ts（注册内置
│                     工具、构造 Adapter / 事件日志 / grant 运行态；审批 handler 由 Actor 注入——
│                     cli 传 REPL 问答版，tui 传面板版）、resume.ts 冷恢复对账流程（哈希自动
│                     确证 + 三选一人工确认写 resolution，问答与输出注入）、format.ts 通俗措辞
│                     单一约定（trace / replay / resume 菜单共用）、search.ts /search 命令层与
│                     history.ts 会话历史投影（M5）；装配根在会话开始读常驻 Memory、登记 Skill、
│                     拼 system prompt 并冻结；governance.ts 工具调用治理实现（M5.5 S0，049）；
│                     workers.ts worker 运行面工厂与按会话装配编排器、worker-scope.ts worker 会话
│                     恢复范围、workers-commands.ts /spawn /cancel /workers 命令层（M5.5）；mcp.ts MCP 会话
│                     装配（读配置、并发启动、映射工具、取 prompt 正文、run.started 摘要与启动提示）与
│                     disposeRuntime 统一释放（M5.7，worker 以其工作树为工作区根启动自己的 MCP 会话）；
│                     headless.ts 无父会话运行入口，与 worker 共用装配内核（M6.5，decisions.md 056）；
│                     session-list.ts 会话列表命令层与 grants.ts 固化规则命令层（cli 与 tui 共用同一份
│                     查询与排版）、workspace.ts 工作区准备与固化 grant 种子恢复；
│                     可依赖 state / persistence / tools / approvals / pi-runtime / execution / memory /
│                     skills / orchestration / mcp，不触达 Actor 层
├─ eval/              依赖 application 及以下，不触达 Actor 层（M6.5，decisions.md 046 / 057–060）：task.json 任务目录
│                     加载、从任务 ref 开工作树的快照准备、验证资产回填与退出码三值验证器（eval.verified）、
│                     三条件 runner（skillRoots 切换）、results.jsonl 与 report.md；由 cli 的 eval 子命令调用；
│                     M9（102）起 runner 只认任务源接口 task-source.ts——自造冒烟题 local-source.ts 与外部基准
│                     swebench-source.ts 各一个实现，可并行，错误行不占续跑键
├─ cli/               Actor：REPL 内联审批（四键）、/grants /revoke /grants save、trace /
│                     replay / session list 只读渲染、resume 的参数解析与 IO 接线；装配根与
│                     resume 流程在 application/（M2 S1，025——M4 记账的 cli 直连 execution
│                     过渡豁免已消除）；cli 不得依赖 execution，只经 application；M5.5 起 trace
│                     从主会话列出并进入 worker 会话，resume worker 会话回到其工作树；M6.5 起 run（headless）
│                     与 eval 子命令。除 application 外另有两处直接依赖：repl.ts 取 pi-runtime 的
│                     PiRuntimeAdapter 类型，approval-ui.ts 取 approvals 的审批接口与会话 grant 运行态
└─ tui/               Actor：M2 Pigeon 自有 TUI，唯一允许直连 pi-tui 的目录（tui-pi-tui-only
                      精确豁免，spike 判过 decisions.md 026）；继承 cli 的治理投影，不得触达
                      execution；依赖 application（装配根、治理命令、历史、resume、搜索、会话列表、
                      worker 命令层）与 state，另有两处直接依赖：shell.ts 取 pi-runtime 的运行结果与
                      流式增量类型，approval.ts 与 main.ts 取 approvals 的审批接口、队列与会话
                      grant 运行态

占位（export {}，按里程碑填充）：
└─ context/           上下文规划（M5 以 system prompt 冻结段与 transformContext 只读观察落地，
                      本目录仍空）

占位目录暂按最小允许清单约束：只允许依赖 state 与 tools（placeholders-only-state-tools）。
review/、distillation/、activation/ 随第一版学习闭环退役删除（decisions.md 137、158）；
replay/ 不再是占位，现为回放的一致性核对（plan.ts 量尺提取、fidelity.ts 放宽即拒），
决策 156 保留、供跑批器的单步重跑调用，区别于 state/replay 的只读重建（decisions.md 014）。
```

上图是逻辑模块图，物理形态是一个 npm package 下的 `src/` 目录。拆成多包 monorepo 的唯一触发条件是出现需要独立版本化/发布的产物，本轮不做。

关键状态流：

```text
Run（整体生命周期，事实：src/pi-runtime/adapter.ts RunTerminalStatus）：
Running → completed / failed / aborted / unknown

Run 终态只描述循环如何收尾，不描述成败。成败由失败四分类（decisions.md 017 判据表，
src/state/classification.ts，活侧与冷侧共用同一纯函数）给出：
  取消（子类：治理熔断，靠 breaker 记录区分） / 业务失败 / 基础设施错误 / 未知
默认桶是「未知」：宁可标不知道，不贴错标签（标签要喂 M6+ 蒸馏）。
崩溃残留恒为未知：run.ended（agent_end）缺失即循环没有跑完，无论末条 turn 的
stopReason 是什么都不判正常；无任何 turn.completed（D8 迁移会话）同样未知
（decisions.md 023）。

Tool Execution（单次工具调用，事实：src/state/tool-execution.ts）：
proposal → approval → dispatch → execution → settled → verification
                    ↘ settled（仅拒绝：approval 直接落 settled）

证据链按副作用分层（decisions.md 008）：写/exec 类调用持久化 intent（调用前，
含改前/预期改后哈希）+ decision（拒绝时，逐字理由）+ receipt（调用后）三族；
读类调用只留 tool.proposed / tool.settled 事件级记录。拒绝走 decision 族
不产生 Receipt，拒绝是治理闭环不是失败。
settled 只表示执行过程到达终态；verification 的推进器（确定性测试、业务状态
查询、用户确认）在 M6.5 前尚无运行时路径，当前由冷恢复对账的 resolution
（哈希自动确证 / 人工确认）承担销账，任何路径不自动重新执行。

OutcomeUnknown 先归属到具体 ExecutionId（intent 无 receipt 且无 resolution），
再由 Run 聚合。Run 的状态不代替工具调用状态。

Candidate（M6 起，已随第一版学习闭环退役，decisions.md 137；旧记录读取时跳过，以下保留为历史）:
提出（扫描结果随提出记录一并写入）→ SecurityScanned / ScanRejected
         → ReplayValidated / ReplayInconclusive / ReplayRegressed
         → Approved → Active → Revoked ／ Rejected ／ Superseded
```

## 5. 分阶段路线图

每一阶段都应形成一个可独立演示、可回归验证的纵向切片。里程碑编号是稳定标识，不表示执行顺序。

执行顺序与时间盒：时间盒是规划参考，不是裁决权重；超盒时是否砍范围由项目负责人裁决，不以时间盒为由缩水设计（decisions.md 040）。

| 顺序 | 里程碑 | 时间盒 | 阶段 |
|---|---|---|---|
| 1 | M0 仓库与架构基线 | 3 天 | MVP |
| 2 | M1 PiRuntimeAdapter 切片 | 5 天 | MVP |
| 3 | M3 Coding 工具与最小治理闭环（含 CLI 审批） | 10 天 | MVP |
| 4 | M4 Session、Trace、Replay 与崩溃恢复扩展 | 10 天 | MVP 截止 |
| 5 | M2 瘦身 TUI（含中文终端 spike） | 5 天 | v0.2 |
| 6 | M5 上下文、Memory 与 Skill 注入 | 5 天 | v0.2 |
| 7 | M5.5 并行 worker 编排（轻档） | 8 天 | v0.2 |
| 8 | M5.7 外部工具链接入（MCP 客户端） | 4 天 | v0.2 |
| 9 | M6.5 Eval 冒烟（提前验证学习收益） | 5 天 | v0.2 |
| 10 | M6 受限后台 Reviewer | 7 天 | v0.2 |
| 11 | M7–M9 蒸馏、激活与完整 Eval | 15 天 | v0.2 |
| 外 | 垂直工具链（MCP server，独立仓库） | 不计入 | 路线图外，见 §M5.7 |
| 12 | 集成演示：Pigeon 的 worker 用工具链执行任务 | 2 天 | v0.2 |
| — | M10 外部 Memory Provider | 不计入 | v2 候选，本轮不做 |

MVP 累计 28 天；v0.2 在 MVP 之后追加 49 天，完整路线合计 77 天。

### M0：仓库与架构基线

目标：建立最小工程骨架，并把所有权和边界写成可检查规则。

交付：

- TypeScript workspace、构建、测试、格式化和依赖锁定；
- 核心包边界和依赖方向检查；
- `RunId`、`SessionId`、`EntryId`、`ExecutionId`、`ReceiptId` 等稳定标识；
- Event Log、Receipt 和 Candidate 的版本化 schema；
- 架构约束测试：TUI 不直接依赖执行器，业务层不绕过 `PiRuntimeAdapter`；
- 上游 `pi-agent-core` harness 层（session、tools、compaction、skills、telemetry）逐模块 reuse/own 审计表：import、包装、自建、参考实现四选一，附理由，作为 Adapter 设计输入。参考实现指借鉴外部设计但代码自有，必须注明设计出处（如编辑工具参考 oh-my-pi hashline 方案）。
  每行标注叙事角色（差异化证据 / 基础设施复用）；自有代码集中在治理闭环（审批、Receipt、Candidate、Eval、蒸馏），商品化能力（Agent Loop、消息模型、模型接入、存储原语、TUI 渲染）优先复用，且每个复用决策必须能一句话讲清理由。

完成证据：

- 全新环境可重复安装和构建；
- schema 往返与迁移测试通过；
- 依赖边界检查能够阻止禁止的 import。

### M1：PiRuntimeAdapter 最小纵向切片

目标：使用真实 `pi-agent-core Agent` 完成一个无副作用对话 Run。

交付：

- 创建、运行、中断、观察和释放 Pi Agent；
- 将 Pi 公开事件归一化为 Pigeon Runtime Event；
- 冻结模型、工具、上下文、Memory 和 Skill 注入快照；
- 注入快照 schema 包含 ToolPolicy 字段（M1 阶段允许为空集），模型、工具、权限、上下文四元组齐备；
- 记录实际工具广告和终止原因；
- 记录 Pi transcript 与 Pigeon Run/Turn/ToolExecution 的映射，不把 transcript 当作治理事实源；
- 不依赖 `pi-coding-agent InteractiveMode`。

完成证据：

- 公共 Adapter 测试跨越真实 Pi Agent seam；
- 同一快照可重建等价的无副作用 Run；
- 中断和异常能够得到明确终态或 `OutcomeUnknown`。

### M2：Pigeon 自有 TUI（瘦身，v0.2）——as-built（2026-09-13 回写，决策 024–034）

目标：基于 `pi-tui` 建立最小可用交互界面。MVP 不依赖本里程碑。

前置 spike（已完成，decisions.md 026）：pi-tui 0.84.4 最小控件 + 中文长文本流式输出 + 窗口 resize 重绘，在 Windows ConPTY 下逐格对拍判过，无需切 ink。结论绑定版本，升级 pi-tui 时按 §2 第 3 条重跑 spike-pi-tui。施工纪律：每消息一个 Text 组件、自有 chrome 只用 ASCII、不依赖 CPR/DSR 应答、resize 交给 pi-tui 全量重绘。

交付（事实，锚点 src/tui/、src/application/）：

- Application Shell、输入区和流式消息区：`tui/shell.ts`（TuiMainScreen + 消息区每消息一个 Text + 底行 Input + 纯 ASCII 状态栏）；流式文本经 Adapter 只读观察口 `subscribeStream`（024：text_delta 增量，不进 Event Log、不锚身份；045 修订：载荷加 kind 字段，thinking_delta 一并转发，M5 落地）；busy 语义（027：运行中拒绝提交、保留缓冲、不排队）。
- Run 状态、工具调用、错误和终止原因展示：状态栏五态；工具行"提议 → 结果"原位更新；轮次标记；run() 决议后终态行带四分类徽章（措辞与 cli trace 同一份 `application/format.ts`）+ errorMessage；listenerErrors 增量警告（D2 可见化）。
- 取消、恢复和会话选择入口：Esc 取消（032：模态优先、不 double-abort）；`/sessions`、`/resume <sessionId>` 走 application 命令层与 cli 同一份（031：单键三选一确认、rebind 换绑续跑）；退出三层形态（033：Ctrl+C 单击清缓冲、双击或 `/quit` 优雅退出，挂起审批 fail-closed）。
- TUI 关闭后 Run 状态仍由持久化核心保存：TUI 不持有权威状态；优雅退出经 adapter.dispose() 收尾（真实终端复验：运行中退出的会话有 run.ended、末轮 aborted）。
- 审批四键与 /grants 视图作为同一治理状态的投影继承，零新增治理语义：`tui/approval.ts` 面板 handler（029：Promise 挂起等四键，非决议键吞掉，三条取消路径 fail-closed）；`/grants /revoke /grants save` 走 `application/grants.ts`（030）。
- 附带落位：装配根、resume 流程、grant 与 session 命令层、共用措辞、工作区准备与恢复种子全部归 application/（025、030、031、034），cli 与 tui 共用；巡航规则 application-is-controller / actors-no-execution / actors-no-persistence-writes / tui-pi-tui-only。

完成证据（事实）：

- TUI 只通过 Application API 提交意图：`TuiRuntimeFace` 只有 run / interrupt / subscribe / subscribeStream / listenerErrors；`tui/shell.test.ts` 注入假运行面断言提交唯一通道；巡航规则守 Actor 边界。
- 重启 TUI 后可恢复并渲染已有 Session：`tui/session-view.test.ts` 的 /resume 全流程（人工确认写 resolution、哈希自动确证免菜单、restoredGrants 种子渲染）；真实进程强杀后 resume 剧本通过。M2 收口时渲染的是治理投影（工具、审批、Receipt、分类），消息文本不持久化（024）；M5 起正文与 thinking 持久化并渲染全部历史（037、045）。
- 自动化测试和一次人工终端验收分别记录：tui 37 例 + application 10 例 + adapter 流式 4 例（离屏 Mock Terminal + CJK 感知虚拟屏仿真）；人工验收七剧本经自建 ConPTY 桥（流式 CJK / 面板批准 / [a] 放权 / Esc 取消 / 强杀 + resume 哈希确证 / 两视图渲染 / 退出路径），证据 docs/audits/2026-09-12-m2-tui-acceptance.md（本地）。审计 docs/audits/2026-09-12-m2-review.md：无 P1 / P2，承重机制变异 15 项精确变红。

已知边界与偏差（如实登记）：

- resize 重绘无自动化用例（ConPTY 尺寸修改不可靠），只有 spike 实证与人工观察。
- 离屏测试用自研虚拟屏仿真器，真实终端正确性由 spike 与人工验收覆盖；Windows CI 无交互控制台。
- 崩溃残留不进会话列表（031 偏差；2026-09-13 裁决维持 015"唯一突出项是待对账"，靠 `--class unknown` 与 resume 屏呈现）。
- TUI [n] 拒绝无理由通道，负样本信号在 TUI 路径退化（029 修订，M6 前置）。
- 运行中不能 `/quit`（027 busy 不开旁路），退出用双击 Ctrl+C，[busy] 提示已说明。
- 工具调用轮在消息区留一个空行（观感，登记不动）：已关闭，见 035；/grants 长输出在真实终端曾观察到重复行（待验，见审计 note-3）：已关闭，判为不可复现，见 m2 裁决记录。

### M3：Coding 工具与治理闭环

目标：完成第一个需要人工审批的真实 Coding 工具纵向切片。M3 只做单次执行的最小账本，完整 Session、Trace 和 Replay 放到 M4。

交付：

- Tool Registry、参数校验、路径约束和风险分类；
- 只读工具与写工具的明确边界；
- Tool Call Proposal、人工审批和拒绝流程；
- 极简 CLI 审批交互（diff 展示 + 批准/拒绝），M3 不依赖 M2 的完整 TUI；
- 审批模式 approvalMode ∈ {prompt, yolo} 进注入快照（深冻结，模型不可自改）；yolo 是人事先批发授权，Receipt 照写，approvedBy 区分 human / policy:yolo，证据链不断；
- deny 清单绝对且工具名级精确匹配；参数内容模式识别显式排除，归 M6 安全扫描；
- 已批准请求与实际执行参数的完整性绑定；
- 执行 ID、最小 Receipt、幂等和 `OutcomeUnknown` 对账；
- 用统一 `ToolExecution` 生命周期承载 proposal、approval、dispatch、execution、settled 和 verification；
- 编辑工具：hashline（参考 oh-my-pi 的锚定与稀疏编辑格式，按内容哈希寻址行）作为可选编辑模式保留；缺省改为 replace（原文替换，原文须在文件里恰好出现一次），依据 decisions.md 062。hashline 的优化（锚点容错、回传新锚点、字符串补丁、过期恢复与块操作）留作后续方向，有使用方时再盘。

完成证据：

- 未审批写操作无法到达执行器；
- Agent、Skill 或 Reviewer 无法伪造人工批准；
- 一个派发前后崩溃点测试证明已派发写操作不会盲目重放；
- 冷启动能依靠最小 Receipt 完成单次执行对账。

### M4：Session、Trace、Replay 与崩溃恢复

目标：在 M3 最小执行账本之上，让每次运行都可追溯、可恢复、可解释。

交付：

- Pigeon 自有 Session/Run 状态与 Pi Session Entry 映射；
- 完整 Event Log、工具轨迹、审批和 Receipt 关联；
- Session Search；
- Replay 的只读重建模式；
- 明确区分业务失败、基础设施错误、取消和未知结果；
- 将 M3 的单次 Receipt 扩展为完整事件、审批、工具轨迹和最终验证的关联视图；
- 验证关键状态可以仅依靠 Event Log/Snapshot 冷物化，内存缓存、TUI 和 Pi 运行时重启后不会产生第二套事实；
- Grant 体系（§3.9 的落地）：审批提示四键 [y/n/a/d]、会话 grant 存储、/grants /revoke /grants save 命令、项目级 .pigeon/grants.json（版本化 schema，随 .pigeon/ gitignored，团队共享是将来的显式决策）、Event Log grant 四族（created / revoked / promoted / config-removed）、崩溃恢复后 grant 静默续命；同一 grant 只允许升格一次。

完成证据：

- 进程在关键 checkpoint 崩溃后能够冷恢复；
- Replay 默认不会重新执行真实副作用；
- Trace 可以从用户请求追溯到工具参数、审批、Receipt 和最终验证；
- grant 与固化规则命中时，deny 清单仍拒绝、熔断仍计数（变异反向验证：豁免 deny 的单点变异精确变红）；
- grants.json 的生产写入方只有 /grants save 与 /revoke config#N 两处人显式命令；
- 移除排在前面的固化规则后，历史账本对剩余规则的回指逐字不变。

### M5：上下文、Memory 与 Skill 渐进加载——as-built（2026-09-13 回写，决策 037、038、042–045）

目标：在保持上下文有界的同时积累长期知识。

交付（原计划，全部落地，事实与锚点见下方 as-built 块）：

- 可配置预算的常驻 Memory 和用户偏好；
- 完整历史进入 M4 建立的 Session Search，而不是塞入 system prompt；
- Session 开始时冻结 Memory 注入版本；
- Run 开始时冻结本次实际使用的模型、工具、Policy、Memory/Skill 版本和注入内容摘要；消息与执行状态仍可在 Run 内增长；每次模型请求保存实际 `llmContext` 摘要。
- Skill Catalog 在启动时只注入名称和简介；
- 按需加载完整 `SKILL.md`，再按需加载 references、scripts 和 templates；
- 每次实际读取和注入写入 Trace。

交付（事实，锚点 src/state/、src/persistence/、src/memory/、src/skills/、src/pi-runtime/、src/application/、src/cli/、src/tui/）：

- 消息正文与 thinking 持久化：`state/message-content.ts` 定义内容记录与规范序列化哈希，`persistence/event-log.ts` 写旁置内容文件（先内容后 entry），entry 带 contentHash，Event Log 升 v6；正文缺口在 trace / replay / resume 三处可见（037）。
- Session Search：`memory/session-search.ts` 全文扫描命中流，`memory/search-tools.ts` 的 search_sessions 与 read_session_entry 两个 read 档工具，`application/search.ts` 的 /search 命令层，cli 与 tui 共用（038）。
- 常驻 Memory：`memory/resident.ts` 两层读取与字符预算，装配根在会话开始拼进 system prompt 冻结，清单进 InjectionSnapshot v3（042）。
- Skill Catalog：`skills/catalog.ts` 登记与哈希清单，`skills/load-skill-tool.ts` 三重约束与清单比对，每次读取落 skill.loaded（043）。
- Run 快照与上下文指纹：Adapter 在每个 Run 开始落 run.started、system prompt 全文写内容文件，transformContext 只读观察落 llm.request，turn.completed 带 usage；会话列表显示总 token 与成本，trace 显示启动快照与每轮 usage（044）。
- 历史渲染与 thinking：`application/history.ts` 历史投影，TUI 在 /resume 后渲染全部历史（上限可配），thinking 流式与历史单独成段并弱化；cli trace 与 replay 加 `--with-content`（045）。
- 分层：巡航新增 memory-below-controller 与 skills-only-state-tools（022 修订）。

既定口径（decisions.md 037、038、042）：

- 消息正文持久化到旁置内容文件，entry 带内容哈希回指（037）；Session Search 第一版为全文扫描，模型经搜索与读原文两个 read 档工具访问（038）。
- 常驻 Memory 两层存储：项目级 `.pigeon/memory/*.md` 与用户级 `~/.pigeon/preferences.md`，都是人可直接编辑的 markdown；M5 写入方只有人，M8 激活候选时程序写入同一目录。
- 注入位置是 system prompt 追加段，会话开始拼一次即冻结；不走 transformContext。transformContext 只做只读观察（llm.request 摘要），并留给 M10 外部 Provider 的逐调用动态召回。
- 预算单位为字符数（按约 4 字符 1 token 估算），实际消耗由 usage 落盘事后校准；偏好永不截断，Memory 文件按配置顺序装到预算满，其余只列文件名，模型可用读工具按需读。
- 冻结身份：每文件 sha256 与字节数，整体哈希写入 InjectionSnapshot v3 的 memory 字段；会话中途改文件下个会话生效。
- Skill Catalog（043）：标准目录 `.pigeon/skills/<name>/SKILL.md`（前言 name / description）加可选 references、scripts、templates，用户级 `~/.pigeon/skills/` 同构，格式与 Claude Code / pi 兼容；加载器自写不借上游 harness；启动只把名称、简介、路径追加进 system prompt 与 Memory 同段冻结；按需读取走专用 read 档工具 load_skill(name, resource?)，三重约束 fail-closed：realpath 后必须在该 Skill 目录内、单文件上限默认 64 KiB 超出可见截断、来源只认登记过的 Skill 名；开会话时给每个 Skill 目录下全部文件算哈希清单写入 InjectionSnapshot v3 的 skills 字段，load_skill 读取时比对，不一致即拒绝并提示下个会话生效；每次读取除 tool 事件外另落 skill.loaded 观察记录（名、路径、哈希、是否截断）；scripts 在 M5 只读不执行；Skill 不扩权由构造保证并以"Skill 文本要求使用 deny 工具"用例证明。
- llmContext 与 usage（044）：InjectionSnapshot 此前从未落盘，M5 补上。system prompt 全文以 role 为 system 的记录写进 037 的内容文件，每会话一次带哈希；新增观察族 run.started（模型、策略、广告工具集、system prompt 哈希、memory 与 skills 哈希清单）与 llm.request（每次模型调用一条：消息条数、各角色条数、估算字符数、消息内容哈希的滚动哈希、system prompt 哈希），后者在 transformContext 只读观察，自包 try/catch 原样返回；turn.completed 加法式加 usage（input / output / cacheRead / cacheWrite / totalTokens / cost，源自上游 AssistantMessage.usage），会话摘要算每会话总 token 与成本。037 的 entry contentHash、043 的 skill.loaded 与本条的三处改动合并为 Event Log v6 一次升，迁移全部加法式。
- TUI 历史渲染与 thinking（045）：/resume 与重启后默认渲染全部历史，正文与治理投影按时序交织；安全上限默认 500 条可配，超过时最早部分折叠为一行提示；单条正文有渲染上限，toolResult 默认折叠；无 contentHash 的旧会话提示"M5 前会话，无正文"；cli 的 trace 与 replay 带正文加开关默认关；全部经 sanitizeTerminalText。thinking 块与 text 同形态持久化、默认开可关（037 修订）；subscribeStream 载荷加 kind 字段转发 thinking_delta（024 修订），TUI 流式与历史把 thinking 画成单独一段并视觉弱化；§3.8 不变，thinking 只是线索不是证据。

完成证据（事实）：

- 大量 Skill 不会线性膨胀初始上下文：`skills/catalog.test.ts` 一百个 Skill 各带长正文，目录段恰 100 行、不含正文。
- 当前 Session 内新增 Memory 不改变已冻结 prompt：`application/runtime-memory.test.ts` 会话中途改文件后发往模型的 system prompt 与快照清单哈希不变；Kimi 真实链路同样成立，修改在下个会话生效。
- Skill 资源读取有路径、大小和来源约束：`skills/load-skill-tool.test.ts` 三组约束（含目录联接逃逸）与清单哈希比对；Kimi 真实链路复验来源与路径两类拒绝。
- Skill 只能影响操作建议，不能扩大 Tool Policy：`skills/skill-governance.test.ts` 中 Skill 文本要求调用被 deny 的工具，yolo 下仍落 policy:deny 拒绝、文件不变。
- 门禁与变异：`npm run verify` 387 测试全绿；五个切片共 11 处承重变异全部精确变红；证据 docs/audits/2026-09-13-m5-ba94b53.md（含真实链路验收）。

已知边界与偏差（如实登记）：

- 推理档位未配置：Kimi For Coding 只在请求带推理档位时返回 thinking 块，生产装配不设档位，TUI 的 thinking 只在 streamFn 自行传档位时出现；是否把推理档位纳入快照与配置待裁决：已关闭，见 050（档位进快照并可配）。
- 常驻 Memory 的"配置顺序"尚无配置来源，缺省按文件名字典序。
- read_session_entry 与 load_skill 的域错误不进 tools/error-kind.ts 判据（分层所限），失败调用冷分类落"未知"：已关闭，见 050（错误对象归类标记）。
- OpenAI 兼容端点经 reasoning_content 映射 thinking 的线路未实测（现用 key 对该端点 401）。
- 索引不做：全文扫描在真实数据下单次超过约 2 秒再盘（038）。

### M5.5：并行 worker 编排（轻档，紧接 M5）——as-built（2026-09-13 回写，决策 040、048、049、050）

目标：在一个 Pigeon 进程内并行派出多个 worker，各自在隔离的工作区执行任务，审批汇聚到同一个人，每个 worker 的证据链完整，进程崩溃后各自可恢复。这是 §1 的第一个主角。

术语：worker 即本文其他章节（§3.6、§3.7、§8）所说的子代理，差别是它拥有独立 Session、会话文件与工作树，而不是父 Session 内的 Child Run；lane（§3.7）是同一 Session 树内的分叉，与 worker 正交；reviewer / explorer / implementer / tester 是 worker 的角色参数，不是执行体。执行体一层现有三种：工具调用、worker、后台 Reviewer（M6，只读、无工作树的 worker）。

形态（轻档）：

- worker = 一整套完整 agent：一个上游 Agent 循环 + 一个 PiRuntimeAdapter + 自己的上下文、工具集与策略、会话文件、隔离工作区。同进程多 Adapter，装配根每 worker 调一次 buildRuntime；worker 内部仍是 002 的工具串行与 run() 互斥。
- 隔离工作区第一版 = git 工作树（`.pigeon/worktrees/<sessionId>-<name>`，分支 `pigeon/<name>`），路径围栏的根即工作树；隔离单位是可插拔接口（M5.7 泛化）。
- 治理根与工作区根分离：`.pigeon/` 恒在主仓库根，工作区根按 worker 各异。
- 每 worker 一个会话文件，头部记 parentSessionId 与 parentRunId；父会话记 child.spawned / child.settled 两族（childSessionId、角色、委派策略摘要、轮次上限、结果摘要），Event Log 加法式升版。011 / 012 / 013 不动，任何文件永远只有一个写入者。
- 审批汇聚：ApprovalRequest 增 sessionId 与 worker 标签，父级面板排队、一次一个；决定写入该 worker 的会话文件并绑定其 executionId；worker 内 [a]/[d] 创建的会话 grant 只活在该 worker 会话内，随其结束作废。
- 权限：worker 策略只能从父策略中挑子集（构造规则保证）；正式的 `childPolicy ⊆ delegatedParentPolicy` 校验在治理编排搬到 application/ 之后补（下一档）；深度 1，worker 不能再派 worker；grants.json 只有人能写。
- 预算与取消：第一版只有轮次上限与墙钟上限；`/cancel <worker>` 走现有 abort 路径；token 预算等 usage 落盘（M5 第 5 件裁决）后补。
- 结果回收：worker 结束交回结构化结果（分支名、改动文件清单、receipt 列表、自述摘要）；合并由人用 git 做，Pigeon 不自动合并。
- 命令与投影：`/spawn <角色> "<任务>"`、`/cancel <worker>`、`/workers`；状态栏一行显示各 worker 状态；trace 从主会话可进入 worker 会话。
- orchestration/ 对外只暴露 spawn / cancel / status / awaitResult 四个动作与一个审批请求回调，这就是 §3.6 的 Job 边界；第一版只留接口不做第二种实现，多进程与跨机器是换实现不换调用方。
- 多窗口：多个 Pigeon 进程各自独立，窗口内治理加编排，窗口间只保安全不保协调：会话文件打开锁（拒绝两个窗口恢复同一会话）、grants.json 临时文件加改名原子替换、工作树目录名带会话编号。
- 演进路径（不在本里程碑）：父 agent 经受治理的 spawn 工具自行派 worker（默认审批、子集校验、深度 1）；确定性脚本调四动作做流水线。

worker 角色（默认权限由父策略子集构造）：

| 角色 | 默认权限 | 结果 |
|---|---|---|
| `reviewer` | 只读 Trace、Session 和 Receipt | 分析结果或 Candidate |
| `explorer` | 只读搜索与文件查看 | 结构化发现 |
| `implementer` | 自己工作树内的读写工具 | 分支与写入 Receipt |
| `tester` | 只读 + run_command，且策略限定为 `.pigeon/commands.json` 登记的命令 | 测试结果与验证 Receipt |

exec 类工具（decisions.md 048）：一个 exec 档工具 run_command，参数是命令字符串，模型自由提出。exec 档永不走"read 自动放行"，默认逐次审批且面板显示完整命令；[a] 对 exec 档收窄为"本会话放行这条一模一样的命令"（精确字符串匹配，§3.9 第五条不动），/grants save 升格为固化规则、/revoke 撤销，与既有六档流程同一套；yolo 照旧免审。执行不经 shell 解释器，参数数组直接 spawn；工作目录固定为 worker 工作树；环境变量白名单；墙钟超时；输出按字节截断并标记。Receipt 记命令、退出码、输出哈希与截断输出，加执行前后工作树文件清单差异。`.pigeon/commands.json` 为可选便利：给常用命令起短名，并作 tester 等角色的默认权限清单，主会话不受其限制。沙箱后置：自由命令的沙箱按平台适配（macOS sandbox-exec、Linux bubblewrap、Windows Docker），Sandbox 接口只有 run 一个动作，探测不到沙箱时不改变 run_command 的审批语义；这一步等真实需求再排。048 修订：Windows 上解析到 .cmd / .bat 时参数逐个匹配保守字符集（字母、数字与 _ . - / : = @），全部通过经 cmd.exe /d /s /c 作启动器运行，任一不通过即拒绝并指出参数；需要 shell 语义的命令只在人确认后以 shell 运行（审批面板对精确命令串的批准、带 shell 标记的 [a] 会话 grant 或 /grants save 固化规则），yolo 照 004 免审；面板原样显示命令串并标"经 shell"，Receipt 标明经 shell；commands.json 不是 shell 授权来源。

前置：S0 治理编排（六档排律、审批调用、四族落盘）从 PiRuntimeAdapter 整体抽到 application/（decisions.md 049，清 022 记账的债）：ToolGovernance 接口定义在 pi-runtime、实现在 application，Adapter 的 beforeToolCall 钩子只转发 decide 并把拒绝理由原样交回上游，零行为变化，现有测试断言不改全过，接缝变异（篡改拒绝理由一字）精确变红；002 的 per-tool shared/exclusive 演进不再是前置。四小件（decisions.md 050）：推理档位进 InjectionSnapshot 的 model 段冻结并随 run.started 落盘，来源两级（启动参数全局、worker 角色配置覆盖），缺省不请求推理，运行时自动调整列为 M9 之后候选；常驻 Memory 顺序按文件名排序为既定口径；域错误分类改为看错误对象标记不 import memory；reasoning_content 线路待有效 key 再测。

完成证据（原计划，事实见下方 as-built 块）：

- 两个以上 worker 并行在各自工作树写入，主仓库工作区零改动；
- 每个 worker 的每次写操作有 intent / decision / receipt；审批面板能区分来源，批准绑定到对应 worker 的 executionId；
- 进程崩溃后每个 worker 会话各自冷恢复，OutcomeUnknown 对账正常；
- 父会话 trace 能进入任一 worker 会话，child.spawned 与 child.settled 对得上；
- worker 无法获得父策略之外的工具，无法派孙 worker；
- 两个窗口同时恢复同一会话被拒绝；grants.json 写入中断不留半截文件（变异反向验证精确变红）。

交付（事实，锚点 src/orchestration/、src/application/、src/approvals/、src/state/、src/persistence/、src/tools/、src/pi-runtime/、src/tui/、src/cli/）：

- S0 治理编排搬家（049）：`pi-runtime/governance.ts` 定义 ToolGovernance 接口与宿主能力，`application/governance.ts` 原样承接审批闸整族逻辑；Adapter 的 beforeToolCall 只转发 decide 并原样交回理由，装配根组装后注入；测试断言不改，只换注入面。
- S1 根分离与多窗口小修（040）：装配根分治理根与工作区根（会话文件、grants.json、Memory、Skill 在治理根，工具围栏在工作区根）；`orchestration/worktree.ts` 以参数数组调 git 管理工作树（目录带会话编号）；`persistence/session-lock.ts` 会话打开锁（存活进程持有即拒绝、崩溃残留接管、同进程可重入）；`persistence/atomic-write.ts` 让 grants.json 临时文件 fsync 后改名替换。
- S2 worker 生命周期（040）：Event Log 升 v7，加法式新增 session.header / child.spawned / child.settled；`orchestration/workers.ts` 四动作加审批回调，先落 spawned 再建工作区与运行面、释放后落带结构化结果的 settled，派出失败同样收口；`orchestration/roles.ts` 角色表与委派子集构造（allow 只缩、deny 只增、审批模式不升级）加派出前子集校验；深度 1；轮次与墙钟上限走 interrupt；`application/workers.ts` 每 worker 调一次 buildRuntime。
- S3 审批汇聚（040，029 修订）：`approvals/queue.ts` 让主会话与各 worker 的审批一次一个；审批请求带来源会话、worker 标签与放权落点，面板显示来源行；worker 的 [a]/[d] 放权写进该 worker 自己的会话文件；拒绝理由与批准都落在对应 worker 的会话文件并绑定其 executionId。
- S4 结果回收与投影（040）：TUI 的 /spawn /cancel /workers 与状态栏 worker 行，收尾摘要投影到消息区；有 worker 在跑时拒绝 /resume，关窗先取消 worker 并等收尾记录；`application/worker-scope.ts` 让恢复 worker 会话回到它自己的工作树与委派策略（哈希确证以工作树为读取根），其编排器按深度 1 拒绝再派；trace 从主会话列出并进入 worker 会话、标注派出未收尾；会话列表显示父子关系。
- S5 exec 与四小件（048、050）：`tools/run-command.ts` 普通命令不经 shell 按参数数组执行，Windows 的 .cmd / .bat 参数过保守字符集时经 cmd.exe 启动器运行，需要 shell 语义的命令经人确认后以 shell 运行（048 修订），环境变量白名单、墙钟超时、输出截断、文件清单差异；exec 档永不自动放行，[a] 收窄为精确命令串，/grants save 与 /revoke 同一流程携带命令；Receipt 升 v4 记 exec 证据；`.pigeon/commands.json` 提供短名与角色允许清单，tester 为只读加 run_command 且只能跑登记命令；InjectionSnapshot 升 v4，model 段冻结推理档位，`--thinking` 全局值加角色表覆盖，随 run.started 落盘；常驻 Memory 按文件名字典序；域错误归类先读错误对象标记。
- 分层：巡航新增 orchestration-below-controller；application 可依赖 orchestration。

角色表 as-built（`orchestration/roles.ts`，默认工具再与父策略取子集；推理档位列第一版全部继承全局值）：

| 角色 | 默认工具 |
|---|---|
| `reviewer` | search_sessions、read_session_entry |
| `explorer` | read_file、search_sessions、read_session_entry |
| `implementer` | read_file、edit_file |
| `tester` | read_file、run_command（限 `.pigeon/commands.json` 为 tester 登记的命令） |

完成证据（事实）：

- 并行写入与零改动：`application/workers-e2e.test.ts` 在真实 git 仓库里两个 implementer 并行各写自己的工作树，主仓库已跟踪文件零改动，父会话两族配对，worker 会话头回指父会话、intent 与 receipt 齐全。
- 证据链与审批来源：`application/workers-approvals-e2e.test.ts` 两个 worker 并发请求审批一次一个，面板区分来源，批准、拒绝理由与放权各落对应 worker 的会话文件；变异去排队精确 3 红、放权落点回退精确 4 红。
- 崩溃冷恢复：`application/workers-recovery-e2e.test.ts` worker 死于 receipt 与 settled 之前，会话列表与 trace 标注未收尾，恢复回到其工作树并哈希自动确证；变异忽略工作树精确 1 红。
- trace 跨会话：`cli/trace-workers.test.ts` 父会话列出 worker 与进入命令，worker 会话回指父会话。
- 权限与深度：`orchestration/roles.test.ts`、`roles-tester.test.ts`、`workers.test.ts`；变异子集扩权与去深度检查均精确变红。
- 多窗口：`persistence/session-lock.test.ts` 以真实子进程持锁验证拒绝与残留接管，`persistence/grants-config-atomic.test.ts` 写一半即抛原文件不变；两处变异均精确变红。
- Kimi 真实链路（TUI + ConPTY，`spikes/tui-acc/run-m55.mjs`）：两个 worker 并行写各自工作树、主工作区零改动、审批面板区分来源；run_command 面板显示完整命令，[a] 后同一命令免审、改参数重新问；审批挂起时强杀进程，父会话标注未收尾，新进程恢复 worker 会话显示崩溃残留并续跑，worker 会话里再派被深度 1 拒绝；trace 从主会话进入 worker 会话；第二个窗口恢复同一会话被拒绝。
- 门禁与变异：`npm run verify` 457 测试全绿；六个切片与 048 修订共 13 处承重变异全部精确变红；证据 docs/audits/2026-09-13-m5-5-8ac7266.md。

已知边界与偏差（如实登记）：

- Windows 下 npm 等 .cmd / .bat 入口已由 048 修订闭合（保守字符集内经 cmd.exe 启动器运行，越界参数需人确认 shell）；沙箱仍后置（048）。
- tester 的命令允许清单在工具执行时判定：清单外命令批准后仍被拒绝、不启动进程，审批面板预先警告。
- /spawn /cancel /workers 只在 TUI 提供；主会话 Run 进行中时斜杠命令整体受 busy 语义拒绝（027）。
- 收尾摘要只投影到 TUI 消息区与 child.settled，不注入父 agent 上下文；父 agent 经受治理的 spawn 工具自派仍是演进项。
- 工作树位于主仓库 `.pigeon/worktrees/` 下，主仓库 git status 会列出未跟踪的 `.pigeon/`；worker 收尾后工作树保留供人审阅合并。
- 会话打开锁以 pid 判存活，pid 复用会误判；grants.json 原子替换未 fsync 目录。
- OpenAI 兼容端点经 reasoning_content 映射 thinking 的线路仍未实测。

### M5.7：外部工具链接入（MCP 客户端；decisions.md 041）——as-built（2026-09-14 回写，决策 041、051–055）

目标：Pigeon 治理任意 MCP server 提供的工具，使独立仓库的垂直工具链（Unity 资产管线、数据分析等）能在 Pigeon 下走完审批、回执与并行 worker。仓库内工具直接注册 Registry；外部工具只经 MCP，不做私有插件 SDK。

交付：

- MCP 客户端适配（stdio 与 streamable HTTP 两种传输）：启动 server、拉工具清单、映射为 ToolRegistration、转发调用；server 启动定义兼容读取 Claude Code 的 `.mcp.json`（工具链在 Claude Code 里调通后 Pigeon 零配置可接），Pigeon 独有的工具风险档覆盖写旁置 `.pigeon/mcp.json`（版本化 schema 同 grants.json：servers 按名、defaultTier 缺省 write、tools 按名给 tier、read 工具可带 pathConfinement；无 `.mcp.json` 时可在此直接定义 server；两份合并冲突以 `.pigeon/mcp.json` 为准，decisions.md 051）；oh-my-pi 的 MCP 桥接（server 生命周期、自动重连、工具映射进注册表）作为设计参考阅读，不引其包，上游仍锁 pi-agent-core 0.84.4。
- 风险档映射 fail-closed：MCP 注解（readOnlyHint / destructiveHint 等）只当线索，风险档以本地配置为准；未配置一律 write 档走审批；注解与配置冲突按更严的执行（声明只读配置 write / exec 按配置；声明 destructive 配置 read 按 write），冲突记进 run.started 工具集摘要的 declaredHint / effectiveTier / conflict 字段，trace 的 Run 头列出（decisions.md 052）。
- Receipt 证据泛化（decisions.md 053）：Receipt 升 v5 加第三个可选证据块 mcp，与 contentAfterHash（write）、exec（exec）并列：argsHash、resultSummary / resultHash、resultBytes / truncated、structuredHash、serverEvidence（MCP 返回 structuredContent 的 `evidence` 键原样收入，16 KiB 上限，哈希）；冷侧对账对 mcp 块只判回执在不在；治理链与记录族不动。有钩子的内部工具口径不变，需要改前改后哈希级证据的工具做成内部工具。
- 隔离单位泛化（decisions.md 054）：已由 M5.5 的 WorkspaceProvider 接口满足，M5.7 不动；Pigeon 侧形状封顶三种（git 工作树、普通目录、容器），第二种随首个非 git 工具链再加；领域隔离归工具链，Pigeon 经 MCP roots 告知 worker 目录路径；工作区隔离与沙箱是两个正交的轴。
- 按接入的工具链类型触发、不单独立项的前置：exec 沙箱（代码执行类）、预算档（超预算走审批，数据查询类）、账本敏感数据脱敏与保留期（数据类）、计划级审批（批准一份清单后连续执行，装配管线类）。

完成证据：

- 官方参考 server filesystem（锁 2026.8.31）指向 worker 工作树，在 Pigeon 下走完审批与回执，并被两个 worker 并行使用，回执 mcp 块与 changedFiles 对得上（decisions.md 055）；
- 未配置档位的 MCP 工具默认进审批（变异反向验证：改为默认放行精确变红）；
- 注解声明只读但配置为 write 的工具走审批；
- MCP server 不可用时核心 Coding Run 仍可运行；
- 官方参考 server everything（锁 2026.8.31）走自动化测试：注解与配置冲突落 run.started、prompts 进 Skill Catalog、工具清单变更通知、掉线留痕（decisions.md 055）。

交付（事实，锚点 src/mcp/、src/application/、src/state/、src/persistence/、src/tools/、src/skills/、src/orchestration/、src/pi-runtime/、src/cli/、src/tui/）：

- S1 配置（051）：`state/mcp-config.ts` 版本化 schema（servers 按名、defaultTier 缺省 write、tools 按名给 tier、read 工具可带 pathConfinement、可选启动定义）与纯合并判据；`persistence/mcp-config.ts` 读 `.mcp.json`（stdio 的 command / args / env，或 type http 加 url）与 `.pigeon/mcp.json`，同名冲突以后者为准，畸形或语义不明（无启动定义、路径约束挂在非 read 工具上、server 名不合法）响亮失败。
- S2 客户端与映射（041）：`mcp/client.ts` 每 server 一条连接，会话开始时拉工具与 prompts 清单后冻结，tools/list_changed 只记录；掉线按退避重启，本会话重启总次数有上限，超上限或启动失败即不可用，工具调用报环境错误、不再触达 server；`mcp/transport.ts` 自有 stdio 传输按 `tools/run-command.ts` 的 planMcpLaunch 启动（Windows 的 .cmd 经 048 启动器，字符集外参数以 shell 运行，引号与百分号拒绝），子进程环境为 048 白名单加配置显式给的 env；`mcp/registry-bridge.ts` 工具名 `mcp__<server>__<工具>`、inputSchema 原样透传（注册表放宽为也接受 type 为 object 的 JSON Schema）；`.dependency-cruiser.js` 新增 mcp-only-state-tools（022 修订）；@modelcontextprotocol/sdk 1.30.0 进 dependencies。
- S3 治理接线与证据（052、053）：`state/mcp-toolset.ts` 写死更严规则（声明只读配 write / exec 按配置、声明 destructive 配 read 按 write，均标冲突），按实际档位注册，六档排律、审批、intent 与 receipt 照走；run.started 加法式带 mcpTools（declaredHint / configuredTier / effectiveTier / conflict）与 mcpServers（状态、重启次数、错误、清单变更），trace 的 Run 头列冲突、非连接 server 与清单变更，启动时进程内同时警告；Receipt 升 v5 加 mcp 块（server、tool、argsHash、isError、resultSummary、resultHash、resultBytes、truncated、structuredHash、serverEvidence），server 在 structuredContent 的 evidence 键交的证据原样收入、超 16 KiB 截断标记、哈希按整体；server 给出返回即算已执行；Event Log 升 v8，读路径把内嵌 receipt 升到当前版本；replay 显示 mcp 摘要；冷侧对账对 mcp 块只判回执在不在。
- S4 prompts 与 roots（043 口径、054）：会话开始时对无必填参数的 prompt 调 getPrompt 取正文进 Skill Catalog（来源标 server，哈希清单按正文算），需要参数或取不到的不登记并记问题；load_skill 重取正文、哈希不符拒绝、大小上限可见截断、留 skill.loaded；client 广告 roots 为工作区根，worker 以其工作树为工作区根启动自己的 MCP 会话（有 MCP 配置时异步就绪，无配置时装配路径与 M5.5 相同）；implementer 继承父策略里的 MCP 工具。
- 装配与释放：cli 与 tui 在装配前异步启动 MCP 会话，装配失败先关 server；disposeRuntime 依次释放 Adapter、MCP 连接与会话文件；tui 的 /resume 换绑按目标会话工作区根启动 MCP 会话。
- S5 验收夹具与剧本（055）：devDependencies 锁 server-filesystem 与 server-everything 2026.8.31；`spikes/mcp-acc/.mcp.json` 与 `spikes/mcp-acc/.pigeon/mcp.json` 夹具，`run-everything.mjs` 自动化剧本，`run-filesystem.mjs` Kimi 真实链路剧本。

完成证据（事实）：

- filesystem 被两个 worker 并行使用（`spikes/mcp-acc/run-filesystem.mjs`，Kimi For Coding + ConPTY）：两个 implementer 各自的 filesystem server 以其工作树为 roots，list_allowed_directories（read 档）自动放行、不产生 intent，write_file（write 档）逐次人工审批且面板标明来源 worker 与工具名；回执 mcp 块的参数哈希与 intent 原始参数对上，返回摘要点名的文件即 changedFiles 里的新文件，文件内容正确；主仓库工作区零改动；主会话 `npm --prefix app test` 经 cmd.exe 启动器运行、退出码 0。
- 未配置档位的工具默认进审批：`persistence/mcp-config.test.ts` 与 `application/mcp-e2e.test.ts`；变异缺省档改 read 精确变红（计数见审计）。
- 注解声明只读但配置为 write 的工具走审批：`application/mcp-e2e.test.ts`（未配置的 echo、声明 destructive 配 read 的 peek 均问人，配置 read 且无冲突的 look 自动放行）；变异去冲突规则精确变红。
- MCP server 不可用时核心 Coding Run 仍可运行：`application/mcp-e2e.test.ts` 与 everything 剧本强杀 server 进程后，MCP 调用报环境错误、read_file 照跑、下个 Run 的 run.started 记 server 不可用、trace 头可见；变异去可用性守卫精确变红。
- everything 自动化（`spikes/mcp-acc/run-everything.mjs`，16 项核对全过）：经启动器拉起；echo 的冲突落 run.started 并走审批；simple-prompt 进 Skill Catalog 并由 load_skill 读取留痕，三个带必填参数的 prompt 不登记；初始化后条件工具注册触发的工具清单变更通知被记录；echo 回执带 mcp 块；强杀后核心 Run 照跑并留痕。
- 门禁与变异：`npm run verify` 498 测试全绿，dependency-cruiser 239 模块 1589 依赖零违规；五处承重变异全部精确变红；证据 docs/audits/2026-09-14-m5-7-d99d693.md。

已知边界与偏差（如实登记）：

- tools/list_changed 只记录，本会话暴露的工具集不变、下个会话生效：Adapter 的注入快照按会话冻结（§2 规则 4），不做 Run 间换工具集。
- 注解冲突按"声明只读而未逐工具配置"也会标出，缺省 write 的 server 冲突项较多，trace 的 Run 头一行会很长。
- 审批发生在调用之前，server 已不可用时写档调用仍先问人、批准后报环境错误。
- filesystem 的 structuredContent 不带 evidence 键，真实链路回执的 serverEvidence 缺省；serverEvidence 的收入与截断由 everything 之外的夹具测试覆盖。
- 只有 implementer 继承主会话的 MCP 工具，只读与测试角色暂不接（decisions.md 041 修订）。
- worker 有 MCP 配置时运行面在 run 时异步就绪，装配失败按 worker 失败收尾而非派出失败，落 child.spawned 与 child.settled 两条记录（decisions.md 040 修订）。
- 需要参数的 prompt 不进目录；resources 读取、sampling、elicitation、HTTP 鉴权与 OAuth 按开工范围不做。
- 验收工作区根目录不放 package.json：npx 按最近的 package.json 定前缀。

### M6：受限后台 Reviewer——as-built（2026-09-16 回写，决策 064、065）

> 已退役（decisions.md 137、158）：Reviewer、候选暂存与扫描随第一版学习闭环整套删除，本节保留为历史记录。

目标：主 Agent 完成若干轮交互或工具调用后，异步判断是否值得形成经验候选。Reviewer 使用独立 Agent 实例和一次性的 `ReviewRun`，读取主 Session 的不可变快照，不创建 lane、不向主 Session 写入分析消息。M6 不阻塞 M6.5 的最小评测。

交付：

- `BackgroundReviewScheduler` 和独立 `ReviewRun`；
- 主 Session 的不可变对话、Trace 和 Receipt 快照；
- 精确的 Reviewer 工具白名单；
- 同模型完整快照与辅助模型 digest 路由策略；
- Memory、Skill Candidate 暂存；
- 重复、提示词注入、外泄模式和不可见 Unicode 扫描。
- 经验覆盖度与内部自洽性筛查（参考 W2S 的 coverage/consistency 检查；LLM 仅作筛查，判决归确定性验证与人工审批，见 §3.8）。
- 前置（decisions.md 029 修订）：TUI 审批面板的 [n] 是单键拒绝，理由恒为默认文案，decision 记录的逐字拒绝理由只有 cli 路径齐全；接入蒸馏前补 TUI 拒绝理由通道，或在 Episode 标注上按来源 Actor 区分负样本信号强度，不得把 TUI 路径的默认文案当作人类给出的理由。

完成证据：

- Reviewer 不能调用终端、消息、浏览器、任意文件写入或 Coding 写工具；
- Reviewer 不修改主 Session 和当前 RunSnapshot；
- Reviewer 崩溃、超时或输出畸形不影响主 Run；
- 所有产物都停留在 Candidate 状态。

说明：缓存复用取决于具体模型提供方。Pigeon 只保证不破坏主会话前缀和缓存可用性，不把“必然命中缓存”作为产品承诺。

交付（事实，锚点 src/review/、src/application/、src/orchestration/、src/state/、src/persistence/、src/pi-runtime/、src/cli/、src/tui/）：

- 接入形态（064）：Reviewer 复用 worker 编排，是无工作区的 reviewer worker。工作区联合以加法式新增"无工作区"成员，派出与收尾复用 child.* 两族；收尾结果可携带结构化内容，候选由 Controller 解析落盘，Reviewer 不持有任何写工具。角色表新增可选的模型接入覆盖列，四个角色缺省留空、继承主会话。
- 冻结快照与白名单（064 子裁决 ⑤）：`review/snapshot.ts` 把被审的那一次 Run 物化成冻结快照（对话增量加少量前情、Trace 投影、Receipt 摘要）；单条正文超过 2,000 字符头尾保留并标注省略字符数，整份超过 24,000 字符从最早处丢弃并标注省略条数，省略处保留条目号。reviewer 白名单只有 `review_snapshot` 与 `review_entry` 两个 read 档工具，作用域绑定被审 Run，参数里没有会话或 Run 入口；两者不在主会话工具清单里，按"只读且绑定父会话自己的 Run"豁免子集约束，父策略的 deny 照旧生效。
- 调度（064 子裁决 ①②④）：`review/scheduler.ts` 缺省每 8 轮触发一次，Run 结束固定补一次；`--review-every <N>`（0 表示只在 Run 结束审）与 `--no-review` 只在 cli REPL / resume 与 tui 接受；配置冻结进注入快照（v6）并随 run.started 落盘。全局同时只跑 1 个审阅：按轮次触发遇忙则跳过并落 review.skipped 观察；Run 结束补审遇忙则排队（064 修订，每会话最多一个，新请求覆盖旧请求），上一次审阅收尾后立即执行；会话退出或释放时取消排队中与进行中的审阅，落一条原因为退出的 review.skipped（可选 reason 字段区分忙与退出，缺省视为忙）；预算 12 轮、3 分钟、40,000 token（worker 上限新增可选 token 项与 token-limit 收尾状态），超限按中止、不产出候选。挂载点在 `application/session-runtime.ts`，只挂 cli 与 tui 的主会话；worker、headless、Eval 与 Reviewer 自身会话不挂。
- 候选暂存（065）：候选 schema v2 只放不可变元数据，状态不入 schema、由 candidate.proposed 与 candidate.screened 两族现算（已提出 / 已扫描 / 扫描拒收）；正文按内容哈希原子写入 `.pigeon/candidates/<种类>/<名字>-<哈希前 16 位>/`，同哈希跳过，同名改内容即新候选并标记取代；Skill 为 SKILL.md、Memory 为整个 markdown 文件（Policy 形态自 094 起停止产出，旧候选仍可读、可列，但不可批准、不可激活）。Reviewer 结果不可解析时只落 review.unparsable 观察、不落文件。v1 候选从无写入方，迁移成"由 v1 迁移"的保留形状，不编造字段。
- 扫描（065 子裁决 ④）：`review/scan.ts` 确定性规则——不可见字符（Unicode Tags、零宽、双向控制、变体选择符）、注入短语、外泄模式（curl / wget、密钥形态、可疑 URL）、可执行脚本目录；命中照常暂存并标拒收，扫描器版本随筛查记录落盘。
- 入口（064、065 子裁决 ⑤）：`pigeon review <sessionId> [--run <runId>]` 对冷会话手动补审（与自动审阅同一派发器，Reviewer 自身会话拒审）；`pigeon candidates [--all]` 跨会话只读列出候选，缺省隐藏扫描拒收项。trace 与 replay 同步呈现候选、跳过与不可解析记录。
- 已知边界：辅助模型 digest 路由、经验覆盖度与自洽性筛查、模型筛查标注的实际产出未做（筛查记录已留可选字段）；证据核验状态未落地（M6 状态只走到已扫描 / 扫描拒收）；cli REPL 退出时会取消在跑的审阅。

完成证据对照：

- 不能调用终端、消息、浏览器、任意文件写入或 Coding 写工具：reviewer 委派策略只有两个只读快照工具，Reviewer 会话 run.started 的广告集逐条断言只有这两个（`review/tools.test.ts`、`application/review-runtime.test.ts`）。
- 不修改主 Session 和当前 RunSnapshot：Reviewer 只经冻结快照读取，写入主会话文件的只有 Controller 落的 child.* 两族、候选两族与审阅观察，不写消息与 entry；主会话注入快照在会话开始时冻结，审阅不改它。
- 崩溃、超时或输出畸形不影响主 Run：调度器吞掉派出与收尾异常，Reviewer 模型接入抛错时主 Run 照常完成；超预算以上限状态收尾不产出候选；输出畸形只落 review.unparsable（`review/scheduler.test.ts`、`application/review-runtime.test.ts`、`review/candidates.test.ts`）。
- 所有产物都停留在 Candidate 状态：候选只写暂存目录（缺省不加载），状态最高到已扫描，批准与激活归 M8。

### M6.5：Eval 冒烟

目标：在子代理和蒸馏链全自动完成前，先证明“经验能带来可测量改善”这个论断可测。M6.5 只依赖 M4 的 Trace/验证和 M5 的手工注入，不依赖 M5.5 或 M6。

交付：

- 固定任务集（5–10 个任务）、固定仓库快照、固定模型与预算；
- 手工编写一个 Skill Candidate；
- 三向对照运行：无 Skill、候选 Skill、已批准 Skill，各运行固定次数；另设未参与候选提炼的保留任务集，检查迁移效果；
- 成功率、误成功率、工具调用数、延迟和成本的对比报告。

完成证据：

- 至少一条完整链路：Trace → 失败 → 手工 Candidate → 审批 → 重跑 → 指标变化；改善与证伪都计为有效证据；
- 业务成败由确定性验证器判定，LLM 只用于轨迹诊断。

既定方向（decisions.md 046）：Eval 用自建薄 runner，不引入外部评测框架作主干。runner 只做四件事：读任务目录、准备仓库快照、经 headless 运行入口跑 Pigeon 若干次、调验证器并从账本出 JSONL 结果；三向对照靠 042 / 043 的注入冻结开关；指标全部从 Event Log 算（验证器回执、tool 事件、审批与恢复记录、044 的 usage）；统计按 M9 规范自写；报告先出 markdown 表不做界面。任务目录格式对齐公开基准（说明 + 验证脚本 + 环境声明，Terminal-Bench 形态），公开任务可导入；Terminal-Bench / SWE-bench 适配器为可选项，让 Pigeon 作为 agent 接入以取得可对比分数，不影响主角。M6.5 在本机工作树跑不做容器隔离；容器隔离随 exec 沙箱一并考虑。headless 运行入口（decisions.md 056）：进程内 API 复用 M5.5 的 worker 运行面工厂，`pigeon run` 子命令是它的薄壳（任务描述、--yolo、--max-turns、--wall-clock、--json、退出码按终态映射）；无人值守下的审批只有 prompt 加 fail-closed 拒绝、显式 yolo、固化规则加 yolo 三种合法形态；"需审批次数"从回执反推（write / exec 档且 approvedBy 为 policy:yolo 的调用数），不新增记录。任务目录格式（decisions.md 057）：`eval/tasks/<id>/` 一任务一目录，task.md 说明、task.json 元数据（repo 与 ref、预算、验证器命令与超时、tags、holdout）、verify 脚本、README；快照为 git 引用经 WorkspaceProvider 开工作树；验证器由 runner 在收工后作为独立子进程执行，只看工作区最终文件。验证器接口（decisions.md 058）：退出码三值判决（0 通过、非 0 失败、超时或崩溃为未判定）加可选 JSON 尾行；误成功第一层为"agent 自报完成但验证失败"，第二层反向断言脚本留接口；判决记观察族 eval.verified 落在该次运行的会话文件里。验证资产由 runner 在验证前从任务目录回填工作区（058 修订）。冒烟对照（decisions.md 059）：候选 Skill 放暂存目录 `.pigeon/candidates/skills/`，headless API 以 skillRoots 切换无 / 候选 / 已批准三条件；Skill 由人从真实失败手写，自动提炼归 M6 与 M7；任务集 5 到 10 个在本仓库锁定提交上，2 到 3 个标 holdout，每任务每条件跑 3 次。Eval 用的 Skill 放入库的 `eval/skills/<name>/{candidate,approved}/`，skillRoots 直接指向；memoryRoots 为空（059 修订）。结果落点（decisions.md 060）：每次运行一个目录 `docs/audits/eval/<日期>-<基线号>/`，results.jsonl 与 report.md 入库，实验会话文件落该目录下独立治理根 `.pigeon/` 不入库、不进日常会话列表；015 的会话列表重审推迟到日常会话数真实变多时。

交付（事实，2026-09-14 回写，锚点 src/eval/、src/application/、src/skills/、src/memory/、src/orchestration/、src/state/、src/cli/、eval/）：

- S0：源码注释措辞统一；`src/migration-completeness.test.ts` 扫描全部 `*_VERSION` 常量并对每个版本化 schema 从 v1 逐级迁移校验（架构审计建议第 2 条）。
- S1 headless 入口（056）：`application/headless.ts` 与 worker 共用抽出的装配内核，无父会话、无角色、无审批通道（prompt 档 fail-closed），带轮次 / 墙钟 / token 上限，结果从 Event Log 算；`pigeon run` 子命令（--json、退出码映射）；Skill Catalog 与常驻 Memory 支持显式根。
- S2 任务目录与快照（057）：`eval/task.ts` 加载器，`eval/snapshot.ts` 从任务 ref 开工作树（仓库根与治理根分传、baseRef、`<taskId>-<condition>-<n>`、node_modules 联接、跑完清理、崩溃残留续跑前清理）；分层规则 eval-below-actors（022 修订）。
- S3 验证器（058 含修订）：`eval/verify.ts` 回填验证资产后独立子进程判决，退出码三值、尾行 JSON、误报第一层；Event Log 升 v9 加 eval.verified，trace Run 头与 replay 显示。
- S4 runner 与结果（059、060 含修订）：`eval/runner.ts` 三条件 skillRoots、memoryRoots 为空、交错执行、续跑跳过；`eval/report.ts` 成功率表、holdout 单列、三元结果、pairwise delta、成本；`pigeon eval` 子命令。
- S5 内容：`eval/tasks/` 8 个任务（3 个 holdout）在 8e76567 上，每个实测参考改法前红后绿；`eval/skills/pigeon-coding-pitfalls/candidate/` 从审计里模型真实失误手写。

完成证据（事实）：

- 业务成败由确定性验证器判定：`eval/verify.test.ts`（三值、回填防改测试、误报、eval.verified 落盘与 trace）；变异超时改判失败、去回填均精确变红。
- 冒烟链路：Kimi For Coding 上 none、candidate、approved 各 24 次运行，results.jsonl 与 report.md 在 docs/audits/eval/2026-09-14-8e76567/；成功率 none 24/24、candidate 23/24（误报 1）、approved 21/24（误报 2），candidate 与 approved 的 SKILL.md 逐字节一致；本配置下未测出改善（基线触顶）：任务集对该模型触顶，论断可测、未被支持；实测到的区分信号是成本与过程（有 Skill 的条件平均多约 3 轮、多约 4 次工具调用）。
- 门禁与变异：`npm run verify` 534 测试全绿，dependency-cruiser 256 模块零违规；八处承重变异全部精确变红；证据 docs/audits/2026-09-14-m6-5-8e76567.md。

已知边界与偏差（如实登记）：

- approved 条件在项目负责人审阅通过后补跑，与前两个条件没有交错执行。
- SKILL.md 把编辑失败说成计入熔断，与实现不符（熔断只有治理阻断同一 key 累计满 3 次与上游拦截同一工具连续 3 次两类）；为保持 candidate 与 approved 逐字节一致本轮不改，下一版 Skill 修正。
- 任务集对当前模型触顶，成功率没有区分度；M9 的任务集需让无 Skill 基线明显低于满分。
- 样本只证可测，不做显著性结论；反向断言、容器隔离、外部 harness 适配器未做。
- runner 单进程顺序执行；本机内存不足时进程可能被终止，以续跑恢复。

### M7：整棵会话树的对比式经验提炼

> 部分退役（decisions.md 137）：对比提炼器与候选产出删除；成败标签与 /spawn --attempts 用到的 episode 部分保留。本节保留为历史记录。

目标：比较成功与失败分支，而不是只总结当前活动叶子。

交付：

- 通过 Pi 公开 Session API 读取完整树；
- 会话树读取只允许出现在 `PiRuntimeAdapter` 内，业务代码不直接接触上游格式；
- 针对 Pi Session Format 的契约测试，格式漂移时测试先于运行失败；
- 启动时探测上游版本，与已验证版本不匹配时明确告警，不静默继续；
- `EpisodeBuilder` 从共同祖先切分独立尝试，共享前缀只计算一次；
- `OutcomeLabeler` 标记 `Passed`、`Failed`、`Abandoned`、`Unknown` 和 `InfrastructureError`；
- `ContrastiveDistiller` 提炼步骤、前置条件、失败案例和适用范围；
- Candidate 保存原始 Entry、Branch 与内容摘要；Trace 与 Receipt 由会话与 Run 现算，不另存副本（decisions.md 075 修订）。
- 对比机制锚定 ExpeL：成败分支成对比较后抽象，而非单轨迹总结；
- 蒸馏产物分三形态——lesson（教训）、workflow（流程）、procedure（步骤集）——不压成单一摘要；
- `SkillCandidate` 内部结构参考 W2S 的 Skill-IR 分解（routing / workflow backbone / semantics / attachments），仅作内部结构参考；
- `preconditions`/`applicability` 以纯文本起步；结构化触发条件（paths/tools/taskKind 机器匹配）为可选项，观察到误触发率后再决定是否升级。

Outcome 判断优先级：

1. 确定性测试和验证 Receipt；
2. 工具退出码及结构化结果；
3. 用户明确确认或否定；
4. Repository 或业务状态观察；
5. 模型推断只能给出建议标签或 `Unknown`。

完成证据：

- 当前叶子没有验证时不会被标为成功；
- 失败分支只产生 failure case，不会被写成长期事实；
- 摘要只用于定位，最终证据来自原始节点和工具结果；
- 相同共享前缀不会因分支数量被重复强化。

既定方向（decisions.md 068–079）：

- 前提修正：Pigeon 持久化数据中原本没有会话树（entry 只有线性序号，resume 从零重建上下文，未实现分叉）；上游 pi-agent-core 0.84.4 提供会话树存储、分支上下文还原与后端契约测试，但把 Agent 运行接入会话树的 AgentHarness 为桩实现。"通过 Pi 公开 Session API 读取完整树"由 Pigeon 补写穿与分叉续跑接线实现；契约测试对象为 core 0.84.4 的 v4 JSONL 格式，使用上游 `createSessionBackendConformance`（非 pi-coding-agent 文档中的 v3 格式）。
- 对比素材两类，均在本里程碑完成，先比对后分叉（068）：同任务独立尝试（Eval 同任务多次运行、并行派发同一任务的多个 worker），与上游 Session 树上的分叉。Pigeon Event Log 仍是唯一权威事实源，会话树是派生结构。
- 同任务认定用显式任务标识（069）；Episode 边界按来源定：同任务比对取尝试会话的首个 Run，分叉取分叉点到叶子的路径，共享前缀只算一次（070）。
- Eval 之外的成功判定由程序在尝试收尾后独立执行配置的验证命令并落通用验证记录（071）；五个标签的判定边界见 072，成功只认验证通过，放弃与基础设施错误不进成败对比。
- Run 内局部对只取人写的拒绝理由与域错误后成功重试，只产出教训（073）。
- 提炼器复用 worker 机制作为新角色，并行同任务全部收尾后与分叉叶子验证后自动触发，另有 `pigeon distill`（074）；候选升 v3 加对比来源块（075）；输入沿用 M6 截断口径并按对比结构裁剪（076）。
- 会话树在分叉发生时才建立，账本记分叉记录，树为可重建的派生缓存（077）；分叉时文件经 git 快照回到分叉点、在独立工作树中续跑（078）；分叉由人手动发起，失败自动分叉重试为缺省关闭的可选项（079）。

### M8：Candidate 验证、审批与激活

> 已退役（decisions.md 137、156、158）：候选验证、审批与激活删除；回放中的一致性核对（模型、预算、工具不得比原尝试更宽）保留，接到跑批器的单步重跑上，供记忆的定点对照使用。本节保留为历史记录。

目标：形成完整而不可绕过的经验生效链。

交付：

- Candidate diff、来源链和安全扫描结果；
- Memory/Skill 的双回放验证：正回放（失败分支 + 经验应当变好）+ 负回放（成功兄弟分支 + 经验不应变差），堵"经验拟合来源 Trace"的循环论证；
- 回放判定：N 次（3–5）+ Wilson 置信区间；pass@k 与 pass^k 分开报告，单次通过不构成证据；
- 命名边界（decisions.md 014）：M4 的 `pigeon replay` 与 state/replay 是只读重建，永不执行副作用；本里程碑的回放验证是沙箱重执行，落在 replay/ 目录，命令与类型另起名字，不复用 replay 一词；
- 验证 Receipt 和环境摘要；
- 人工批准、拒绝、撤销和 supersede；
- 已激活 Memory、Skill 的不可变版本；
- 下一 Session 才使用新版本。

完成证据：

- Candidate 不能通过数据库字段修改或内部工具调用跳过审批；
- 批准内容与最终激活内容摘要一致；
- 验证环境变化时旧批准失效或要求重新确认；
- 激活器在代码层面不得依赖放权写入模块，由分层规则机检（取代原"Policy Candidate 的激活路径与普通 Skill 写入路径物理分离"，见 094）。

既定方向（decisions.md 081–093）：

- 措辞修正：本里程碑的回放验证是在独立工作树中的重执行，隔离手段为固化命令规则而非沙箱——代码中尚无沙箱实现，048 已将其后置；容器沙箱排入 M9 前置（083）。
- 成败判定的前提是验证命令可得：改为项目级配置，人配一次本项目所有会话继承，不做自动推断（081）。
- 执行体复用 worker 编排新增验证器角色，起点用 M7 的快照回到任务开始处，统计沿用 Eval 结果行；命名仍守 014（082）。回放单设并发闸，预算与模型沿用被验证那次尝试，不得放宽（087）。
- 判定为三值——通过、未测出、回归——加大效应门槛，四组固定 N 全跑不中途停，pass@k 与 pass^k 分开报，Wilson 区间进回执但不作判据（084）。回归不可批准，未测出可由人显式批准并标注未经回放证实（092）。
- 回放在临时治理根中按正常格式装载经验，走与真激活相同的装载路径（085）；触发缺省人工，另给无人值守的自动开关（086）。
- 审批走 CLI 子命令，TUI 只提示待审数量（088）；账本新增验证回执、决定、激活三族，决定族带动作与理由来源字段（089）。
- 激活路径永不自动改放权文件或命令规则，由分层规则机检钉死（090；Policy 形态随 094 停止产出，其只读建议文件与专属规则一并删除）。
- 环境摘要记全，批准失效只看模型、经验集合内容哈希、预算参数、验证命令四项封闭清单（091）。
- 激活为复制到正常目录、人仍可编辑，启动时比对哈希标注漂移；撤销不追溯，取代与候选取代同构（093）。

### M9：Eval 与可测量改进

目标：证明经验学习带来可重复改善，而不是只增加文字。

交付：

- 固定任务集 20–50 个（可从真实 Trace 改编）、仓库快照、模型、工具、预算和验证器；M6.5 冒烟仍维持 5–10；
- 无 Skill、候选 Skill、已批准 Skill 三类对照运行；
- 成功率、误成功率、工具调用、延迟、成本、审批次数和恢复结果；
- 失败分类和证据链接；
- 回归门槛与自动撤回建议。
- 统计报告规范：不报裸胜率，报 per-task 三元结果 + pairwise delta + Wilson 区间；paired 比较用 McNemar exact；
- rotating holdout 子集（M9 后期）：滚动更换的保留任务，防固定题集被蒸馏链污染。

完成证据：

- 至少有一条完整链路：Trace → 失败 → Candidate → 验证 → 审批 → 重跑 → 指标改善；
- 业务成功由确定性验证器判断，LLM Eval 只诊断轨迹；
- 不把单次成功或 Judge 偏好写成稳定能力结论。

既定方向（decisions.md 096–101）：

- 题源推翻重来：自造的 8 道题经实测全部触顶（40 次运行全部通过），交付中"固定任务集 20–50 个、可从真实 Trace 改编"不再适用；正式度量改用外部基准 SWE-bench Verified，先跑 50 题子集打通管道（含以标准答案补丁自检判分管道），再扩到 100–150 题（097）。自造题降为冒烟，只留三道（100）。
- 只报相对差异：数据集存在训练数据污染，但污染与坏测试对两个对照条件是共模项，做差分时抵消；因此结论一律以同模型下的相对差异呈现，绝对分数不作为能力指标对外报（097）。
- 对照条件四组：无经验、候选经验、已激活经验，外加一条公开最简 harness 的基线对跑；基线只在扩量后的正式测量执行（099）。
- 执行隔离由容器提供，且与评测环境合一：外部基准的实例镜像内工作区已处在基准提交、依赖已装好，agent 进容器干活、完事取 diff 交官方判据判分。容器由此同时承担隔离与评测环境两职，原定的沙箱选型（083）并入本项。
- 只替换不并存：工具不感知工作区形状，抽出执行端接口，本地与容器各一份实现，快照与分叉挂同一层（096、098）。
- 统计口径：每题每条件跑一次、预算优先投向题数，二值配对用 McNemar 精确检验；回放验证仍按四组各 N 次，两处口径不同是设计（101）。

第一阶段结论（decisions.md 119–124）：

- 评测管道可信：判据经标准答案自检、三处答案泄漏（联网取上游修复版、镜像内 git 历史、未固定采样）已堵并量化（泄漏抬高约 18 个百分点），最终基线 50 题两轮通过 31 与 34，同条件噪声为 50 对翻转 7 题。
- 学习闭环第一版按原设计运行后判定不可用，四个根因见 123；主张一改为"同一代码库上越用越省"。
- 随后的浪费分析（审计第十五节）显示"越用越省"在知名仓库上无可测余量，第二版暂缓（124）。测量集无经验基线停在 70/99 道，逐题落盘可续跑。
- 下一步：工程收尾（入库、README、可用性、许可证），再用同一套浪费分析在模型不熟且结构复杂的候选仓库上先量浪费，有余量再决定第二版。

连续工作流与第二版记忆（decisions.md 125 至 159；与上文交付条目及前两段方向冲突处，以本段为准）：

- 测试床与主张：SWE-bench 题目在时间与空间上零局部性，不适合评估"同一代码库上越用越好"，测试床改为连续工作流（125）；主张一改为长时程一致性——agent 在同一代码库上延续式连续工作，能否不让错误累积、不破坏既有约束（126）。
- 两层评测：四条件整流实验（完整 Pigeon、去掉验证门与回退、去掉记忆、最简 agent）在外部仓库 strands-agents/harness-sdk 的 Python 部分上进行，回答整体一致性（149、150、152）；记忆的定点对照在本仓库提交流上进行（局部性强），从同一起点按带记忆、不带、带无关记忆三组各重跑 5 遍，主判据为按步骤配对的变红比例差（138、139、151、157），执行体为跑批器的单步重跑（156）。
- 成题与流：题面为提交信息加该提交新增或修改的测试文件全文（127）；题与题之间的非题提交按类型处理——测试类套用人的版本、纯格式跳过、有代码无测试的作维护步、超大提交处重置（141、153）。
- 流控制：收工前过验证门，不过即把报错作为新一轮发回同一会话回炉，最多 3 轮；修满或预算耗尽即把这一步撤回到起点，撤回的题留空、后续照常（142、143、154）。
- 度量：主指标为全量测试通过率随步数的曲线，比较终点值，分母为人在该步代码上通过的用例（145 修订）；各条件先跑 1 遍，终点差距不足 10 个百分点的两条件各补到 3 遍；各条件每步同一个总预算，回炉消耗计入，开跑前试跑校准（140、145、146、147）。
- 环境：每条流一个断网容器，落地的步骤以题面提交信息提交进 git 历史；模型请求一律经跑批进程内置的本地网关，限额处理与用量计量只在一处（148、155）。
- 结构化记忆：程序从账本派生、挂在文件上、开局与回炉时推送、用前核验（129 至 136，见 §1 与 §3.4）；验证配置拆成命名分步，各步结论记入验证记录，供回炉反馈与记忆按步取用（159）。
- 退役：账本剪去无读者与重复的记录（128）；第一版学习闭环整套退役（137、158，见 §M6 至 §M8）。
- 实验后：若定点对照显示记忆有作用，结构化记忆重构为从工具的结构化输出读报错、由调用方显式声明题面测试，推断只作兜底；若无作用则不再投入（162）。

### M10：外部 Memory Provider（v2 候选，本轮不做）

目标：在不让渡治理权的前提下接入可替换记忆后端。

候选包括 Honcho、Mem0、Hindsight、OpenViking 和 Supermemory。

交付：

- 有界 `MemoryProvider` 接口；
- 召回、预取、会话结束提取和同步；
- Provider 身份、租户、超时、失败和数据去向记录；
- 本地禁用、导出和删除能力；
- 语义检索（向量召回）作为 Provider 能力之一归此处，关键词扫描留在核心 Session Search（decisions.md 038）；
- Provider 的逐调用动态召回经 transformContext 注入，与 M5 常驻 Memory 的 system prompt 冻结注入分属两条路径（decisions.md 042）。

边界：

- 外部 Provider 可以召回和建议，不能授予权限；
- 外部 Provider 不是 Trace、Receipt 或审批的事实源；
- Provider 不可用时核心 Coding Run 仍可运行；
- 接入任何云 Provider 前必须明确数据外发范围和用户同意。

## 6. 核心数据模型草案

以下 SkillCandidate 为第一版学习闭环的草案，已随其退役（decisions.md 137），保留为历史；现行学习产物为程序从账本派生的结构化记忆（§1、§3.4）。

```ts
interface SkillCandidate {
  candidateId: string;
  procedure: Step[];
  preconditions: string[];
  failureCases: string[];
  applicability: string[];

  sourceSessionId: string;
  sourceEntryIds: string[];
  successfulBranchIds: string[];
  failedBranchIds: string[];
  sourceContentDigests: string[];

  traceIds: string[];
  validationReceipts: TestReceipt[];
  confidence: number;
  status: CandidateStatus;
}
```

`confidence` 只表示 Reviewer 的判断强度，不表示权限或生效资格。

## 7. MVP 截止线

首个可对外演示的 MVP 为 M0 + M1 + M3 + M4：

- 能通过真实 Pi Agent 完成 Coding Run；
- 有一个只读工具和一个审批后写工具；
- 极简 CLI 审批（diff 展示 + 批准/拒绝），不依赖完整 TUI；
- 有持久化 Session、Trace、Receipt 和冷恢复。

TUI（M2）、Memory/Skill 渐进注入（M5）和后台 Reviewer（M6）均不属于 MVP，进入 v0.2。

v0.2 演示截止线（decisions.md 039、040）：第一个主角"无人值守的并行执行"= M5 + M5.5 + M5.7；第二个主角"从历史学习"= M6.5 + M6 + M7 到 M9。演示以两个主角为主，治理只在崩溃之后与学习之后两个场景露面。

M6.5 之后的自动蒸馏、回放验证与完整 Eval 是 Pigeon 的差异化能力，但“证据能带来改善”的论断必须在 M6.5 就有数据支撑，不等 M9。

## 8. 明确不做

在对应阶段获得独立需求和验证方案前，不做：
- 不做无限深度或无限数量的 Agent Swarm；
- 不允许多个子代理在同一工作区并行写入（并行只经隔离工作区，M5.5）；
- 不做多窗口跨进程协调：多个 Pigeon 进程各自独立，窗口间只保共享文件安全，不做共享审批或调度（decisions.md 040）；
- 不做私有插件 SDK：仓库内工具直接注册，外部工具链只经 MCP 接入（decisions.md 041）；
- 不允许子代理通过父 Agent 的权限继承自动扩大自身权限；
- 不允许子代理直接修改父 Session 或绕过父 Run 采纳结果；

- 修改或 Fork `pi-agent-core` 私有实现；
- 套用 `pi-coding-agent InteractiveMode` 作为 Pigeon UI；
- 让后台 Reviewer 拥有完整 Coding 工具；
- 让 Memory、Skill 或外部 Provider 直接修改 Tool Policy；
- 根据当前叶子、摘要或模型自评自动认定成功；
- 对结果未知的副作用工具自动重试；
- 在当前 Session 内热替换长期 Memory 或 Skill；
- 把 Eval 高分直接转化为权限扩大；
- 给"一批工具长期放行"的捷径：批量放开只能走 yolo（短寿命），长期放开只能逐工具固化（每条独立带出处、独立可撤销）；
- 允许 agent、模型、Reviewer 或任何后台流程写 grants.json，或在快照里冻结 grant。

## 9. 验证与发布原则

每个里程碑分别报告以下证据，不混为一个“已完成”：

- 源码与类型检查；
- 单元测试；
- 跨公共 seam 的集成测试；
- 真实 Pi Agent 运行；
- 真实模型或 Provider 运行；
- TUI 人工验收；
- 崩溃恢复和结果未知演练；
- 生产环境接受度。

一个层级通过，不自动证明其他层级通过。

## 10. 上游参考

- [Stencil — The Harness Playbook](https://stencil.so/blog/harness-playbook)（权威状态、Controller/Actor 和执行边界的架构启发；不等于 Pigeon 实现依赖）
- [Hermes Background Review](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py)
- [Hermes Working with Skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md)
- [Hermes Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Hermes Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers/)
- [Pi Session Format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Pi Compaction and Branch Summarization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- oh-my-pi 的 hashline 锚定编辑与稀疏编辑格式（M3 编辑工具的降摩擦设计参考）
- [oh-my-pi MCP Integration](https://deepwiki.com/can1357/oh-my-pi/12.3-mcp-integration)（M5.7 MCP 客户端的设计参考：stdio / HTTP / SSE 传输、生命周期与重连、工具桥接进注册表、继承 .claude 等目录的 MCP 配置；pi 本体无内置 MCP，走扩展，见 [earendil-works/pi#563](https://github.com/earendil-works/pi/issues/563)）

这些项目提供设计参考，但 Pigeon 自己拥有运行状态、治理、审批、Receipt、恢复、候选验证和激活语义。编辑工具等面向模型的接口设计参考 oh-my-pi 的降摩擦方案，但工具治理、审批绑定和 Receipt 语义由 Pigeon 自有。
