# M2 开工裁决（2026-09-12）

- 定位：M2 开工前六件待盘裁决中会改变施工方向的两件；其余四件（spike 方案、审批注入形态、会话列表与恢复入口、测试策略）按推荐直接执行，事后补索引条目
- 裁决：项目负责人；方式：先按七件列出，其中"引入 pi-tui"属路线图既定事项不盘，减为六件；再筛出会改施工方向的两件逐件盘，第 4 件与第 2 件均取 B
- 索引：decisions.md 024、025（施工落实后把"设计"改为"事实"）

## 第 4 件：TUI 流式文本的事实源 = B（Adapter 只读流式观察口）

- 事实：Adapter 事件回调收到上游全部事件，归一化只产出 turn/tool/run 五种，message_update 被丢弃；Event Log 的 entry 只存 runSeq 与 role，不存文本
- 选项：A 只按 turn 刷新（零改动，像状态面板）；B Adapter 加 subscribeStream 只读观察口（约二十行，不记账不存盘不锚身份）；C TUI 直连上游 Agent（违反 §2，排除）
- 裁决：B。附带子裁决：thinking 增量第一版不转发；消息文本不持久化，历史会话渲染治理投影，文本持久化归 M5 与 Session Search 一起定
- 测试：fake streamFn 的 chunkSize 切流可驱动；listener 抛错不影响 Run（同 subscribe 不变式）

## 第 2 件：装配根放哪 = B（抽到 application/）

- 事实：buildRuntime 在 cli/index.ts（约 65 行，审批 handler 用 REPL 的 ask 现造）；resume 流程在 cli/session.ts 直接调 execution.recoverSession 并写 resolution；application/ 空；巡航规则无 application 位置
- 选项：A TUI 借用 cli/index.ts 的 buildRuntime（Actor 依赖 Actor，审批 handler 签名要改，过渡债继续挂）；B 只抽装配根与 resume 流程到 application/，审批 handler 注入，cli/tui 都经 application，巡航规则补齐；C 抽完整 Controller 含治理编排（M5.5 的事，排除）
- 裁决：B。放 S1，先于 TUI 代码；治理编排仍留 Adapter

## S2 壳裁决（2026-09-12，索引 027/028）

### busy 语义 = 拒绝提交（027）

- 背景：S2 输入区要求"运行中提示 busy 或排队——选一个简单语义"。
- 选项：A 排队（运行中的提交缓存，Run 结束自动发出）；B 拒绝（保留缓冲 + [busy] 提示）。
- 裁决：B。排队引出意图顺序/持久化/崩溃重放一整组未设计语义；拒绝零新状态且让 002 互斥可见；缓冲保留把重提时机交还人。S5 取消键落地后重审。
- 空输入（纯空白）：静默忽略，不回显不提交不提示。

### 消息区结构与 streamFn 归位（028）

- ScrollView follow:"end" 包装消息流：实证 TuiMainScreen（main-screen）不走 layout.js 布局引擎（layout.js 仅 tui-alt-screen.js 引用），ScrollView 裁剪/follow 在 main-screen 下不激活，follow-end 由终端 scrollback 天然实现；包装声明"这是可滚动消息区"的意图，alt-screen 下自动生效。
- chrome 纯 ASCII：shortId 的省略号（U+2026）是歧义宽字符，不进标题/状态栏——sessionId 原样全量展示。
- loadStreamFn 从 cli/index.ts 归位 application/runtime.ts：模型接入装载属装配职责，两个 Actor 共用避免 Actor 互依（025 收尾）；cli 侧 import 改指 application，行为不变。

## S3 面板裁决（2026-09-12，索引 029/030）

### 审批面板交互语义（029）

- 背景：S3 已定 ApprovalHandler 是异步函数、面板用 Promise 挂起等按键（5a 第 2 件，接口不动）；「面板期间普通输入挂起或忽略——选一个简单语义写注释」与「超时/取消路径 fail-closed」授权施工侧裁决并补索引。
- 裁决（施工侧按授权，走 027 同款推理）：
  - 面板期间普通输入**吞掉**（不是挂起也不是排队）：四键外一律 consume 丢弃，不进输入缓冲、不提交、不回显；输入区已有内容保留，面板关闭后继续编辑。理由同 027——排队意味着未设计的意图顺序/持久化语义，吞掉零新状态且输入焦点语义可见（状态栏 `state: approval | decide in panel`）。
  - **无墙钟审批超时**：cli 版没有，TUI 不造（新增超时是新增治理语义，超出「投影继承」边界）。
  - 取消路径一律 fail-closed 按拒绝处理、理由逐字：壳停止（APPROVAL_CANCEL_CLOSED）、face 未装配（APPROVAL_CANCEL_DETACHED，buildRuntime 收工厂时壳尚未构造的晚绑定窗口，属装配级故障）、并发审批防御（APPROVAL_CANCEL_BUSY，决策 002 串行不变量下不可达的重入）。
  - [n] 无拒绝理由输入通道：REPL 的理由追问是多轮问答形态，四键面板单按即决议不移植；reason 缺省由 Adapter 落默认文案「人工拒绝」，决策 001 的拒绝闭环不断。
  - [d] 无 path 时提示不提供该键（决策 3a 口径）；仍按下与 cli 版同语义退化为工具级（同 [a]）——cli/approval-ui.ts 的实际代码路径即如此，措辞与行为两处都不造第二套。
  - busy 期间斜杠命令与普通提交同样被拒绝（027 语义不开旁路）；审批面板本身在 run 期间打开，输入由面板接管，不经过 busy 判定。

