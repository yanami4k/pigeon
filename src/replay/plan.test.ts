// 回放计划解析（M8 S3，决策 082 / 087）：被验证那次尝试的任务、起点、预算与模型。
// 预算与模型拿不到就响亮失败——回放沿用它们且不得放宽，猜一个就等于放宽。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import type { ObservationInput } from "../state/event-log.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { AttemptPlanError, resolveAttemptPlan } from "./plan.ts";

const MODEL = { provider: "anthropic", id: "claude-x", thinkingLevel: "off" as const };
const LIMITS = { maxTurns: 7, wallClockMs: 60_000, maxTokens: 9000 };
const BASE_COMMIT = "a".repeat(40);

type RunStartedPayload = Extract<ObservationInput, { kind: "run.started" }>["payload"];

function runStartedPayload(extra: Partial<RunStartedPayload> = {}): RunStartedPayload {
  return {
    model: { ...MODEL },
    policy: { allow: ["read_file"], deny: [], approvalMode: "yolo" },
    advertisedTools: ["read_file"],
    systemPromptHash: "b".repeat(64),
    memory: [],
    skills: [],
    ...extra,
  };
}

// 并行同任务派发的一次尝试：父会话记派出，worker 会话记会话头与 run.started
function workerAttempt(
  dir: string,
  options: { baseCommit?: string; budget?: boolean } = {}
): {
  sessionId: SessionId;
  runId: RunId;
  parentSessionId: SessionId;
} {
  const parentSessionId = newSessionId();
  const sessionId = newSessionId();
  const runId = newRunId();
  const workspace = {
    kind: "git-worktree" as const,
    path: join(dir, "wt"),
    branch: "pigeon/impl-1",
    ...(options.baseCommit !== undefined ? { baseCommit: options.baseCommit } : {}),
  };
  const parent = new JsonlEventLog(dir, parentSessionId);
  parent.appendChildSpawned({
    childSessionId: sessionId,
    name: "impl-1",
    role: "implementer",
    task: "修好 parse 的边界",
    policy: { allow: ["read_file"], deny: [], approvalMode: "yolo" },
    limits: LIMITS,
    workspace,
    spawnedAt: 1,
  });
  parent.close();
  const child = new JsonlEventLog(dir, sessionId);
  child.appendSessionHeader({
    parentSessionId,
    worker: { name: "impl-1", role: "implementer" },
    workspace,
    startedAt: 1,
  });
  child.appendObservation({
    kind: "run.started",
    runId,
    payload: runStartedPayload(options.budget === true ? { budget: LIMITS } : {}),
  });
  child.appendEntry({ runId, runSeq: 1, role: "user", message: { role: "user", content: "无关" } });
  child.close();
  return { sessionId, runId, parentSessionId };
}

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-rerun-plan-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("计划：worker 尝试的任务取派出记录，起点取工作树的起点提交，预算取冻结快照", () => {
  withDir((dir) => {
    const attempt = workerAttempt(dir, { baseCommit: BASE_COMMIT, budget: true });
    const plan = resolveAttemptPlan({ sessionsDir: dir, ...attempt });
    assert.equal(plan.task, "修好 parse 的边界");
    assert.equal(plan.startCommit, BASE_COMMIT);
    assert.equal(plan.startSource, "worker-base");
    assert.deepEqual(plan.budget, LIMITS);
    assert.equal(plan.model.provider, "anthropic");
    assert.equal(plan.model.id, "claude-x");
    assert.equal(plan.approvalMode, "yolo");
  });
});

test("计划：run.started 没记预算时回退到派出记录的上限（M8 之前的旧尝试）", () => {
  withDir((dir) => {
    const attempt = workerAttempt(dir, { baseCommit: BASE_COMMIT });
    const plan = resolveAttemptPlan({ sessionsDir: dir, ...attempt });
    assert.deepEqual(plan.budget, LIMITS);
    assert.equal(plan.budgetSource, "child-spawned");
  });
});

test("计划：工作树没记起点提交时回退到分支尖端，并如实标注来源", () => {
  withDir((dir) => {
    const attempt = workerAttempt(dir, { budget: true });
    const plan = resolveAttemptPlan({
      sessionsDir: dir,
      ...attempt,
      resolveBranchTip: (branch) => (branch === "pigeon/impl-1" ? "c".repeat(40) : undefined),
    });
    assert.equal(plan.startCommit, "c".repeat(40));
    assert.equal(plan.startSource, "worker-branch-tip");
  });
});

test("计划：拿不到起点提交就拒绝回放，不拿现状凑合", () => {
  withDir((dir) => {
    const attempt = workerAttempt(dir, { budget: true });
    assert.throws(
      () => resolveAttemptPlan({ sessionsDir: dir, ...attempt }),
      (error: unknown) => error instanceof AttemptPlanError && /起点/.test(String(error))
    );
  });
});

test("计划：拿不到预算就拒绝回放——猜一个就等于放宽", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    log.appendObservation({ kind: "run.started", runId, payload: runStartedPayload() });
    log.appendEntry({
      runId,
      runSeq: 1,
      role: "user",
      message: { role: "user", content: "任务正文" },
    });
    log.close();
    assert.throws(
      () => resolveAttemptPlan({ sessionsDir: dir, sessionId, runId, startCommit: BASE_COMMIT }),
      (error: unknown) => error instanceof AttemptPlanError && /预算/.test(String(error))
    );
  });
});

test("计划：普通会话的任务取该 Run 第一条用户消息的正文", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const runId = newRunId();
    const log = new JsonlEventLog(dir, sessionId);
    log.appendObservation({
      kind: "run.started",
      runId,
      payload: runStartedPayload({ budget: { maxTurns: 5 } }),
    });
    log.appendEntry({
      runId,
      runSeq: 1,
      role: "user",
      message: { role: "user", content: "任务正文" },
    });
    log.appendEntry({
      runId,
      runSeq: 2,
      role: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
    });
    log.close();
    const plan = resolveAttemptPlan({
      sessionsDir: dir,
      sessionId,
      runId,
      startCommit: BASE_COMMIT,
    });
    assert.equal(plan.task, "任务正文");
    assert.deepEqual(plan.budget, { maxTurns: 5 });
    assert.equal(plan.startSource, "given");
  });
});

test("计划：找不到这次 Run 的启动快照即拒绝——模型标识不猜", () => {
  withDir((dir) => {
    const sessionId = newSessionId();
    const log = new JsonlEventLog(dir, sessionId);
    log.close();
    assert.throws(
      () => resolveAttemptPlan({ sessionsDir: dir, sessionId, runId: newRunId() }),
      AttemptPlanError
    );
  });
});
