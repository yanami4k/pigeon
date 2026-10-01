import { legacySessionsNote } from "../persistence/session-catalog.ts";
import { listSessionSummaries } from "../persistence/session-list.ts";
import { sessionsDirOf } from "../state/paths.ts";
import type { SessionListFilters } from "../state/session-summary.ts";

export interface SessionListCommandOptions {
  // 工作区根（会话在 <root>/.pigeon/sessions/）
  root: string;
  filters?: SessionListFilters;
}

// 只读渲染入口（投影层在 persistence/session-list.ts；此处只做安静排版：一会话一行）
export function runSessionListCommand(options: SessionListCommandOptions): string {
  const sessionsDir = sessionsDirOf(options.root);
  const summaries = listSessionSummaries(sessionsDir, options.filters ?? {});
  const notice = legacySessionsNote(sessionsDir);
  const lines: string[] = [];
  if (summaries.length === 0) {
    lines.push("尚无会话记录。");
  }
  for (const summary of summaries) {
    // 时间渲染：UTC（ISO 切片），跨时区确定——测试文本比对与 grep 友好
    // M5 S5（决策 044）：有 usage 的会话追加总 token 与成本
    const usage =
      summary.totalTokens > 0
        ? `  ${summary.totalTokens} tokens  $${summary.totalCost.toFixed(4)}`
        : "";
    // M5.5 S4（决策 040）：父子关系安静后缀
    const lineage =
      summary.worker !== undefined
        ? `  worker ${summary.worker.name}（${summary.worker.role}）← 父会话 ${summary.worker.parentSessionId}`
        : "";
    const children =
      summary.children !== undefined
        ? `  派出 worker ${summary.children.count} 个${summary.children.unsettled > 0 ? `（${summary.children.unsettled} 个未收尾）` : ""}`
        : "";
    lines.push(
      `${new Date(summary.createdAt).toISOString().slice(0, 16).replace("T", " ")}  ${summary.runCount} 个 Run  ${summary.sessionId}${usage}${lineage}${children}`
    );
  }
  if (notice !== undefined) {
    lines.push(notice);
  }
  return `${lines.join("\n")}\n`;
}
