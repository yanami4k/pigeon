// 编排一段的装配与开关（决策 265、294、297、299、302）：新工具的注册范围（主会话五件积木加 take_worker；层数放开时未到最底层的
// worker 另得五件积木、不得 take_worker）；任务清单工具的开关（缺省开、配置可关、只给主会话、pigeon run 缺省关由入口按配置打开、
// 跑批器各条件都不注册，身份头记关）与增改查、续聊还原；worker 用写层文件工具改自己工作树内的文件默认放行，越出工作树、跑命令仍请示，
// 主会话照旧请示。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { STREAM_SPAWN_WORKERS, STREAM_TASK_LIST } from "../eval/stream-agents.ts";
import { effectivePigeonSettings } from "../eval/stream-experiment.ts";
import { CONDITION_SPECS } from "../eval/stream-runner.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { DEFAULT_ORCHESTRATION_SETTINGS } from "../state/orchestration-config.ts";
import { orchestrationSettingsOf as orchestrationSectionOf } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";
import { orchestrationSettingsOf, parseLaunchFlags } from "./launch-flags.ts";
import { noMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type RuntimeDeps } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import {
  DEFAULT_SPAWN_WORKER_SETTINGS,
  SpawnWorkerSlot,
  spawnWorkerSettingsOf,
} from "./spawn-worker-tool.ts";
import { renderTaskList, TaskList, TaskListError } from "./task-list-tool.ts";

const ORCHESTRATION_TOOLS = [
  "spawn_worker",
  "wait_workers",
  "worker_status",
  "message_worker",
  "stop_worker",
];
const NEW_TOOLS = [...ORCHESTRATION_TOOLS, "take_worker", "update_tasks", "list_tasks"];

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function gitRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pigeon-orch-wiring-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, file), content);
  }
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

test("注册范围：主会话给槽即得五件积木与 take_worker；未到最底层的 worker 另得五件积木、不得 take_worker；缺省层数的 worker 一件都没有", async () => {
  const root = gitRoot();
  const main = await advertised(baseDeps(root, { spawnWorker: new SpawnWorkerSlot() }));
  for (const name of [...ORCHESTRATION_TOOLS, "take_worker"]) {
    assert.ok(main.includes(name), name);
  }
  const workerPolicy = {
    allow: ["read_file", ...ORCHESTRATION_TOOLS],
    deny: [],
    approvalMode: "yolo" as const,
  };
  const nested = await advertised(
    baseDeps(root, {
      toolPolicy: workerPolicy,
      spawnWorker: new SpawnWorkerSlot(
        spawnWorkerSettingsOf({ ...DEFAULT_ORCHESTRATION_SETTINGS, maxDepth: 2 }, 1)
      ),
    })
  );
  assert.deepEqual(
    nested.filter((name) => NEW_TOOLS.includes(name)).sort(),
    [...ORCHESTRATION_TOOLS].sort()
  );
  // 主会话的槽（派出方在第 0 层）给到 worker 身上不算数
  const plain = await advertised(
    baseDeps(root, { toolPolicy: workerPolicy, spawnWorker: new SpawnWorkerSlot() })
  );
  assert.deepEqual(
    plain.filter((name) => NEW_TOOLS.includes(name)),
    []
  );
});

