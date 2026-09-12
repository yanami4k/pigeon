// CLI session 命令的渲染与 IO 适配（M4 S5，D5）：session list = 派生投影的安静渲染
//（默认只给时间 + Run 数，唯一突出项是待对账）。M2 S1（决策 025）：resume 冷恢复对账流程
//（哈希确证 + 人工确认写 resolution）已抽到 Controller 层 application/resume.ts，
// cli 不再直连 execution（actors-no-execution 巡航规则），只经 application 触发。
import { join } from "node:path";
import { listSessionSummaries } from "../persistence/session-list.ts";
import type { SessionListFilters } from "../state/session-summary.ts";

export interface SessionListCommandOptions {
  // 工作区根（事件日志在 <root>/.pigeon/sessions/）
  root: string;
  filters?: SessionListFilters;
}

// 时间渲染：UTC（ISO 切片），跨时区确定——测试文本比对与 grep 友好
function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// 只读渲染入口（投影层在 session-list.ts；此处只做安静排版：一会话一行，
// pendingReconcile > 0 才追加突出行——D5 唯一 actionable 项，人话 + 动作提示，无徽章图标）
export function runSessionListCommand(options: SessionListCommandOptions): string {
  const sessionsDir = join(options.root, ".pigeon", "sessions");
  const summaries = listSessionSummaries(sessionsDir, options.filters ?? {});
  if (summaries.length === 0) {
    return "尚无会话记录。\n";
  }
  const lines: string[] = [];
  for (const summary of summaries) {
    lines.push(
      `${formatTime(summary.createdAt)}  ${summary.runCount} 个 Run  ${summary.sessionId}`
    );
    if (summary.pendingReconcile > 0) {
      lines.push(`  ${summary.pendingReconcile} 条待对账（上次会话异常中断，用 resume 处理）`);
    }
  }
  return `${lines.join("\n")}\n`;
}
