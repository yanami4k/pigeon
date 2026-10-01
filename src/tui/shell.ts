// Application Shell（M2 S2，ROADMAP §M2 交付第 1 件）：pi-tui ProcessTerminal + TuiMainScreen
// 驱动的最小壳——消息区（每消息一个 Text）+ 底行输入区 + 纯 ASCII chrome（标题/状态栏）。
//
// 决策 067 拆分（零行为变化）：消息流在 message-flow.ts，审批面板与按键路由在 modal.ts，
// 斜杠命令分发在 commands.ts，worker 命令与状态行在 workers-view.ts，resume / 历史 / 换绑在
// resume-view.ts；本文件保留布局、启停、提交与事件渲染，并重新导出原有公开符号（导入方不变）。
// 运行中、恢复中、待审批、退出布防等状态一律由本壳持有，子模块经窄接口读写，不各自存一份。
//
// 边界与纪律：
// - TUI 只通过 Application API 提交意图（ROADMAP §M2 完成证据）：输入提交唯一通道是
//   TuiRuntimeFace.run()，绝不直连上游 Agent；PiRuntimeAdapter 结构满足该面。
// - 消息区内容源（决策 024）：subscribeStream 的 text_delta 渲染当前 assistant 消息流式生长；
//   subscribe 的 turn.started/turn.completed/tool.proposed/tool.settled/run.ended 渲染轮次
//   标记与工具调用行（措辞复用 application/format.ts 的通俗措辞约定）；user 消息提交时回显。
// - spike 施工纪律（docs/notes/spike-pi-tui.zh-CN.md）：每消息一个 Text 组件，禁止单 Text
//   装全部历史（A5a 实测线性退化）；自有 chrome 只用 ASCII（歧义宽字符不进边框/状态栏账目，
//   内容区不限制）；不设计依赖 CPR/DSR 应答的探测；resize 交给 pi-tui 全量重绘，本壳不自持
//   宽度缓存副本。
// - ScrollView follow:"end" 包装消息流：TuiMainScreen（main-screen 模式）不走 layout.js
//   布局引擎，ScrollView 的裁剪/follow 不激活，follow-end 由终端 scrollback 天然实现
//   （内容超高流入回卷，差分渲染器重写尾部）；包装声明意图，alt-screen 布局引擎下自动生效。
// - 运行中输入（决策 286 第 4 项，取代决策 027 的 busy 拒绝）：运行中（含压缩、/resume 进行中）提交的输入进队列
//   （input-queue.ts），空闲后逐条自动发出；Esc 中断时排队内容退回输入框，Alt+Up（Windows 下另认 Alt+Q）随时退回。
//   斜杠命令不排队：只读类与 /cancel、/quit 运行中照常执行，改主会话状态或工作目录的命令拒绝并说明原因、输入留在
//   输入框（放行表在 command-table.ts）。
// - 审批面板（S3，决策 029）、取消键（S5 裁决 032）与退出三层形态（S5+ 裁决 033）的交互语义见 modal.ts；
//   壳停止时挂起的审批 fail-closed 按拒绝处理（理由逐字）。
// - 决策 286 其余各项：输入框为 pi-tui Editor（input-editor.ts，多行、粘贴保留换行、历史跨启动保留）；输入框下方一行
//   状态栏（status-bar.ts：模型、上下文用量、本会话花费、后台补做进度）；工具调用行下方显示结果（缺省收起，Ctrl+O
//   展开或收起全部）；/resume 不带会话号弹出会话选择器（session-picker.ts）；运行期告警经 addWarning 落消息区。
// - 斜杠命令（S3，决策 030）：/grants /revoke /grants save 走 application/grants.ts 的
//   命令层（与 cli REPL 同一份），输出经 write 回调投影到消息区——零新增治理语义。
// - 终态摘要（S5）：run() 决议后落终态行——status + stopReason + 四分类徽章（措辞复用
//   application/format.ts 的 failureBadge，与 cli trace 同口径）+ errorMessage（若有）+
//   syntheticFailure 标注（若有）；listenerErrors 非空时消息区增量警告（D2 可见化的
//   TUI 投影，措辞与增量报数口径同 cli repl：启动即查 + 每次 run 收尾复查）。
// - dispose 对称：取消键的订阅与监听器一律进 disposers，在 start/stop 里成对出现。
// - 决策 301（编排进度）：输入框下方、状态栏之下是编排面板（worker-panel.ts，取代原先输入框上方的 worker 状态行）；Ctrl+X 或
//   /agents 切换整屏的树形视图（worker-tree.ts）；输入框为空时按 ↓ 进入面板选 worker。在面板与树形视图里回车进入 worker 的会话：
//   消息区换成它的对话（历史取自会话记录，之后实时），输入作为消息发给它，/stop 停止、/approve 补批续做，Esc 回主会话。
//   主会话在此期间照常运行（主会话的消息区在后台照常更新）；审批面板就地在当前视图弹出（写明来源），答完仍留在原处。
//   已收尾的 worker 会话只读（停在等审批的可 /approve 补批续做）。
// - 决策 304：树形视图分两种模式，Tab 切换——运行中（上面的编排树）与会话树（session-tree.ts，当前会话这一家）。会话树里
//   Enter 查看（本次运行编排器里的 worker 进入其会话，其余只读看历史，Esc 回树），r 在此续接（主会话、分支、失败重试；
//   走 /resume 同一流程）。
//   面板、树形视图与状态栏的在跑 worker 花费同源（worker-activity.ts，编排器的只读观察口）。
import {
  type Component,
  type Editor,
  matchesKey,
  type Terminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { compactionNoticeText, manualCompactionText } from "../application/compaction-text.ts";
import { failureBadge } from "../application/format.ts";
import { loadSessionHistory } from "../application/history.ts";
import type { HookEventReport } from "../application/hooks.ts";
import type { PromptHistoryStore } from "../application/prompt-history.ts";
import { listRecentMainSessions } from "../application/recent-sessions.ts";
import type { ScriptCommands } from "../application/script-commands.ts";
import {
  accumulatedSessionCost,
  addUsage,
  ChildSessionCosts,
  type CostTally,
  emptyCostTally,
  mergeCostTally,
} from "../application/session-cost.ts";
import { type FamilyNode, loadSessionFamily } from "../application/session-family.ts";
import type { TaskItem } from "../application/task-list-tool.ts";
import {
  renderWorkerOutcome,
  resumeApprovalText,
  type WorkerActivity,
  type WorkerLifecycleEvent,
  type WorkerStatus,
} from "../application/workers-commands.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type {
  CompactionNotice,
  ManualCompactionOutcome,
  RunResult,
  StreamTextDelta,
  ToolResultNotice,
} from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { DEFAULT_STOP_HOOK_BLOCK_CAP } from "../state/hooks.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { TurnCompletedPayload } from "../state/runtime-events.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import { toolResultModelUsage } from "../state/tool-usage.ts";
import type { ApprovalPanelResult, TuiApprovalFace } from "./approval.ts";
import {
  lookupSlashCommand,
  rejectInWorkerSession,
  rejectWhileRunning,
  slashTokens,
} from "./command-table.ts";
import {
  type CommandsHost,
  handleSlashCommand as dispatchSlashCommand,
  type TuiGrantsContext,
} from "./commands.ts";
import type { TuiHooksFace } from "./hooks-view.ts";
import { createPromptEditor } from "./input-editor.ts";
import { InputQueue } from "./input-queue.ts";
import { attachToolResultTo, MessageFlow, projectRuntimeEvent } from "./message-flow.ts";
import {
  askApprovalPanel,
  closePendingModals,
  handleShellKey,
  type ModalHost,
  type PendingApproval,
} from "./modal.ts";
import {
  handleResumeCommand as dispatchResumeCommand,
  type ResumeOptions,
  type ResumeViewHost,
  renderHistory,
  type SessionBinding,
} from "./resume-view.ts";
import { type PickerKey, SessionPicker } from "./session-picker.ts";
import { familyKindLabel, SessionTree } from "./session-tree.ts";
import { type BackfillStatus, StatusBar } from "./status-bar.ts";
import { WorkerActivityTracker } from "./worker-activity.ts";
import {
  hasFadingWorkers,
  isActiveWorker,
  isBlockedWorker,
  PANEL_FADE_MS,
  PANEL_MAX_ROWS,
  WorkerPanel,
  workerStateWord,
} from "./worker-panel.ts";
import { type OrchestrationScriptNode, WorkerTree } from "./worker-tree.ts";
import {
  handleCancelCommand,
  handleSpawnCommand,
  handleTakeCommand,
  refreshWorkers as refreshWorkersView,
  renderWorkersTable,
  showWorkersStatus,
  type TuiWorkersFace,
  type WorkersViewHost,
} from "./workers-view.ts";

export type { TuiGrantsContext } from "./commands.ts";
export type { OrchestrationScriptNode } from "./worker-tree.ts";
export type { TuiWorkersFace } from "./workers-view.ts";

// Application API 面：TUI 提交意图与订阅投影的唯一通道（决策 025 的实体）。
// 结构类型——PiRuntimeAdapter 直接满足；测试注入假实现断言「只经 application API」。
export interface TuiRuntimeFace {
  run(input: string): Promise<RunResult>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void;
  // S5 取消入口：中断当前 Run（Adapter 固定姿势 abort → waitForIdle，注释约束 5，
  // 任何路径不悬挂；终态由并发等待的 run() 返回承载）。打转叫停带上原因（307），收尾条目记结束方式为打转
  interrupt(cause?: RunStopCause): Promise<void>;
  // S5 D2 可见化投影：会话记录写入失败观察口（措辞与增量报数口径同 cli repl）
  listenerErrors(): unknown[];
  // 决策 189：压缩完成的提示（自动与手动）与手动压缩；缺省（替身运行面）即不提示、/compact 不可用
  subscribeCompaction?(listener: (notice: CompactionNotice) => void): () => void;
  compact?(customInstructions?: string): Promise<ManualCompactionOutcome>;
  // 决策 297：worker 完成通知——待递的条数与空闲时只带通知跑一轮；缺省（替身运行面）即不支持
  pendingNotices?(): number;
  runNotices?(): Promise<RunResult>;
  // 决策 286：工具结果（展开显示与 diff）与上下文用量（状态栏）；缺省即不显示结果块、状态栏不显示上下文
  subscribeToolResults?(listener: (notice: ToolResultNotice) => void): () => void;
  contextUsage?(): { tokens: number; contextWindow: number } | undefined;
}

