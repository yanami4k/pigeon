// PreToolUse 钩子在审批闸里的接线（决策 324）：钩子在审批之前执行，拒绝 > 要人确认 > 放行；
// 放行只免掉人工审批这一步（拒绝名单、受保护路径照常生效）；ask 进人工审批（无通道即 fail-closed）；
// updatedInput 按改后参数走账本与放行。钩子实现直接注入假函数（不起真进程）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { GovernanceHost, ToolGovernance } from "../pi-runtime/governance.ts";
import type { RunId } from "../state/ids.ts";
import type { ToolExecution } from "../state/tool-execution.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolGovernance, type ToolGovernanceOptions } from "./governance.ts";

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: Type.Object({ path: Type.String() }),
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({ path: Type.String() }),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  return registry;
}

interface Harness {
  governance: ToolGovernance;
  aborts: () => number;
  errors: unknown[];
}

// 只注入调用方显式给的选项：不给 approvalHandler 即「没有审批通道」（决策 006 的 fail-closed 面）
function harness(
  options: Omit<ToolGovernanceOptions, "registry"> = {},
  policy: Partial<ToolPolicyLike> = {}
): Harness {
  let aborts = 0;
  const errors: unknown[] = [];
  const host: GovernanceHost = {
    policy: {
      allow: [...(policy.allow ?? [])],
      deny: [...(policy.deny ?? [])],
      approvalMode: policy.approvalMode ?? "prompt",
    },
    tools: new Map(),
    activeRunId: () => "run_01J5Z7K8W9ABCDEFGHJKMNPQRS" as RunId,
    abort: () => {
      aborts += 1;
    },
    reportError: (error) => {
      errors.push(error);
    },
  };
  const governance = createToolGovernance({ registry: makeRegistry(), ...options })(host);
  return { governance, aborts: () => aborts, errors };
}

interface Call {
  toolCallId: string;
  toolName: string;
  args: unknown;
  preparedArgs: unknown;
}

// 每个用例固定同一形态的调用，只有工具名与参数不同
function call(toolName: string, args: Record<string, unknown>, toolCallId = "tc-1"): Call {
  return { toolCallId, toolName, args, preparedArgs: args };
}

test("deny：钩子拒绝 → block 且理由逐字；账本记 rejected/policy:hook 带同一理由", async () => {
  const inputs: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
  const h = harness({
    preToolUseHooks: async (input) => {
      inputs.push(input);
      return { decision: "deny", reason: "钩子说这个不能读" };
    },
  });
  const verdict = await h.governance.decide(call("read_file", { path: "a.ts" }));
  assert.deepEqual(verdict, { kind: "block", reason: "钩子说这个不能读" });
  assert.deepEqual(inputs, [{ toolCallId: "tc-1", toolName: "read_file", args: { path: "a.ts" } }]);
  const decision = h.governance.decisionOf("tc-1");
  assert.equal(decision?.outcome, "rejected");
  assert.equal(decision?.approvedBy, "policy:hook");
  assert.equal(decision?.reason, "钩子说这个不能读");
  assert.deepEqual(h.errors, []);
});

test("ask：无审批通道一律 fail-closed（block）；有审批通道则走到人工审批", async () => {
  // read 档本来会自动放行，钩子 ask 把它改成必须人工审批；无通道即拒绝
  const denied = harness({
    preToolUseHooks: async () => ({ decision: "ask", reason: "钩子要人看一眼" }),
  });
  const blocked = await denied.governance.decide(call("read_file", { path: "a.ts" }));
  assert.deepEqual(blocked, { kind: "block", reason: "策略要求人工审批但未配置审批通道" });
  const deniedDecision = denied.governance.decisionOf("tc-1");
  assert.equal(deniedDecision?.outcome, "rejected");
  assert.equal(deniedDecision?.approvedBy, "policy:deny");

  const asked: Array<{ toolName: string; toolCallId: string }> = [];
  const withChannel = harness({
    preToolUseHooks: async () => ({ decision: "ask", reason: "钩子要人看一眼" }),
    approvalHandler: async (request) => {
      asked.push({ toolName: request.toolName, toolCallId: request.toolCallId });
      return { approved: true };
    },
  });
  const allowed = await withChannel.governance.decide(call("read_file", { path: "a.ts" }));
  assert.deepEqual(allowed, { kind: "allow" });
  assert.deepEqual(asked, [{ toolName: "read_file", toolCallId: "tc-1" }]);
  assert.equal(withChannel.governance.decisionOf("tc-1")?.approvedBy, "human");
});

