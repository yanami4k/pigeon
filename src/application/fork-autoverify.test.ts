// 自动验证的内部故障不吞（M8 收口补遗）：并行派发那条路径把它 push 进错误清单，
// 分叉那条此前把整个返回值丢掉，两处口径不一致。现在两处都交出来。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { CANDIDATE_VERSION, type ReviewerCandidate } from "../state/candidate.ts";
import { EVENT_ENVELOPE_VERSION } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { autoVerifyCandidates } from "./auto-verify.ts";
import { distillForkGroup } from "./fork.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

function candidate(): ReviewerCandidate {
  const sessionId = newSessionId();
  return {
    version: CANDIDATE_VERSION,
    origin: "distiller",
    kind: "skill",
    name: "read-before-edit",
    contentHash: "a".repeat(64),
    bytes: 10,
    source: {
      sessionId,
      runId: newRunId(),
      producerSessionId: newSessionId(),
      entryRunSeqs: [1],
      contentDigest: "d".repeat(64),
    },
    summary: "改之前先读",
    strength: 0.6,
    scan: { scannerVersion: "1", hits: [] },
    createdAt: 1,
  };
}

test("自动验证：逐条候选的失败进错误清单，不吞掉也不中断后面的候选", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-autoverify-errors-"));
  try {
    const outcome = await autoVerifyCandidates(
      {
        enabled: true,
        options: {
          governanceRoot: root,
          repoRoot: root,
          verify: { command: "npm test", timeoutMs: 1000 },
          runtimeFactoryFor: () => {
            throw new Error("不该装配运行面");
          },
        },
      },
      // 账本里并没有这两条候选：验证会在检索阶段失败，正好用来看故障有没有被交出来
      { written: [candidate(), candidate()], duplicates: 0, rejected: [] }
    );
    assert.equal(outcome.records.length, 0);
    assert.equal(outcome.errors.length, 2, "两条候选各自的失败都要在清单里");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("自动验证：开关关着时不跑也不报错", async () => {
  const outcome = await autoVerifyCandidates(undefined, {
    written: [candidate()],
    duplicates: 0,
    rejected: [],
  });
  assert.deepEqual(outcome.records, []);
  assert.deepEqual(outcome.errors, []);
});

test("分叉提炼：返回值带错误清单——调用方有东西可收", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-fork-errors-"));
  try {
    // 没有分支时走 no-contrast 早返回：形状里同样要有错误清单，调用方不必判空
    const result = await distillForkGroup({
      governanceRoot: root,
      sourceSessionId: newSessionId(),
      forkPoint: { runId: newRunId(), runSeq: 1 },
      distill: {
        createRuntime: () => {
          throw new Error("不该派提炼器");
        },
      },
    });
    assert.equal(result.skip, "no-contrast");
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const DISTILLED = JSON.stringify({
  candidates: [
    {
      kind: "skill",
      name: "write-exact-content",
      summary: "按要求逐字写入内容",
      strength: 0.6,
      form: "procedure",
      content:
        "---\nname: write-exact-content\ndescription: 按要求逐字写入\n---\n1. 写入前核对目标文本\n",
      evidence: { successful: [2], failed: [2] },
    },
  ],
});

test("分叉提炼：真实选对并落库后，自动验证的故障随返回值交给调用方", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-fork-auto-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-auto-home-"));
  try {
    const dir = join(root, ".pigeon", "sessions");
    const sourceId = newSessionId();
    const runId = newRunId();
    const forkPoint = { runId, runSeq: 1 };
    const checkpoint = { ref: `refs/pigeon/checkpoints/${sourceId}/1`, commit: "a".repeat(40) };
    const passed = newSessionId();
    const failed = newSessionId();

    const sourceLog = new JsonlEventLog(dir, sourceId);
    for (const branchSessionId of [passed, failed]) {
      sourceLog.appendSessionForked({
        runId,
        forkPoint,
        branchSessionId,
        checkpoint,
        trigger: "retry-on-fail",
        forkedAt: 1,
      });
    }
    // 两条分支：一条验证通过、一条验证失败，凑齐选对需要的两侧
    for (const [branchSessionId, verdict] of [
      [passed, "pass"],
      [failed, "fail"],
    ] as const) {
      const branchLog = new JsonlEventLog(dir, branchSessionId);
      branchLog.appendBranchHeader({
        sourceSessionId: sourceId,
        forkPoint,
        checkpoint,
        workspace: { kind: "git-worktree", path: join(root, "w"), branch: "b" },
        trigger: "retry-on-fail",
        startedAt: 2,
      });
      branchLog.appendRuntimeEvent({
        version: EVENT_ENVELOPE_VERSION,
        id: newEntryId(),
        sessionId: branchSessionId,
        runId,
        timestamp: 3,
        kind: "run.ended",
        payload: { messageCount: 3 },
      });
      branchLog.appendAttemptVerified({
        target: { sessionId: branchSessionId, runId },
        command: ["node", "check.mjs"],
        exitCode: verdict === "pass" ? 0 : 1,
        timedOut: false,
        durationMs: 5,
        outputBytes: 2,
        outputHash: "0".repeat(64),
        output: "ok",
        truncated: false,
        workspace: root,
        verdict,
        verifiedAt: 4,
      });
      branchLog.close();
    }

    const result = await distillForkGroup({
      governanceRoot: root,
      sourceSessionId: sourceId,
      sourceLog,
      forkPoint,
      distill: {
        createRuntime: createWorkerRuntimeFactory({
          provider: "fake-provider",
          modelId: "fake-model",
          homeDir: home,
          streamFnFor: () => createFakeStreamFn({ replies: [{ text: DISTILLED }] }),
        }),
        autoVerify: {
          enabled: true,
          options: {
            governanceRoot: root,
            repoRoot: root,
            verify: { command: "npm test", timeoutMs: 1000 },
            // 验证走不到运行面就会失败；要看的是这个故障有没有被交出来
            runtimeFactoryFor: () => {
              throw new Error("不装配验证运行面");
            },
          },
        },
      },
    });
    sourceLog.close();

    assert.equal(result.skip, undefined, "一成一败应当选出对比对");
    assert.equal(result.distill?.persisted?.written.length, 1, "提炼器的候选要落库");
    assert.equal(
      result.errors.length,
      1,
      "落库候选的自动验证故障要随返回值交出来，不能在分叉这条路径上被丢掉"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