### grant 命令层归属（030）

- 背景：判断点——runGrantCommand 的 ctx 依赖 write 回调（内联结构类型），可直复用或抽 application。
- 选项：A tui 直 import cli/grants.ts（改动最小，但 Actor 依赖 Actor，025 写明方向别扭）；B 命令层归位 application/grants.ts，cli/tui 共用（025 方向收尾，一次机械移动 + 4 处 import 更新）。
- 裁决：B。write 回调本就是注入面，命令层不 import 任何 Actor；extractPathArg 一并归位 approvals/handler.ts（cli 与 tui 审批共用同一路径参数口径，不各造一份）。治理语义零新增：放权/撤销/升格全部走 SessionGrantStore 与既有命令逻辑，TUI 只是投影与按键来源。

## S4 会话入口裁决（2026-09-12，索引 031）

### 会话列表与恢复入口的命令层归属

- 背景：S4 的判断点——会话选择与恢复入口复用 state/session-summary 与 application/resume，TUI 只渲染。
- 落地：/sessions 的查询与渲染自 cli/session.ts 归位 application/session-list.ts（同 030 方向，025 的收尾——TUI 直 import cli 是 Actor 依赖 Actor）；/resume 复用 application/resume.ts 的 runResumeFlow，AskFn/WriteFn 注入面板实现，human-confirmed resolution 写盘路径唯一（壳不另起）。/resume 对账收口后的续跑 = 壳换绑运行面：rebind 工厂由 main.ts 注入，配方同 cli resume 的 enterRepl（materialize grants 种子 → buildRuntime(restoredGrants) → 释放旧运行面；先建后换，装配失败旧面不受影响）。

### 恢复人工确认的交互形态 = 面板式单键

- 选项：A 面板式单键（1/2/3 键即答案，复用 029 模态键控）；B 顺序问答（逐行输入 + 回车提交）。
- 裁决：A。B 的逐行提交会穿过 busy 判定与斜杠分发，需要第三种输入模式（提交要路由进恢复流程而不是 run()/命令）；A 复用已裁决的模态语义，零新输入语义，与审批面板手感一致。非 1/2/3 键吞掉（转义序列等多字节输入不决议，避免方向键刷重复提示）；壳停止时按 EOF 语义回 null（流程把悬账原样保留，不写错误确证）。

### 崩溃残留列表呈现 = 偏差回落（pendingReconcile 口径）

- 背景：开工口径「崩溃残留在列表按 N 个 Run 无 run.ended 呈现」，并授权：若现有字段只有 pendingReconcile，按 pendingReconcile 口径呈现并在 decisions.md 说明偏差。
- 核对结果：SessionSummary 投影只有 pendingReconcile；materialize 虽有 unfinishedRuns（023），但把它提进列表投影 = 给 015「唯一突出项是待对账」开第二个突出项，且共享渲染会改变 cli 列表输出，超出 S4「TUI 只渲染、cli 零回归」边界。
- 裁决：按授权回落——TUI 列表与 cli 同口径（安静行 + 待对账突出行），崩溃残留不在列表单独突出；既有呈现面是 resume 恢复屏「既往缺口：崩溃残留：N 个 Run 无 run.ended」与 trace 会话头（023）。若要把崩溃残留提进列表，需先修订 015（需项目负责人裁决）。

### 附：恢复当前会话的防御

- /resume <当前 sessionId> 响亮拒绝（「已在会话中，无需恢复」）：恢复流程会对目标会话文件自开 JsonlEventLog 写 resolution，与运行中日志同文件双写会导致幂等索引分叉；且语义上无意义（人就活在该会话里）。

## S5 取消裁决（2026-09-12，索引 032）

### 取消键 = Esc；Ctrl+C 保留进程退出语义