test("allow：原本要人工审批的 write 档调用（无审批通道）被钩子直接放行，账本 policy:hook", async () => {
  const h = harness({ preToolUseHooks: async () => ({ decision: "allow" }) });
  const verdict = await h.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.deepEqual(verdict, { kind: "allow" });
  const decision = h.governance.decisionOf("tc-1");
  assert.equal(decision?.outcome, "approved");
  assert.equal(decision?.approvedBy, "policy:hook");
});

test("allow 不免除受保护路径：命中 protectedPath 时仍走审批，无通道即 fail-closed", async () => {
  const protectedPath = (target: string) => (target.includes(".pigeon") ? target : undefined);
  const protectedArgs = { path: ".pigeon/settings.json" };
  const denied = harness({
    preToolUseHooks: async () => ({ decision: "allow" }),
    protectedPath,
  });
  const blocked = await denied.governance.decide(call("edit_file", protectedArgs));
  assert.deepEqual(blocked, { kind: "block", reason: "策略要求人工审批但未配置审批通道" });
  assert.equal(denied.governance.decisionOf("tc-1")?.approvedBy, "policy:deny");
  // 有审批通道时进人工审批（钩子放行不生效）
  const asked: string[] = [];
  const withChannel = harness({
    preToolUseHooks: async () => ({ decision: "allow" }),
    protectedPath,
    approvalHandler: async (request) => {
      asked.push(request.toolName);
      return { approved: true };
    },
  });
  const allowed = await withChannel.governance.decide(call("edit_file", protectedArgs));
  assert.deepEqual(allowed, { kind: "allow" });
  assert.deepEqual(asked, ["edit_file"]);
  assert.equal(withChannel.governance.decisionOf("tc-1")?.approvedBy, "human");
  // 未命中受保护路径时钩子放行照常生效
  const plain = harness({ preToolUseHooks: async () => ({ decision: "allow" }), protectedPath });
  assert.deepEqual(await plain.governance.decide(call("edit_file", { path: "a.ts" })), {
    kind: "allow",
  });
});

test("updatedInput：verdict.updatedArgs 与账本 rawArgs 都是改后参数", async () => {
  const h = harness({
    preToolUseHooks: async ({ toolName }) =>
      toolName === "edit_file" ? { decision: "allow", updatedInput: { path: "b.ts" } } : undefined,
  });
  const verdict = await h.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.deepEqual(verdict, { kind: "allow", updatedArgs: { path: "b.ts" } });
  const records: ToolExecution[] = h.governance.toolExecutions();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.rawArgs, { path: "b.ts" });
  assert.equal(records[0]?.decision?.outcome, "approved");
  assert.equal(records[0]?.decision?.approvedBy, "policy:hook");
});

test("updatedInput 不带放行含义：write 档只改参数不给结论时仍要人工审批（审批看到的是新参数）", async () => {
  // 无审批通道：只给 updatedInput 的钩子不能把 write 档变成自动放行
  const noChannel = harness({
    preToolUseHooks: async () => ({ updatedInput: { path: "b.ts" } }),
  });
  const blocked = await noChannel.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.deepEqual(blocked, { kind: "block", reason: "策略要求人工审批但未配置审批通道" });

  // 有审批通道：请求里是人要看的新参数；批准后按新参数执行
  const requests: unknown[] = [];
  const withChannel = harness({
    preToolUseHooks: async () => ({ updatedInput: { path: "b.ts" } }),
    approvalHandler: async (request) => {
      requests.push(request.args);
      return { approved: true };
    },
  });
  const verdict = await withChannel.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.deepEqual(requests, [{ path: "b.ts" }]);
  assert.deepEqual(verdict, { kind: "allow", updatedArgs: { path: "b.ts" } });
  assert.equal(withChannel.governance.decisionOf("tc-1")?.approvedBy, "human");
});

