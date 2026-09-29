// TUI worker 命令（M5.5 S4，决策 040）：/spawn 派出回显与编排面板的一行（决策 301 取代原状态行）、/workers 清单、运行中拒绝 /resume、
// /cancel 走编排面、收尾摘要落消息区、未知命令提示含 worker 命令；壳停止后轮到的审批按拒绝处理。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SpawnRequest, WorkerOutcome, WorkerStatus } from "../application/workers-commands.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { APPROVAL_CANCEL_CLOSED } from "./approval.ts";
import { PigeonTuiShell, type TuiRuntimeFace, type TuiWorkersFace } from "./shell.ts";
import { MockTerminal, screenFlat, settle } from "./testing.ts";

class StubRuntime implements TuiRuntimeFace {
  run(): Promise<RunResult> {
    return Promise.withResolvers<RunResult>().promise;
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  listenerErrors(): unknown[] {
    return [];
  }
  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }
  subscribeStream(_listener: (delta: StreamTextDelta) => void): () => void {
    return () => {};
  }
}

class FakeWorkers implements TuiWorkersFace {
  readonly spawned: SpawnRequest[] = [];
  readonly cancelled: SessionId[] = [];
  readonly entries: WorkerStatus[] = [];
  readonly #results = new Map<SessionId, ReturnType<typeof Promise.withResolvers<WorkerOutcome>>>();

  spawn(request: SpawnRequest): SessionId {
    const sessionId = newSessionId();
    const name = request.name ?? `${request.role}-1`;
    this.spawned.push(request);
    this.entries.push({
      sessionId,
      name,
      role: "implementer",
      state: "running",
      turns: 2,
      branch: `pigeon/${name}`,
      startedAt: 0,
      workspace: { kind: "git-worktree", path: `/wt/${name}`, branch: `pigeon/${name}` },
    });
    this.#results.set(sessionId, Promise.withResolvers<WorkerOutcome>());
    return sessionId;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    this.cancelled.push(sessionId);
  }

  status(): WorkerStatus[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  awaitResult(sessionId: SessionId): Promise<WorkerOutcome> {
    const result = this.#results.get(sessionId);
    return result === undefined ? Promise.reject(new Error("未知 worker")) : result.promise;
  }

  // 决策 279：/take 的取用（文字与 take_worker 同一套）
  readonly taken: string[] = [];
  async take(name: string): Promise<string> {
    this.taken.push(name);
    return `已把 worker ${name} 的改动叠进工作目录。叠入的文件（1）：a.ts。冲突未写入的文件（0）：无。worker 删除的文件（0，未删）：无。`;
  }

  finish(outcome: WorkerOutcome): void {
    const entry = this.entries.find((candidate) => candidate.sessionId === outcome.sessionId);
    if (entry !== undefined) {
      entry.state = outcome.status;
    }
    this.#results.get(outcome.sessionId)?.resolve(outcome);
  }
}

async function submit(term: MockTerminal, text: string): Promise<void> {
  term.input(text);
  term.input("\r");
  await settle();
}

test("TUI worker 命令：派出回显与状态行、清单、运行中拒绝恢复、取消、收尾摘要、未知命令提示", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-workers-"));
  const term = new MockTerminal(140, 50);
  const workers = new FakeWorkers();
  let rebinds = 0;
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new StubRuntime(),
    sessionId: newSessionId(),
    logDir,
    workers,
    workerRefreshMs: 20,
    resume: {
      root: logDir,
      rebind: () => {
        rebinds += 1;
        return { runtime: new StubRuntime() };
      },
    },
  });
  try {
    shell.start();
    await settle();

    await submit(term, '/spawn implementer --name fix-a "修复 a.ts"');
    assert.deepEqual(workers.spawned, [{ role: "implementer", task: "修复 a.ts", name: "fix-a" }]);
    const workerId = workers.entries[0]?.sessionId;
    assert.ok(workerId !== undefined);
    assert.ok(screenFlat(term).includes("已派出 worker fix-a（implementer）"), screenFlat(term));
    assert.match(screenFlat(term), /fix-a\s+running\s+\S+\s+2t\s+\$0\s+starting/);

    await submit(term, "/workers");
    assert.ok(screenFlat(term).includes("workers (1):"), screenFlat(term));
    assert.ok(
      screenFlat(term).includes(`implementer | branch pigeon/fix-a | session ${workerId}`),
      screenFlat(term)
    );

    await submit(term, `/resume ${newSessionId()}`);
    assert.ok(screenFlat(term).includes("有 worker 仍在运行"), screenFlat(term));
    assert.equal(rebinds, 0);

    await submit(term, "/cancel fix-a");
    assert.deepEqual(workers.cancelled, [workerId]);
    assert.ok(
      screenFlat(term).includes("[cancel] worker fix-a interrupt requested"),
      screenFlat(term)
    );

    workers.finish({
      sessionId: workerId,
      name: "fix-a",
      role: "implementer",
      status: "cancelled",
      turns: 2,
      workspace: { kind: "git-worktree", path: "/wt/fix-a", branch: "pigeon/fix-a" },
      result: {
        branch: "pigeon/fix-a",
        changedFiles: ["a.ts"],
        summary: "",
        summaryTruncated: false,
      },
    });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    assert.ok(
      screenFlat(term).includes("== worker fix-a（implementer）收尾：已取消"),
      screenFlat(term)
    );
    assert.ok(screenFlat(term).includes("改动 1 个文件：a.ts"), screenFlat(term));
    assert.match(screenFlat(term), /fix-a\s+cancelled\s+/);

    await submit(term, "/cancel fix-a");
    assert.ok(screenFlat(term).includes("已收尾（已取消），无需取消"), screenFlat(term));

    // 决策 279：/take <名> 取用已收尾 worker 的改动，结果落消息区；没给名字提示用法
    await submit(term, "/take fix-a");
    assert.deepEqual(workers.taken, ["fix-a"]);
    assert.ok(screenFlat(term).includes("已把 worker fix-a 的改动叠进工作目录"), screenFlat(term));
    await submit(term, "/take");
    assert.ok(screenFlat(term).includes("用法：/take <worker 名>"), screenFlat(term));

    await submit(term, "/nope");
    assert.ok(
      screenFlat(term).includes('/spawn <角色> "<任务>"、/cancel <worker>、/workers'),
      screenFlat(term)
    );

    await submit(term, "/spawn");
    assert.ok(screenFlat(term).includes("命令失败：用法：/spawn"), screenFlat(term));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("壳停止后轮到的审批（排队中的 worker 请求）立即按拒绝处理，不渲染到已停界面上吊死", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-workers-"));
  const shell = new PigeonTuiShell({
    terminal: new MockTerminal(80, 24),
    runtime: new StubRuntime(),
    sessionId: newSessionId(),
    logDir,
  });
  try {
    shell.start();
    await settle();
    shell.stop();
    assert.deepEqual(
      await shell.askApproval({
        toolName: "edit_file",
        toolCallId: "tc-1",
        args: { path: "a.ts" },
      }),
      { key: "cancel", reason: APPROVAL_CANCEL_CLOSED }
    );
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
