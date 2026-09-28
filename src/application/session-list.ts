// Session 列表命令层（M4 S5，D5：派生投影的安静渲染——默认只给时间 + Run 数；M2 S4 自 cli/session.ts 归位，
// 方向同决策 030）：cli 与 tui 两个 Actor 共用同一份查询与排版，命令层不 import 任何 Actor；输出是纯字符串，
// cli 写 stdout，tui 投影到消息区。读新会话存储；旧列表唯一的突出项"待对账"随写操作回执停写（184）不再有来源。
// 迁移之前的旧格式会话不列出，末尾给一行计数提示（新代码不读旧格式，187 / 211）。
import { join } from "node:path";
import { legacySessionsNote } from "../persistence/session-catalog.ts";
import { listSessionSummaries } from "../persistence/session-list.ts";
import type { SessionListFilters } from "../state/session-summary.ts";

export interface SessionListCommandOptions {
  // 工作区根（会话在 <root>/.pigeon/sessions/）
  root: string;
  filters?: SessionListFilters;
}

// 只读渲染入口（投影层在 persistence/session-list.ts；此处只做安静排版：一会话一行）
export function runSessionListCommand(options: SessionListCommandOptions): string {
  const sessionsDir = join(options.root, ".pigeon", "sessions");
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
