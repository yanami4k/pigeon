// Application Shell（M2 S2，ROADMAP §M2 交付第 1 件）：pi-tui ProcessTerminal + TuiMainScreen
// 驱动的最小壳——消息区（每消息一个 Text）+ 底行输入区 + 纯 ASCII chrome（标题/状态栏）。
//
// 边界与纪律：
// - TUI 只通过 Application API 提交意图（ROADMAP §M2 完成证据）：输入提交唯一通道是
//   TuiRuntimeFace.run()，绝不直连上游 Agent；PiRuntimeAdapter 结构满足该面。
// - 消息区内容源（决策 024）：subscribeStream 的 text_delta 渲染当前 assistant 消息流式生长；
//   subscribe 的 turn.started/turn.completed/tool.proposed/tool.settled/run.ended 渲染轮次
//   标记与工具调用行（措辞复用 application/format.ts 的人话约定）；user 消息提交时回显。
// - spike 施工纪律（docs/notes/spike-pi-tui.zh-CN.md）：每消息一个 Text 组件，禁止单 Text
//   装全部历史（A5a 实测线性退化）；自有 chrome 只用 ASCII（歧义宽字符不进边框/状态栏账目，
//   内容区不限制）；不设计依赖 CPR/DSR 应答的探测；resize 交给 pi-tui 全量重绘，本壳不自持
//   宽度缓存副本。
// - ScrollView follow:"end" 包装消息流：TuiMainScreen（main-screen 模式）不走 layout.js
//   布局引擎，ScrollView 的裁剪/follow 不激活，follow-end 由终端 scrollback 天然实现
//   （内容超高流入回卷，差分渲染器重写尾部）；包装声明意图，alt-screen 布局引擎下自动生效。
// - busy 语义（决策 027）：运行中提交被拒绝——保留输入缓冲、消息区留 [busy] 提示、不进队列；
//   斜杠命令同样不开旁路。
// - 审批面板（S3，决策 029）：ApprovalHandler 挂起等四键 [y/n/a/d]，addInputListener 接管
//   按键，其余输入一律吞掉；壳停止时挂起的审批 fail-closed 按拒绝处理（理由逐字）。
// - 斜杠命令（S3，决策 030）：/grants /revoke /grants save 走 application/grants.ts 的
//   命令层（与 cli REPL 同一份），输出经 write 回调投影到消息区——零新增治理语义。
// - 会话列表与恢复入口（S4）：/sessions 走 application/session-list.ts 命令层（与 cli
//   同一份渲染口径）；/resume <sessionId> 走 application/resume.ts 的 runResumeFlow——
//   人工确认用面板式单键（决策 031：与 029 一致的输入语义，不引入第三种输入模式），
//   resolution 写盘路径完全复用 application 层；对账收口后经装配方注入的 rebind
//   换绑运行面（restoredGrants 种子在 main.ts 物化），同 sessionId 续跑。
// - 取消入口（S5，裁决 032）：运行中按 Esc 触发 adapter.interrupt()（固定姿势
//   abort → waitForIdle，注释约束 5）；Ctrl+C 不绑定取消——保留进程退出语义
//   （main.ts 的 OS 信号处理）。模态键控优先：审批面板/恢复菜单挂起期间 Esc 与非决议键
//   同待遇吞掉——审批挂起即 Run 阻塞在 beforeToolCall 的人工决议上，此时 interrupt
//   会吊在挂起 Promise 上直到人按键，「取消」名不副实；模态先决议再 Esc 是唯一次序。
//   中断飞行中重复 Esc 不再触发（不 double-abort、不悬挂）；running 清算在 handleRunEnd。
// - 退出三层形态（S5+，裁决 033，omp 键位模型）：Esc 取消（032 不动）；Ctrl+C 永不取消
//   Run——单击（非模态）清输入缓冲并留 [cleared] 提示（模态期间不清，仍计布防第一次）；
//   双击（窗口内两次 \x03，任意模式含模态）与 /quit 走同一优雅退出——先 stop()
//   （dispose 对称；挂起审批 fail-closed 走 APPROVAL_CANCEL_CLOSED，证据链不断）再回调
//   注入的 onExit（main.ts 注入 dispose + process.exit；测试注入探针，绝不真退进程）。
// - 终态摘要（S5）：run() 决议后落终态行——status + stopReason + 四分类徽章（措辞复用
//   application/format.ts 的 failureBadge，与 cli trace 同口径）+ errorMessage（若有）+
//   syntheticFailure 标注（若有）；listenerErrors 非空时消息区增量警告（D2 可见化的
//   TUI 投影，措辞与增量报数口径同 cli repl：启动即查 + 每次 run 收尾复查）。
// - dispose 对称：取消键的订阅与监听器一律进 disposers，在 start/stop 里成对出现。
import {
  Container,
  Input,
  ScrollView,
  type Terminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { failureBadge, summarizeArgs } from "../application/format.ts";
import { type GrantConfigEventSink, runGrantCommand } from "../application/grants.ts";
import { runResumeFlow } from "../application/resume.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import { asSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type {
  ToolProposedPayload,
  ToolSettledPayload,
  TurnCompletedPayload,
} from "../state/runtime-events.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import {
  APPROVAL_CANCEL_BUSY,
  APPROVAL_CANCEL_CLOSED,
  type ApprovalPanelResult,
  approvalBlockText,
  type TuiApprovalFace,
} from "./approval.ts";

