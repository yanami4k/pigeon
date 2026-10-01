// 终端界面的输入历史（决策 286 第 1 项）：↑↓ 翻看的历史跨启动保留、按项目分开——存在项目治理根的
// .pigeon/tui-history.json，不进会话记录与账本。条数上限 100，与 pi-tui 编辑器内置的历史上限一致（超出的最旧条目丢弃）。
// 读不出（文件缺失、畸形）按空历史处理；写失败静默放弃（历史是便利功能，不挡输入）。写入先写临时文件再改名，不留半截文件。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promptHistoryPathOf } from "../state/paths.ts";

export const PROMPT_HISTORY_LIMIT = 100;

export interface PromptHistoryStore {
  // 从旧到新
  load(): string[];
  add(text: string): void;
}

function historyPath(governanceRoot: string): string {
  return promptHistoryPathOf(governanceRoot);
}

function readEntries(path: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return (parsed as { entries: unknown[] }).entries.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== ""
      );
    }
  } catch {
    // 缺失或畸形：空历史
  }
  return [];
}

export function promptHistoryStore(governanceRoot: string): PromptHistoryStore {
  const path = historyPath(governanceRoot);
  return {
    load: () => readEntries(path).slice(-PROMPT_HISTORY_LIMIT),
    add: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      // 每次追加前现读：同一项目同时开着几个终端界面时不互相覆盖掉对方刚加的条目
      const entries = readEntries(path);
      if (entries.at(-1) !== trimmed) entries.push(trimmed);
      try {
        mkdirSync(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(
          temp,
          `${JSON.stringify({ version: 1, entries: entries.slice(-PROMPT_HISTORY_LIMIT) })}\n`
        );
        renameSync(temp, path);
      } catch {
        // 写不进去：本次启动内的历史仍在编辑器里，下次启动少这一条
      }
    },
  };
}
