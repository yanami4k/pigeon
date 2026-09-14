// resume 冷恢复对账流程（M4 S5，D5；M2 S1 决策 025 从 cli/session.ts 抽到 Controller 层）：
// recoverSession 先做哈希自动确证（确证记录持久化，非静默销账），剩余悬账逐条人工确认——
// [1] 已执行 / [2] 未执行 写 human-confirmed resolution（第三种确证渠道，对齐 ToolExecution
// Verified 语义），[3] 与 EOF 留 pending；之后打印上下文重建说明并进入调用方注入的续会话入口
// （同一 sessionId 续写事件日志，Pi transcript 不恢复）。任何路径系统不自动重新执行（§3.2）。
// 问答与输出均依赖注入（决策 025）：cli 传 REPL 问答版，将来的 tui 传面板版；
// AskFn/WriteFn 与 cli/repl.ts 的同名类型结构同型（函数类型按结构兼容），定义留在本层
// 是为了不引入 application → cli 的反向依赖（application-is-controller 巡航规则）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { recoverSession } from "../execution/recovery.ts";
import { JsonlEventLog, listSessionIds } from "../persistence/event-log.ts";
import { asSessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { summarizeArgs } from "./format.ts";

// 提问函数：返回一行输入；EOF/流关闭返回 null（与 cli/repl.ts 的 AskFn 结构同型）
export type AskFn = (prompt: string) => Promise<string | null>;
// 输出函数（与 cli/repl.ts 的 WriteFn 结构同型）
export type WriteFn = (text: string) => void;

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
  // M5 S1（决策 037）：entry 回指的正文缺失或哈希不符
  if (materialized.contentGaps.length > 0) {
    lines.push(
      `消息正文缺失：${materialized.contentGaps.length} 条（内容文件无记录或哈希不符，用 trace 查看）`
    );
  }
  if (materialized.unfinishedRuns.length > 0) {
    lines.push(
      `崩溃残留：${materialized.unfinishedRuns.length} 个 Run 无 run.ended（用 trace 或 replay 查看中断位置）`
    );
  }
  const orphans =
    materialized.reconcile.orphanReceipts.length + materialized.reconcile.orphanResolutions.length;
  if (orphans > 0) {
    lines.push(`孤儿记录：${orphans} 条（Receipt/Resolution 无对应 intent）`);
  }
  return lines;
}

export interface ResumeFlowOptions {
  // 工作区根（事件日志在 <root>/.pigeon/sessions/；哈希确证的读目标以它为根）
  root: string;
  sessionId: string;
  // 问答与输出均依赖注入（决策 025），菜单可测、交互面可替换
  ask: AskFn;
  write: WriteFn;
  // 对账收口后的续会话入口（测试可 mock/即刻返回；cli 在此进入 REPL，见 cli/index.ts）
  enterRepl: () => Promise<void>;
}

export async function runResumeFlow(options: ResumeFlowOptions): Promise<void> {
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
    write("  既往缺口（文件形态派生）：\n");
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
