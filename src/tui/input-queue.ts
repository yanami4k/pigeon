// 运行中输入的排队（决策 286 第 4 项）：运行中（含压缩、/resume 进行中）提交的输入先进队列，空闲后自动发出；
// 多条排队时按 pi 惯例逐条发出——一条跑完再发下一条，不合并。排队内容显示在输入框上方；Alt+Up（Windows 下另认 Alt+Q，
// 同 pi 的 Windows 缺省）把全部排队内容退回输入框修改；Esc 中断时排队内容同样退回输入框（pi 惯例）。
// 本模块只是独立的小接口（入队、取出、清空、退回输入框），不认识 worker 完成通知；"下一轮发什么"由壳在空闲时经 take() 取。
import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";

// 队列显示里每条的字符上限（只显示首行）
const QUEUE_LINE_CHARS = 80;

export class InputQueue {
  private readonly items: string[] = [];
  // 输入框上方的排队显示（空队列渲染零行）
  readonly view = new Text("");

  enqueue(text: string): void {
    this.items.push(text);
    this.refresh();
  }

  // 取出下一条（先进先出）；空队列为 undefined
  take(): string | undefined {
    const next = this.items.shift();
    this.refresh();
    return next;
  }

  // 清空并交回全部排队内容（先进先出）
  clear(): string[] {
    const all = this.items.splice(0);
    this.refresh();
    return all;
  }

  size(): number {
    return this.items.length;
  }

  pending(): readonly string[] {
    return [...this.items];
  }

  // 退回输入框：排队内容在前、输入框里已有的草稿在后，空行分隔（pi 惯例）；返回合并后的文本，队列清空
  restoreInto(draft: string): string {
    return [...this.clear(), draft].filter((text) => text.trim() !== "").join("\n\n");
  }

  private refresh(): void {
    if (this.items.length === 0) {
      this.view.setText("");
      return;
    }
    const lines = this.items.map((item) => {
      const first = item.split("\n")[0] ?? "";
      const more = item.includes("\n") ? " ..." : "";
      const chars = [...first];
      const shown =
        chars.length > QUEUE_LINE_CHARS ? `${chars.slice(0, QUEUE_LINE_CHARS).join("")}...` : first;
      return `queued: ${shown}${more}`;
    });
    lines.push("(sent one by one when idle; alt+up to edit, esc restores on interrupt)");
    this.view.setText(sanitizeTerminalText(lines.join("\n")));
  }
}
