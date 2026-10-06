// spawn_worker 的工具清单与作用范围（决策 360）：参数原样交给编排器、写进 worker 的委派策略；不合要求即不派出并退还额度；
// 说明里提到的工具按主 agent 当前已注册的工具生成。编排器用真实实现，运行面与工作区用内存替身。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { WorkerOrchestrator, type WorkerRuntimeRequest } from "../orchestration/workers.ts";
import { newSessionId } from "../state/ids.ts";
import {
  createSpawnWorkerTool,
  DEFAULT_SPAWN_WORKER_SETTINGS,
  SpawnWorkerBudget,
  type SpawnWorkerDetails,
  SpawnWorkerSlot,
  spawnWorkerDescription,
} from "./spawn-worker-tool.ts";

const root = mkdtempSync(join(tmpdir(), "pigeon-spawn-scopes-"));
execFileSync("git", ["init", "-q"], { cwd: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const requests: WorkerRuntimeRequest[] = [];
  const orchestrator = new WorkerOrchestrator({
    governanceRoot: root,
    session: { sessionId: newSessionId() },
    parentPolicy: {
      allow: ["read_file", "edit_file", "run_command", "update_memory"],
      deny: [],
      approvalMode: "yolo",
    },
    parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
    createRuntime: (request) => {
      requests.push(request);
      return {
        run: async () => ({ status: "completed" }),
        interrupt: async () => {},
        subscribe: () => () => {},
        summary: () => "",
        dispose: async () => {},
      };
    },
    approvals: async () => ({ approved: true }),
    workspaces: {
      plan: ({ name }) => ({
        kind: "git-worktree",
        path: join(root, name),
        branch: `pigeon/${name}`,
      }),
      create: () => {},
      changedFiles: () => [],
    },
  });
  const budget = new SpawnWorkerBudget({ maxAgentSpawns: 1 });
  const slot = new SpawnWorkerSlot({ ...DEFAULT_SPAWN_WORKER_SETTINGS, maxAgentSpawns: 1 });
  slot.bind({
    orchestrator,
    workspaceRoot: root,
    budget,
    spawnAttempts: async () => {
      throw new Error("本用例不派多份尝试");
    },
  });
  return { requests, tool: createSpawnWorkerTool(slot) };
}

test("工具清单与作用范围写进 worker 的委派策略；不合要求不派出、退还额度，之后照常能派", async () => {
  const { requests, tool } = setup();
  const rejected = await tool.execute("c1", {
    role: "tester",
    task: "跑测试",
    tools: ["read_file", "update_memory"],
  });
  assert.equal((rejected.details as SpawnWorkerDetails).rejected, "bad-tools");
  assert.equal(requests.length, 0);
  const spawned = await tool.execute("c2", {
    role: "tester",
    task: "跑测试",
    tools: ["read_file", "run_command"],
    scopes: [
      { tool: "read_file", paths: ["src/"] },
      { tool: "run_command", commandPrefixes: ["npm test"] },
    ],
  });
  assert.equal((spawned.details as SpawnWorkerDetails).sessionIds.length, 1);
  assert.deepEqual(requests[0]?.policy, {
    allow: ["read_file", "run_command"],
    deny: [],
    approvalMode: "yolo",
    scopes: [
      { tool: "read_file", paths: ["src"] },
      { tool: "run_command", commandPrefixes: ["npm test"] },
    ],
  });
});

test("说明按主 agent 现有的工具生成：没有的工具不提，有没有会话检索工具说明不同", () => {
  const base = ["read_file", "edit_file"];
  const text = spawnWorkerDescription(DEFAULT_SPAWN_WORKER_SETTINGS, base);
  for (const present of ["tools", "scopes", "read_file", "edit_file"]) {
    assert.ok(text.includes(present), present);
  }
  for (const absent of ["web_search", "web_fetch", "run_command"]) {
    assert.ok(!text.includes(absent), absent);
  }
  const withSessions = spawnWorkerDescription(DEFAULT_SPAWN_WORKER_SETTINGS, [
    ...base,
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
    LIST_SESSIONS_TOOL,
  ]);
  assert.notEqual(withSessions, text);
});
