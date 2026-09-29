// 会话选择器（决策 286 第 5 项）：/resume 与 pigeon --resume 不带会话号时弹出，列本项目可续接的主会话
// （application/recent-sessions.ts：worker、分支与复盘会话不列）。↑↓ 选、回车进、Esc 退；每行最近活动时间、轮数、
// 沙箱标记与首条输入摘要。显示在输入框上方，打开期间按键归选择器（输入框内容不动）。
import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../application/format.ts";
import { type RecentSession, recentSessionLine } from "../application/recent-sessions.ts";

// 一屏最多列几行（超出的随选中项滚动）
export const PICKER_VISIBLE_ROWS = 10;

export type PickerKey = "up" | "down" | "enter" | "escape";

export class SessionPicker {
  readonly view = new Text("");
  private items: RecentSession[] = [];
  private index = 0;
  private openState = false;
  private onPick: ((session: RecentSession | undefined) => void) | undefined;

  isOpen(): boolean {
    return this.openState;
  }

  // 打开；选中或退出时回调一次（退出为 undefined）
  open(items: RecentSession[], onPick: (session: RecentSession | undefined) => void): void {
    this.items = items;
    this.index = 0;
    this.openState = true;
    this.onPick = onPick;
    this.refresh();
  }

  close(): void {
    this.openState = false;
    this.onPick = undefined;
    this.view.setText("");
  }

  press(key: PickerKey): void {
    if (!this.openState) return;
    if (key === "up" || key === "down") {
      const count = this.items.length;
      if (count > 0) this.index = (this.index + (key === "up" ? count - 1 : 1)) % count;
      this.refresh();
      return;
    }
    const onPick = this.onPick;
    const picked = key === "enter" ? this.items[this.index] : undefined;
    this.close();
    onPick?.(picked);
  }

  private refresh(): void {
    const lines = ["resume a session: up/down to move, enter to open, esc to cancel"];
    const start = Math.max(
      0,
      Math.min(this.index - PICKER_VISIBLE_ROWS + 1, this.items.length - PICKER_VISIBLE_ROWS)
    );
    const shown = this.items.slice(start, start + PICKER_VISIBLE_ROWS);
    shown.forEach((session, offset) => {
      const marker = start + offset === this.index ? "> " : "  ";
      lines.push(`${marker}${recentSessionLine(session)}`);
    });
    if (this.items.length > PICKER_VISIBLE_ROWS) {
      lines.push(`  (${this.index + 1}/${this.items.length})`);
    }
    this.view.setText(sanitizeTerminalText(lines.join("\n")));
  }
}
