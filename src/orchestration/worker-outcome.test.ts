// worker 收尾结果与预算（M6 S0，决策 064）：git 工作树角色建工作树，结果带分支与改动文件；
// 收尾结果可携带结构化内容；累计 token 达到上限即中止。
// 只读、无工作区的 Reviewer 已随第一版学习闭环退役（决策 137），git 工作区提供者不再规划无工作区。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId } from "../state/ids.ts";
import type {
  ChildSettledInput,
  ChildSpawnedInput,
  WorkerWorkspace,
} from "../state/session-payloads.ts";
import {
  gitWorktreeWorkspaces,
  WorkerOrchestrator,
  type WorkerOrchestratorOptions,
  type WorkerRunResult,
  type WorkerRuntimeHandle,
  type WorkerRuntimeRequest,
  WorkerSpawnError,
  type WorkspaceProvider,
} from "./workers.ts";

class FakeRuntime implements WorkerRuntimeHandle {
  disposed = false;
  readonly #structured: unknown;
  readonly #hookOutputs: string[] | undefined;

  constructor(structured?: unknown, hookOutputs?: string[]) {
    this.#structured = structured;
    this.#hookOutputs = hookOutputs;
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    void listener;
    return () => {};
  }

  async run(): Promise<WorkerRunResult> {
    return {
      status: "completed",
      ...(this.#hookOutputs !== undefined ? { hookOutputs: this.#hookOutputs } : {}),
    };
  }

  async interrupt(): Promise<void> {}

  summary(): string {
    return "完成";
  }

  structured(): unknown {
    return this.#structured;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function setup(
  options: { structured?: unknown; hookOutputs?: string[]; workspaces?: WorkspaceProvider } = {}
) {
  const spawned: ChildSpawnedInput[] = [];
  const settled: ChildSettledInput[] = [];
  const requests: WorkerRuntimeRequest[] = [];
  const created: WorkerWorkspace[] = [];
  const workspaces: WorkspaceProvider = options.workspaces ?? {
    plan: ({ sessionId, name }): WorkerWorkspace => ({
      kind: "git-worktree",
      path: `/virtual/${sessionId}-${name}`,
      branch: `pigeon/${name}`,
    }),
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
      allow: ["read_file", "edit_file"],
      deny: [],
      approvalMode: "prompt",
    },
    parentLog: {
      appendChildSpawned: (input) => spawned.push(input),
      appendChildSettled: (input) => settled.push(input),
    },
    createRuntime: (request) => {
      requests.push(request);
      return new FakeRuntime(options.structured, options.hookOutputs);
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
  const first = withStructured.orchestrator.spawn({ role: "explorer", task: "看看" });
  const outcome = await withStructured.orchestrator.awaitResult(first);
  assert.deepEqual(outcome.result?.structured, payload);
  assert.deepEqual(withStructured.settled[0]?.result?.structured, payload);

  const withoutStructured = setup();
  const second = withoutStructured.orchestrator.spawn({ role: "explorer", task: "看看" });
  const plain = await withoutStructured.orchestrator.awaitResult(second);
  assert.equal(plain.result?.structured, undefined, "不提供结构化结果时字段缺省");
});

test("收尾钩子的输出随结果交回（决策 322：多份尝试各带各的钩子输出）；没有输出时字段缺省", async () => {
  const withOutputs = setup({ hookOutputs: ["还差边界用例", "覆盖率 85%"] });
  const first = withOutputs.orchestrator.spawn({ role: "explorer", task: "看看" });
  const outcome = await withOutputs.orchestrator.awaitResult(first);
  assert.deepEqual(outcome.hookOutputs, ["还差边界用例", "覆盖率 85%"]);

  const without = setup();
  const second = without.orchestrator.spawn({ role: "explorer", task: "看看" });
  const plain = await without.orchestrator.awaitResult(second);
  assert.equal(plain.hookOutputs, undefined, "没有钩子输出时字段缺省");
});
test("git 工作区提供者：可派出的角色一律规划 git 工作树", () => {
  const provider = gitWorktreeWorkspaces({ repoRoot: "/repo", governanceRoot: "/repo" });
  const sessionId = newSessionId();
  for (const role of ["explorer", "implementer", "tester"] as const) {
    const plan = provider.plan({ sessionId, name: `${role}-1`, role });
    assert.equal(plan.kind, "git-worktree", role);
  }
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
      plan: ({ name }) => ({ kind: "git-worktree", path: `/virtual/${name}`, branch: name }),
      create: () => {},
      changedFiles: () => [],
    },
  });
  const id = orchestrator.spawn({
    role: "explorer",
    task: "看看",
    limits: { maxTurns: 100, wallClockMs: 60_000, maxTokens: 40_000 },
  });
  const outcome = await orchestrator.awaitResult(id);
  assert.equal(outcome.status, "token-limit");
  assert.equal(outcome.turns, 3, "15,000 × 3 = 45,000 ≥ 40,000，第 3 轮后中止");
  assert.equal(spawned[0]?.limits.maxTokens, 40_000, "预算随派出记录落盘");
  assert.equal(settled[0]?.status, "token-limit");
});

test("退役角色（决策 137 / 158）：派 reviewer、distiller、verifier 按未知角色拒绝，不写派出记录", () => {
  const { orchestrator, spawned, requests } = setup();
  for (const role of ["reviewer", "distiller", "verifier"]) {
    assert.throws(() => orchestrator.spawn({ role, task: "看看" }), WorkerSpawnError);
  }
  assert.deepEqual(spawned, []);
  assert.deepEqual(requests, []);
});
