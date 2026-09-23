// worker 角色与委派策略（M5.5 S2，决策 040）：角色是参数不是执行体；worker 策略只能从父策略里挑子集——
// allow 只缩（角色默认工具 ∩ 父 allow，再剔除父 deny），deny 只增（原样继承父 deny），审批模式不升级
// （父 prompt 不派 yolo 子）。assertPolicySubset 是构造之外的第二道校验，派出前必过。
// 第一版学习闭环退役（决策 137 / 158）：reviewer、distiller、verifier 三个角色停用、不再派出；
// 账本里的角色取值（WorkerRoleSchema）保留，旧会话记录照常读取。
import { MCP_TOOL_PREFIX } from "../mcp/registry-bridge.ts";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import type { DelegatedPolicy, WorkerRole } from "../state/event-log.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";

export class WorkerPolicyError extends Error {}

// 可派出的角色（写入侧）：账本角色取值的子集
export type ActiveWorkerRole = Extract<WorkerRole, "explorer" | "implementer" | "tester">;

export const WORKER_ROLES: readonly ActiveWorkerRole[] = ["explorer", "implementer", "tester"];

// 角色默认工具（ROADMAP §M5.5 角色表）；tester 的 run_command 另受 .pigeon/commands.json 角色清单限定（048）
export const ROLE_TOOLS: Readonly<Record<ActiveWorkerRole, readonly string[]>> = {
  explorer: ["read_file", SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL],
  implementer: ["read_file", "edit_file"],
  tester: ["read_file", "run_command"],
};

// 角色表的推理档位列（决策 050）：在场即覆盖启动参数的全局值，缺省继承全局。现有角色都继承
export const ROLE_THINKING_LEVELS: Readonly<Partial<Record<WorkerRole, ThinkingLevel>>> = {};

// 角色表的模型接入覆盖列（M6，决策 064 子裁决 ③）：在场即覆盖主会话的模型接入与标识，缺省继承。
// streamFnSpec 是插件模块说明符，由装配层预先加载成 StreamFn（工厂本身同步，不在此处做 IO）；
// provider 与 modelId 只是身份标签，进注入快照与 run.started。现有角色都留空
export interface RoleModelOverride {
  streamFnSpec?: string;
  provider?: string;
  modelId?: string;
}

export const ROLE_MODEL_OVERRIDES: Readonly<Partial<Record<WorkerRole, RoleModelOverride>>> = {};

export function isWorkerRole(value: string): value is ActiveWorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

export function deriveWorkerPolicy(
  parent: ToolPolicyLike,
  role: ActiveWorkerRole
): DelegatedPolicy {
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

// 第二道校验（决策 040 修订）：子策略的 allow 必须全在父 allow 里且不碰父 deny
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