// /resume 换绑产物（S4）：目标会话的新运行面与新治理上下文（形状定义在 resume-view.ts）
export interface TuiSessionBinding
  extends SessionBinding<TuiRuntimeFace, TuiGrantsContext, TuiWorkersFace> {
  // 决策 323/324：目标会话的钩子面——换绑后本会话的会话级事件用它（各会话的清单随各自的快照冻结）
  hooks?: TuiHooksFace;
}

export interface TuiShellOptions {
  terminal: Terminal;
  runtime: TuiRuntimeFace;
  sessionId: SessionId;
  // pi-tui 崩溃/调试日志目录（行宽护栏 throw 时写 pi-crash.log）
  logDir?: string;
  // S3：grant 治理面投影——/grants /revoke /grants save 的命令上下文（命令层在
  // application/grants.ts，与 cli REPL 同一份）；缺省 = 斜杠命令不可用
  grants?: TuiGrantsContext;
  // S4：/sessions 会话列表入口（命令层在 application/session-list.ts，与 cli 同一份）
  sessions?: { root: string };
  // S4：/resume <sessionId> 恢复入口——对账流程在 application/resume.ts（写盘路径唯一）；
  // rebind 由装配方注入：对账收口后按目标 sessionId 重建运行面（restoredGrants 种子）
  // 并释放旧运行面；缺省 = /resume 不可用
  resume?: ResumeOptions<TuiSessionBinding>;
  // 决策 340：/reload 重读设置——返回给人看的行（装配方实现：重读、确认、换上新快照并重建运行面）
  reload?: (args: readonly string[]) => Promise<string[]>;
  // S5+（裁决 033）：优雅退出回调——双击 Ctrl+C / /quit 触发；壳先 stop() 再回调。
  // 注入使测试绝不真退进程；缺省 = 退出只停壳（装配方必须注入真实退出路径）
  onExit?: () => void;
  // 双击窗口（毫秒）：缺省 1000；测试注入小窗口断言过期语义
  exitWindowMs?: number;
  // M5 S2（决策 038）：/search 命令上下文（工作区根）；缺省时 /search 不可用
  search?: { root: string };
  // M5 S2（决策 045）：/resume 历史渲染的安全上限（行）；缺省 500
  historyLimit?: number;
  // M5.5 S4（决策 040）：/spawn /cancel /workers 与状态栏 worker 行；缺省 = 命令不可用
  workers?: TuiWorkersFace;
  // worker 状态行刷新间隔（毫秒，有 worker 在跑时生效）；缺省 1000
  workerRefreshMs?: number;
  // 决策 237、245：沙箱会话——/export 手动交回；分叉、worker 与 /resume 换绑在沙箱里不支持，命令给出原因
  sandbox?: TuiSandboxFace;
  // 决策 294 B1：/tasks 查看当前会话的任务清单（排好的文字）；返回 undefined = 清单没开；缺省 = 命令不可用
  tasks?: () => string | undefined;
  // 决策 286：状态栏显示的模型（provider/模型号）；缺省不显示
  model?: string;
  // 决策 286：主 agent 的模型接入（DeepSeek 回复自带价格为 0 时按官方人民币价目计会话花费）；缺省不另计价
  provider?: string;
  // 决策 286：输入历史的跨启动存储（按项目）；缺省只在本次启动内保留
  promptHistory?: PromptHistoryStore;
  // 决策 301：编排面板最多列几行（缺省 5）、结束的 worker 多久后淡出（毫秒，缺省 30 秒）；时钟（缺省 Date.now，测试注入）
  panelMaxRows?: number;
  panelFadeMs?: number;
  now?: () => number;
  // 决策 301：树形视图按标签标出清单项用的任务清单（清单关着时返回 undefined）；缺省不标
  taskItems?: () => readonly TaskItem[] | undefined;
  // 决策 301：树形视图的脚本与阶段两层（脚本编排接上）；缺省没有这两层
  scripts?: () => readonly OrchestrationScriptNode[];
  // 决策 309：人的一条输入交给运行面之前（点名判定只挂在这里：提交与排队输入，模型读到的内容不经这里）
  onHumanInput?: (text: string) => void;
  // 决策 309、312、301：/orchestrate 的命令面（跟着当前会话）；缺省 = 命令不可用
  scriptCommands?: () => ScriptCommands | undefined;
  // 决策 323、324：当前会话的钩子面（会话级事件与 /hooks）；缺省 = 本会话不接钩子
  hooks?: TuiHooksFace;
  // 决策 323：收尾钩子的连续拦截上限（取设置快照的 merged.stopHookBlockCap，/reload 后跟着变）；缺省 8
  stopHookCap?: () => number;
}

// 决策 301：界面所处的视图——主会话、整屏的树形视图、进入的 worker 会话
export type ShellView = "main" | "tree" | "worker" | "history";

// 决策 304：树形视图的两种模式
export type TreeMode = "running" | "sessions";

// 从哪里进入的 worker 会话或历史查看（Esc 回到那里）
type ReturnTo = { view: "main" } | { view: "tree"; mode: TreeMode };

// 沙箱会话的命令面：交回返回给人看的一行（分支名与查看命令，或失败原因）
export interface TuiSandboxFace {
  exportChanges(): Promise<string>;
}

