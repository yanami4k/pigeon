// 回炉（决策 142 / 143 / 147）的应用层部件：回炉反馈消息与"回到这一步起点"的恢复。流程本身在 headless-core.ts。
// - 反馈：验证命令、退出码、输出末尾（沿用验证记录的 16 KiB 尾部）与修正要求；末尾留一个附加内容的注入点，
//   缺省为空——结构化记忆将来从这里附加回炉时匹配到的记忆（决策 134），本次不实现；
// - 恢复：起点取这一步首个快照记录里的改前基线（首次改动之前的工作区状态），按快照覆盖的范围原地恢复。
//   一次文件都没改过即没有快照，无需恢复。恢复由账本现算起点、可重复执行：进程崩溃在最后一次验证之后、
//   恢复之前时，续跑再执行一次即可。
import path from "node:path";
import { CHECK_OUTPUT_LIMIT_BYTES, type CheckOutcome } from "../execution/check-command.ts";
import { restoreWorkspaceTo } from "../orchestration/checkpoint.ts";
import { materializeSession } from "../persistence/event-log.ts";
import type { SessionId } from "../state/ids.ts";

export const REPAIR_FEEDBACK_INSTRUCTION = "修正代码直到验证通过，不要修改测试文件。";

// 回炉反馈的附加内容注入点：返回要附在反馈末尾的文字；缺省或返回空即不附
export type RepairAppendix = (context: {
  round: number;
  maxRounds: number;
  outcome: CheckOutcome;
}) => string | undefined;

export interface RepairFeedbackInput {
  // 人配置的那一行验证命令
  command: string;
  outcome: Pick<CheckOutcome, "exitCode" | "output" | "truncated">;
  // 即将开始的是第几轮回炉（从 1 起）与上限
  round: number;
  maxRounds: number;
  appendix?: string;
}

export function buildRepairFeedback(input: RepairFeedbackInput): string {
  const output = input.outcome.output.trimEnd();
  const lines = [
    `验证未通过（第 ${input.round}/${input.maxRounds} 轮回炉）。`,
    `验证命令：${input.command}`,
    `退出码：${input.outcome.exitCode ?? "无"}`,
    input.outcome.truncated
      ? `输出末尾（已截断，只保留末尾 ${CHECK_OUTPUT_LIMIT_BYTES / 1024} KiB）：`
      : "输出末尾：",
    output === "" ? "（无输出）" : output,
    "",
    REPAIR_FEEDBACK_INSTRUCTION,
  ];
  const appendix = input.appendix?.trim();
  if (appendix !== undefined && appendix !== "") {
    lines.push("", appendix);
  }
  return lines.join("\n");
}

export interface RestoreStepStartInput {
  governanceRoot: string;
  workspaceRoot: string;
  sessionId: SessionId;
}

// 把工作区恢复到这一步第一个 Run 之前的状态（快照覆盖的范围内逐字一致）。起点从账本现算：
// 本会话首个带改前基线的快照记录；没有即这一步一次文件都没改过，无需恢复
export function restoreStepStart(input: RestoreStepStartInput): {
  restored: boolean;
  commit?: string;
} {
  const session = materializeSession(
    path.join(input.governanceRoot, ".pigeon", "sessions"),
    input.sessionId,
    { content: false }
  );
  const base = session.checkpoints.find((record) => record.payload.baseCommit !== undefined)
    ?.payload.baseCommit;
  if (base === undefined) {
    return { restored: false };
  }
  restoreWorkspaceTo(input.workspaceRoot, base);
  return { restored: true, commit: base };
}