test("任务清单开关：给了才注册、只给主会话；编排配置缺省开、可关；畸形配置响亮失败", async () => {
  const root = gitRoot();
  assert.ok((await advertised(baseDeps(root, { taskList: true }))).includes("update_tasks"));
  assert.ok((await advertised(baseDeps(root, { taskList: true }))).includes("list_tasks"));
  assert.ok(!(await advertised(baseDeps(root))).includes("update_tasks"));
  assert.ok(
    !(
      await advertised(
        baseDeps(root, {
          taskList: true,
          toolPolicy: { allow: ["read_file", "update_tasks"], deny: [], approvalMode: "yolo" },
        })
      )
    ).includes("update_tasks")
  );
  // 决策 325：编排设定是设置的 orchestration 一节（用户级指到空的临时目录）
  const home = mkdtempSync(join(tmpdir(), "pigeon-orch-home-"));
  const loadOrchestration = () => orchestrationSectionOf(loadSettings(root, { homeDir: home }));
  assert.equal(loadOrchestration().taskList, true);
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(
    join(root, ".pigeon", "settings.json"),
    JSON.stringify({
      orchestration: {
        taskList: false,
        maxConcurrent: 3,
        maxDepth: 2,
        worker: { maxTurns: 10, wallClockMinutes: 5 },
        stallMinutes: 2,
        approvalTimeoutMinutes: 1,
      },
    })
  );
  const settings = loadOrchestration();
  assert.deepEqual(settings, {
    maxConcurrent: 3,
    maxDepth: 2,
    workerMaxTurns: 10,
    workerWallClockMs: 300_000,
    stallMs: 120_000,
    approvalTimeoutMs: 60_000,
    taskList: false,
    scriptModelDecides: false,
    scriptStallMs: 600_000,
  });
  // 启动参数优先于配置
  const flags = parseLaunchFlags(["--worker-concurrency", "5"], { usage: "u", spawnWorkers: true });
  assert.equal(
    orchestrationSettingsOf(flags, loadSettings(root, { homeDir: home })).maxConcurrent,
    5
  );
  writeFileSync(
    join(root, ".pigeon", "settings.json"),
    JSON.stringify({ orchestration: { maxConcurrent: 0 } })
  );
  assert.throws(() => loadOrchestration(), /settings\.json（项目共享）/);
  rmSync(home, { recursive: true, force: true });
});

async function headlessTools(
  root: string,
  options: Partial<Parameters<typeof runHeadless>[0]>
): Promise<readonly string[]> {
  let tools: readonly string[] = [];
  await runHeadless({
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

test("实验条件不注册本段新增的任何工具（265）：pigeon run 缺省不带清单、开了才带；跑批器四格一件都没有，身份头记关", async () => {
  const root = gitRoot();
  assert.ok(!(await headlessTools(root, {})).includes("update_tasks"));
  assert.ok((await headlessTools(root, { taskList: true })).includes("update_tasks"));
  const withWorkers = await headlessTools(root, { spawnWorkers: true });
  for (const name of [...ORCHESTRATION_TOOLS, "take_worker"]) {
    assert.ok(withWorkers.includes(name), name);
  }
  for (const spec of Object.values(CONDITION_SPECS).filter((entry) => entry.agent === "pigeon")) {
    const tools = await headlessTools(root, {
      spawnWorkers: STREAM_SPAWN_WORKERS,
      taskList: STREAM_TASK_LIST,
      sessionSearch: spec.sessionSearch,
      pushedMemory: spec.pushedMemory,
      skillRoots: [],
      memoryRoots: [],
    });
    assert.deepEqual(
      tools.filter((name) => NEW_TOOLS.includes(name)),
      [],
      spec.name
    );
  }
  const identity = effectivePigeonSettings({}, "m");
  assert.equal(identity.workerTools, false);
  assert.equal(identity.taskList, false);
  assert.equal(DEFAULT_SPAWN_WORKER_SETTINGS.maxAgentSpawns, undefined);
});

test("任务清单：新建、按 id 更新、查看整份；一批里有不成立的项即整批不改；只记录不调度", () => {
  const list = new TaskList();
  const created = list.update({
    tasks: [{ title: "调查 a" }, { title: "改 a", depends_on: ["1"], worker_label: "T-a" }],
  });
  assert.deepEqual(created, [
    { id: "1", title: "调查 a", status: "pending" },
    { id: "2", title: "改 a", status: "pending", dependsOn: ["1"], workerLabel: "T-a" },
  ]);
  list.update({
    tasks: [
      { id: "1", status: "done" },
      { id: "2", status: "in_progress" },
    ],
  });
  assert.equal(
    renderTaskList(list.items()),
    "1. [完成] 调查 a\n2. [进行中] 改 a（依赖 1）（worker 标签 T-a）"
  );
  assert.throws(
    () =>
      list.update({
        tasks: [
          { id: "2", status: "done" },
          { id: "9", status: "done" },
        ],
      }),
    TaskListError
  );
  assert.throws(() => list.update({ tasks: [{ status: "done" }] }), /新建的项要有标题/);
  assert.equal(list.items()[1]?.status, "in_progress");
  assert.equal(renderTaskList([]), "任务清单是空的。");
});

test("任务清单存进会话：更新随工具结果写进会话文件，续聊时从会话里最后一次更新还原", async () => {
  const root = gitRoot();
  const sessionId = newSessionId();
  const flags = { yolo: true, provider: "fake", modelId: "fake", persistThinking: true };
  const first = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    flags,
    taskList: true,
    startMcp: () => noMcpSession(),
    streamFn: createFakeStreamFn({
      replies: [
        {
          text: "记清单",
          toolCalls: [
            {
              name: "update_tasks",
              args: { tasks: [{ title: "查 a" }, { title: "改 b", status: "in_progress" }] },
            },
          ],
        },
        {
          text: "再改",
          toolCalls: [{ name: "update_tasks", args: { tasks: [{ id: "1", status: "done" }] } }],
        },
        { text: "好" },
      ],
    }),
  });
  await first.bundle.adapter.run("拆一下");
  assert.equal(
    renderTaskList(first.bundle.taskList?.items() ?? []),
    "1. [完成] 查 a\n2. [进行中] 改 b"
  );
  await disposeRuntime(first.bundle);
  const resumed = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    flags,
    taskList: true,
    resume: true,
    startMcp: () => noMcpSession(),
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
  });
  try {
    assert.equal(
      renderTaskList(resumed.bundle.taskList?.items() ?? []),
      "1. [完成] 查 a\n2. [进行中] 改 b"
    );
    // 新建的项接着编号
    assert.equal(resumed.bundle.taskList?.update({ tasks: [{ title: "新" }] }).at(-1)?.id, "3");
  } finally {
    await disposeRuntime(resumed.bundle);
  }
});