- 背景：开工口径「运行中按一个固定键（建议 Esc）触发 adapter.interrupt()；若 Esc 被 pi-tui 占用/语义冲突另选并注释理由——Ctrl+C 保留进程退出语义」。
- 核实：pi-tui Input 组件的 onEscape 钩未被本壳装配（空语义），且其 keybinding 把 escape 与 ctrl+c 同绑（tui.select.cancel）——不能走 onEscape（会把 Ctrl+C 也绑成取消）；壳级 addInputListener 在聚焦组件之前截获裸 "\x1b"（方向键等转义序列是多字节，不误判），Ctrl+C 不进取消路径。
- 裁决（施工侧按授权）：Esc = 运行取消键；Ctrl+C 不绑定取消，进程退出语义照旧（main.ts 的 SIGINT/SIGTERM 处理）。

### Esc 在模态下的语义 = 吞掉（模态键控优先）

- 选项：A 模态优先，Esc 与非决议键同待遇吞掉；B Esc 取消模态（审批 fail-closed 按拒绝）再取消 Run；C Esc 穿透模态直接取消 Run。
- 裁决：A。审批挂起即 Run 阻塞在 beforeToolCall 的人工决议 Promise 上，此时 interrupt 的 waitForIdle 吊在挂起 Promise 上直到人按键——「取消」名不副实（B/C 都引入挂起 Promise 竞态：审批决议落在已 abort 的 Run 上）；模态先决议（四键/单键），再 Esc 取消是唯一次序。与 029/031 的「非决议键一律吞掉」同一条语义，零新输入模式。

### 重复取消防御与终态呈现

- 中断飞行中（interrupt 未决议）重复 Esc 不再触发：不 double-abort、不悬挂；running 清算在 run() 决议（handleRunEnd），interrupt 决议只清飞行标记；interrupt 自身抛异常（装配级故障）如实呈现，不伪装成已取消。
- 终态摘要：status + stopReason + 四分类徽章 + syntheticFailure 标注 + errorMessage；徽章措辞复用 failureBadge（自 state/trace.ts 归位 application/format.ts——它是 Actor 共用措辞不是冷投影结构，025 方向；cli trace/replay 改指新位置，无 re-export）。listenerErrors 警告上消息区：措辞与增量报数口径同 cli repl（启动即查 + 每次 run 收尾复查）；/resume 换绑时警告计数随运行面一起换绑。

## S5+ 退出裁决（2026-09-12，索引 033）

### 退出三层形态 = omp 键位模型

- 背景：S5 落地 Esc 取消（032）后，Ctrl+C 仍只是「保留进程退出语义」的空白键；开工口径指定参照 omp——Esc 取消 / Ctrl+C 清缓冲 / 双击退出 + /quit。
- 裁决（omp 语义照搬）：
  - Esc：不变（032——运行中 interrupt，模态吞掉）。
  - Ctrl+C 永不取消 Run：单击（非模态）清输入缓冲并留 `[cleared] 输入已清空（再按一次 Ctrl+C 退出）` 提示行（措辞与 [busy]/[cancel] 同款 ASCII 括号）；无历史召回功能（出界）。模态（审批面板/恢复菜单）期间单击不清缓冲不留提示，但仍计退出布防第一次。
  - 双击（窗口约 1 秒内两次 \x03，任意模式含模态）与 /quit 同一优雅退出：先 shell.stop()（dispose 对称；挂起审批 fail-closed 走 APPROVAL_CANCEL_CLOSED 逐字理由，证据链不断；恢复菜单按 EOF 语义回 null）再回调注入的 onExit。onExit 注入使测试绝不真退进程；main.ts 注入运行面 dispose + process.exit。
- 路由次序：Ctrl+C 判定在模态吞键之前——否则 029/031 的「非决议键一律吞掉」会把退出布防吃掉；退出恰好一次（exitRequested 幂等），窗口过期的两次按键按两次单击处理、第二次重新布防。
- busy 旁路：/quit 在运行中同其他斜杠命令一样被 027 busy 拒绝（不开旁路），运行中的优雅退出走双击 Ctrl+C。

## M2 审计后修复裁决（2026-09-13）

对审计 note×9 的裁决：先修 note-1、note-6、note-9，其余随后处理，全部落文档。

### note-1 = 抽 workspace.ts 进 application（索引 034）

- 缺口：realpath 规范化、D8 迁移、恢复种子物化在 cli/index.ts 与 tui/main.ts 各写一份；tui 直接 import persistence/legacy-migration.ts（会改名并写会话文件）。
- 方案：application/workspace.ts 三个函数；两个入口改用；巡航规则 actors-no-persistence-writes（精确到 legacy-migration.ts 与 grants-config.ts 两个写侧模块，只读物化 materializeSession / listSessionIds / filePathFor 仍允许）。
- 测试先行：workspace.test.ts 两例（prepareWorkspace 归档空账本并可重跑、restoreGrantSeed created − revoked 与空会话），实现前模块不存在即红。
- 反向验证：tui 重新直连 migrateLegacyLedger → 巡航精确变红；cli 直连 grants-config → 精确变红。
- 顺手 note-8：busy 文案补退出提示。