// Application API 面：TUI 提交意图与订阅投影的唯一通道（决策 025 的实体）。
// 结构类型——PiRuntimeAdapter 直接满足；测试注入假实现断言「只经 application API」。
export interface TuiRuntimeFace {
  run(input: string): Promise<RunResult>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void;
  // S5 取消入口：中断当前 Run（Adapter 固定姿势 abort → waitForIdle，注释约束 5，
  // 任何路径不悬挂；终态由并发等待的 run() 返回承载）
  interrupt(): Promise<void>;
  // S5 D2 可见化投影：事件落盘失败观察口（措辞与增量报数口径同 cli repl）
  listenerErrors(): unknown[];
}

// TUI 治理命令上下文（/grants /revoke /grants save；决策 030）
export interface TuiGrantsContext {
  root: string;
  store: SessionGrantStore;
  configRules: readonly ConfigGrantRule[];
  eventLog?: GrantConfigEventSink;
}

// /resume 换绑产物（S4）：目标会话的新运行面与新治理上下文。装配由调用方（main.ts）
// 完成——restoredGrants 种子物化、buildRuntime、旧运行面释放都在壳外；壳只换绑投影
export interface TuiSessionBinding {
  runtime: TuiRuntimeFace;
  grants?: TuiGrantsContext;
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
  resume?: {
    root: string;
    rebind: (sessionId: SessionId) => TuiSessionBinding | Promise<TuiSessionBinding>;
  };
  // S5+（裁决 033）：优雅退出回调——双击 Ctrl+C / /quit 触发；壳先 stop() 再回调。
  // 注入使测试绝不真退进程；缺省 = 退出只停壳（装配方必须注入真实退出路径）
  onExit?: () => void;
  // 双击窗口（毫秒）：缺省 1000；测试注入小窗口断言过期语义
  exitWindowMs?: number;
}

// 消息流：每条消息一个 Text（spike 铁律——未变消息渲染 O(1) 命中缓存，流式只重折行尾巴）。
// 工具行按 toolCallId 索引原位更新，一行呈现「提议 → 结果」的完整生命周期。
class MessageFlow {
  // Container 承载任意多 Text child；ScrollView 恰好包一个 child（决策 028：main-screen 下
  // 裁剪/follow 由终端 scrollback 实现，ScrollView 声明意图并兼容 alt-screen 布局引擎）
  readonly view: ScrollView;
  private readonly list = new Container();
  private streamTail: Text | null = null;
  private streamText = "";
  private readonly toolLines = new Map<string, { text: Text; content: string }>();

  constructor() {
    this.view = new ScrollView(this.list, { follow: "end", primary: true });
  }

  private append(text: string): Text {
    const line = new Text(text);
    this.list.addChild(line);
    return line;
  }

  // user 消息提交回显
  addUserEcho(text: string): void {
    this.append(`> ${text}`);
  }

