// CLI session 命令（M4 S5，D5）：session list = 派生投影的安静渲染（默认只给时间 + Run 数，
// 唯一突出项是待对账）；resume = 冷恢复对账（哈希自动确证已折进 recoverSession）→
// 剩余悬账人工确认菜单 → 在同一会话下续跑 REPL。session list 只读；resume 只写
// resolution 治理族（human-confirmed 渠道，D5 第三种确证）——任何路径系统不自动重新执行（§3.2）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { recoverSession } from "../execution/recovery.ts";
import { JsonlEventLog, listSessionIds } from "../persistence/event-log.ts";
import { listSessionSummaries } from "../persistence/session-list.ts";
import { asSessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import type { SessionListFilters } from "../state/session-summary.ts";
import { summarizeArgs } from "./format.ts";
import type { AskFn, WriteFn } from "./repl.ts";

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

// 既往落盘缺口的人话清单（只呈现不修补；空数组 = 无缺口）
function describeEvidenceGaps(materialized: MaterializedSession): string[] {
  const lines: string[] = [];
  if (materialized.tornTail) {
    lines.push("会话文件末尾撕裂写：1 处（半截记录已按未持久化丢弃）");
  }
  const missingEntries = materialized.entryGaps.reduce(
    (sum, gap) => sum + gap.missingSeqs.length,
    0
  );
  if (missingEntries > 0) {
    lines.push(`entry 映射断号：${missingEntries} 条（写盘失败留证缺口）`);
  }
  const orphans =
    materialized.reconcile.orphanReceipts.length + materialized.reconcile.orphanResolutions.length;
  if (orphans > 0) {
    lines.push(`孤儿记录：${orphans} 条（Receipt/Resolution 无对应 intent）`);
  }
  return lines;
}

export interface ResumeCommandOptions {
  // 工作区根（事件日志在 <root>/.pigeon/sessions/；哈希确证的读目标以它为根）
  root: string;
  sessionId: string;
  // 问答与输出均依赖注入（与 repl.ts 同一 AskFn/WriteFn 形状），菜单可测、REPL 可替换
  ask: AskFn;
  write: WriteFn;
  // 对账收口后的 REPL 入口（测试可 mock/即刻返回；真实接线见 index.ts resume 子命令）
  enterRepl: () => Promise<void>;
}

// 冷恢复对账 + 人工确认（D5 resume 流程）：recoverSession 先做哈希自动确证（确证记录
// 持久化，非静默销账），剩余悬账逐条人工确认——[1] 已执行 / [2] 未执行 写 human-confirmed
// resolution（第三种确证渠道，对齐 ToolExecution Verified 语义），[3] 与 EOF 留 pending；
// 之后打印上下文重建说明并进入 REPL（同一 sessionId 续写事件日志，Pi transcript 不恢复）。
export async function runResumeCommand(options: ResumeCommandOptions): Promise<void> {
  const sessionsDir = join(options.root, ".pigeon", "sessions");
  const sessionId = asSessionId(options.sessionId);
  if (!existsSync(JsonlEventLog.filePathFor(sessionsDir, sessionId))) {
    const available = listSessionIds(sessionsDir);
    throw new Error(
      `会话不存在：${options.sessionId}` +
        (available.length > 0 ? `。已有会话：${available.join("、")}` : "（尚无会话记录）")
    );
  }
  const { write, ask } = options;
  // 自动确证环节（S2，D5）：哈希三方比对，命中即写 resolution（fsync 耐久 + executionId 幂等）
  const recovery = recoverSession(sessionsDir, sessionId, options.root);
  write(`会话 ${sessionId} 冷恢复对账：\n`);
  if (recovery.resolutions.length > 0) {
    write(`  本次自动确证（哈希比对）${recovery.resolutions.length} 条：\n`);
    for (const resolution of recovery.resolutions) {
      write(
        `    ${resolution.toolName}：${resolution.outcome === "executed" ? "已执行" : "未执行"}\n`
      );
    }
  } else {
    write("  本次自动确证（哈希比对）：无\n");
  }
  const unknowns = recovery.materialized.reconcile.unknown;
  // D2 冷侧缺口汇总（M4 收口决策 ③）：进程内 listenerErrors 跨重启必空，既往缺口只能从文件
  // 形态派生——撕裂尾巴 / entry 断号 / 孤儿记录；有任一缺口就不说"证据链完整"
  const gapLines = describeEvidenceGaps(recovery.materialized);
  if (unknowns.length === 0) {
    write(gapLines.length === 0 ? "  剩余待对账：无，证据链完整。\n" : "  剩余待对账：无。\n");
  }
  if (gapLines.length > 0) {
    write("  既往落盘缺口（文件形态派生）：\n");
    for (const line of gapLines) {
      write(`    ${line}\n`);
    }
  }
  // 人工确认菜单：写盘用追加模式开同一个 session 文件（治理族幂等索引由构造器恢复）
  const log = new JsonlEventLog(sessionsDir, sessionId);
  try {
    for (const [i, { intent }] of unknowns.entries()) {
      write(
        `待对账 ${i + 1}/${unknowns.length}：${intent.toolName}（参数：${summarizeArgs(intent.rawArgs)}）\n`
      );
      write("  [1] 我看过了，实际已执行\n  [2] 实际未执行\n  [3] 先不管\n");
      let choice: string | null;
      for (;;) {
        choice = await ask("请选择 [1/2/3]：");
        if (choice === null || choice === "1" || choice === "2" || choice === "3") {
          break;
        }
        write("请输入 1、2 或 3。\n");
      }
      if (choice === "1" || choice === "2") {
        log.appendResolution({
          executionId: intent.executionId,
          toolCallId: intent.toolCallId,
          toolName: intent.toolName,
          outcome: choice === "1" ? "executed" : "not-executed",
          method: "human-confirmed",
          at: Date.now(),
          runId: intent.runId,
        });
        write(choice === "1" ? "  已记录：实际已执行。\n" : "  已记录：实际未执行。\n");
      } else {
        write("  先不管，悬账保留待对账。\n");
      }
    }
  } finally {
    log.close();
  }
  write("\n模型对话上下文重新建立（Pi transcript 不恢复）；后续 Run 继续写入本会话事件日志。\n");
  await options.enterRepl();
}
