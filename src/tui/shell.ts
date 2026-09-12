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
// - dispose 对称为后续切片留位：会话列表（S4）/取消键（S5）的订阅与监听器
//   一律进 disposers，在 start/stop 里成对出现。
import {
  Container,
  Input,
  ScrollView,
  type Terminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { summarizeArgs } from "../application/format.ts";
import { type GrantConfigEventSink, runGrantCommand } from "../application/grants.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { FailureClass } from "../state/classification.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { RunId, SessionId } from "../state/ids.ts";
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
}

export interface TuiShellOptions {
  terminal: Terminal;
  runtime: TuiRuntimeFace;
  sessionId: SessionId;
  // pi-tui 崩溃/调试日志目录（行宽护栏 throw 时写 pi-crash.log）
  logDir?: string;
  // S3：grant 治理面投影——/grants /revoke /grants save 的命令上下文（命令层在
  // application/grants.ts，与 cli REPL 同一份）；缺省 = 斜杠命令不可用
  grants?: {
    root: string;
    store: SessionGrantStore;
    configRules: readonly ConfigGrantRule[];
    eventLog?: GrantConfigEventSink;
  };
}

function failureLabel(failure: FailureClass): string {
  return failure.category === "cancelled" && failure.breaker
    ? "cancelled/breaker"
    : failure.category;
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
  // start/stop 的 dispose 对称面：一切订阅/监听在此成对登记（S4/S5 的同位置留位）
  private readonly disposers: Array<() => void> = [];
  private running = false;
  private activeRunId: RunId | null = null;
  private started = false;
  // S3 审批面板：挂起中的审批决议（resolve 四键或 cancel）；串行不变量（决策 002）下
  // 同时最多一个，非空即面板期间
  private pendingApproval: { resolve: (result: ApprovalPanelResult) => void } | null = null;

  constructor(options: TuiShellOptions) {
    this.options = options;
    this.tui = new TuiMainScreen(options.terminal, false, options.logDir);
    // chrome 纯 ASCII（spike 纪律：歧义宽字符不进边框/标题/状态栏）；sessionId 全 ASCII ULID
    this.tui.addChild(new Text(`== pigeon tui | session ${options.sessionId} ==`));
    this.tui.addChild(this.flow.view);
    this.tui.addChild(this.statusLine);
    this.tui.addChild(this.input);
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.updateStatus();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { runtime } = this.options;
    this.disposers.push(
      // S3 审批面板键控：面板挂起期间接管终端输入（四键决议，其余吞掉）
      this.tui.addInputListener((data) => this.handleApprovalKey(data)),
      runtime.subscribe((event) => this.handleEvent(event)),
      runtime.subscribeStream((delta) => this.handleDelta(delta))
    );
    this.tui.setFocus(this.input);
    this.tui.start();
    this.tui.requestRender();
  }

  stop(): void {
    // fail-closed（决策 029）：壳停止时挂起的审批按拒绝处理（理由逐字），不吊死 Run
    if (this.pendingApproval !== null) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve({ key: "cancel", reason: APPROVAL_CANCEL_CLOSED });
    }
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.started) {
      this.started = false;
      this.tui.stop();
    }
  }

  private updateStatus(): void {
    // 状态栏纯 ASCII；审批期间输入归面板，busy 时输入锁定
    this.statusLine.setText(
      this.pendingApproval !== null
        ? "state: approval | decide in panel"
        : this.running
          ? "state: running | input locked"
          : "state: idle | [enter] submit"
    );
  }

  private handleSubmit(value: string): void {
    // 空输入（纯空白）：静默忽略——不回显、不提交、不提示
    if (value.trim() === "") return;
    if (this.running) {
      // busy 语义（决策 027）：拒绝提交而非排队——排队意味着未设计的意图顺序/持久化语义；
      // 保留输入缓冲让人决定重提时机，拒绝痕迹留在消息区（可见，不静默）。
      // 斜杠命令同样不开旁路（同一语义，命令也不插队）
      this.flow.addSystem("[busy] run in progress; input kept (not submitted)");
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
    // 唯一提交通道：application API。终态摘要在 run() 决议后落（status/failure 是
    // promise 载荷，run.ended 事件只有 messageCount 生命周期事实）
    this.options.runtime.run(value).then(
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

  // 审批面板键控：面板挂起期间接管终端输入——四键 resolve 决议，其余一律吞掉
  //（决策 029 简单语义：普通输入忽略，不进缓冲、不提交、不回显；输入区里已有的
  // 内容不动，面板关闭后继续编辑）
  private handleApprovalKey(data: string): { consume: true } | undefined {
    const pending = this.pendingApproval;
    if (pending === null) {
      return undefined;
    }
    const key = data.toLowerCase();
    if (key === "y" || key === "n" || key === "a" || key === "d") {
      this.pendingApproval = null;
      this.updateStatus();
      pending.resolve({ key });
    }
    return { consume: true };
  }

  // 斜杠命令分发（S3）：grant 命令层在 application/grants.ts（决策 030），与 cli REPL
  // 同一份逻辑；语法/语义错误响亮呈现（同 REPL 口径），未知命令如实说明
  private handleSlashCommand(value: string): void {
    const tokens = value
      .slice(1)
      .split(/\s+/)
      .filter((token) => token.length > 0);
    const grants = this.options.grants;
    try {
      const handled =
        grants !== undefined &&
        runGrantCommand(tokens, {
          root: grants.root,
          store: grants.store,
          configRules: grants.configRules,
          sessionId: this.options.sessionId,
          ...(grants.eventLog !== undefined ? { eventLog: grants.eventLog } : {}),
          write: (text) => {
            this.flow.addSystem(text.trimEnd());
          },
        });
      if (!handled) {
        this.flow.addSystem(`未知命令：${value}（可用 /grants、/revoke <id>、/grants save <id>）`);
      }
    } catch (error) {
      this.flow.addSystem(`命令失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleRunEnd(result: RunResult | null, error?: unknown): void {
    this.running = false;
    this.activeRunId = null;
    if (result !== null) {
      const parts = [`== run: ${result.status}`];
      if (result.stopReason !== undefined) parts.push(`stop: ${result.stopReason}`);
      if (result.failure !== null) parts.push(`failure: ${failureLabel(result.failure)}`);
      this.flow.addSystem(`${parts.join(" | ")} ==`);
    } else {
      // run() 自身抛异常（装配级故障）：如实呈现，不伪装成正常终态
      const message = error instanceof Error ? error.message : String(error);
      this.flow.addSystem(`== run: error | ${message} ==`);
    }
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