  // 系统行：busy 提示、run 终态摘要等（chrome 之外的壳自体消息）
  addSystem(line: string): void {
    this.append(line);
  }

  // turn.started：开出新的 assistant 流式尾巴消息
  openStream(): void {
    this.streamTail = this.append("");
    this.streamText = "";
  }

  // text_delta：流式生长（只 setText 尾巴；无尾巴时防御性开出——deltas 不锚身份，024）
  appendDelta(delta: string): void {
    if (this.streamTail === null) this.openStream();
    this.streamText += delta;
    this.streamTail?.setText(this.streamText);
  }

  // turn.completed：收尾当前流式消息
  closeStream(): void {
    this.streamTail = null;
    this.streamText = "";
  }

  // tool.proposed：工具名 + 参数摘要（措辞复用 application/format.ts 的 summarizeArgs）
  addToolCall(toolCallId: string, line: string): void {
    this.toolLines.set(toolCallId, { text: this.append(line), content: line });
  }

  // tool.settled：在原行追加结果状态（参数摘要保持可见）；settled 先到则如实落整行
  settleToolCall(toolCallId: string, line: string, state: string): void {
    const existing = this.toolLines.get(toolCallId);
    if (existing === undefined) {
      this.addToolCall(toolCallId, `${line} ${state}`);
      return;
    }
    existing.content += ` ${state}`;
    existing.text.setText(existing.content);
  }
}

export class PigeonTuiShell implements TuiApprovalFace {
  private readonly options: TuiShellOptions;
  private readonly tui: TuiMainScreen;
  private readonly flow = new MessageFlow();
  private readonly statusLine = new Text("");
  private readonly input = new Input();
  private readonly title: Text;
  // 当前会话上下文（S4）：/resume 换绑整体替换——运行面、治理上下文、sessionId 一体，
  // 绝不换一半（grants 命令与提交必须落在同一会话上）
  private current: { sessionId: SessionId; runtime: TuiRuntimeFace; grants?: TuiGrantsContext };
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
  private pendingApproval: { resolve: (result: ApprovalPanelResult) => void } | null = null;
  // S4 恢复菜单：挂起中的三选一决议（面板式单键，决策 031）；与审批面板互斥——
  // 审批只发生在 Run 内，菜单只在无 Run 的 /resume 流程内（busy 不开旁路）
  private pendingMenu: { resolve: (choice: string | null) => void } | null = null;
  // S5 取消键：中断飞行中标记——interrupt 未决议期间重复 Esc 不再触发
  //（不 double-abort、不悬挂）；running 清算在 handleRunEnd，两者生命周期独立
  private interrupting = false;
  // S5 D2 可见化（同 repl 增量报数口径）：已警告过的落盘失败累计数
  private reportedListenerErrors = 0;
  // S5+ 退出布防（裁决 033）：上一次 Ctrl+C 的墙钟时刻（窗口内再来一次即优雅退出）；
  // exitRequested 保证退出恰好一次（stop 后输入监听已退订，重入仅作幂等防御）
  private lastCtrlCAt: number | null = null;
  private exitRequested = false;

  constructor(options: TuiShellOptions) {
    this.options = options;
    this.current = { sessionId: options.sessionId, runtime: options.runtime };
    if (options.grants !== undefined) this.current.grants = options.grants;
    this.tui = new TuiMainScreen(options.terminal, false, options.logDir);
    // chrome 纯 ASCII（spike 纪律：歧义宽字符不进边框/标题/状态栏）；sessionId 全 ASCII ULID
    this.title = new Text(`== pigeon tui | session ${options.sessionId} ==`);
    this.tui.addChild(this.title);
    this.tui.addChild(this.flow.view);
    this.tui.addChild(this.statusLine);
    this.tui.addChild(this.input);
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.updateStatus();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // 壳级键控（S3 审批面板 + S4 恢复菜单 + S5 取消键）：模态挂起期间接管终端输入
    this.disposers.push(this.tui.addInputListener((data) => this.handleShellKey(data)));
    this.bindRuntime(this.current.runtime);
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
  }

