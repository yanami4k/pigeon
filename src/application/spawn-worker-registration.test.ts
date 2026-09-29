// 派 worker 的注册范围与可并行（决策 264–267）：主会话给了工具槽才注册；worker 自己（委派策略在场）、沙箱（执行端在场）、
// 命令行对话（不给槽）都不注册；pigeon run 缺省关着、开了才注册；跑批器各条件的工具清单都不含 spawn_worker。
// 注册了时同一次回复里的多个派出真的并行执行。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { STREAM_SPAWN_WORKERS } from "../eval/stream-agents.ts";
import { effectivePigeonSettings } from "../eval/stream-experiment.ts";
import { CONDITION_SPECS } from "../eval/stream-runner.ts";
import type { WorkerOutcome } from "../orchestration/workers.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { asWorkspaceHost } from "../tools/local-host.ts";
import { runHeadlessOnce } from "./headless-core.ts";
import { noMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type RuntimeDeps } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { SPAWN_WORKER_TOOL, SpawnWorkerBudget, SpawnWorkerSlot } from "./spawn-worker-tool.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function gitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-reg-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

function baseDeps(root: string, extra: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "fake",
    modelId: "fake",
    ...extra,
  };
}

async function advertised(deps: RuntimeDeps): Promise<readonly string[]> {
  const bundle = buildRuntime(deps);
  try {
    return bundle.adapter.snapshot().tools.advertised;
  } finally {
    await disposeRuntime(bundle);
  }
}

test("装配根：给了工具槽的主会话注册 spawn_worker；没给槽、委派策略在场（worker 自己）、执行端在场（沙箱）都不注册", async () => {
  const root = gitRoot();
  assert.ok(
    (await advertised(baseDeps(root, { spawnWorker: new SpawnWorkerSlot() }))).includes(
      SPAWN_WORKER_TOOL
    )
  );
  assert.ok(!(await advertised(baseDeps(root))).includes(SPAWN_WORKER_TOOL));
  assert.ok(
    !(
      await advertised(
        baseDeps(root, {
          spawnWorker: new SpawnWorkerSlot(),
          toolPolicy: { allow: ["read_file", SPAWN_WORKER_TOOL], deny: [], approvalMode: "yolo" },
        })
      )
    ).includes(SPAWN_WORKER_TOOL)
  );
  assert.ok(
    !(
      await advertised(
        baseDeps(root, { spawnWorker: new SpawnWorkerSlot(), workspaceHost: asWorkspaceHost(root) })
      )
    ).includes(SPAWN_WORKER_TOOL)
  );
});

test("会话运行面：终端界面给槽即注册并交回槽；命令行对话不给槽不注册", async () => {
  const root = gitRoot();
  const flags = { yolo: true, provider: "fake", modelId: "fake", persistThinking: true };
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const slot = new SpawnWorkerSlot();
  const tui = await openSessionRuntime({
    governanceRoot: root,
    sessionId: newSessionId(),
    streamFn,
    flags,
    spawnWorker: slot,
    startMcp: () => noMcpSession(),
  });
  const line = await openSessionRuntime({
    governanceRoot: root,
    sessionId: newSessionId(),
    streamFn,
    flags,
    startMcp: () => noMcpSession(),
  });
  try {
    assert.ok(tui.bundle.adapter.snapshot().tools.advertised.includes(SPAWN_WORKER_TOOL));
    assert.equal(tui.spawnWorker, slot);
    assert.ok(!line.bundle.adapter.snapshot().tools.advertised.includes(SPAWN_WORKER_TOOL));
    assert.equal(line.spawnWorker, undefined);
  } finally {
    await disposeRuntime(tui.bundle);
    await disposeRuntime(line.bundle);
  }
});

async function headlessTools(
  root: string,
  options: Partial<Parameters<typeof runHeadlessOnce>[0]>
): Promise<readonly string[]> {
  let tools: readonly string[] = [];
  await runHeadlessOnce({
    task: "看一眼",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    yolo: true,
    ...options,
    onBundle: (bundle) => {
      tools = bundle.adapter.snapshot().tools.advertised;
    },
  });
  return tools;
}

