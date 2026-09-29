// 输入框（决策 286 第 1 项）：改用 pi-tui 自带的 Editor——多行、粘贴保留换行、大段粘贴折成 [paste #n ...] 标记并在发送时展开、
// ↑↓ 翻历史。键位取 pi 缺省：Enter 发送；换行为 Shift+Enter 或 Ctrl+J，另有 Alt+Enter 与"行末反斜杠再回车"两个兜底——
// Windows Terminal 默认不区分 Shift+Enter，Ctrl+J 与反斜杠回车在其中总是可用。Editor 自带的补全本段不接。
// 边框与滚动提示换成 ASCII（spike 纪律：歧义宽字符不进 chrome）。历史跨启动保留由 application/prompt-history.ts 负责。
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const identity = (text: string): string => text;

// Editor 以 borderColor 包边框串（"─" 横线与 "↑ n more"/"↓ n more" 滚动提示），在此换成 ASCII
function asciiBorder(text: string): string {
  return text.replaceAll("─", "-").replaceAll("↑", "^").replaceAll("↓", "v");
}

const ASCII_THEME: EditorTheme = {
  borderColor: asciiBorder,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

export function createPromptEditor(tui: TUI, history: readonly string[]): Editor {
  const editor = new Editor(tui, ASCII_THEME, { paddingX: 1 });
  // 从旧到新逐条加入：Editor 的历史最新在前
  for (const entry of history) editor.addToHistory(entry);
  return editor;
}
