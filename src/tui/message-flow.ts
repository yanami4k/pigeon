// 消息流（决策 067 拆分自 shell.ts，零行为变化）：每条消息一个 Text（spike 铁律——未变消息渲染
// O(1) 命中缓存，流式只重折行尾巴）。工具行按 toolCallId 索引原位更新，一行呈现「提议 → 结果」的完整生命周期。
// 决策 036：本类是消息区唯一 Text 创建/setText 入口，半信任内容（模型流式文本、工具参数摘要、审批块、
// 错误消息）携带的终端控制序列在此统一净化——pi-tui 的 Text 按设计保留并直通 ANSI/OSC/APC（M2 审计 P2-1），
// 故净化必须发生在进 Text 之前；幂等，流式累积文本每帧重净化是安全的。
import { Container, ScrollView, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import type { HistoryLine } from "../application/history.ts";

// thinking 段视觉弱化（M5 S2，决策 045）：暗色由壳的受信代码在 pi-tui 补齐行宽后逐行包裹；
// 内容在进 Text 前已经 036 净化，模型文本里的控制序列此时已惰性化，这里的 SGR 不来自模型
const dimLine = (line: string): string => `\x1b[2m${line}\x1b[22m`;

export class MessageFlow {
  // Container 承载任意多 Text child；ScrollView 恰好包一个 child（决策 028：main-screen 下
  // 裁剪/follow 由终端 scrollback 实现，ScrollView 声明意图并兼容 alt-screen 布局引擎）
  readonly view: ScrollView;
  private readonly list = new Container();
  private streamTail: Text | null = null;
  private streamText = "";
  // M5 S2（决策 045）：thinking 流式段——与正文尾巴分开，谁的增量到了谁开段（同 035 懒创建）
  private thinkingTail: Text | null = null;
  private thinkingText = "";
  private readonly toolLines = new Map<string, { text: Text; content: string }>();

  constructor() {
    this.view = new ScrollView(this.list, { follow: "end", primary: true });
  }

  private append(text: string): Text {
    const line = new Text(sanitizeTerminalText(text));
    this.list.addChild(line);
    return line;
  }

  // 弱化段（thinking）：同样先净化，再由受信的逐行样式函数加暗色
  private appendDim(text: string): Text {
    const line = new Text(sanitizeTerminalText(text), 1, 1, dimLine);
    this.list.addChild(line);
    return line;
  }

  // 历史行（M5 S2，决策 045）：/resume 换绑后一次性渲染；thinking 行弱化，其余同实时流口径
  addHistory(lines: readonly HistoryLine[]): void {
    for (const line of lines) {
      if (line.kind === "thinking") {
        this.appendDim(line.text);
      } else {
        this.append(line.text);
      }
    }
  }

  // user 消息提交回显
  addUserEcho(text: string): void {
    this.append(`> ${text}`);
  }

  // 系统行：busy 提示、run 终态摘要等（chrome 之外的壳自体消息）
  addSystem(line: string): void {
    this.append(line);
  }

  // turn.started：只重置流式状态，不 append——尾巴懒创建（决策 035：首个 text_delta 到达时
  // 才开出；纯工具调用轮因此不留占位子组件。pi-tui 0.84.4 的 Text("") 渲染零行
  //（components/text.js 空文本早退），懒创建前后屏幕逐行一致，此不变式是字面性的：
  // 尾巴存在 ⟺ 本轮已流式文本）
  openStream(): void {
    this.streamTail = null;
    this.streamText = "";
    this.thinkingTail = null;
    this.thinkingText = "";
  }

  // thinking_delta（M5 S2，决策 045）：思维链单独一段、~ 前缀、暗色弱化；正文段已开则先收尾，
  // 保证段序与块序一致（真实 provider 块序：thinking 在 text 之前）
  appendThinkingDelta(delta: string): void {
    if (this.thinkingTail === null) {
      this.streamTail = null;
      this.streamText = "";
      this.thinkingTail = this.appendDim("");
    }
    this.thinkingText += delta;
    this.thinkingTail.setText(sanitizeTerminalText(`~ ${this.thinkingText}`));
  }

  // text_delta：流式生长（首个 delta 懒开出尾巴并 setText；无 turn.started 的 deltas
  // 同样经此防御性开出——deltas 不锚身份，024）
  appendDelta(delta: string): void {
    // thinking 段收尾：正文另起一段
    this.thinkingTail = null;
    this.thinkingText = "";
    if (this.streamTail === null) this.streamTail = this.append("");
    this.streamText += delta;
    // 累积文本整体重净化（幂等为前提）：跨 delta 劈开的序列在补齐帧被惰性化，
    // 中间帧的裸 ESC 显示为 ␛ 是正常形态
    this.streamTail.setText(sanitizeTerminalText(this.streamText));
  }

  // turn.completed：收尾当前流式消息（从未开过尾巴的轮次不追加任何行）
  closeStream(): void {
    this.streamTail = null;
    this.streamText = "";
    this.thinkingTail = null;
    this.thinkingText = "";
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
    existing.text.setText(sanitizeTerminalText(existing.content));
  }
}
