// 续接时找回之前运行的 worker（会话权威链审计 ②、③）：真实 git 仓库、真实编排器与工作树、假模型。
// 第一次运行：主 agent 用 spawn_worker 派出 w1，w1 改了 b.txt 后收尾；它的完成通知还在内存队列里时运行面释放（模拟进程退出）；
// 另记一个只有派出、没有收尾的 worker half。续接后：w1 的状态标明来自之前的运行、take_worker 取用成功；half 标为中断、
// 不可取用；对之前运行的 worker 发取消、发消息、补批续做给出明确说明；没递出的完成通知补递一条、只发一次。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { createFakeStreamFn, type FakeStreamBehavior } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { DEFAULT_ORCHESTRATION_SETTINGS } from "../state/orchestration-config.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { noMcpSession } from "./mcp.ts";
import {
  previousWorkersOf,
  REDELIVERED_NOTICE_LEAD,
  restoreSessionWorkers,
  undeliveredWorkerOutcomes,
} from "./previous-workers.ts";
import { disposeRuntime } from "./runtime.ts";
import { type OpenedSessionRuntime, openSessionRuntime } from "./session-runtime.ts";
import { childFamilySink } from "./session-store.ts";
import { bindSpawnWorkers } from "./spawn-worker-host.ts";
import { SpawnWorkerSlot, spawnWorkerSettingsOf } from "./spawn-worker-tool.ts";
import { isStatusText } from "./status-fixtures.ts";
import { TAKE_WORKER_TEXTS, takeWorkerChanges } from "./take-worker-tool.ts";
import type { WorkerNotices } from "./worker-notices.ts";
import { createSessionWorkers } from "./workers.ts";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repo(): { root: string; home: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-prev-workers-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-prev-workers-home-"));
  made.push(root, home);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return { root, home };
}

// 按会话的第一条人输入的用户消息分派剧本：主会话与 worker 各走各的回复队列
function firstUserText(context: Parameters<StreamFn>[1]): string {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type: string; text?: string }>)
              .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
              .join("")
          : "";
    // 决策 363：开工状态块不是会话的第一条输入
    if (!isStatusText(text)) return text;
  }
  return "";
}

function routed(scripts: Array<[marker: string, behavior: FakeStreamBehavior]>): StreamFn {
  const fns = scripts.map(([marker, behavior]) => [marker, createFakeStreamFn(behavior)] as const);
  return ((model, context, options) => {
    const text = firstUserText(context);
    const match = fns.find(([marker]) => text.includes(marker));
    if (match === undefined) throw new Error(`没有剧本：${text}`);
    return match[1](model, context, options);
  }) as StreamFn;
}

const FLAGS = { yolo: true, provider: "fake", modelId: "fake", persistThinking: true };

interface Main {
  opened: OpenedSessionRuntime;
  orchestrator: WorkerOrchestrator;
  notices: WorkerNotices | undefined;
}

// 照终端界面主会话的装配：带派 worker 的工具槽，编排器绑到槽上，完成通知进主 agent 的下一轮
async function openMain(
  root: string,
  home: string,
  sessionId: SessionId,
  streamFn: StreamFn,
  resume: boolean
): Promise<Main> {
  const settings = spawnWorkerSettingsOf(DEFAULT_ORCHESTRATION_SETTINGS);
  const opened = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn,
    flags: FLAGS,
    homeDir: home,
    startMcp: () => noMcpSession(),
    spawnWorker: new SpawnWorkerSlot(settings),
    ...(resume ? { resume: true } : {}),
  });
  const orchestrator = createSessionWorkers({
    governanceRoot: root,
    workspaceRoot: root,
    bundle: opened.bundle,
    approvals: async () => ({ approved: true }),
    streamFn,
    provider: "fake",
    modelId: "fake",
    homeDir: home,
  });
  assert.ok(opened.spawnWorker !== undefined);
  const bound = bindSpawnWorkers({
    slot: opened.spawnWorker,
    orchestrator,
    workspaceRoot: root,
    hostSessionId: opened.bundle.adapter.sessionId,
    target: opened.bundle.adapter,
  });
  return { opened, orchestrator, notices: bound.notices };
}

