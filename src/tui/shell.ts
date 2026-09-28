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
// - busy 语义（决策 027）：运行中提交被拒绝——保留输入缓冲、消息区留 [busy] 提示、不进队列；
//   斜杠命令同样不开旁路。
// - 审批面板（S3，决策 029）、恢复菜单（S4，决策 031）、取消键（S5 裁决 032）与退出三层形态
//   （S5+ 裁决 033）的交互语义见 modal.ts；壳停止时挂起的审批 fail-closed 按拒绝处理（理由逐字）。
// - 斜杠命令（S3，决策 030）：/grants /revoke /grants save 走 application/grants.ts 的
//   命令层（与 cli REPL 同一份），输出经 write 回调投影到消息区——零新增治理语义。
// - 终态摘要（S5）：run() 决议后落终态行——status + stopReason + 四分类徽章（措辞复用
//   application/format.ts 的 failureBadge，与 cli trace 同口径）+ errorMessage（若有）+
//   syntheticFailure 标注（若有）；listenerErrors 非空时消息区增量警告（D2 可见化的
//   TUI 投影，措辞与增量报数口径同 cli repl：启动即查 + 每次 run 收尾复查）。
// - dispose 对称：取消键的订阅与监听器一律进 disposers，在 start/stop 里成对出现。
import { Input, type Terminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { compactionNoticeText, manualCompactionText } from "../application/compaction-text.ts";
import { failureBadge, summarizeArgs } from "../application/format.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type {
  CompactionNotice,
  ManualCompactionOutcome,
  RunResult,
  StreamTextDelta,
} from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type {
  ToolProposedPayload,
  ToolSettledPayload,
  TurnCompletedPayload,
} from "../state/runtime-events.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import type { ApprovalPanelResult, TuiApprovalFace } from "./approval.ts";
import {
  type CommandsHost,
  handleSlashCommand as dispatchSlashCommand,
  type TuiGrantsContext,
} from "./commands.ts";
import { MessageFlow } from "./message-flow.ts";
import {
  askApprovalPanel,
  askMenuChoice as askMenuChoiceModal,
  closePendingModals,
  handleShellKey,
  type ModalHost,
  type PendingApproval,
  type PendingMenu,
} from "./modal.ts";
import {
  handleResumeCommand as dispatchResumeCommand,
  type ResumeOptions,
  type ResumeViewHost,
  type SessionBinding,
} from "./resume-view.ts";
import {
  handleCancelCommand,
  handleSpawnCommand,
  handleTakeCommand,
  refreshWorkers as refreshWorkersView,
  showWorkersStatus,
  type TuiWorkersFace,
  type WorkersViewHost,
} from "./workers-view.ts";

export type { TuiGrantsContext } from "./commands.ts";
export type { TuiWorkersFace } from "./workers-view.ts";

// Application API 面：TUI 提交意图与订阅投影的唯一通道（决策 025 的实体）。
// 结构类型——PiRuntimeAdapter 直接满足；测试注入假实现断言「只经 application API」。
export interface TuiRuntimeFace {
  run(input: string): Promise<RunResult>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void;
  // S5 取消入口：中断当前 Run（Adapter 固定姿势 abort → waitForIdle，注释约束 5，
  // 任何路径不悬挂；终态由并发等待的 run() 返回承载）
  interrupt(): Promise<void>;
  // S5 D2 可见化投影：会话记录写入失败观察口（措辞与增量报数口径同 cli repl）
  listenerErrors(): unknown[];
  // 决策 189：压缩完成的提示（自动与手动）与手动压缩；缺省（替身运行面）即不提示、/compact 不可用
  subscribeCompaction?(listener: (notice: CompactionNotice) => void): () => void;
  compact?(customInstructions?: string): Promise<ManualCompactionOutcome>;
}

