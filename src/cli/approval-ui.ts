// CLI 审批交互（M3 决策 3：REPL 内联、单进程最小闭环）。
// 被 Adapter 审批闸调用：终端展示工具名、参数（pretty JSON）与 diff 预览（若有），
// 交互 y/N + 可选拒绝理由。决策 1：只有批准/拒绝两态，无"人工改参数"。
import type { ApprovalHandler } from "../approvals/handler.ts";
import type { AskFn, WriteFn } from "./repl.ts";

export function createCliApprovalHandler(ask: AskFn, write: WriteFn): ApprovalHandler {
  return async (request) => {
    write("\n—— 人工审批 ——\n");
    write(`工具：${request.toolName}\n`);
    write(`参数：\n${JSON.stringify(request.args, null, 2)}\n`);
    if (request.diffPreview !== undefined) {
      write(`改动预览：\n${request.diffPreview}\n`);
    }
    const answer = await ask("批准执行？[y/N] ");
    const approved = answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
    if (approved) {
      return { approved: true };
    }
    const reasonInput = await ask("拒绝理由（可空，将逐字反馈给模型）：");
    const reason = reasonInput?.trim() ?? "";
    // 空理由按 undefined 传，由 Adapter 落到默认文案
    return reason === "" ? { approved: false } : { approved: false, reason };
  };
}
