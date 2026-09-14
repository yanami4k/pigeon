// worker 角色与委派策略（M5.5 S2，决策 040）：角色是参数不是执行体；worker 策略只能从父策略里挑子集——
// allow 只缩（角色默认工具 ∩ 父 allow，再剔除父 deny），deny 只增（原样继承父 deny），审批模式不升级
// （父 prompt 不派 yolo 子）。assertPolicySubset 是构造之外的第二道校验，派出前必过。
import { MCP_TOOL_PREFIX } from "../mcp/registry-bridge.ts";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import type { DelegatedPolicy, WorkerRole } from "../state/event-log.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";

export class WorkerPolicyError extends Error {}

export const WORKER_ROLES: readonly WorkerRole[] = [
  "reviewer",
  "explorer",
  "implementer",
  "tester",
];

// 角色默认工具（ROADMAP §M5.5 角色表）；tester 的 run_command 另受 .pigeon/commands.json 角色清单限定（048）
export const ROLE_TOOLS: Readonly<Record<WorkerRole, readonly string[]>> = {
  reviewer: [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL],
  explorer: ["read_file", SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL],
  implementer: ["read_file", "edit_file"],
  tester: ["read_file", "run_command"],
};

// 角色表的推理档位列（决策 050）：在场即覆盖启动参数的全局值，缺省继承全局。第一版四个角色都继承
export const ROLE_THINKING_LEVELS: Readonly<Partial<Record<WorkerRole, ThinkingLevel>>> = {};

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

export function deriveWorkerPolicy(parent: ToolPolicyLike, role: WorkerRole): DelegatedPolicy {
  const deny = [...new Set(parent.deny)];
  // M5.7 S4：implementer 另继承父策略里的 MCP 工具（外部写工具照样逐次审批）；其余角色不继承
  const inherited =
    role === "implementer"
      ? parent.allow.filter((tool) => tool.startsWith(`${MCP_TOOL_PREFIX}__`))
      : [];
  const allow = [...ROLE_TOOLS[role], ...inherited].filter(
    (tool) => parent.allow.includes(tool) && !deny.includes(tool)
  );
  return { allow, deny, approvalMode: parent.approvalMode };
}

export function assertPolicySubset(child: ToolPolicyLike, parent: ToolPolicyLike): void {
  const widened = child.allow.filter(
    (tool) => !parent.allow.includes(tool) || parent.deny.includes(tool)
  );
  if (widened.length > 0) {
    throw new WorkerPolicyError(`worker 策略超出父策略：${widened.join("、")}`);
  }
  const dropped = parent.deny.filter((tool) => !child.deny.includes(tool));
  if (dropped.length > 0) {
    throw new WorkerPolicyError(`worker 策略丢了父策略的 deny：${dropped.join("、")}`);
  }
  if (child.approvalMode === "yolo" && parent.approvalMode !== "yolo") {
    throw new WorkerPolicyError("worker 审批模式不能高于父策略（父 prompt 不派 yolo 子）");
  }
}
