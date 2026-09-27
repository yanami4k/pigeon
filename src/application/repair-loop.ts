// 回炉（决策 142 / 143 / 147）的应用层部件：回炉反馈消息。流程本身在 headless-core.ts。
// 反馈：验证命令、退出码、输出末尾（沿用验证记录的 16 KiB 尾部）与修正要求；分步配置下（决策 159）改为写明
// 哪几步失败、附各失败步的退出码与输出末尾。末尾留一个附加内容的注入点，缺省为空——结构化记忆从这里附加
// 回炉时匹配到的记忆（决策 134）。
import { CHECK_OUTPUT_LIMIT_BYTES, type CheckOutcome } from "../execution/check-command.ts";
import type { VerifyStepResult } from "../state/verify-steps.ts";

export const REPAIR_FEEDBACK_INSTRUCTION = "修正代码直到验证通过，不要修改测试文件。";

// 回炉反馈的附加内容注入点：返回要附在反馈末尾的文字；缺省或返回空即不附
export type RepairAppendix = (context: {
  round: number;
  maxRounds: number;
  outcome: CheckOutcome;
  // 决策 159：分步配置下的各步结论（单条命令配置缺省）
  steps?: readonly VerifyStepResult[];
}) => string | undefined;

export interface RepairFeedbackInput {
  // 人配置的那一行验证命令（分步配置下为各步的展示串）
  command: string;
  outcome: Pick<CheckOutcome, "exitCode" | "output" | "truncated">;
  // 决策 159：分步配置下的各步结论——在场时反馈写明哪几步失败并附各失败步的输出末尾
  steps?: readonly VerifyStepResult[];
  // 即将开始的是第几轮回炉（从 1 起）与上限
  round: number;
  maxRounds: number;
  appendix?: string;
}

function tailHeading(truncated: boolean): string {
  return truncated
    ? `输出末尾（已截断，只保留末尾 ${CHECK_OUTPUT_LIMIT_BYTES / 1024} KiB）：`
    : "输出末尾：";
}

export function buildRepairFeedback(input: RepairFeedbackInput): string {
  const heading = `验证未通过（第 ${input.round}/${input.maxRounds} 轮回炉）。`;
  const lines =
    input.steps !== undefined
      ? [heading, ...stepFeedbackLines(input.steps), "", REPAIR_FEEDBACK_INSTRUCTION]
      : [
          heading,
          `验证命令：${input.command}`,
          `退出码：${input.outcome.exitCode ?? "无"}`,
          tailHeading(input.outcome.truncated),
          nonEmpty(input.outcome.output),
          "",
          REPAIR_FEEDBACK_INSTRUCTION,
        ];
  const appendix = input.appendix?.trim();
  if (appendix !== undefined && appendix !== "") {
    lines.push("", appendix);
  }
  return lines.join("\n");
}

function nonEmpty(output: string): string {
  const trimmed = output.trimEnd();
  return trimmed === "" ? "（无输出）" : trimmed;
}

// 分步反馈：先列失败与无法判定的步骤名，再逐个附退出码与输出末尾；通过的步骤只在清单里出现
function stepFeedbackLines(steps: readonly VerifyStepResult[]): string[] {
  const failed = steps.filter((step) => step.verdict === "fail");
  const undetermined = steps.filter((step) => step.verdict === "undetermined");
  const passed = steps.filter((step) => step.verdict === "pass");
  const lines = [`失败的步骤：${failed.map((step) => step.name).join("、") || "无"}`];
  if (undetermined.length > 0) {
    lines.push(`无法判定的步骤：${undetermined.map((step) => step.name).join("、")}`);
  }
  if (passed.length > 0) {
    lines.push(`已通过的步骤：${passed.map((step) => step.name).join("、")}`);
  }
  for (const step of [...failed, ...undetermined]) {
    lines.push(
      "",
      `【${step.name}${step.cwd !== undefined ? ` @ ${step.cwd}` : ""}】退出码：${step.exitCode ?? "无"}`,
      tailHeading(step.truncated),
      nonEmpty(step.output)
    );
  }
  return lines;
}
