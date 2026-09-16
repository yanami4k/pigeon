// 无工作区 worker 与结构化收尾结果（M6 S0，决策 064）：Reviewer 是只读、无工作树的 worker——
// 派出时不开工作树、不建分支，收尾无需清理，结果里没有分支与改动文件；收尾结果可携带结构化内容，
// 供 Controller 落盘候选。既有 git-worktree 角色的行为逐字不变。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildSettledInput, ChildSpawnedInput, WorkerWorkspace } from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newReceiptId, newSessionId, type ReceiptId } from "../state/ids.ts";
import {
  gitWorktreeWorkspaces,
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  type WorkspaceProvider,
} from "./workers.ts";

class FakeRuntime implements WorkerRuntimeHandle {
  readonly receipt: ReceiptId = newReceiptId();
  disposed = false;
  readonly #structured: unknown;

  constructor(structured?: unknown) {
    this.#structured = structured;
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    void listener;
    return () => {};
  }

  async run(): Promise<{ status: "completed" }> {
    return { status: "completed" };
  }

  async interrupt(): Promise<void> {}

  receiptIds(): ReceiptId[] {
    return [this.receipt];
  }

  summary(): string {
    return "审阅完成";
  }

  structured(): unknown {
    return this.#structured;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function setup(options: { structured?: unknown; workspaces?: WorkspaceProvider } = {}) {
  const spawned: ChildSpawnedInput[] = [];
  const settled: ChildSettledInput[] = [];
  const requests: WorkerRuntimeRequest[] = [];
  const created: WorkerWorkspace[] = [];
  const workspaces: WorkspaceProvider = options.workspaces ?? {
    plan: ({ sessionId, name, role }): WorkerWorkspace =>
      role === "reviewer"
        ? { kind: "none" }
        : { kind: "git-worktree", path: `/virtual/${sessionId}-${name}`, branch: `pigeon/${name}` },
    // 编排层统一调 create，由提供者按形状决定是否真的建工作区（git 提供者对 none 直接跳过）
    create: (workspace) => {
      if (workspace.kind === "git-worktree") {
        created.push(workspace);
      }
    },
    changedFiles: (workspace) => (workspace.kind === "git-worktree" ? ["a.ts"] : []),
  };
  const orchestratorOptions: WorkerOrchestratorOptions = {
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: {
      allow: ["read_file", "edit_file", "review_snapshot", "review_entry"],
      deny: [],
      approvalMode: "prompt",
    },
    parentLog: {
      appendChildSpawned: (input) => spawned.push(input),
      appendChildSettled: (input) => settled.push(input),
    },
    createRuntime: (request) => {
      requests.push(request);
      return new FakeRuntime(options.structured);
    },
    approvals: async () => ({ approved: true }),
    workspaces,
  };
  return {
    orchestrator: new WorkerOrchestrator(orchestratorOptions),
    spawned,
    settled,
    requests,
    created,
  };
}

test("reviewer 无工作区：不建工作树、工作区记 none、收尾结果不含分支与改动文件", async () => {
  const { orchestrator, spawned, settled, requests, created } = setup();
  const id = orchestrator.spawn({ role: "reviewer", task: "审一下这次运行", name: "reviewer-1" });
  const outcome = await orchestrator.awaitResult(id);

  assert.deepEqual(created, [], "无工作区不得创建任何工作区");
  assert.deepEqual(spawned[0]?.workspace, { kind: "none" }, "派出记录的工作区为 none 形状");
  assert.deepEqual(requests[0]?.workspace, { kind: "none" }, "运行面请求拿到 none 工作区");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result?.branch, undefined, "无工作区没有分支");
  assert.equal(outcome.result?.changedFiles, undefined, "无工作区没有改动文件清单");
  assert.deepEqual(settled[0]?.result?.receiptIds.length, 1, "Receipt 清单照常回收");
  assert.deepEqual(outcome.workspace, { kind: "none" });
});