test("续接：之前的运行收尾未取用的 worker 照常可取，中断的不可取用；取消、发消息、补批续做给出明确说明；没递出的通知补递一次", async () => {
  const { root, home } = repo();
  const sessionId = newSessionId();
  const streamFn = routed([
    [
      "MAIN",
      {
        replies: [
          {
            text: "派",
            toolCalls: [
              {
                name: "spawn_worker",
                args: { role: "implementer", task: "WORKER 改 b", name: "w1" },
              },
            ],
          },
          { text: "等通知" },
          { text: "收到通知" },
        ],
      },
    ],
    [
      "WORKER",
      {
        replies: [
          {
            text: "改",
            toolCalls: [
              { name: "edit_file", args: { path: "b.txt", old_string: "b", new_string: "worker" } },
            ],
          },
          { text: "改好了" },
        ],
      },
    ],
  ]);
  // ---- 第一次运行 ----
  const first = await openMain(root, home, sessionId, streamFn, false);
  let w1: SessionId | undefined;
  try {
    const run = await first.opened.bundle.adapter.run("MAIN 派个 worker");
    assert.equal(run.status, "completed", JSON.stringify(run.errorMessage));
    w1 = first.orchestrator.status().find((worker) => worker.name === "w1")?.sessionId;
    assert.ok(w1 !== undefined);
    const outcome = await first.orchestrator.awaitResult(w1);
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    // 完成通知已入队、还没递出
    assert.equal(first.opened.bundle.adapter.pendingNotices(), 1);
    // 另记一个只有派出、没有收尾的 worker（进程中途退出的情形）
    const ws = outcome.workspace;
    assert.equal(ws.kind, "git-worktree");
    childFamilySink(first.opened.bundle.sessionStore).appendChildSpawned({
      childSessionId: newSessionId(),
      name: "half",
      role: "implementer",
      task: "WORKER 半截",
      policy: { allow: [], deny: [], approvalMode: "yolo" },
      limits: { maxTurns: 1, wallClockMs: 1000 },
      workspace: {
        kind: "git-worktree",
        path: join(root, ".pigeon", "state", "worktrees", "half"),
        branch: "pigeon/half",
        ...(ws.kind === "git-worktree" && ws.baseCommit !== undefined
          ? { baseCommit: ws.baseCommit }
          : {}),
      },
      spawnedAt: Date.now(),
    });
  } finally {
    // 释放即"进程退出"：内存里的通知随之丢失
    await disposeRuntime(first.opened.bundle);
  }
  // ---- 续接 ----
  const second = await openMain(root, home, sessionId, streamFn, true);
  try {
    const result = restoreSessionWorkers({
      orchestrator: second.orchestrator,
      governanceRoot: root,
      sessionId,
      ...(second.notices !== undefined ? { notices: second.notices } : {}),
    });
    assert.deepEqual(result, { restored: 2, redelivered: 1 });
    const statuses = second.orchestrator.status();
    assert.deepEqual(
      statuses.map((worker) => [worker.name, worker.state, worker.previousRun, worker.origin]),
      [
        ["w1", "completed", "settled", "agent"],
        ["half", "aborted", "interrupted", "human"],
      ]
    );
    // 已收尾的：take_worker 取用成功
    const taken = takeWorkerChanges(
      { orchestrator: second.orchestrator, workspaceRoot: root },
      "w1"
    );
    assert.ok(
      taken.text.startsWith("已把 worker w1 的改动叠进工作目录。叠入的文件（1）：b.txt。"),
      taken.text
    );
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "worker\n");
    // 中断的：不可取用
    const half = takeWorkerChanges(
      { orchestrator: second.orchestrator, workspaceRoot: root },
      "half"
    );
    assert.equal(half.text, TAKE_WORKER_TEXTS.interrupted("half"));
    assert.equal(half.details.rejected, "interrupted");
    const halfId = statuses.find((worker) => worker.name === "half")?.sessionId as SessionId;
    await assert.rejects(
      second.orchestrator.cancel(halfId),
      /是之前的运行派出的，随上次进程退出而中断/
    );
    assert.throws(() => second.orchestrator.send(w1 as SessionId, "x"), /收不到消息/);
    assert.throws(() => second.orchestrator.resume(w1 as SessionId), /续接后不能对它补批续做/);
    // 补递的通知：带会话号，进下一次运行
    assert.equal(second.opened.bundle.adapter.pendingNotices(), 1);
    const delivered = await second.opened.bundle.adapter.runNotices();
    assert.equal(delivered.status, "completed", JSON.stringify(delivered.errorMessage));
  } finally {
    await disposeRuntime(second.opened.bundle);
  }
  const view = loadSessionView(sessionsDirOf(root), sessionId);
  assert.ok(view !== undefined);
  const notices = view.messages.filter(
    (message) =>
      message.role === "user" &&
      JSON.stringify(message.raw.content).includes(`（worker 会话 ${w1}）`)
  );
  assert.equal(notices.length, 1);
  assert.ok(JSON.stringify(notices[0]?.raw.content).includes(REDELIVERED_NOTICE_LEAD));
  // ---- 再续接：已递出的不重复 ----
  const third = await openMain(root, home, sessionId, streamFn, true);
  try {
    const again = restoreSessionWorkers({
      orchestrator: third.orchestrator,
      governanceRoot: root,
      sessionId,
      ...(third.notices !== undefined ? { notices: third.notices } : {}),
    });
    assert.deepEqual(again, { restored: 2, redelivered: 0 });
    assert.equal(third.opened.bundle.adapter.pendingNotices(), 0);
  } finally {
    await disposeRuntime(third.opened.bundle);
  }
});

test("补递的判定：等待工具已交回结果的、人派的、中断的都不补递", async () => {
  const { root, home } = repo();
  const sessionId = newSessionId();
  const streamFn = routed([
    [
      "MAIN",
      {
        replies: [
          {
            text: "派",
            toolCalls: [
              {
                name: "spawn_worker",
                args: { role: "explorer", task: "WORKER 看看", name: "waited" },
              },
            ],
          },
          { text: "等", toolCalls: [{ name: "wait_workers", args: { workers: ["waited"] } }] },
          { text: "看到了" },
        ],
      },
    ],
    ["WORKER", { replies: [{ text: "看完了" }] }],
  ]);
  const first = await openMain(root, home, sessionId, streamFn, false);
  try {
    const run = await first.opened.bundle.adapter.run("MAIN 派了等");
    assert.equal(run.status, "completed", JSON.stringify(run.errorMessage));
    // 人派的：不发通知，也不补递
    const human = first.orchestrator.spawn({
      role: "explorer",
      task: "WORKER 人派",
      name: "by-human",
      origin: "human",
    });
    await first.orchestrator.awaitResult(human);
    assert.equal(first.opened.bundle.adapter.pendingNotices(), 0);
  } finally {
    await disposeRuntime(first.opened.bundle);
  }
  const view = loadSessionView(sessionsDirOf(root), sessionId);
  assert.ok(view !== undefined);
  const previous = previousWorkersOf(view);
  assert.deepEqual(
    previous.map((worker) => [worker.name, worker.origin, worker.previousRun]),
    [
      ["waited", "agent", "settled"],
      ["by-human", "human", "settled"],
    ]
  );
  assert.deepEqual(undeliveredWorkerOutcomes(view, previous), []);
});