  stop(): void {
    // fail-closed（决策 029）：壳停止时挂起的审批按拒绝处理（理由逐字），不吊死 Run
    if (this.pendingApproval !== null) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve({ key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
    }
    // 恢复菜单挂起中停止：按 EOF 语义回 null（流程把悬账原样保留，不写错误确证）
    if (this.pendingMenu !== null) {
      const pending = this.pendingMenu;
      this.pendingMenu = null;
      pending.resolve(null);
    }
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const dispose of this.runtimeDisposers.splice(0)) dispose();
    if (this.started) {
      this.started = false;
      this.tui.stop();
    }
  }

  private updateStatus(): void {
    // 状态栏纯 ASCII；审批/恢复菜单期间输入归模态键控，busy 与 resume 期间输入锁定
    this.statusLine.setText(
      this.pendingApproval !== null
        ? "state: approval | decide in panel"
        : this.resuming
          ? "state: resume | answer in message area"
          : this.interrupting
            ? "state: cancelling | input locked"
            : this.running
              ? "state: running | input locked"
              : "state: idle | [enter] submit"
    );
  }

  private handleSubmit(value: string): void {
    // 空输入（纯空白）：静默忽略——不回显、不提交、不提示
    if (value.trim() === "") return;
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
      this.handleSlashCommand(value);
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

  // ---- S3 审批面板（TuiApprovalFace 实现）----

  // 渲染审批块并挂起等四键；返回面板决议。串行不变量（决策 002）下同一会话同时最多
  // 一个待审批调用——重入是上游/装配 bug，防御性 fail-closed（按拒绝处理），绝不排队
  askApproval(request: ApprovalRequest): Promise<ApprovalPanelResult> {
    if (this.pendingApproval !== null) {
      return Promise.resolve({ key: "cancel", reason: APPROVAL_CANCEL_BUSY });
    }
    this.flow.addSystem(approvalBlockText(request));
    const { promise, resolve } = Promise.withResolvers<ApprovalPanelResult>();
    this.pendingApproval = { resolve };
    this.updateStatus();
    this.tui.requestRender();
    return promise;
  }

  // 审批结果回显（handler 在决议后调用：裁决行 / 已创建放权行）
  noteApproval(line: string): void {
    this.flow.addSystem(line);
    this.tui.requestRender();
  }

  // 壳级键控路由：退出键（Ctrl+C）最先——模态吞键语义不得吃掉退出布防（033：模态
  // 单击仍计布防第一次）；其后模态键控（决策 029/031），最后是取消键（S5 裁决 032）
  private handleShellKey(data: string): { consume: true } | undefined {
    if (data === "\x03") {
      this.handleCtrlC();
      return { consume: true };
    }
    if (this.handleModalKey(data) !== undefined) return { consume: true };
    // 取消键（S5）：Esc = 裸 "\x1b"（方向键等转义序列是多字节，不会误判）；Ctrl+C 不进
    // 本路径——永不绑定取消（033），退出语义由 handleCtrlC 承载。仅运行中消费；
    // 空闲 Esc 放行给 Input 组件（其 onEscape 未装配，语义为空）
    if (data === "\x1b" && this.running) {
      this.requestInterrupt();
      return { consume: true };
    }
    return undefined;
  }

  // Ctrl+C（S5+，裁决 033）：单击布防——非模态清输入缓冲并留 [cleared] 提示（措辞与
  // [busy]/[cancel] 同款 ASCII 括号；无历史召回语义，清空即丢弃）；模态期间不清缓冲
  // 不留提示（029/031 吞键语义），但仍计布防第一次。窗口内第二次（任意模式含模态）
  // 优雅退出；窗口过期则本次退化为单击并重新布防
  private handleCtrlC(): void {
    const now = Date.now();
    if (
      this.lastCtrlCAt !== null &&
      now - this.lastCtrlCAt <= (this.options.exitWindowMs ?? 1000)
    ) {
      this.lastCtrlCAt = null;
      this.requestExit();
      return;
    }
    this.lastCtrlCAt = now;
    if (this.pendingApproval === null && this.pendingMenu === null) {
      this.input.setValue("");
      this.flow.addSystem("[cleared] 输入已清空（再按一次 Ctrl+C 退出）");
      this.tui.requestRender();
    }
  }

  // 优雅退出（S5+，裁决 033）：双击 Ctrl+C 与 /quit 共用本路径——先 stop()（dispose
  // 对称；挂起审批 fail-closed 按拒绝处理、理由逐字 APPROVAL_CANCEL_CLOSED，证据链不断；
  // 恢复菜单按 EOF 语义回 null），再回调注入的 onExit。幂等：退出恰好一次
  private requestExit(): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    this.stop();
    this.options.onExit?.();
  }