test("git-worktree 角色行为不变：照常建工作树，结果带分支与改动文件", async () => {
  const { orchestrator, spawned, settled, created } = setup();
  const id = orchestrator.spawn({ role: "explorer", task: "看看 a.ts", name: "explorer-1" });
  const outcome = await orchestrator.awaitResult(id);

  assert.equal(created.length, 1, "git-worktree 角色照常建工作区");
  assert.equal(spawned[0]?.workspace.kind, "git-worktree");
  assert.equal(outcome.result?.branch, "pigeon/explorer-1");
  assert.deepEqual(outcome.result?.changedFiles, ["a.ts"]);
  assert.equal(settled[0]?.result?.branch, "pigeon/explorer-1");
});

test("收尾结果可携带结构化内容：进 outcome 与 child.settled；运行面不提供时缺省", async () => {
  const payload = { candidates: [{ kind: "skill", name: "hashline-anchors" }] };
  const withStructured = setup({ structured: payload });
  const first = withStructured.orchestrator.spawn({ role: "reviewer", task: "审阅" });
  const outcome = await withStructured.orchestrator.awaitResult(first);
  assert.deepEqual(outcome.result?.structured, payload);
  assert.deepEqual(withStructured.settled[0]?.result?.structured, payload);

  const withoutStructured = setup();
  const second = withoutStructured.orchestrator.spawn({ role: "reviewer", task: "审阅" });
  const plain = await withoutStructured.orchestrator.awaitResult(second);
  assert.equal(plain.result?.structured, undefined, "不提供结构化结果时字段缺省");
});

test("git 工作区提供者：reviewer 规划为 none 且不落工作树目录，其他角色照旧", () => {
  const provider = gitWorktreeWorkspaces({ repoRoot: "/repo", governanceRoot: "/repo" });
  const sessionId = newSessionId();
  const reviewerPlan = provider.plan({ sessionId, name: "reviewer-1", role: "reviewer" });
  assert.deepEqual(reviewerPlan, { kind: "none" });
  assert.deepEqual(provider.changedFiles(reviewerPlan), []);

  const explorerPlan = provider.plan({ sessionId, name: "explorer-1", role: "explorer" });
  assert.equal(explorerPlan.kind, "git-worktree");
});

test("token 预算：累计 token 达到上限即中止，以 token-limit 收尾（缺省不限）", async () => {
  const listeners = new Set<(event: EventEnvelope) => void>();
  let interrupted = false;
  const burner: WorkerRuntimeHandle = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run: async () => {
      while (!interrupted) {
        for (const listener of listeners) {
          listener({
            kind: "turn.completed",
            payload: { usage: { totalTokens: 15_000 } },
          } as unknown as EventEnvelope);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { status: "aborted" };
    },
    interrupt: async () => {
      interrupted = true;
    },
    receiptIds: () => [],
    summary: () => "",
    dispose: async () => {},
  };
  const spawned: ChildSpawnedInput[] = [];
  const settled: ChildSettledInput[] = [];
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: "/virtual",
    session: { sessionId: newSessionId() },
    parentPolicy: { allow: [], deny: [], approvalMode: "prompt" },
    parentLog: {
      appendChildSpawned: (input) => spawned.push(input),
      appendChildSettled: (input) => settled.push(input),
    },
    createRuntime: () => burner,
    approvals: async () => ({ approved: true }),
    workspaces: {
      plan: () => ({ kind: "none" }),
      create: () => {},
      changedFiles: () => [],
    },
  });
  const id = orchestrator.spawn({
    role: "reviewer",
    task: "审阅",
    limits: { maxTurns: 100, wallClockMs: 60_000, maxTokens: 40_000 },
  });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "token-limit");
  assert.equal(outcome.turns, 3, "15,000 × 3 = 45,000 ≥ 40,000，第 3 轮后中止");
  assert.equal(spawned[0]?.limits.maxTokens, 40_000, "预算随派出记录落盘");
  assert.equal(settled[0]?.status, "token-limit");
});