### note-6 = 不补通道，记账到 029 修订与 ROADMAP §M6 前置

- 缺口：TUI [n] 单键拒绝无理由输入，Adapter 落默认文案"人工拒绝"；cli 版逐字理由是 006 写明的 M6 负样本信号。
- 裁决：M2 不引入多轮问答（029 既定）；在 decisions.md 029 追加修订句，ROADMAP §M6 交付加一条前置——补通道或按来源 Actor 标注信号强度。
- 无代码改动，无测试。

### note-4 / note-7 / note-2 / note-3 裁决（2026-09-13）

- note-4：维持 015，不提进列表（031 修订）。理由：崩溃残留不是 actionable 项；023 后 `--class unknown` 可筛、resume 屏会说。
- note-7：现在回写 ROADMAP §M2 为 as-built（不等 M2 收口）。
- note-2：裁决为一并修——尾巴懒创建，随 note-3 一起施工，索引预留 035（note-3 若立项用 036）。
- note-3：裁决为先验证、复现即修；索引编号预留 035。

### note-2 / note-3 执行结果（2026-09-13）

- note-3 先验：剧本 n3（tmp/tui-acc/run-n3.mjs，零模型调用）——ws-n3 预置两条固化规则 + 复制 ws-c 的会话（含 grant.created），/resume 后连发三次 /grants 各抓快照。四张快照每条 grant 行恰一次、行宽 ≤100、无 U+FFFD；屏幕上**未复现**重复行。快照里的残影（对账报告行倒置、双状态栏）与偏差 3 已登记的重放近似同类（对照：g2/a-stream 快照各恰一条状态栏）。结论：闭合，不修、不加索引条目。
- note-2 复核出意外事实：登记的"空行"是代码阅读推断——pi-tui 0.84.4 的 Text("") 渲染零行（components/text.js 空文本早退，连 padding 都不产生），恒开尾巴本就不可见。三路证据：库源码、离屏探针逐行布局（tmp/probe-note2-layout.mjs，一次性）、恒开/懒创建两版探针输出 diff 仅差会话号。裁决为一并修复，照常落地：openStream 只重置状态、appendDelta 懒开出、closeStream 无尾巴不追加；性质记为不变式卫生（尾巴存在 ⟺ 本轮有文本），不记为观感修复。
- 测试形态讨论：要求红测试先行加反向验证变红，但两实现屏幕逐行一致，屏幕级断言无法区分——恒开变异下新用例仍绿（实测）。最终写法是合同钉：断言工具行两侧间距一致，占位尾巴可见化（自造占位符/库升级语义变化）变红；内部子组件数这条可区分轴按测试纪律不断言。反向验证的"不变红"作为前提不成立的证据如实写进修复记录。
- 索引：note-2 → decisions.md 035；note-3 未复现闭合，036 不占用。

### P2-1 渲染注入 = (a) 壳边界剥除（2026-09-13，索引预留 036）

- 缺口：独立审计（f71c779 基线）以实证探针发现 pi-tui Text 原样直通 CSI/OSC/APC；TUI 消息区与审批块、cli 审批输出与错误消息都不净化半信任内容；审批屏可被伪造行诱导。
- 选项：(a) 壳边界剥除（两个 Actor 的终端边界统一净化，ESC 序列与 C0 替换为可见标记，不做 SGR 白名单）；(b) 只护审批块（伪造行可放在面板上方消息区，不够）；(c) 不修（以审批通道为卖点的项目不成立）。
- 裁决：按推荐方案 (a) 施工，索引 036 在同一提交内落。
- 附带纪律：审计文件只追加不覆盖，不同会话审计走不同路径。

- 执行回填（2026-09-13）：sanitizeTerminalText 归 application/format.ts（可见化语义：ESC→␛、C0→控制图形、DEL→␡、\r→␍、留 \n\t、无 SGR 白名单、幂等）；TUI 边界 = MessageFlow 三处（append / appendDelta 累积重净化 / settleToolCall）；cli 边界 = repl.ts sanitizedWriter 组合子 + index.ts writeOut 统一出口（REPL/审批/grant/trace/replay/session list 全覆盖）。三组红测试先行；变异反向验证三发三中（恒等返回→8 红；去 TUI 边界→1 红；去 cli 边界→2 红）。verify 323 测试全绿。commit ba94b53，索引 036 同提交（顺手补上 035 缺的表格行）。真实终端复验未做（离屏原始字节流断言已闭环）。