  // 取消入口（S5）：触发 adapter.interrupt()（固定姿势 abort → waitForIdle，注释约束 5）。
  // 重复取消防御：中断飞行中不再触发——不 double-abort、不悬挂；running 清算在
  // handleRunEnd（run() 决议承载终态），interrupt 决议只清飞行标记
  private requestInterrupt(): void {
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

  // D2 可见化的 TUI 投影（S5）：事件落盘失败非空时消息区警告——措辞与 cli repl 同口径，
  // 增量报数（同一批故障不重复刷屏，新故障以累计数提醒）；启动即查 + 每次 run 收尾复查
  private warnEvidenceGaps(): void {
    const count = this.current.runtime.listenerErrors().length;
    if (count > this.reportedListenerErrors) {
      this.flow.addSystem(`警告：本会话有 ${count} 条事件落盘失败，证据链不完整。`);
      this.reportedListenerErrors = count;
    }
  }

  // 模态键控：审批面板（S3）或恢复菜单（S4）挂起期间接管终端输入——决议键 resolve，
  // 其余一律吞掉（决策 029/031 简单语义：普通输入忽略，不进缓冲、不提交、不回显；
  // 输入区里已有的内容不动，模态关闭后继续编辑）。两者互斥（审批只在 Run 内，
  // 菜单只在无 Run 的 /resume 流程内），同挂起是装配 bug，审批优先
  private handleModalKey(data: string): { consume: true } | undefined {
    const approval = this.pendingApproval;
    if (approval !== null) {
      const key = data.toLowerCase();
      if (key === "y" || key === "n" || key === "a" || key === "d") {
        this.pendingApproval = null;
        this.updateStatus();
        approval.resolve({ key });
      }
      return { consume: true };
    }
    const menu = this.pendingMenu;
    if (menu !== null) {
      // 恢复菜单（决策 031）：面板式单键决议——1/2/3 键即答案，与审批四键同款语义；
      // 转义序列等多字节输入不决议（静默吞掉，避免方向键刷出重复提示）
      if (data === "1" || data === "2" || data === "3") {
        this.pendingMenu = null;
        this.updateStatus();
        menu.resolve(data);
      }
      return { consume: true };
    }
    return undefined;
  }

  // 斜杠命令分发（S3/S4）：grant 命令层在 application/grants.ts（决策 030）、会话列表在
  // application/session-list.ts、恢复流程在 application/resume.ts——全部与 cli 同一份逻辑；
  // 语法/语义错误响亮呈现（同 REPL 口径），未知命令如实说明
  private handleSlashCommand(value: string): void {
    const tokens = value
      .slice(1)
      .split(/\s+/)
      .filter((token) => token.length > 0);
    const grants = this.current.grants;
    try {
      // S5+（裁决 033）：/quit 与双击 Ctrl+C 同一优雅退出路径（busy 语义不开旁路：
      // 运行中提交在 handleSubmit 即被拒绝，退出键仍可用）
      if (tokens[0] === "quit") {
        this.requestExit();
        return;
      }
      // S4：/sessions 会话列表——只读渲染，命令层与 cli 同一份（零新治理语义）
      if (tokens[0] === "sessions" && this.options.sessions !== undefined) {
        this.flow.addSystem(runSessionListCommand({ root: this.options.sessions.root }).trimEnd());
        this.tui.requestRender();
        return;
      }
      // S4：/resume <sessionId> 冷恢复对账 + 换绑续跑（异步流程，见 handleResumeCommand）
      if (tokens[0] === "resume" && this.options.resume !== undefined) {
        this.handleResumeCommand(tokens[1]);
        return;
      }
      const handled =
        grants !== undefined &&
        runGrantCommand(tokens, {
          root: grants.root,
          store: grants.store,
          configRules: grants.configRules,
          sessionId: this.current.sessionId,
          ...(grants.eventLog !== undefined ? { eventLog: grants.eventLog } : {}),
          write: (text) => {
            this.flow.addSystem(text.trimEnd());
          },
        });
      if (!handled) {
        this.flow.addSystem(
          `未知命令：${value}（可用 /quit、/sessions、/resume <sessionId>、/grants、/revoke <id>、/grants save <id>）`
        );
      }
    } catch (error) {
      this.flow.addSystem(`命令失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // /resume <sessionId>（S4）：对账流程在 application/resume.ts（自动确证报告 → 剩余悬账
  // 人工确认 → human-confirmed resolution 落盘——写盘路径唯一，壳不另起）；人工确认用
  // 面板式单键（决策 031）；enterRepl 钩子 = 换绑运行面续跑（同 sessionId 续写会话文件）
  private handleResumeCommand(arg: string | undefined): void {
    const resume = this.options.resume;
    if (resume === undefined) {
      this.flow.addSystem(
        `未知命令：/resume（可用 /quit、/sessions、/grants、/revoke <id>、/grants save <id>）`
      );
      return;
    }
    if (arg === undefined) {
      this.flow.addSystem("用法：/resume <sessionId>");
      return;
    }
    // 恢复当前会话会让恢复流程与运行中日志同文件双写（两个 JsonlEventLog 实例写一个
    // 文件，幂等索引分叉）——且语义上无意义（人就活在该会话里）：响亮拒绝
    if (arg === this.current.sessionId) {
      this.flow.addSystem(`已在会话 ${arg} 中，无需恢复`);
      return;
    }
    this.resuming = true;
    this.updateStatus();
    this.tui.requestRender();
    const finish = (error?: unknown): void => {
      this.resuming = false;
      if (error !== undefined) {
        this.flow.addSystem(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.updateStatus();
      this.tui.requestRender();
    };
    void runResumeFlow({
      root: resume.root,
      sessionId: arg,
      // 问答注入（决策 025 同形）：菜单提示落消息区，面板式单键捕获作答
      ask: (prompt) => this.askMenuChoice(prompt),
      write: (text) => {
        this.flow.addSystem(text.trimEnd());
        this.tui.requestRender();
      },
      // 对账收口后续跑：换绑运行面（restoredGrants 种子与新运行面的装配在壳外的
      // rebind 工厂，同 cli resume 的 enterRepl 配方）；壳已停止则换绑无意义
      enterRepl: async () => {
        if (!this.started) return;
        const sessionId = asSessionId(arg);
        const binding = await resume.rebind(sessionId);
        this.rebindSession(sessionId, binding);
      },
    }).then(
      () => finish(),
      (error: unknown) => finish(error)
    );
  }

  // 恢复菜单的作答面（S4，决策 031）：提示落消息区后挂起，等 1/2/3 单键决议；
  // 壳停止时按 EOF 语义回 null（流程把悬账原样保留，不写错误确证）
  private askMenuChoice(prompt: string): Promise<string | null> {
    if (!this.started) return Promise.resolve(null);
    this.flow.addSystem(prompt.trimEnd());
    const { promise, resolve } = Promise.withResolvers<string | null>();
    this.pendingMenu = { resolve };
    this.updateStatus();
    this.tui.requestRender();
    return promise;
  }

  // 换绑（S4）：会话上下文一体替换（sessionId + 运行面 + 治理上下文），chrome 标题跟进，
  // 运行面订阅先退旧再订新；消息区内容保留（对账报告与重建说明是恢复的证据链呈现）
  private rebindSession(sessionId: SessionId, binding: TuiSessionBinding): void {
    this.current = { sessionId, runtime: binding.runtime };
    if (binding.grants !== undefined) this.current.grants = binding.grants;
    this.activeRunId = null;
    // S5：落盘失败警告计数随运行面一起换绑——新面的 listenerErrors 从零起算
    this.reportedListenerErrors = 0;
    this.title.setText(`== pigeon tui | session ${sessionId} ==`);
    this.bindRuntime(binding.runtime);
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
    this.flow.appendDelta(delta.delta);
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