test("pigeon run：缺省不注册、开了才注册；跑批器五个条件（四格明确关掉，最简 agent 不经 Pigeon）的工具清单都不含 spawn_worker，身份头记关", async () => {
  const root = gitRoot();
  assert.ok(!(await headlessTools(root, {})).includes(SPAWN_WORKER_TOOL));
  assert.ok((await headlessTools(root, { spawnWorkers: true })).includes(SPAWN_WORKER_TOOL));
  // 实验的五个条件（193、265）：四格经 headless 跑 Pigeon、派 worker 明确关掉；最简 agent 是宿主上的独立进程，
  // 不装 Pigeon 的任何工具
  const specs = Object.values(CONDITION_SPECS);
  assert.equal(specs.length, 5);
  assert.deepEqual(
    specs.filter((spec) => spec.agent !== "pigeon").map((spec) => `${spec.name}:${spec.agent}`),
    ["minimal:minimal"]
  );
  const pigeonConditions = specs.filter((spec) => spec.agent === "pigeon");
  assert.equal(pigeonConditions.length, 4);
  for (const spec of pigeonConditions) {
    const tools = await headlessTools(root, {
      spawnWorkers: STREAM_SPAWN_WORKERS,
      sessionSearch: spec.sessionSearch,
      pushedMemory: spec.pushedMemory,
      skillRoots: [],
      memoryRoots: [],
    });
    assert.ok(tools.includes("read_file"), spec.name);
    assert.ok(!tools.includes(SPAWN_WORKER_TOOL), `${spec.name}：${tools.join("、")}`);
  }
  assert.equal(effectivePigeonSettings({}, "m").spawnWorkers, false);
});

test("可并行：同一次回复里两次调用 spawn_worker 都立即返回派出的名字，不等 worker 收尾", async () => {
  const root = gitRoot();
  const spawned: SessionId[] = [];
  const names = new Map<SessionId, string>();
  const never = Promise.withResolvers<WorkerOutcome>();
  const slot = new SpawnWorkerSlot();
  slot.bind({
    governanceRoot: root,
    budget: new SpawnWorkerBudget({}),
    spawnAttempts: async () => {
      throw new Error("不派多份");
    },
    orchestrator: {
      status: () =>
        spawned.map((id) => ({
          sessionId: id,
          name: names.get(id) ?? "w",
          role: "explorer" as const,
          state: "running" as const,
          turns: 0,
          branch: `pigeon/${names.get(id) ?? "w"}`,
          startedAt: 0,
          workspace: {
            kind: "git-worktree" as const,
            path: root,
            branch: `pigeon/${names.get(id)}`,
          },
        })),
      spawn: (request) => {
        const id = newSessionId();
        names.set(id, request.name ?? "w");
        spawned.push(id);
        return id;
      },
      // worker 永不收尾：派出不等它
      awaitResult: () => never.promise,
      cancel: async () => {},
      wait: async () => ({ settled: [], pending: [], timedOut: true }),
      send: async () => "delivered" as const,
      subscribe: () => () => {},
    },
  });
  const streamFn = createFakeStreamFn({
    replies: [
      {
        text: "派两个",
        toolCalls: [
          { name: SPAWN_WORKER_TOOL, args: { role: "explorer", task: "查 A", name: "a" } },
          { name: SPAWN_WORKER_TOOL, args: { role: "explorer", task: "查 B", name: "b" } },
        ],
      },
      { text: "收到" },
    ],
  });
  const bundle = buildRuntime(baseDeps(root, { streamFn, spawnWorker: slot }));
  try {
    const run = await bundle.adapter.run("并行查两件事");
    assert.equal(run.status, "completed");
    const results = bundle.adapter
      .transcript()
      .filter((message) => message.role === "toolResult")
      .map((message) =>
        message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
      );
    assert.deepEqual(results, [
      "已派出 worker a（explorer），分支 pigeon/a。它结束时会有通知；需要结果才能往下做时用 wait_workers 等。",
      "已派出 worker b（explorer），分支 pigeon/b。它结束时会有通知；需要结果才能往下做时用 wait_workers 等。",
    ]);
  } finally {
    await disposeRuntime(bundle);
  }
});