test("ask 与 updatedInput 并存：进人工审批且保留新参数", async () => {
  const requests: unknown[] = [];
  const h = harness({
    preToolUseHooks: async () => ({
      decision: "ask",
      reason: "钩子要人看一眼",
      updatedInput: { path: "b.ts" },
    }),
    approvalHandler: async (request) => {
      requests.push(request.args);
      return { approved: true };
    },
  });
  const verdict = await h.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.deepEqual(requests, [{ path: "b.ts" }]);
  assert.deepEqual(verdict, { kind: "allow", updatedArgs: { path: "b.ts" } });
});

test("updatedInput 不合参数模式：当钩子出错处理——记异常、按原参数走", async () => {
  const h = harness({
    // edit_file 的参数模式要求 path 为 string；给个不合模式的
    preToolUseHooks: async () => ({ decision: "allow", updatedInput: { path: 42 } }),
  });
  const verdict = await h.governance.decide(call("edit_file", { path: "a.ts" }));
  // 放行照旧（钩子 allow 生效），但执行用原参数
  assert.deepEqual(verdict, { kind: "allow" });
  assert.equal(h.errors.length, 1);
  assert.match(String(h.errors[0]), /updatedInput 不合 edit_file 的参数模式/);
  const records: ToolExecution[] = h.governance.toolExecutions();
  assert.deepEqual(records[0]?.rawArgs, { path: "a.ts" }, "账本留原参数");
});

test("deny 清单仍绝对：钩子 allow 与 updatedInput 都不豁免 deny 名单工具", async () => {
  const h = harness(
    { preToolUseHooks: async () => ({ decision: "allow", updatedInput: { path: "b.ts" } }) },
    { deny: ["edit_file"] }
  );
  const blocked = await h.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.equal(blocked.kind, "block");
  assert.match(
    blocked.kind === "block" ? blocked.reason : "",
    /deny 清单精确匹配，任何模式一律拒绝：edit_file/
  );
  const decision = h.governance.decisionOf("tc-1");
  assert.equal(decision?.outcome, "rejected");
  assert.equal(decision?.approvedBy, "policy:deny");
});

test("ask 只收紧不放行：deny 清单工具配 ask 钩子仍被拒绝，不进人工审批", async () => {
  let asked = 0;
  const h = harness(
    {
      preToolUseHooks: async () => ({ decision: "ask", reason: "钩子要人看一眼" }),
      approvalHandler: async () => {
        asked += 1;
        return { approved: true };
      },
    },
    { deny: ["edit_file"] }
  );
  const blocked = await h.governance.decide(call("edit_file", { path: "a.ts" }));
  assert.match(
    blocked.kind === "block" ? blocked.reason : "",
    /deny 清单精确匹配，任何模式一律拒绝：edit_file/
  );
  assert.equal(asked, 0);
  const decision = h.governance.decisionOf("tc-1");
  assert.equal(decision?.outcome, "rejected");
  assert.equal(decision?.approvedBy, "policy:deny");
});

test("钩子自身抛错不拦只记（不改变治理结论），也不影响后续判定", async () => {
  const error = new Error("钩子炸了");
  const h = harness({
    preToolUseHooks: async () => {
      throw error;
    },
  });
  // read 档照常自动放行
  assert.deepEqual(await h.governance.decide(call("read_file", { path: "a.ts" })), {
    kind: "allow",
  });
  assert.deepEqual(h.errors, [error]);
  // write 档仍按 prompt 走：无审批通道 fail-closed
  const denied = await h.governance.decide(call("edit_file", { path: "a.ts" }, "tc-2"));
  assert.deepEqual(denied, { kind: "block", reason: "策略要求人工审批但未配置审批通道" });
  assert.equal(h.errors.length, 2);
});
