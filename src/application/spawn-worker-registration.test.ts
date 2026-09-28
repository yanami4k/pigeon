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

test("pigeon run：缺省不注册、开了才注册；跑批器各条件（明确关掉）的工具清单都不含 spawn_worker，身份头记关", async () => {
  const root = gitRoot();
  assert.ok(!(await headlessTools(root, {})).includes(SPAWN_WORKER_TOOL));
  assert.ok((await headlessTools(root, { spawnWorkers: true })).includes(SPAWN_WORKER_TOOL));
  const pigeonConditions = Object.values(CONDITION_SPECS).filter((spec) => spec.agent === "pigeon");
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

test("可并行：同一次回复里两次调用 spawn_worker 并行执行（第一个等到第二个派出后才收尾）", async () => {
  const root = gitRoot();
  const spawned: SessionId[] = [];
  const secondSpawned = Promise.withResolvers<void>();
  const outcome = (id: SessionId, name: string, summary: string): WorkerOutcome => ({
    sessionId: id,
    name,
    role: "explorer",
    status: "completed",
    turns: 1,
    result: { branch: `pigeon/${name}`, changedFiles: [], summary, summaryTruncated: false },
    workspace: { kind: "git-worktree", path: join(root, name), branch: `pigeon/${name}` },
  });
  const names = new Map<SessionId, string>();
  const slot = new SpawnWorkerSlot();
  slot.bind({
    governanceRoot: root,
    budget: new SpawnWorkerBudget({ maxAgentSpawns: 16 }),
    spawnAttempts: async () => {
      throw new Error("不派多份");
    },
    orchestrator: {
      spawn: (request) => {
        const id = newSessionId();
        names.set(id, request.name ?? "w");
        spawned.push(id);
        if (spawned.length === 2) {
          secondSpawned.resolve();
        }
        return id;
      },
      awaitResult: async (id) => {
        const name = names.get(id) ?? "w";
        if (id === spawned[0]) {
          // 串行执行时第二个调用要等第一个返回才开始：等不到即判为串行
          const parallel = await Promise.race([
            secondSpawned.promise.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
          ]);
          return outcome(id, name, parallel ? "并行" : "串行");
        }
        return outcome(id, name, "好");
      },
      cancel: async () => {},
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
      "worker a（explorer）已完成。分支：pigeon/a。改动的文件（0）：无。摘要：并行",
      "worker b（explorer）已完成。分支：pigeon/b。改动的文件（0）：无。摘要：好",
    ]);
  } finally {
    await disposeRuntime(bundle);
  }
});