export class PigeonTuiShell
  implements
    TuiApprovalFace,
    ModalHost,
    CommandsHost,
    WorkersViewHost,
    ResumeViewHost<TuiSessionBinding>
{
  private readonly options: TuiShellOptions;
  private readonly tui: TuiMainScreen;
  private readonly flow = new MessageFlow();
  private readonly statusLine = new Text("");
  // M5.5 S4（决策 040）：worker 的刷新定时器（有 worker 在跑或还有结束的在淡出期内才开）
  private workerTimerHandle: ReturnType<typeof setInterval> | null = null;
  // 决策 301：worker 活动记录（面板、树形视图与状态栏花费同源）、编排面板、树形视图与当前视图
  private readonly tracker: WorkerActivityTracker;
  private readonly panel: WorkerPanel;
  private readonly tree: WorkerTree;
  private view: ShellView = "main";
  // 决策 304：树形视图的模式、会话树、只读历史查看与 Esc 回到哪里
  private treeMode: TreeMode = "running";
  private readonly sessionTree: SessionTree;
  private historySession: { sessionId: string; flow: MessageFlow } | undefined;
  private returnTo: ReturnTo = { view: "main" };
  // 决策 301：树形视图里就地显示的审批面板（审批挂起期间）
  private readonly approvalBox = new Text("");
  private approvalBoxText = "";
  // 进入的 worker 会话：它的会话号、消息区与活动订阅
  private workerSession:
    | { sessionId: SessionId; flow: MessageFlow; unsubscribe: () => void }
    | undefined;
  private readonly input: Editor;
  private readonly queue = new InputQueue();
  private readonly picker = new SessionPicker();
  private readonly statusBar: StatusBar;
  // 本会话花费（286）：打开或续接时从会话记录累计的已有部分 + 本次运行中主 agent 的新增 + 之后收尾的子会话
  private costBase: CostTally = emptyCostTally();
  private costLive: CostTally = emptyCostTally();
  private childCosts: ChildSessionCosts | undefined;
  private runningWorkerCount = 0;
  // 本轮开始的时刻（DeepSeek 计价看开始与结束是否落在高峰）
  private turnStartedAt: number | undefined;
  private readonly title: Text;
  // 当前会话上下文（S4）：/resume 换绑整体替换——运行面、治理上下文、sessionId 一体，
  // 绝不换一半（grants 命令与提交必须落在同一会话上）
  private current: {
    sessionId: SessionId;
    runtime: TuiRuntimeFace;
    grants?: TuiGrantsContext;
    workers?: TuiWorkersFace;
    hooks?: TuiHooksFace;
  };
  // 决策 323、324：SessionStart 补的上下文（待下一条输入前缀）；换绑换会话时清掉
  private hookContexts: string[] = [];
  // 决策 323：本轮是否被外部取消（Esc / 打转叫停）——取消过的一轮不跑 Stop 钩子
  private runCancelled = false;
  // start/stop 的 dispose 对称面：壳级监听器在此成对登记（S5 的同位置留位）；
  // 运行面订阅单独登记——/resume 换绑时只退订运行面，壳级监听（模态键控）不动
  private readonly disposers: Array<() => void> = [];
  private runtimeDisposers: Array<() => void> = [];
  private running = false;
  private activeRunId: RunId | null = null;
  private started = false;
  // S4：/resume 进行中——输入排队、改状态的命令被拒（决策 286，同运行中）
  private resuming = false;
  // S3 审批面板：挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下
  // 同时最多一个，非空即面板期间
  private pendingApprovalState: PendingApproval | null = null;
  // 决策 066：理由行输入模式——[r] 打开后按键归输入区，回车提交理由，Esc 回面板（不算拒绝）
  private reasonModeOn = false;
  // S5 取消键：中断飞行中标记——interrupt 未决议期间重复 Esc 不再触发
  //（不 double-abort、不悬挂）；running 清算在 handleRunEnd，两者生命周期独立
  private interrupting = false;
  // S5 D2 可见化（同 repl 增量报数口径）：已警告过的落盘失败累计数
  private reportedListenerErrors = 0;
  // S5+ 退出布防（裁决 033）：上一次 Ctrl+C 的墙钟时刻（窗口内再来一次即优雅退出）；
  // exitRequested 保证退出恰好一次（stop 后输入监听已退订，重入仅作幂等防御）
  private lastCtrlCAtValue: number | null = null;
  private exitRequested = false;
  // 决策 294 B1：/tasks 的取数（装配方给了才有这条命令）
  tasks?: () => string | undefined;

  constructor(options: TuiShellOptions) {
    this.options = options;
    this.current = { sessionId: options.sessionId, runtime: options.runtime };
    if (options.grants !== undefined) this.current.grants = options.grants;
    if (options.workers !== undefined) this.current.workers = options.workers;
    if (options.hooks !== undefined) this.current.hooks = options.hooks;
    if (options.tasks !== undefined) this.tasks = options.tasks;
    this.tui = new TuiMainScreen(options.terminal, false, options.logDir);
    this.input = createPromptEditor(this.tui, options.promptHistory?.load() ?? []);
    this.statusBar = new StatusBar({
      ...(options.model !== undefined ? { model: options.model } : {}),
      cost: emptyCostTally(),
    });
    // chrome 纯 ASCII（spike 纪律：歧义宽字符不进边框/标题/状态栏）；sessionId 全 ASCII ULID
    this.title = new Text(`== pigeon tui | session ${options.sessionId} ==`);
    this.tracker = new WorkerActivityTracker(
      options.provider !== undefined ? { provider: options.provider } : {}
    );
    this.panel = new WorkerPanel({
      statuses: () => this.workerStatuses(),
      tracker: this.tracker,
      now: () => this.now(),
      maxRows: options.panelMaxRows ?? PANEL_MAX_ROWS,
      fadeMs: options.panelFadeMs ?? PANEL_FADE_MS,
    });
    this.tree = new WorkerTree({
      sources: () => {
        const tasks = options.taskItems?.();
        return {
          mainSessionId: this.current.sessionId,
          statuses: this.workerStatuses(),
          tracker: this.tracker,
          scripts: options.scripts?.() ?? [],
          ...(tasks !== undefined ? { tasks } : {}),
          now: this.now(),
        };
      },
      // 标题一行、状态栏一行
      height: () => Math.max(3, this.options.terminal.rows - 2),
    });
    this.sessionTree = new SessionTree({
      height: () => Math.max(3, this.options.terminal.rows - 2),
    });
    this.layout();
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.updateStatus();
  }

  // 按视图排布组件：排队内容与会话选择器在输入框上方，状态栏在输入框下方，编排面板在状态栏之下（决策 286、301）；
  // 树形视图整屏（标题、树、状态栏）；worker 会话的消息区换成它的对话，排队内容与会话选择器属于主会话，不显示
  private layout(): void {
    const children: Component[] =
      this.view === "tree"
        ? [
            this.title,
            this.treeMode === "sessions" ? this.sessionTree : this.tree,
            this.approvalBox,
            this.statusBar,
          ]
        : this.view === "history" && this.historySession !== undefined
          ? [
              this.title,
              this.historySession.flow.view,
              this.statusLine,
              this.approvalBox,
              this.statusBar,
            ]
          : this.view === "worker" && this.workerSession !== undefined
            ? [
                this.title,
                this.workerSession.flow.view,
                this.statusLine,
                this.input,
                this.statusBar,
                this.panel,
              ]
            : [
                this.title,
                this.flow.view,
                this.statusLine,
                this.queue.view,
                this.picker.view,
                this.input,
                this.statusBar,
                this.panel,
              ];
    this.tui.clear();
    for (const child of children) this.tui.addChild(child);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private workerStatuses(): WorkerStatus[] {
    return this.current.workers?.status() ?? [];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // 决策 301：编排视图的按键（树形视图、面板选择、worker 会话的 Esc）排在最前；审批挂起期间与 Ctrl+C 一律放给壳级键控
    this.disposers.push(this.tui.addInputListener((data) => this.handleOrchestrationKey(data)));
    // 壳级键控（S3 审批面板 + S4 恢复菜单 + S5 取消键）：模态挂起期间接管终端输入
    this.disposers.push(this.tui.addInputListener((data) => handleShellKey(this, data)));
    // 决策 286：会话选择器、Ctrl+O 与退回排队内容的按键（模态与取消键之后、输入框之前）
    this.disposers.push(this.tui.addInputListener((data) => this.handleViewKey(data)));
    this.bindRuntime(this.current.runtime);
    this.resetCosts(this.current.sessionId, false);
    refreshWorkersView(this);
    // D2 可见化（S5，同 repl 口径）：启动即查一次落盘失败
    this.warnEvidenceGaps();
    this.tui.setFocus(this.input);
    this.tui.start();
    this.tui.requestRender();
  }

  // 运行面订阅：换绑先退订旧面再订阅新面——旧面的迟到事件/增量换绑后不进消息区
  private bindRuntime(runtime: TuiRuntimeFace): void {
    for (const dispose of this.runtimeDisposers.splice(0)) dispose();
    this.runtimeDisposers.push(
      runtime.subscribe((event) => this.handleEvent(event)),
      runtime.subscribeStream((delta) => this.handleDelta(delta))
    );
    // 决策 189：每次压缩（自动或手动）在消息区提示一行压缩前后的 token 数
    const unsubscribeCompaction = runtime.subscribeCompaction?.((notice) => {
      this.flow.addSystem(`[compact] ${compactionNoticeText(notice)}`);
      // 压缩后上下文用量随之下降；压缩前复盘的花费在其收尾后计入
      this.refreshContext();
      this.collectChildCosts();
      this.tui.requestRender();
    });
    if (unsubscribeCompaction !== undefined) {
      this.runtimeDisposers.push(unsubscribeCompaction);
    }
    const unsubscribeToolResults = runtime.subscribeToolResults?.((notice) =>
      this.handleToolResult(notice)
    );
    if (unsubscribeToolResults !== undefined) {
      this.runtimeDisposers.push(unsubscribeToolResults);
    }
    this.refreshContext();
    // 决策 294、301：worker 生命周期事件驱动编排面板——agent 派出的 worker 同样即时显示与刷新
    const unsubscribeWorkers = this.current.workers?.subscribe?.((event) => {
      if (event !== undefined) this.handleWorkerLifecycle(event);
      refreshWorkersView(this);
      this.tui.requestRender();
    });
    if (unsubscribeWorkers !== undefined) {
      this.runtimeDisposers.push(unsubscribeWorkers);
    }
    // 决策 301：worker 的运行事件、流式正文与工具结果（面板的轮数、花费与正在做什么；进入的 worker 会话实时显示）
    const unsubscribeActivity = this.current.workers?.observe?.((activity) =>
      this.handleWorkerActivity(activity)
    );
    if (unsubscribeActivity !== undefined) {
      this.runtimeDisposers.push(unsubscribeActivity);
    }
  }

  stop(): void {
    // fail-closed（决策 029）：壳停止时挂起的审批按拒绝处理、恢复菜单按 EOF 语义回 null
    closePendingModals(this);
    this.workerSession?.unsubscribe();
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const dispose of this.runtimeDisposers.splice(0)) dispose();
    if (this.workerTimerHandle !== null) {
      clearInterval(this.workerTimerHandle);
      this.workerTimerHandle = null;
    }
    if (this.started) {
      this.started = false;
      this.tui.stop();
    }
  }

  updateStatus(): void {
    // 决策 301：worker 会话里状态行说明这个 worker 的状态与可用的动作
    if (this.view === "history" && this.pendingApprovalState === null) {
      this.statusLine.setText(
        `history: read only | [esc] back to ${this.returnTo.view === "tree" ? "tree" : "main"}`
      );
      return;
    }
    if (
      this.view === "worker" &&
      this.workerSession !== undefined &&
      this.pendingApprovalState === null
    ) {
      this.statusLine.setText(this.workerSessionStatusText(this.workerSession.sessionId));
      return;
    }
    // 状态行纯 ASCII；审批期间输入归模态键控，运行中与 resume 期间输入排队（决策 286）
    const base =
      this.pendingApprovalState !== null
        ? "state: approval | decide in panel"
        : this.resuming
          ? "state: resume | restoring session; input is queued"
          : this.interrupting
            ? "state: cancelling | waiting for run to settle"
            : this.running
              ? "state: running | [enter] queue, [esc] interrupt"
              : "state: idle | [enter] submit, [ctrl+j] newline";
    this.statusLine.setText(base);
  }

  private handleSubmit(value: string): void {
    // 空输入（纯空白）：静默忽略——不回显、不提交、不提示（理由行同口径：留在理由行继续编辑）
    if (value.trim() === "") return;
    // 理由行提交（决策 066）：本次回车是拒绝理由而非任务提交——理由逐字回模型，审批就此决议
    if (this.reasonModeOn) {
      const reason = value.trim();
      this.reasonModeOn = false;
      const approval = this.pendingApprovalState;
      this.pendingApprovalState = null;
      this.addApprovalLine(`拒绝理由：${reason}`);
      this.updateStatus();
      this.tui.requestRender();
      approval?.resolve({ key: "r", reason });
      return;
    }
    // 历史（286）：发出的与排队的都进历史；拒绝理由不进
    this.input.addToHistory(value);
    this.options.promptHistory?.add(value);
    // 决策 301：worker 会话里的输入归这个 worker（与主会话是否在跑无关）
    if (this.view === "worker" && this.workerSession !== undefined) {
      this.handleWorkerSessionSubmit(this.workerSession.sessionId, value);
      this.tui.requestRender();
      return;
    }
    if (this.isBusy()) {
      if (value.startsWith("/")) {
        // 运行中的斜杠命令不排队：放行的照常执行，改主会话状态或工作目录的拒绝并说明原因、输入留在输入框
        const rejection = rejectWhileRunning(value);
        if (rejection !== undefined) {
          this.input.setText(value);
          this.flow.addSystem(rejection);
        } else {
          this.flow.addUserEcho(value);
          dispatchSlashCommand(this, value);
        }
        this.tui.requestRender();
        return;
      }
      // 决策 286：运行中输入进队列，空闲后逐条发出
      this.queue.enqueue(value);
      this.tui.requestRender();
      return;
    }
    this.submitNow(value);
  }

  // 运行中（含压缩）或 /resume 进行中：输入排队、改状态的命令被拒
  private isBusy(): boolean {
    return this.running || this.resuming;
  }

  // 立即提交一条输入（空闲时的回车，或空闲后从队列取出的一条）
  private submitNow(value: string): void {
    // S3 斜杠命令：grant 治理面投影（/grants /revoke /grants save）——命令层与
    // cli REPL 同一份（application/grants.ts，决策 030），write 回调落消息区
    if (value.startsWith("/")) {
      this.flow.addUserEcho(value);
      dispatchSlashCommand(this, value);
      this.tui.requestRender();
      return;
    }
    this.flow.addUserEcho(value);
    this.running = true;
    this.runCancelled = false;
    this.updateStatus();
    this.tui.requestRender();
    // 决策 309：点名只看人的这条输入
    this.options.onHumanInput?.(value);
    // 决策 323、324：UserPromptSubmit 挡在每条输入前——可拦下、可补上下文；随后才是唯一提交通道
    //（application API：当前会话运行面——/resume 换绑后是新面）。终态摘要在 run() 决议后落
    void this.runWithHooks(value);
  }

  // 决策 323、324：UserPromptSubmit——拦下则这一条不跑（理由落消息区），补的上下文与 SessionStart
  // 待用上下文一起前缀给本次输入。钩子出错如实提示，不挡提交
  private async runWithHooks(value: string): Promise<void> {
    let input = value;
    const hooks = this.current.hooks;
    if (hooks !== undefined && !hooks.disabled) {
      try {
        const report = await hooks.runEvent("UserPromptSubmit", "", { prompt: value });
        for (const line of report.systemMessages) this.flow.addSystem(line);
        const blocked =
          report.blocked?.reason ??
          (report.continueFalse !== undefined
            ? (report.continueFalse.stopReason ?? "钩子要求整个会话停止")
            : undefined);
        if (blocked !== undefined) {
          this.flow.addSystem(`输入被钩子拦下：${blocked}`);
          this.finishRun();
          return;
        }
        const contexts = [...this.hookContexts, ...report.additionalContext];
        this.hookContexts = [];
        if (contexts.length > 0) input = `${contexts.join("\n\n")}\n\n${value}`;
      } catch (error) {
        this.flow.addSystem(
          `钩子出错（UserPromptSubmit）：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.current.runtime.run(input).then(
      (result) => this.handleRunEnd(result),
      (error: unknown) => this.handleRunEnd(null, error)
    );
  }

  // 空闲后发出排队的输入（pi 惯例逐条：一条跑完再发下一条）；即时完成的命令不占住，接着发下一条。
  // 决策 297：worker 完成通知也从这里发出——有排队的输入时先发输入，这一轮由运行面在开头带上已到的通知（通知在前、输入在后）；
  // 没有排队的输入时，已到的通知单独跑一轮（只带通知）
  private drainQueue(): void {
    while (!this.isBusy() && this.started && !this.picker.isOpen() && this.queue.size() > 0) {
      const next = this.queue.take();
      if (next === undefined) break;
      this.submitNow(next);
    }
    const runtime = this.current.runtime;
    if (
      !this.isBusy() &&
      this.started &&
      !this.picker.isOpen() &&
      runtime.runNotices !== undefined &&
      (runtime.pendingNotices?.() ?? 0) > 0
    ) {
      this.running = true;
      this.runCancelled = false;
      this.updateStatus();
      runtime.runNotices().then(
        (result) => this.handleRunEnd(result),
        (error: unknown) => this.handleRunEnd(null, error)
      );
    }
    this.tui.requestRender();
  }

  // 决策 297：worker 完成通知到来时叫醒主 agent——与排队输入同一个出口；在跑时不动，通知留在运行面上，下一轮或这一轮结束后再递
  runNotices(): void {
    this.drainQueue();
  }

  // 决策 309：/orchestrate 的命令面（CommandsHost）
  scriptCommands(): ScriptCommands | undefined {
    return this.options.scriptCommands?.();
  }

  // 以人的输入提交一条（/orchestrate 发起）：空闲即发，运行中排队
  submitInput(text: string): void {
    if (this.isBusy()) {
      this.queue.enqueue(text);
      this.tui.requestRender();
      return;
    }
    this.submitNow(text);
  }

  // ---- 决策 286：排队接口（编排一段在"下一轮发什么"处接入 worker 完成通知）----

  enqueueInput(text: string): void {
    this.queue.enqueue(text);
    this.drainQueue();
  }

  queuedInputs(): readonly string[] {
    return this.queue.pending();
  }

  // 把排队内容退回输入框（排队在前、已有草稿在后）
  restoreQueueToEditor(): void {
    if (this.queue.size() === 0) return;
    this.input.setText(this.queue.restoreInto(this.input.getText()));
    this.tui.requestRender();
  }

  // ---- 决策 286：视图按键（选择器、Ctrl+O、退回排队）----

  private handleViewKey(data: string): { consume: true } | undefined {
    if (this.picker.isOpen()) {
      const key: PickerKey | undefined = matchesKey(data, "up")
        ? "up"
        : matchesKey(data, "down")
          ? "down"
          : matchesKey(data, "enter")
            ? "enter"
            : matchesKey(data, "escape")
              ? "escape"
              : undefined;
      if (key !== undefined) {
        this.picker.press(key);
        this.tui.requestRender();
      }
      // 选择器打开期间其余按键吞掉，输入框内容不动
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      const expanded = !this.flow.toolsExpandedState();
      this.flow.setToolsExpanded(expanded);
      this.workerSession?.flow.setToolsExpanded(expanded);
      this.historySession?.flow.setToolsExpanded(expanded);
      this.tui.requestRender();
      return { consume: true };
    }
    if ((matchesKey(data, "alt+up") || matchesKey(data, "alt+q")) && this.queue.size() > 0) {
      this.restoreQueueToEditor();
      return { consume: true };
    }
    return undefined;
  }

  // ---- 决策 286：工具结果、上下文用量与花费 ----

  private handleToolResult(notice: ToolResultNotice): void {
    // 同增量：只认当前 Run 的出处
    if (this.activeRunId === null || notice.runId !== this.activeRunId) return;
    attachToolResultTo(this.flow, notice);
    // 工具执行中另发的模型请求（web_fetch 的提炼等）计入本会话花费
    const extra = toolResultModelUsage(notice.details);
    if (extra !== undefined) {
      addUsage(this.costLive, extra, {
        ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
        endMs: Date.now(),
      });
      this.refreshCost();
    }
    this.tui.requestRender();
  }

  private refreshContext(): void {
    const usage = this.current.runtime.contextUsage?.();
    this.statusBar.update(usage !== undefined ? { context: usage } : { context: undefined });
  }

  private refreshCost(): void {
    const total = emptyCostTally();
    mergeCostTally(total, this.costBase);
    mergeCostTally(total, this.costLive);
    // 决策 301：在跑 worker 的实时花费（与面板同源）；收尾后由会话记录计入的不再另算
    const children = this.childCosts;
    mergeCostTally(
      total,
      this.tracker.uncountedTotal((sessionId) => children?.isCollected(sessionId) === true)
    );
    this.statusBar.update({ cost: total });
  }

  // 打开或续接会话时重置花费：续接从会话记录累计已有花费（主会话、其 worker 与复盘）
  private resetCosts(sessionId: SessionId, resumed: boolean): void {
    const root = this.options.sessions?.root;
    this.costLive = emptyCostTally();
    if (root === undefined) {
      this.costBase = emptyCostTally();
      this.childCosts = undefined;
    } else {
      const sessionsRoot = sessionsDirOf(root);
      try {
        this.costBase = resumed
          ? accumulatedSessionCost(sessionsRoot, sessionId)
          : emptyCostTally();
      } catch {
        this.costBase = emptyCostTally();
      }
      this.childCosts = new ChildSessionCosts(sessionsRoot, sessionId, Date.now());
    }
    this.refreshCost();
  }

  // 收尾了的 worker 与复盘会话的花费（运行收尾、压缩、worker 收尾时查）
  private collectChildCosts(): void {
    if (this.childCosts === undefined) return;
    try {
      mergeCostTally(this.costLive, this.childCosts.collect());
    } catch {
      // 读会话文件失败：这次不计，下次再看
    }
    this.refreshCost();
  }

  // 后台补做复盘的进度（283、284）：状态栏显示第几个、共几个、花了多少；undefined 即不再显示
  setBackfillProgress(progress: BackfillStatus | undefined): void {
    this.statusBar.update({ backfill: progress });
    this.tui.requestRender();
  }

  // 运行期告警（复盘、压缩、会话存储、工作区快照等）：终端界面运行期间落消息区，文案与去重由告警方负责
  addWarning(line: string): void {
    this.flow.addSystem(line);
    this.tui.requestRender();
  }

  // 启动时直接续接的会话（pigeon --continue / --resume <id>）：给出续跑报告与历史，并从会话记录累计已有花费
  announceResumed(root: string, report: readonly string[]): void {
    for (const line of report) this.flow.addSystem(line);
    this.resetCosts(this.current.sessionId, true);
    renderHistory(this, root, this.current.sessionId);
  }

  // 会话选择器（286）：/resume 与 pigeon --resume 不带会话号时弹出；当前会话与没有输入过的会话不列
  openSessionPicker(): void {
    const root = this.options.resume?.root;
    if (root === undefined) {
      this.flow.addSystem("本会话不支持 /resume");
      this.tui.requestRender();
      return;
    }
    let sessions: ReturnType<typeof listRecentMainSessions>;
    try {
      sessions = listRecentMainSessions(root).filter(
        (session) => session.sessionId !== this.current.sessionId && session.turns > 0
      );
    } catch (error) {
      this.flow.addSystem(
        `读会话列表失败：${error instanceof Error ? error.message : String(error)}`
      );
      this.tui.requestRender();
      return;
    }
    if (sessions.length === 0) {
      this.flow.addSystem("没有可续接的会话");
      this.tui.requestRender();
      return;
    }
    this.picker.open(sessions, (picked) => {
      if (picked === undefined) {
        this.flow.addSystem("已取消选择会话");
      } else if (picked.sandbox) {
        this.flow.addSystem(sandboxResumeHint(picked.sessionId));
      } else {
        this.flow.addUserEcho(`/resume ${picked.sessionId}`);
        dispatchResumeCommand(this, picked.sessionId);
      }
      this.tui.requestRender();
      this.drainQueue();
    });
    this.tui.requestRender();
  }

  // ---- S3 审批面板（TuiApprovalFace 实现；交互语义在 modal.ts）----

  askApproval(request: ApprovalRequest, directoryGrant?: boolean): Promise<ApprovalPanelResult> {
    // 决策 301：就地弹出——在树形视图、面板或 worker 会话里时不切走，面板写明来源，答完仍留在原处
    this.clearApprovalBox();
    return askApprovalPanel(this, request, directoryGrant);
  }

  // 审批结果回显（handler 在决议后调用：裁决行 / 已创建放权行）
  noteApproval(line: string): void {
    this.addApprovalLine(line);
    this.tui.requestRender();
  }

  // 决策 301：审批面板的各行——主会话的消息区照常留下记录；在 worker 会话里同时写进它的消息区，在树形视图里显示在树下方
  addApprovalLine(line: string): void {
    this.flow.addSystem(line);
    if (this.view === "worker" && this.workerSession !== undefined) {
      this.workerSession.flow.addSystem(line);
    } else if (this.view === "tree" || this.view === "history") {
      this.approvalBoxText =
        this.approvalBoxText === "" ? line : `${this.approvalBoxText}\n${line}`;
      this.approvalBox.setText(this.approvalBoxText);
    }
  }

  private clearApprovalBox(): void {
    this.approvalBoxText = "";
    this.approvalBox.setText("");
  }

  outsideMainView(): boolean {
    return this.view !== "main";
  }

  // ---- 子模块窄接口（状态本体在本壳，子模块只读写不持有）----

  isStarted(): boolean {
    return this.started;
  }

  isRunning(): boolean {
    return this.running;
  }

  pendingApproval(): PendingApproval | null {
    return this.pendingApprovalState;
  }

  setPendingApproval(pending: PendingApproval | null): void {
    this.pendingApprovalState = pending;
    if (pending === null) this.clearApprovalBox();
  }

  lastCtrlCAt(): number | null {
    return this.lastCtrlCAtValue;
  }

  setLastCtrlCAt(at: number | null): void {
    this.lastCtrlCAtValue = at;
  }

  reasonMode(): boolean {
    return this.reasonModeOn;
  }

  setReasonMode(on: boolean): void {
    this.reasonModeOn = on;
  }

  exitWindowMs(): number {
    return this.options.exitWindowMs ?? 1000;
  }

  addSystem(line: string): void {
    this.flow.addSystem(line);
  }

  addHistoryLines(lines: Parameters<MessageFlow["addHistory"]>[0]): void {
    this.flow.addHistory(lines);
  }

  clearInput(): void {
    this.input.setText("");
  }

  render(): void {
    this.tui.requestRender();
  }

  sessionId(): SessionId {
    return this.current.sessionId;
  }

  grants(): TuiGrantsContext | undefined {
    return this.current.grants;
  }

  workers(): TuiWorkersFace | undefined {
    return this.current.workers;
  }

  sessionsRoot(): string | undefined {
    return this.options.sessions?.root;
  }

  searchRoot(): string | undefined {
    return this.options.search?.root;
  }

  resumeConfigured(): boolean {
    return this.options.resume !== undefined;
  }

  sandbox(): TuiSandboxFace | undefined {
    return this.options.sandbox;
  }

  resumeOptions(): ResumeOptions<TuiSessionBinding> | undefined {
    return this.options.resume;
  }

  historyLimit(): number | undefined {
    return this.options.historyLimit;
  }

  hasRunningWorkers(): boolean {
    return this.current.workers?.status().some((worker) => worker.state === "running") === true;
  }

  setResuming(resuming: boolean): void {
    this.resuming = resuming;
    // /resume 流程收尾（成败皆然）后发出排队的输入；延到本轮调用栈之后，让流程先写完收尾行
    if (!resuming) queueMicrotask(() => this.drainQueue());
  }

  // worker 状态刷新（生命周期事件、命令与定时器）：收尾（在跑的个数减少）时把其花费由会话记录计入本会话
  workersRefreshed(workers: readonly WorkerStatus[]): void {
    // 面板淡出按收尾时刻：生命周期事件没带到的（编排面不发事件时），以第一次看到它已收尾的时刻为准
    for (const status of workers) {
      if (!isActiveWorker(status) && this.tracker.get(status.sessionId)?.settledAt === undefined) {
        this.tracker.settled(status.sessionId, this.now());
      }
    }
    const running = workers.filter((w) => w.state === "running").length;
    if (running < this.runningWorkerCount) this.collectChildCosts();
    else this.refreshCost();
    this.runningWorkerCount = running;
    if (this.view === "worker") this.updateStatus();
  }

  // 定时刷新（面板的耗时在走、结束的到点淡出）：有在跑或排队的，或还有结束的在淡出期内
  workersNeedTicking(workers: readonly WorkerStatus[]): boolean {
    return (
      workers.some(isActiveWorker) ||
      hasFadingWorkers(workers, this.tracker, this.now(), this.options.panelFadeMs ?? PANEL_FADE_MS)
    );
  }

  workerActivity(): WorkerActivityTracker {
    return this.tracker;
  }

  clock(): number {
    return this.now();
  }

  workerTimer(): ReturnType<typeof setInterval> | null {
    return this.workerTimerHandle;
  }

  setWorkerTimer(timer: ReturnType<typeof setInterval> | null): void {
    this.workerTimerHandle = timer;
  }

  workerRefreshMs(): number {
    return this.options.workerRefreshMs ?? 1000;
  }

  spawnCommand(workers: TuiWorkersFace, raw: string): void {
    handleSpawnCommand(this, workers, raw);
  }

  cancelCommand(workers: TuiWorkersFace, ref: string | undefined): void {
    handleCancelCommand(this, workers, ref);
  }

  takeCommand(workers: TuiWorkersFace, name: string | undefined): void {
    handleTakeCommand(this, workers, name);
  }

  workersStatusCommand(workers: TuiWorkersFace): void {
    showWorkersStatus(this, workers);
  }

  // /resume：不带会话号弹出选择器（286）；沙箱会话不在本机界面里续接，说明用法
  resumeCommand(arg: string | undefined): void {
    if (arg === undefined) {
      this.openSessionPicker();
      return;
    }
    const root = this.options.resume?.root;
    if (root !== undefined && isSandboxSession(root, arg)) {
      this.flow.addSystem(sandboxResumeHint(arg));
      return;
    }
    dispatchResumeCommand(this, arg);
  }

  // 决策 340：/reload——重读期间与 Run 同样占住输入；结果逐行写进消息区
  get reloadCommand(): ((args: readonly string[]) => void) | undefined {
    const reload = this.options.reload;
    if (reload === undefined) return undefined;
    return (args) => {
      this.running = true;
      this.updateStatus();
      this.tui.requestRender();
      const finish = (lines: readonly string[]): void => {
        this.running = false;
        for (const line of lines) this.flow.addSystem(line);
        this.updateStatus();
        this.tui.requestRender();
        this.drainQueue();
      };
      reload(args).then(finish, (error: unknown) =>
        finish([`重读设置失败：${error instanceof Error ? error.message : String(error)}`])
      );
    };
  }

  // 决策 189：/compact [重点] 手动压缩——压缩期间与 Run 同样占住输入（输入排队，决策 286）；压成时的一行提示由订阅给出，
  // 没有压成时说明原因
  compactCommand(focus: string | undefined): void {
    const runtime = this.current.runtime;
    if (runtime.compact === undefined) {
      this.flow.addSystem("本会话不支持 /compact");
      this.tui.requestRender();
      return;
    }
    this.running = true;
    this.updateStatus();
    this.tui.requestRender();
    const settleCompact = (line: string | undefined): void => {
      this.running = false;
      if (line !== undefined) {
        this.flow.addSystem(`[compact] ${line}`);
      }
      this.refreshContext();
      this.collectChildCosts();
      this.updateStatus();
      this.tui.requestRender();
      this.drainQueue();
    };
    runtime.compact(focus).then(
      (outcome) => settleCompact(manualCompactionText(outcome)),
      (error: unknown) =>
        settleCompact(`压缩失败：${error instanceof Error ? error.message : String(error)}`)
    );
  }

  // ---- 退出与取消（键位路由在 modal.ts）----

  // 优雅退出（S5+，裁决 033）：双击 Ctrl+C 与 /quit 共用本路径——先 stop()（dispose
  // 对称；挂起审批 fail-closed 按拒绝处理、理由逐字 APPROVAL_CANCEL_CLOSED，证据链不断；
  // 恢复菜单按 EOF 语义回 null），再回调注入的 onExit。幂等：退出恰好一次
  requestExit(): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    this.stop();
    this.options.onExit?.();
  }

  // 取消入口（S5）：触发 adapter.interrupt()（固定姿势 abort → waitForIdle，注释约束 5）。
  // 重复取消防御：中断飞行中不再触发——不 double-abort、不悬挂；running 清算在
  // handleRunEnd（run() 决议承载终态），interrupt 决议只清飞行标记
  requestInterrupt(cause?: RunStopCause): void {
    if (this.interrupting) return;
    this.interrupting = true;
    // 决策 323：被取消的一轮不跑 Stop 钩子（外部取消与打转叫停都算）
    this.runCancelled = true;
    this.flow.addSystem("[cancel] interrupt requested; waiting for run to settle");
    // pi 惯例：中断时排队内容退回输入框，不在中断后自动发出
    this.restoreQueueToEditor();
    this.updateStatus();
    this.tui.requestRender();
    const settle = (error?: unknown): void => {
      this.interrupting = false;
      if (error !== undefined) {
        // interrupt 自身抛异常（装配级故障）：如实呈现，不伪装成已取消
        this.flow.addSystem(
          `[cancel] interrupt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.updateStatus();
      this.tui.requestRender();
    };
    this.current.runtime.interrupt(cause).then(
      () => settle(),
      (error: unknown) => settle(error)
    );
  }

  // 决策 307：打转叫停——消息区写明检测到打转、重复的调用与轮数，再同 Esc 一样中断本轮（原因记为打转）；会话照常可用
  stopForLoop(text: string): void {
    this.flow.addSystem(text);
    this.requestInterrupt("looping");
  }

  // D2 可见化的 TUI 投影（S5）：会话记录写入失败非空时消息区警告——措辞与 cli repl 同口径，
  // 增量报数（同一批故障不重复刷屏，新故障以累计数提醒）；启动即查 + 每次 run 收尾复查
  private warnEvidenceGaps(): void {
    const count = this.current.runtime.listenerErrors().length;
    if (count > this.reportedListenerErrors) {
      this.flow.addSystem(`警告：本会话有 ${count} 条会话记录写入失败，证据链不完整。`);
      this.reportedListenerErrors = count;
    }
  }

  // ---- 决策 323、324：会话级钩子（SessionStart / SessionEnd / Notification 与 /hooks）----

  // SessionStart：装配方在壳接管终端之前（首次）调用；补的上下文存起来当作下一条输入的前缀，
  // 消息区提示一行。source：首次启动 "startup"、续跑或换绑/重建 "resume"
  async beginSession(source: "startup" | "resume"): Promise<void> {
    this.hookContexts = [];
    const hooks = this.current.hooks;
    if (hooks === undefined || hooks.disabled) return;
    try {
      const report = await hooks.runEvent("SessionStart", source, { source });
      for (const line of report.systemMessages) this.flow.addSystem(line);
      this.hookContexts = [...report.additionalContext];
      if (this.hookContexts.length > 0) {
        this.flow.addSystem("[hooks] SessionStart 补的上下文将在下一条输入带上");
      }
    } catch (error) {
      this.flow.addSystem(
        `钩子出错（SessionStart）：${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.tui.requestRender();
  }

  // SessionEnd：退出前（reason "exit"）与换绑/重建换走旧会话前（reason "switch"）调用；
  // 必须在释放运行面之前跑，记录才落在本会话文件里
  async endSession(reason: "exit" | "switch"): Promise<void> {
    const hooks = this.current.hooks;
    if (hooks === undefined || hooks.disabled) return;
    try {
      await hooks.runEvent("SessionEnd", reason, { reason });
    } catch {
      // 收尾钩子出错不挡退出（记录已在 SessionHooks 里如实落盘）
    }
  }

  // 决策 323、324：Notification（只作副作用）——审批面板出现时 permission_prompt；
  // worker 的请示汇到本会话时另记 worker_approval（message 用面板提示原文）
  notifyApprovalHook(notificationType: string, message: string): void {
    const hooks = this.current.hooks;
    if (hooks === undefined || hooks.disabled) return;
    void hooks
      .runEvent("Notification", notificationType, { message, notification_type: notificationType })
      .catch(() => undefined);
  }

  // /hooks 的只读面（跟着当前会话；/resume 换绑与 /reload 重建后是新会话的面）
  hooksView(): TuiHooksFace | undefined {
    return this.current.hooks;
  }

  // 换绑（S4）：会话上下文一体替换（sessionId + 运行面 + 治理上下文），chrome 标题跟进，
  // 运行面订阅先退旧再订新；消息区内容保留（对账报告与重建说明是恢复的证据链呈现）
  rebindSession(sessionId: SessionId, binding: TuiSessionBinding): void {
    // 决策 301：换到另一个会话——worker 记录属于原会话的编排器，清掉并回到主会话视图
    this.leaveWorkerSession();
    this.showView("main");
    this.tracker.clear();
    this.current = {
      sessionId,
      runtime: binding.runtime,
      ...(binding.grants !== undefined ? { grants: binding.grants } : {}),
      ...(binding.workers !== undefined ? { workers: binding.workers } : {}),
      ...(binding.hooks !== undefined ? { hooks: binding.hooks } : {}),
    };
    // 决策 323、324：换到新会话——SessionStart（source "resume"）补的上下文归新会话；
    // 旧会话的 SessionEnd 由装配方在释放旧运行面前跑
    void this.beginSession("resume");
    this.activeRunId = null;
    // S5：落盘失败警告计数随运行面一起换绑——新面的 listenerErrors 从零起算
    this.reportedListenerErrors = 0;
    this.title.setText(`== pigeon tui | session ${sessionId} ==`);
    this.bindRuntime(binding.runtime);
    this.resetCosts(sessionId, true);
    refreshWorkersView(this);
    this.tui.requestRender();
  }

  // ---- 决策 301：编排面板、树形视图与进入 worker 会话 ----

  // 当前视图（测试与命令用）
  currentView(): ShellView {
    return this.view;
  }

  // 切换视图：重排组件、标题与状态行跟着变；消息区整体换掉，强制全量重绘
  private showView(view: ShellView): void {
    if (view !== "worker") this.leaveWorkerSession();
    if (view !== "history") this.historySession = undefined;
    this.view = view;
    const session = this.workerSession;
    const worker =
      session !== undefined
        ? this.workerStatuses().find((status) => status.sessionId === session.sessionId)
        : undefined;
    const back = this.returnTo.view === "tree" ? "tree" : "main";
    this.title.setText(
      view === "worker" && session !== undefined
        ? `== pigeon tui | worker ${worker?.name ?? session.sessionId} | session ${session.sessionId} | [esc] back to ${back} ==`
        : view === "history" && this.historySession !== undefined
          ? `== pigeon tui | history | session ${this.historySession.sessionId} | read only | [esc] back to ${back} ==`
          : `== pigeon tui | session ${this.current.sessionId} ==`
    );
    this.layout();
    this.tui.setFocus(this.input);
    this.updateStatus();
    this.tui.requestRender(true);
  }

  // /agents 与 Ctrl+X：打开或关上树形视图（没有编排面时说明）
  toggleTree(): void {
    if (this.current.workers === undefined) {
      this.flow.addSystem("本会话不支持 worker（没有编排面）");
      this.tui.requestRender();
      return;
    }
    this.panel.blur();
    if (this.view === "tree") {
      this.showView("main");
      return;
    }
    // /agents 与 Ctrl+X 进运行中模式
    this.treeMode = "running";
    this.showView("tree");
  }

  // 决策 304：回到树形视图的某个模式（会话树每次进入都重读这一家）
  private showTree(mode: TreeMode): void {
    this.treeMode = mode;
    if (mode === "sessions") this.loadSessionTree();
    this.showView("tree");
  }

  private loadSessionTree(): void {
    const root = this.options.sessions?.root;
    if (root === undefined) {
      this.sessionTree.fail("本会话不支持会话树（没有会话存储）");
      return;
    }
    try {
      this.sessionTree.load(loadSessionFamily(sessionsDirOf(root), this.current.sessionId));
    } catch (error) {
      this.sessionTree.fail(
        `读会话树失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 会话树里 Enter：本次运行编排器里的 worker 进入其会话（实时加历史），其余只读看历史
  private viewFamilyNode(node: FamilyNode): void {
    if (node.kind === "unreadable") {
      this.sessionTree.setNote("读不到这个会话，不能查看");
      return;
    }
    this.returnTo = { view: "tree", mode: "sessions" };
    if (
      node.kind === "worker" &&
      this.workerStatuses().some((status) => status.sessionId === node.sessionId)
    ) {
      this.openWorkerSession(node.sessionId as SessionId, this.returnTo);
      return;
    }
    this.openHistory(node.sessionId, familyKindLabel(node));
  }

  // 只读的历史查看（任意会话）：与进入 worker 会话同一份历史渲染，没有输入框，Esc 回到进入的地方
  private openHistory(sessionId: string, label: string): void {
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    flow.addSystem(`== ${label} | 会话 ${sessionId} | 只读 ==`);
    this.renderHistoryInto(flow, sessionId, "== 历史结束 ==");
    this.historySession = { sessionId, flow };
    this.showView("history");
  }

  // 读会话文件渲染历史（与 /resume 同一份读取与上限）
  private renderHistoryInto(flow: MessageFlow, sessionId: string, endLine: string): void {
    const root = this.options.sessions?.root;
    if (root === undefined) return;
    try {
      const limit = this.options.historyLimit;
      const lines = loadSessionHistory(root, sessionId, limit !== undefined ? { limit } : {});
      flow.addSystem(`== 历史：会话 ${sessionId}（${lines.length} 行）==`);
      flow.addHistory(lines);
      flow.addSystem(endLine);
    } catch (error) {
      flow.addSystem(`历史渲染失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 会话树里 r：在此续接——只对主会话、分支与失败重试，走 /resume 同一流程；说明写在树下方
  private resumeFamilyNode(node: FamilyNode): void {
    const refusal =
      node.kind === "review"
        ? "复盘会话只能查看，不能续接"
        : node.kind === "worker"
          ? "worker 会话在这里只能查看，不能续接"
          : node.kind === "fork"
            ? "未标明种类的分叉只能查看，不能续接"
            : node.kind === "unreadable"
              ? "读不到这个会话，不能续接"
              : node.sessionId === this.current.sessionId
                ? "当前会话不能续接"
                : this.isBusy()
                  ? resumeWhileRunningText()
                  : !this.resumeConfigured()
                    ? "本会话不支持续接"
                    : undefined;
    if (refusal !== undefined) {
      this.sessionTree.setNote(refusal);
      return;
    }
    const root = this.options.resume?.root;
    if (root !== undefined && isSandboxSession(root, node.sessionId)) {
      this.sessionTree.setNote(sandboxResumeHint(node.sessionId));
      return;
    }
    this.returnTo = { view: "main" };
    this.showView("main");
    this.flow.addUserEcho(`/resume ${node.sessionId}`);
    dispatchResumeCommand(this, node.sessionId);
  }

  // 进入 worker 的会话：消息区换成它的对话——历史取自它的会话记录（与 /resume 同一份渲染），之后的运行事件、流式正文与
  // 工具结果实时投影（与主会话同一套投影）
  openWorkerSession(sessionId: SessionId, returnTo: ReturnTo = { view: "main" }): void {
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (status === undefined) return;
    this.leaveWorkerSession();
    this.returnTo = returnTo;
    const flow = new MessageFlow();
    flow.setToolsExpanded(this.flow.toolsExpandedState());
    flow.addSystem(
      `== worker ${status.name}（${status.role}）| 会话 ${status.sessionId}` +
        `${status.label !== undefined ? ` | 标签 ${status.label}` : ""} ==`
    );
    this.renderHistoryInto(flow, sessionId, "== 历史结束，以下为实时 ==");
    if (status.outcome !== undefined) flow.addSystem(renderWorkerOutcome(status.outcome));
    const unsubscribe = this.tracker.listen((activity) => {
      if (activity.worker.sessionId !== sessionId) return;
      if (activity.kind === "event") {
        projectRuntimeEvent(flow, activity.event);
      } else if (activity.kind === "delta") {
        if (activity.delta.kind === "thinking") flow.appendThinkingDelta(activity.delta.delta);
        else flow.appendDelta(activity.delta.delta);
      } else {
        attachToolResultTo(flow, activity.result);
      }
    });
    this.workerSession = { sessionId, flow, unsubscribe };
    this.panel.blur();
    this.showView("worker");
  }

  private leaveWorkerSession(): void {
    this.workerSession?.unsubscribe();
    this.workerSession = undefined;
  }

  private workerSessionStatusText(sessionId: SessionId): string {
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (status === undefined) return "worker: unknown | [esc] back";
    const actions = isActiveWorker(status)
      ? "[enter] message, /stop, [esc] back"
      : isBlockedWorker(status)
        ? "read only, /approve to approve and continue, [esc] back"
        : "read only, [esc] back";
    return `worker: ${status.name} ${workerStateWord(status)} | ${actions}`;
  }

  // 生命周期：面板淡出与续做的记账；进入的 worker 会话里写上收尾摘要与续做
  private handleWorkerLifecycle(event: WorkerLifecycleEvent): void {
    if (event.kind === "worker.settled") {
      this.tracker.settled(event.worker.sessionId, event.at);
    } else if (event.kind === "worker.resumed") {
      this.tracker.resumed(event.worker.sessionId);
    }
    const session = this.workerSession;
    if (session === undefined || session.sessionId !== event.worker.sessionId) return;
    if (event.kind === "worker.settled") {
      session.flow.addSystem(renderWorkerOutcome(event.outcome));
    } else if (event.kind === "worker.resumed") {
      session.flow.addSystem(
        event.approved ? "== 已补批，worker 接着做 ==" : "== worker 接着做 =="
      );
    } else if (event.kind === "worker.blocked") {
      session.flow.addSystem(`== worker 停在等审批：${event.action} ==`);
    }
    this.updateStatus();
  }

  // worker 活动：记下（面板、树形视图、状态栏花费）并转给进入的 worker 会话；轮次收尾时刷新花费
  private handleWorkerActivity(activity: WorkerActivity): void {
    this.tracker.record(activity);
    if (activity.kind === "event" && activity.event.kind === RuntimeEventKind.TurnCompleted) {
      this.refreshCost();
    }
    this.tui.requestRender();
  }

  // 编排视图的按键。Ctrl+C 与审批挂起期间放给壳级键控；树形视图打开时按键全归它
  private handleOrchestrationKey(data: string): { consume: true } | undefined {
    if (data === "\x03" || this.pendingApprovalState !== null) return undefined;
    const workers = this.current.workers;
    if (workers === undefined) return undefined;
    if (this.view === "tree" && this.treeMode === "sessions") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+x")) {
        this.returnTo = { view: "main" };
        this.showView("main");
      } else if (matchesKey(data, "tab")) {
        this.showTree("running");
      } else if (matchesKey(data, "up")) {
        this.sessionTree.move(-1);
      } else if (matchesKey(data, "down")) {
        this.sessionTree.move(1);
      } else if (matchesKey(data, "enter")) {
        const selected = this.sessionTree.selected();
        if (selected !== undefined) this.viewFamilyNode(selected);
      } else if (data === "r" || data === "R") {
        const selected = this.sessionTree.selected();
        if (selected !== undefined) this.resumeFamilyNode(selected);
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.view === "history") {
      if (matchesKey(data, "escape")) {
        this.goBack();
        return { consume: true };
      }
      // Ctrl+O 交给视图按键；其余按键吞掉（只读）
      return matchesKey(data, "ctrl+o") ? undefined : { consume: true };
    }
    if (this.view === "tree") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+x")) {
        this.returnTo = { view: "main" };
        this.showView("main");
      } else if (matchesKey(data, "tab")) {
        this.showTree("sessions");
      } else if (matchesKey(data, "up")) {
        this.tree.move(-1);
      } else if (matchesKey(data, "down")) {
        this.tree.move(1);
      } else if (matchesKey(data, "right")) {
        this.tree.setExpanded(true);
      } else if (matchesKey(data, "left")) {
        this.tree.setExpanded(false);
      } else if (matchesKey(data, "space")) {
        this.tree.toggleExpanded();
      } else if (matchesKey(data, "enter")) {
        const selected = this.tree.selected();
        if (selected !== undefined) {
          this.openWorkerSession(selected, { view: "tree", mode: "running" });
        }
      } else if (data === "X" && this.tree.selected() !== undefined) {
        // 决策 301：选中的 worker 属于某个脚本时停止整个脚本，否则同 x
        const selected = this.tree.selected() as SessionId;
        const scripts = this.options.scriptCommands?.();
        const write = (line: string): void => {
          this.flow.addSystem(line);
          this.tui.requestRender();
        };
        void (scripts?.stopOfWorker(selected) ?? Promise.resolve(undefined)).then((line) => {
          if (line !== undefined) write(line);
          else this.stopWorker(selected, write);
        });
      } else if (data === "x") {
        const selected = this.tree.selected();
        if (selected !== undefined) this.stopWorker(selected, (line) => this.flow.addSystem(line));
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.panel.isFocused()) {
      if (matchesKey(data, "up")) {
        this.panel.move(-1);
      } else if (matchesKey(data, "down")) {
        this.panel.move(1);
      } else if (matchesKey(data, "escape")) {
        this.panel.blur();
      } else if (matchesKey(data, "enter")) {
        const selected = this.panel.selected();
        if (selected !== undefined) this.openWorkerSession(selected.sessionId);
      } else if (data === "x" || data === "X") {
        const selected = this.panel.selected();
        if (selected !== undefined) {
          this.stopWorker(selected.sessionId, (line) => this.activeFlow().addSystem(line));
        }
      } else {
        // 其余按键：离开面板、交回输入框照常处理
        this.panel.blur();
        this.tui.requestRender();
        return undefined;
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+x")) {
      this.toggleTree();
      return { consume: true };
    }
    if (this.view === "worker" && matchesKey(data, "escape")) {
      this.goBack();
      return { consume: true };
    }
    // 输入框为空时按 ↓ 进入面板（Claude Code 惯例）；会话选择器打开时不抢
    if (
      matchesKey(data, "down") &&
      this.input.getText() === "" &&
      !this.picker.isOpen() &&
      this.panel.focus()
    ) {
      this.tui.requestRender();
      return { consume: true };
    }
    return undefined;
  }

  // Esc：从 worker 会话或历史查看回到进入它的地方（主会话，或树形视图的某个模式）
  private goBack(): void {
    const back = this.returnTo;
    this.returnTo = { view: "main" };
    if (back.view === "tree") this.showTree(back.mode);
    else this.showView("main");
  }

  // 当前显示的消息区（worker 会话里是它的对话）
  private activeFlow(): MessageFlow {
    return this.view === "worker" && this.workerSession !== undefined
      ? this.workerSession.flow
      : this.flow;
  }

  // 停止一个 worker（面板与树形视图的 x、worker 会话里的 /stop）：走编排器的取消，收尾照常
  private stopWorker(sessionId: SessionId, write: (line: string) => void): void {
    const workers = this.current.workers;
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (workers === undefined || status === undefined) return;
    if (!isActiveWorker(status)) {
      write(`worker ${status.name} 已收尾（${workerStateWord(status)}），无需停止`);
      return;
    }
    write(`[cancel] worker ${status.name} interrupt requested`);
    workers.cancel(sessionId).then(
      () => {
        refreshWorkersView(this);
        this.tui.requestRender();
      },
      (error: unknown) => {
        write(
          `停止 worker ${status.name} 失败：${error instanceof Error ? error.message : String(error)}`
        );
        this.tui.requestRender();
      }
    );
  }

  // worker 会话里的输入：斜杠命令按命令表（只放行 worker 会话里能用的），其余作为消息——在跑的递进它的下一轮，
  // 已收尾的带着这段话接着做
  private handleWorkerSessionSubmit(sessionId: SessionId, value: string): void {
    const session = this.workerSession;
    const workers = this.current.workers;
    if (session === undefined || workers === undefined) return;
    const flow = session.flow;
    const status = this.workerStatuses().find((worker) => worker.sessionId === sessionId);
    if (status === undefined) return;
    if (value.startsWith("/")) {
      const rejection = rejectInWorkerSession(value);
      if (rejection !== undefined) {
        this.input.setText(value);
        flow.addSystem(rejection);
        return;
      }
      flow.addUserEcho(value);
      const tokens = slashTokens(value);
      const name = lookupSlashCommand(tokens)?.name;
      if (name === "stop") {
        this.stopWorker(sessionId, (line) => flow.addSystem(line));
      } else if (name === "approve") {
        this.approveWorker(status, value.trim().slice("/approve".length).trim(), flow);
      } else if (name === "agents") {
        this.toggleTree();
      } else if (name === "workers") {
        flow.addSystem(renderWorkersTable(workers.status(), this.tracker, this.now()));
      } else if (name === "tasks") {
        flow.addSystem(
          this.tasks?.() ?? "任务清单没有开（设置 orchestration 一节的 taskList 为 false）。"
        );
      } else if (name === "quit") {
        this.requestExit();
      }
      return;
    }
    // 已收尾的 worker 会话只读：发话不续做，话留在输入框（停在等审批的用 /approve 补批续做）
    if (!isActiveWorker(status)) {
      this.input.setText(value);
      flow.addSystem(
        isBlockedWorker(status)
          ? `${WORKER_ENDED_READ_ONLY}；它停在等审批，可用 /approve 补批续做`
          : WORKER_ENDED_READ_ONLY
      );
      return;
    }
    flow.addUserEcho(value);
    if (workers.send === undefined) {
      flow.addSystem("当前编排面不支持给 worker 发消息");
      return;
    }
    workers.send(sessionId, value).then(
      (result) => {
        flow.addSystem(
          result === "delivered"
            ? `已把话递给 worker ${status.name}，它在下一轮看到`
            : `未送达：worker ${status.name} 已结束或正在收尾`
        );
        this.tui.requestRender();
      },
      (error: unknown) => {
        flow.addSystem(`发消息失败：${error instanceof Error ? error.message : String(error)}`);
        this.tui.requestRender();
      }
    );
  }

  // /approve [话]：补批停在等审批的 worker，放行它重新发起的同一个调用并接着做（编排一段的补批续做）
  private approveWorker(status: WorkerStatus, extra: string, flow: MessageFlow): void {
    const blocked = status.outcome?.blocked;
    if (!isBlockedWorker(status) || blocked === undefined) {
      flow.addSystem(`worker ${status.name} 没有停在等审批，不需要补批`);
      return;
    }
    this.resumeWorker(
      status,
      {
        approve: true,
        ...(extra !== "" ? { message: `${resumeApprovalText(blocked.action)}\n${extra}` } : {}),
      },
      flow
    );
  }

  private resumeWorker(
    status: WorkerStatus,
    options: { approve?: boolean; message?: string },
    flow: MessageFlow
  ): void {
    const workers = this.current.workers;
    if (workers?.resume === undefined) {
      flow.addSystem("当前编排面不支持让 worker 接着做");
      return;
    }
    try {
      workers.resume(status.sessionId, options);
      flow.addSystem(
        `已补批 worker ${status.name} 的调用（${status.outcome?.blocked?.action ?? ""}），它接着做`
      );
    } catch (error) {
      flow.addSystem(`续做失败：${error instanceof Error ? error.message : String(error)}`);
    }
    refreshWorkersView(this);
  }

  private handleRunEnd(result: RunResult | null, error?: unknown): void {
    this.activeRunId = null;
    this.renderRunSummary(result, error);
    // D2 可见化（S5）：每次 run 收尾复查落盘失败（增量报数，同 repl 口径）
    this.warnEvidenceGaps();
    this.refreshContext();
    this.collectChildCosts();
    // 决策 323、324：Stop 钩子在一轮收尾后跑（拦下即接着跑新一轮）；跑完才真正空闲并发排队输入
    void this.afterRun(result);
  }

  // 一轮收尾的终态摘要（S5）：status + stopReason + 四分类徽章（failureBadge，与 cli trace
  // 同口径）+ syntheticFailure 标注（若有）+ errorMessage（若有）
  private renderRunSummary(result: RunResult | null, error?: unknown): void {
    if (result !== null) {
      // 终态摘要（S5）：status + stopReason + 四分类徽章（failureBadge，与 cli trace
      // 同口径）+ syntheticFailure 标注（若有）+ errorMessage（若有）
      const parts = [`== run: ${result.status}`];
      if (result.stopReason !== undefined) parts.push(`stop: ${result.stopReason}`);
      parts.push(`分类：${failureBadge(result.failure)}`);
      if (result.syntheticFailure) parts.push("(synthetic failure)");
      if (result.errorMessage !== undefined) parts.push(`error: ${result.errorMessage}`);
      this.flow.addSystem(`${parts.join(" | ")} ==`);
    } else {
      // run() 自身抛异常（装配级故障）：如实呈现，不伪装成正常终态
      const message = error instanceof Error ? error.message : String(error);
      this.flow.addSystem(`== run: error | ${message} ==`);
    }
  }

  // 一轮真正收尾：空闲下来、刷新状态并发排队输入（Stop 钩子跑完之后）
  private finishRun(): void {
    this.running = false;
    this.updateStatus();
    this.tui.requestRender();
    this.drainQueue();
  }

  // 决策 323、324：一轮收尾后的 Stop 钩子。外部取消过、run 自身报错或钩子停用即直接收尾；
  // 拦下（或补了上下文）即把理由/上下文作为新一轮输入接着跑，连续拦到上限（stopHookBlockCap，
  // 缺省 8）后不再理会并提示一行。stop_hook_active 首次 false、继续后 true
  private async afterRun(result: RunResult | null): Promise<void> {
    try {
      if (result === null || this.runCancelled) return;
      const hooks = this.current.hooks;
      if (hooks === undefined || hooks.disabled) return;
      const cap = this.options.stopHookCap?.() ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
      let stopHookActive = false;
      let blockedCount = 0;
      for (;;) {
        let report: HookEventReport;
        try {
          report = await hooks.runEvent("Stop", "", { stop_hook_active: stopHookActive });
        } catch (error) {
          this.flow.addSystem(
            `钩子出错（Stop）：${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        for (const line of report.systemMessages) this.flow.addSystem(line);
        const wantsContinue = report.blocked !== undefined || report.additionalContext.length > 0;
        if (!wantsContinue) return;
        if (blockedCount >= cap) {
          this.flow.addSystem(`[hooks] Stop 钩子连续拦下 ${cap} 次，已到上限，不再接着跑`);
          return;
        }
        blockedCount += 1;
        stopHookActive = true;
        const reason = report.blocked?.reason;
        if (reason !== undefined) {
          this.flow.addSystem(`[hooks] Stop 拦下，理由作为新一轮输入继续：${reason}`);
        }
        const next = [...report.additionalContext, ...(reason !== undefined ? [reason] : [])].join(
          "\n\n"
        );
        const continued = await this.current.runtime.run(next);
        this.renderRunSummary(continued);
        this.warnEvidenceGaps();
        this.refreshContext();
        this.collectChildCosts();
        this.updateStatus();
        this.tui.requestRender();
        // 外部取消（Esc / 打转叫停）或本轮以中断收尾：不再接着跑
        if (this.runCancelled || continued.status === "aborted") return;
      }
    } finally {
      this.finishRun();
    }
  }

  private handleDelta(delta: StreamTextDelta): void {
    // 024：增量只认 runId 出处——非本 Run 的迟到/幽灵增量不进消息区
    if (this.activeRunId === null || delta.runId !== this.activeRunId) return;
    // M5 S2（决策 045）：thinking 增量单独一段弱化渲染，正文增量照常生长
    if (delta.kind === "thinking") {
      this.flow.appendThinkingDelta(delta.delta);
    } else {
      this.flow.appendDelta(delta.delta);
    }
    this.tui.requestRender();
  }

  private handleEvent(event: EventEnvelope): void {
    // 消息区的投影与进入的 worker 会话共用（message-flow.ts）；活动 Run、花费与上下文用量在此记
    if (event.kind === RuntimeEventKind.TurnStarted) {
      this.activeRunId = event.runId;
      this.turnStartedAt = event.timestamp;
    }
    projectRuntimeEvent(this.flow, event);
    if (event.kind === RuntimeEventKind.TurnCompleted) {
      const payload = event.payload as TurnCompletedPayload;
      // 286：主 agent 每轮的用量与价格计入本会话花费；上下文用量按最近一次回复重算
      if (payload.usage !== undefined) {
        addUsage(this.costLive, payload.usage, {
          ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
          ...(this.turnStartedAt !== undefined ? { startMs: this.turnStartedAt } : {}),
          endMs: event.timestamp,
        });
        this.refreshCost();
      }
      this.refreshContext();
    }
    this.tui.requestRender();
  }
}

// 决策 304：主 agent 运行中按 r 在此续接——照 /resume 运行中被拒的同一原因
function resumeWhileRunningText(): string {
  const spec = lookupSlashCommand(["resume"]);
  const reason =
    spec !== undefined && !spec.whileRunning.allow
      ? spec.whileRunning.reason
      : "它会改动主会话状态";
  return `运行中不能在此续接：${reason}。等本轮结束或按 Esc 中断后再用`;
}

// 决策 301：已收尾的 worker 会话只读
export const WORKER_ENDED_READ_ONLY = "这个 worker 已结束，只能查看";

// 沙箱会话在本机界面里不续接（续接要在同一容器配方里开箱）：给出命令行用法
function sandboxResumeHint(sessionId: string): string {
  return `会话 ${sessionId} 是沙箱会话，不能在本机会话里续接；请用 pigeon --sandbox --resume ${sessionId}`;
}

function isSandboxSession(root: string, sessionId: string): boolean {
  try {
    return listRecentMainSessions(root).some(
      (session) => session.sessionId === sessionId && session.sandbox
    );
  } catch {
    return false;
  }
}
