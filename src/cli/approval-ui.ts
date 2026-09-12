// CLI 审批交互（M3 决策 3 + M4 S6 决策 3：REPL 内联、单进程最小闭环）。
// 被 Adapter 审批闸调用：终端展示工具名、参数（pretty JSON）与 diff 预览（若有），
// 交互四键——[y] 批准一次 / [n] 拒绝 / [a] 本会话允许（工具级 grant）/
// [d] 本会话允许（仅限当前调用所在目录）。决策 1：只有批准/拒绝两态，无"人工改参数"。
// [a]/[d] 创建会话 grant：事件写盘失败 = grant 不生效（fail-closed，见 store.create）
import { dirname } from "node:path";
import type { ApprovalHandler } from "../approvals/handler.ts";
import type { SessionGrantStore } from "../persistence/grants.ts";
import type { AskFn, WriteFn } from "./repl.ts";

export interface CliApprovalOptions {
  // M4 S6（决策 3）：会话 grant 存储——缺省时只提供 y/n 两键（测试/无放权场景）
  grants?: SessionGrantStore;
}

// 调用的路径参数：grant 目录限定只认 args.path 字符串（与 grants.ts 匹配口径一致）
function extractPathArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("path" in args)) {
    return undefined;
  }
  const path = (args as { path: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

export function createCliApprovalHandler(
  ask: AskFn,
  write: WriteFn,
  options: CliApprovalOptions = {}
): ApprovalHandler {
  const grants = options.grants;
  return async (request) => {
    write("\n—— 人工审批 ——\n");
    write(`工具：${request.toolName}\n`);
    write(`参数：\n${JSON.stringify(request.args, null, 2)}\n`);
    if (request.diffPreview !== undefined) {
      write(`改动预览：\n${request.diffPreview}\n`);
    }
    const pathArg = extractPathArg(request.args);
    // [d] 仅在调用带 path 参数时提供（决策 3a：目录限定的前提是调用可定位目录）
    const prompt =
      grants === undefined
        ? "批准执行？[y/N] "
        : pathArg !== undefined
          ? "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录) "
          : "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 ";
    const answer = await ask(prompt);
    const normalized = answer?.trim().toLowerCase() ?? "";
    if (normalized === "a" || normalized === "d") {
      if (grants === undefined) {
        // 无放权通道时 a/d 不具语义——按拒绝流程走（理由可空，由 Adapter 落默认文案）
        const reasonInput = await ask("拒绝理由（可空，将逐字反馈给模型）：");
        const reason = reasonInput?.trim() ?? "";
        return reason === "" ? { approved: false } : { approved: false, reason };
      }
      const grant = grants.create({
        tool: request.toolName,
        // [d]：仅限当前调用所在目录（根级文件 = 工作区根 "."）
        ...(normalized === "d" && pathArg !== undefined ? { pathPrefix: dirname(pathArg) } : {}),
        firstCall: { toolCallId: request.toolCallId, args: request.args },
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      });
      write(`已创建会话放权 ${grant.grantId}（${grant.tool}）\n`);
      return { approved: true };
    }
    const approved = normalized === "y" || normalized === "yes";
    if (approved) {
      return { approved: true };
    }
    const reasonInput = await ask("拒绝理由（可空，将逐字反馈给模型）：");
    const reason = reasonInput?.trim() ?? "";
    // 空理由按 undefined 传，由 Adapter 落到默认文案
    return reason === "" ? { approved: false } : { approved: false, reason };
  };
}