// /resume 换绑产物（S4）：目标会话的新运行面与新治理上下文（形状定义在 resume-view.ts）
export type TuiSessionBinding = SessionBinding<TuiRuntimeFace, TuiGrantsContext, TuiWorkersFace>;

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
}

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
  // M5.5 S4（决策 040）：worker 状态行（无 worker 时空文本，零行）与刷新定时器（有 worker 在跑才开）
  private readonly workerStatusLine = new Text("");
  private workerTimerHandle: ReturnType<typeof setInterval> | null = null;
  private readonly input = new Input();
  private readonly title: Text;
  // 当前会话上下文（S4）：/resume 换绑整体替换——运行面、治理上下文、sessionId 一体，
  // 绝不换一半（grants 命令与提交必须落在同一会话上）
  private current: {
    sessionId: SessionId;
    runtime: TuiRuntimeFace;
    grants?: TuiGrantsContext;
    workers?: TuiWorkersFace;
  };
  // start/stop 的 dispose 对称面：壳级监听器在此成对登记（S5 的同位置留位）；
  // 运行面订阅单独登记——/resume 换绑时只退订运行面，壳级监听（模态键控）不动
  private readonly disposers: Array<() => void> = [];
  private runtimeDisposers: Array<() => void> = [];
  private running = false;
  private activeRunId: RunId | null = null;
  private started = false;
  // S4：/resume 对账进行中——拒绝一切提交（同 027 busy 语义：保留缓冲、提示可见、不排队）
  private resuming = false;
  // S3 审批面板：挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下
  // 同时最多一个，非空即面板期间
  private pendingApprovalState: PendingApproval | null = null;
  // S4 恢复菜单：挂起中的三选一决议（面板式单键，决策 031）；与审批面板互斥——
  // 审批只发生在 Run 内，菜单只在无 Run 的 /resume 流程内（busy 不开旁路）
  private pendingMenuState: PendingMenu | null = null;
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

  constructor(options: TuiShellOptions) {
    this.options = options;
    this.current = { sessionId: options.sessionId, runtime: options.runtime };
    if (options.grants !== undefined) this.current.grants = options.grants;
    if (options.workers !== undefined) this.current.workers = options.workers;
    this.tui = new TuiMainScreen(options.terminal, false, options.logDir);
    // chrome 纯 ASCII（spike 纪律：歧义宽字符不进边框/标题/状态栏）；sessionId 全 ASCII ULID
    this.title = new Text(`== pigeon tui | session ${options.sessionId} ==`);
    this.tui.addChild(this.title);
    this.tui.addChild(this.flow.view);
    this.tui.addChild(this.statusLine);
    this.tui.addChild(this.workerStatusLine);
    this.tui.addChild(this.input);
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.updateStatus();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // 壳级键控（S3 审批面板 + S4 恢复菜单 + S5 取消键）：模态挂起期间接管终端输入
    this.disposers.push(this.tui.addInputListener((data) => handleShellKey(this, data)));
    this.bindRuntime(this.current.runtime);
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
      this.tui.requestRender();
    });
    if (unsubscribeCompaction !== undefined) {
      this.runtimeDisposers.push(unsubscribeCompaction);
    }
  }

  stop(): void {
    // fail-closed（决策 029）：壳停止时挂起的审批按拒绝处理、恢复菜单按 EOF 语义回 null
    closePendingModals(this);
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
    // 状态栏纯 ASCII；审批/恢复菜单期间输入归模态键控，busy 与 resume 期间输入锁定
    const base =
      this.pendingApprovalState !== null
        ? "state: approval | decide in panel"
        : this.resuming
          ? "state: resume | answer in message area"
          : this.interrupting
            ? "state: cancelling | input locked"
            : this.running
              ? "state: running | input locked"
              : "state: idle | [enter] submit";
    this.statusLine.setText(base);
  }

  private handleSubmit(value: string): void {
    // 空输入（纯空白）：静默忽略——不回显、不提交、不提示（理由行同口径：留在理由行继续编辑）
    if (value.trim() === "") return;
    // 理由行提交（决策 066）：本次回车是拒绝理由而非任务提交——理由逐字回模型，审批就此决议
    if (this.reasonModeOn) {
      const reason = value.trim();
      this.input.setValue("");
      this.reasonModeOn = false;
      const approval = this.pendingApprovalState;
      this.pendingApprovalState = null;
      this.flow.addSystem(`拒绝理由：${reason}`);
      this.updateStatus();
      this.tui.requestRender();
      approval?.resolve({ key: "r", reason });
      return;
    }
    if (this.running || this.resuming) {
      // busy 语义（决策 027）：拒绝提交而非排队——排队意味着未设计的意图顺序/持久化语义；
      // 保留输入缓冲让人决定重提时机，拒绝痕迹留在消息区（可见，不静默）。
      // 斜杠命令同样不开旁路（同一语义，命令也不插队）；/resume 对账期同口径（S4）
      this.flow.addSystem(
        this.running
          ? "[busy] run in progress; input kept (not submitted); exit: Ctrl+C twice"
          : "[busy] resume in progress; input kept (not submitted)"
      );
      this.tui.requestRender();
      return;
    }
    // S3 斜杠命令：grant 治理面投影（/grants /revoke /grants save）——命令层与
    // cli REPL 同一份（application/grants.ts，决策 030），write 回调落消息区
    if (value.startsWith("/")) {
      this.input.setValue("");
      this.flow.addUserEcho(value);
      dispatchSlashCommand(this, value);
      this.tui.requestRender();
      return;
    }
    this.input.setValue("");
    this.flow.addUserEcho(value);
    this.running = true;
    this.updateStatus();
    this.tui.requestRender();
    // 唯一提交通道：application API（当前会话运行面——/resume 换绑后是新面）。终态摘要
    // 在 run() 决议后落（status/failure 是 promise 载荷，run.ended 事件只有 messageCount
    // 生命周期事实）
    this.current.runtime.run(value).then(
      (result) => this.handleRunEnd(result),
      (error: unknown) => this.handleRunEnd(null, error)
    );
  }

  // ---- S3 审批面板（TuiApprovalFace 实现；交互语义在 modal.ts）----

  askApproval(request: ApprovalRequest, directoryGrant?: boolean): Promise<ApprovalPanelResult> {
    return askApprovalPanel(this, request, directoryGrant);
  }

  // 审批结果回显（handler 在决议后调用：裁决行 / 已创建放权行）
  noteApproval(line: string): void {
    this.flow.addSystem(line);
    this.tui.requestRender();
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
  }

  pendingMenu(): PendingMenu | null {
    return this.pendingMenuState;
  }

  setPendingMenu(pending: PendingMenu | null): void {
    this.pendingMenuState = pending;
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
    this.input.setValue("");
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
  }

  setWorkerStatusLine(text: string): void {
    this.workerStatusLine.setText(text);
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

  askMenuChoice(prompt: string): Promise<string | null> {
    return askMenuChoiceModal(this, prompt);
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

  resumeCommand(arg: string | undefined): void {
    dispatchResumeCommand(this, arg);
  }

  // 决策 189：/compact [重点] 手动压缩——压缩期间与 Run 同样占住输入（busy 语义）；压成时的一行提示由订阅给出，
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
      this.updateStatus();
      this.tui.requestRender();
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
  requestInterrupt(): void {
    if (this.interrupting) return;
    this.interrupting = true;
    this.flow.addSystem("[cancel] interrupt requested; waiting for run to settle");
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
    this.current.runtime.interrupt().then(
      () => settle(),
      (error: unknown) => settle(error)
    );
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

  // 换绑（S4）：会话上下文一体替换（sessionId + 运行面 + 治理上下文），chrome 标题跟进，
  // 运行面订阅先退旧再订新；消息区内容保留（对账报告与重建说明是恢复的证据链呈现）
  rebindSession(sessionId: SessionId, binding: TuiSessionBinding): void {
    this.current = { sessionId, runtime: binding.runtime };
    if (binding.grants !== undefined) this.current.grants = binding.grants;
    if (binding.workers !== undefined) this.current.workers = binding.workers;
    this.activeRunId = null;
    // S5：落盘失败警告计数随运行面一起换绑——新面的 listenerErrors 从零起算
    this.reportedListenerErrors = 0;
    this.title.setText(`== pigeon tui | session ${sessionId} ==`);
    this.bindRuntime(binding.runtime);
    refreshWorkersView(this);
    this.tui.requestRender();
  }

  private handleRunEnd(result: RunResult | null, error?: unknown): void {
    this.running = false;
    this.activeRunId = null;
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
    // D2 可见化（S5）：每次 run 收尾复查落盘失败（增量报数，同 repl 口径）
    this.warnEvidenceGaps();
    this.updateStatus();
    this.tui.requestRender();
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
    switch (event.kind) {
      case RuntimeEventKind.TurnStarted:
        this.activeRunId = event.runId;
        this.flow.openStream();
        break;
      case RuntimeEventKind.TurnCompleted: {
        this.flow.closeStream();
        const payload = event.payload as TurnCompletedPayload;
        const marker = [`-- turn: ${payload.stopReason}`];
        if (payload.syntheticFailure) marker.push("(synthetic failure)");
        if (payload.errorMessage !== undefined) marker.push(`| ${payload.errorMessage}`);
        this.flow.addSystem(`${marker.join(" ")} --`);
        break;
      }
      case RuntimeEventKind.ToolProposed: {
        const payload = event.payload as ToolProposedPayload;
        this.flow.addToolCall(
          payload.toolCallId,
          `$ ${payload.toolName} ${summarizeArgs(payload.args)}`
        );
        break;
      }
      case RuntimeEventKind.ToolSettled: {
        const payload = event.payload as ToolSettledPayload;
        const state = payload.isError
          ? `-> error${payload.errorKind !== undefined ? ` [${payload.errorKind}]` : ""}`
          : "-> ok";
        this.flow.settleToolCall(payload.toolCallId, `$ ${payload.toolName}`, state);
        break;
      }
      case RuntimeEventKind.RunEnded:
        // run.ended 只有 messageCount 生命周期事实；终态摘要在 run() 决议时落（见 handleSubmit）
        break;
      default:
        break;
    }
    this.tui.requestRender();
  }
}
