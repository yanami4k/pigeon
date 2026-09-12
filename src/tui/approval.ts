// TUI 审批面板 handler（M2 S3；ROADMAP §M2：审批四键作为同一治理状态的投影继承，
// 零新增治理语义）。与 cli/approval-ui.ts 同一治理语义、同一措辞口径：
// 四键 [y/n/a/d]；审批动作集只有批准/拒绝（决策 001，无"人工改参数"）；[a]/[d] 经
// SessionGrantStore 创建会话 grant（store.create fail-closed：grant.created 事件写盘
// 失败则 grant 不生效，异常上抛由审批闸转阻断）；[d] 仅限 args.path 可定位目录的调用
//（决策 3a；无 path 时提示不提供该键，仍按下则与 cli 版同语义退化为工具级，同 [a]）。
//
// 面板交互语义（决策 029）：
// - ApprovalHandler 是异步函数（M2 开工 5a 第 2 件）：面板把 Promise 挂起，
//   addInputListener 接管四键，按键 resolve；接口形状不动。
// - 面板期间普通输入忽略（简单语义）：除四键外一律吞掉——不进输入缓冲、不提交、不回显。
// - 无墙钟审批超时（与 cli 版一致：等人是审批语义本身）；取消路径一律 fail-closed
//   按拒绝处理、理由逐字回模型（决策 001 的自我修正闭环不断）：壳停止
//   （APPROVAL_CANCEL_CLOSED）、面板未装配（APPROVAL_CANCEL_DETACHED）、并发审批防御
//   （APPROVAL_CANCEL_BUSY）。
// - [n] 无拒绝理由输入通道（四键单按即决议）：reason 缺省，由 Adapter 落默认文案
//   「人工拒绝」。
import { dirname } from "node:path";
import { approvalVerdict } from "../application/format.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  extractPathArg,
} from "../approvals/handler.ts";

// 取消路径的逐字理由（fail-closed 按拒绝处理）
export const APPROVAL_CANCEL_CLOSED = "TUI 已停止，审批面板关闭，本次调用按拒绝处理";
export const APPROVAL_CANCEL_DETACHED = "TUI 审批面板未装配，本次调用按拒绝处理";
export const APPROVAL_CANCEL_BUSY = "已有另一审批进行中，本次调用按拒绝处理（串行不变量防御）";

export type ApprovalPanelKey = "y" | "n" | "a" | "d";

// 面板决议：四键之一；cancel = 面板未能完成交互（壳停止/并发防御），携带逐字理由
export type ApprovalPanelResult = { key: ApprovalPanelKey } | { key: "cancel"; reason: string };

// 面板面：PigeonTuiShell 实现——渲染审批块、挂起等四键、回显结果行。
// 装配顺序上 handler 先于 shell 构造（buildRuntime 收 handler 工厂），故工厂收 face
// getter 晚绑定；getter 返回 undefined = 壳未就位（装配级故障），fail-closed
export interface TuiApprovalFace {
  askApproval(request: ApprovalRequest): Promise<ApprovalPanelResult>;
  noteApproval(line: string): void;
}

// 审批块文本：与 cli 版同口径（工具名 + pretty JSON 参数 + diff 预览 + 四键提示）；
// [d] 仅在调用可定位目录时提供（决策 3a）
export function approvalBlockText(request: ApprovalRequest): string {
  const lines = ["—— 人工审批 ——", `工具：${request.toolName}`, "参数："];
  lines.push(JSON.stringify(request.args, null, 2) ?? "undefined");
  if (request.diffPreview !== undefined) {
    lines.push("改动预览：", request.diffPreview);
  }
  lines.push(
    extractPathArg(request.args) !== undefined
      ? "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录)"
      : "批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许"
  );
  return lines.join("\n");
}

// 决议措辞复用 application/format.ts 的 approvalVerdict（人话单一约定，不造第二套）；
// 它只读 approvedBy/outcome，decidedAt 为占位
function verdictLine(
  outcome: "approved" | "rejected",
  approvedBy: "human" | "human:grant"
): string {
  return `审批结果：${approvalVerdict({ outcome, approvedBy, decidedAt: 0 })}`;
}

// 面板版 handler 工厂（决策 025 的注入形态：装配根先建 grantStore，[a]/[d] 放权键需要它）
export function createTuiApprovalHandler(
  grants: SessionGrantStore,
  face: () => TuiApprovalFace | undefined
): ApprovalHandler {
  return async (request): Promise<ApprovalDecision> => {
    const panel = face();
    if (panel === undefined) {
      return { approved: false, reason: APPROVAL_CANCEL_DETACHED };
    }
    const result = await panel.askApproval(request);
    if (result.key === "cancel") {
      panel.noteApproval(`审批结果：人工拒绝（${result.reason}）`);
      return { approved: false, reason: result.reason };
    }
    if (result.key === "a" || result.key === "d") {
      const pathArg = extractPathArg(request.args);
      // 与 cli 版同一份放权语义：grant.created 事件先于运行态（store.create fail-closed）
      const grant = grants.create({
        tool: request.toolName,
        // [d]：仅限当前调用所在目录；无 path 时该键本不提供，按下退化为工具级（同 [a]）
        ...(result.key === "d" && pathArg !== undefined ? { pathPrefix: dirname(pathArg) } : {}),
        firstCall: { toolCallId: request.toolCallId, args: request.args },
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      });
      panel.noteApproval(verdictLine("approved", "human:grant"));
      panel.noteApproval(`已创建会话放权 ${grant.grantId}（${grant.tool}）`);
      return { approved: true };
    }
    if (result.key === "y") {
      panel.noteApproval(verdictLine("approved", "human"));
      return { approved: true };
    }
    // [n]：无拒绝理由输入通道，Adapter 落默认文案「人工拒绝」
    panel.noteApproval(verdictLine("rejected", "human"));
    return { approved: false };
  };
}
