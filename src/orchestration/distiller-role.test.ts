// 提炼器角色（M7 S4，决策 074）：复用 worker 机制，只读、无工作区；白名单只有两个绑定一组尝试的只读工具，
// 与 Reviewer 的只读快照工具同构——不在主会话工具清单里，按"只读且作用域只限这组尝试"豁免子集约束，父策略禁用清单照旧生效。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DISTILL_ENTRY_TOOL, DISTILL_SNAPSHOT_TOOL, type DistillTarget } from "../state/distill.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { REVIEW_ENTRY_TOOL, REVIEW_SNAPSHOT_TOOL } from "../state/review.ts";
import {
  assertPolicySubset,
  deriveWorkerPolicy,
  isWorkerRole,
  ROLE_TOOLS,
  WorkerPolicyError,
} from "./roles.ts";
import { gitWorktreeWorkspaces, WorkerOrchestrator, WorkerSpawnError } from "./workers.ts";

const PARENT = {
  allow: ["read_file", "edit_file", "run_command"],
  deny: [],
  approvalMode: "yolo" as const,
};

test("distiller 是合法角色；白名单只有两个只读工具，不含任何写、终端或检索工具", () => {
  assert.ok(isWorkerRole("distiller"));
  assert.deepEqual([...ROLE_TOOLS.distiller], [DISTILL_SNAPSHOT_TOOL, DISTILL_ENTRY_TOOL]);
  const policy = deriveWorkerPolicy(PARENT, "distiller");
  assert.deepEqual(policy.allow, [DISTILL_SNAPSHOT_TOOL, DISTILL_ENTRY_TOOL]);
  for (const tool of ["edit_file", "run_command", "read_file", "search_sessions"]) {
    assert.ok(!policy.allow.includes(tool), tool);
  }
  assert.doesNotThrow(() => assertPolicySubset(policy, PARENT, "distiller"));
});

test("父策略禁用清单照旧生效；其他角色拿不到提炼器的只读工具", () => {
  const denied = deriveWorkerPolicy({ ...PARENT, deny: [DISTILL_ENTRY_TOOL] }, "distiller");
  assert.deepEqual(denied.allow, [DISTILL_SNAPSHOT_TOOL]);
  assert.throws(() =>
    assertPolicySubset(
      { allow: [DISTILL_SNAPSHOT_TOOL, "edit_file"], deny: [], approvalMode: "yolo" },
      { allow: ["read_file"], deny: [], approvalMode: "yolo" },
      "distiller"
    )
  );
  assert.ok(!deriveWorkerPolicy(PARENT, "reviewer").allow.includes(DISTILL_SNAPSHOT_TOOL));
});

// 决策 040 修订：第二道校验的豁免集合按角色取，不用合并集合
test("子集校验按角色取豁免集合：角色拿到别的角色的作用域工具即拒绝，各自的正常策略照常通过", () => {
  const readOnlyParent = { allow: ["read_file"], deny: [], approvalMode: "yolo" as const };
  // 发放侧写错（把提炼工具发给 reviewer、把审阅工具发给提炼器）时，第二道校验必须拦住
  assert.throws(
    () =>
      assertPolicySubset(
        {
          allow: [REVIEW_SNAPSHOT_TOOL, REVIEW_ENTRY_TOOL, DISTILL_SNAPSHOT_TOOL],
          deny: [],
          approvalMode: "yolo",
        },
        readOnlyParent,
        "reviewer"
      ),
    WorkerPolicyError
  );
  assert.throws(
    () =>
      assertPolicySubset(
        {
          allow: [DISTILL_SNAPSHOT_TOOL, DISTILL_ENTRY_TOOL, REVIEW_ENTRY_TOOL],
          deny: [],
          approvalMode: "yolo",
        },
        readOnlyParent,
        "distiller"
      ),
    WorkerPolicyError
  );
  // 不带作用域工具的角色一个都不豁免
  assert.throws(
    () =>
      assertPolicySubset(
        { allow: ["read_file", REVIEW_SNAPSHOT_TOOL], deny: [], approvalMode: "yolo" },
        readOnlyParent,
        "explorer"
      ),
    WorkerPolicyError
  );
  // 两个角色各自的正常构造仍然通过
  assert.doesNotThrow(() =>
    assertPolicySubset(deriveWorkerPolicy(PARENT, "reviewer"), PARENT, "reviewer")
  );
  assert.doesNotThrow(() =>
    assertPolicySubset(deriveWorkerPolicy(PARENT, "distiller"), PARENT, "distiller")
  );
});

test("工作区规划：提炼器无工作区；缺提炼目标时派出前拒绝（零落盘）", () => {
  const provider = gitWorktreeWorkspaces({ repoRoot: "/r", governanceRoot: "/r" });
  assert.deepEqual(
    provider.plan({ sessionId: newSessionId(), name: "distiller-1", role: "distiller" }),
    { kind: "none" }
  );
  const spawned: unknown[] = [];
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: PARENT,
    parentLog: { appendChildSpawned: (input) => spawned.push(input), appendChildSettled: () => {} },
    createRuntime: () => {
      throw new Error("不应装配");
    },
    approvals: async () => ({ approved: false }),
  });
  assert.throws(() => orchestrator.spawn({ role: "distiller", task: "提炼" }), WorkerSpawnError);
  assert.equal(spawned.length, 0);
  const target: DistillTarget = {
    kind: "task",
    task: { governanceRoot: "/r", sessionId: newSessionId(), runId: newRunId() },
    others: [],
  };
  const requests: unknown[] = [];
  const withTarget = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: PARENT,
    parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
    workspaces: provider,
    createRuntime: (request) => {
      requests.push(request);
      return {
        run: async () => ({ status: "completed" }),
        interrupt: async () => {},
        subscribe: () => () => {},
        receiptIds: () => [],
        summary: () => "",
        dispose: async () => {},
      };
    },
    approvals: async () => ({ approved: false }),
  });
  withTarget.spawn({ role: "distiller", task: "提炼", distill: target });
  assert.deepEqual((requests[0] as { distill?: DistillTarget }).distill, target);
});