test("决策 302：worker 改自己工作树内的文件默认放行；越出工作树、跑命令仍请示；主会话照旧请示", async () => {
  const root = gitRoot({ "a.txt": "a\n" });
  const asked: string[] = [];
  const script = createFakeStreamFn({
    replies: [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      {
        text: "改",
        toolCalls: [
          { name: "edit_file", args: { path: "a.txt", old_string: "a", new_string: "A" } },
        ],
      },
      {
        text: "越界",
        toolCalls: [
          { name: "edit_file", args: { path: "../outside.txt", old_string: "x", new_string: "y" } },
        ],
      },
      { text: "跑", toolCalls: [{ name: "run_command", args: { command: "node -v" } }] },
      { text: "完" },
    ],
  });
  const record = () => async (request: ApprovalRequest) => {
    asked.push(`${request.toolName}:${JSON.stringify(request.args)}`);
    return { approved: false };
  };
  const worker = buildRuntime(
    baseDeps(root, {
      yolo: false,
      streamFn: script,
      toolPolicy: {
        allow: ["read_file", "edit_file", "run_command"],
        deny: [],
        approvalMode: "prompt",
      },
      ownWorkspaceWrites: true,
      createApprovalHandler: record,
    })
  );
  try {
    await worker.adapter.run("改 a");
  } finally {
    await disposeRuntime(worker);
  }
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "A\n");
  assert.deepEqual(asked, [
    'edit_file:{"path":"../outside.txt","old_string":"x","new_string":"y"}',
    'run_command:{"command":"node -v"}',
  ]);
  // 主会话（不带这项放行）：同样的改动要请示
  asked.length = 0;
  writeFileSync(join(root, "a.txt"), "a\n");
  const main = buildRuntime(
    baseDeps(root, {
      yolo: false,
      streamFn: createFakeStreamFn({
        replies: [
          { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
          {
            text: "改",
            toolCalls: [
              { name: "edit_file", args: { path: "a.txt", old_string: "a", new_string: "A" } },
            ],
          },
          { text: "完" },
        ],
      }),
      createApprovalHandler: record,
    })
  );
  try {
    await main.adapter.run("改 a");
  } finally {
    await disposeRuntime(main);
  }
  assert.deepEqual(asked, ['edit_file:{"path":"a.txt","old_string":"a","new_string":"A"}']);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
});
