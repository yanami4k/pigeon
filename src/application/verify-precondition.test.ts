// pigeon verify 的前置校验（M8 收口补遗）：每组次数的下限要在跑任何一次回放之前就判。
// 否则 `--n 2` 会先真跑四组共 8 次重执行（几十分钟加模型花费），才在判定阶段报错，而且不落任何回执。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { acquireExclusiveLock, ExclusiveLockError } from "../persistence/exclusive-lock.ts";
import { MIN_RERUN_N, RerunCountError } from "../replay/verdict.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { verifyCandidate, verifyLockPath } from "./verify-command.ts";
import { sessionsDirOf } from "./workspace.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-verify-precondition-"));
}

const options = (governanceRoot: string, n: number) =>
  ({
    governanceRoot,
    repoRoot: governanceRoot,
    selector: "0".repeat(64),
    verify: { command: "npm test", timeoutMs: 1000 },
    n,
    runtimeFactoryFor: () => {
      throw new Error("不该装配任何回放运行面");
    },
  }) as const;

test("前置：每组次数低于下限时，在定位候选之前就拒绝", async () => {
  const dir = root();
  try {
    // 选择器指向一个不存在的候选：若次数校验没有前置，先报的会是"没有匹配的候选"
    await assert.rejects(
      () => verifyCandidate(options(dir, MIN_RERUN_N - 1)),
      (error: unknown) => error instanceof RerunCountError
    );
    await assert.rejects(
      () => verifyCandidate(options(dir, 0)),
      (error: unknown) => error instanceof RerunCountError
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("前置：次数合法时才继续往下走（此处因候选不存在而止于检索）", async () => {
  const dir = root();
  try {
    await assert.rejects(
      () => verifyCandidate(options(dir, MIN_RERUN_N)),
      (error: unknown) =>
        !(error instanceof RerunCountError) && /没有匹配的候选/.test(String(error))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// M8 收口补遗：同一条候选同一时刻只许一次验证。人工触发与无人值守自动验证可能同时跑同一条候选，
// 四组工作树名只由候选哈希、组别与序号决定，撞车会同时毁掉两次验证的工作树，还会落两条回执
test("互斥：同一条候选已有一次验证在跑时，第二次直接被拒，不开任何工作树", async () => {
  const dir = root();
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const candidate = stageCandidate({
      governanceRoot: dir,
      kind: "skill",
      name: "read-before-edit",
      content: "# 先读后改",
      build: (facts) => ({
        version: CANDIDATE_VERSION,
        origin: "distiller",
        kind: "skill",
        name: "read-before-edit",
        contentHash: facts.contentHash,
        bytes: facts.bytes,
        source: {
          sessionId,
          runId,
          producerSessionId: newSessionId(),
          entryRunSeqs: [1],
          contentDigest: "d".repeat(64),
        },
        summary: "改之前先读",
        strength: 0.6,
        scan: facts.scan,
        createdAt: 1,
      }),
    });
    if (candidate === undefined) {
      throw new Error("候选落盘失败");
    }
    const log = new JsonlEventLog(sessionsDirOf(dir), sessionId);
    log.appendCandidateProposed({ runId, candidate, model: { provider: "p", id: "m" } });
    log.appendCandidateScreened({
      runId,
      candidateKind: "skill",
      name: "read-before-edit",
      contentHash: candidate.contentHash,
      scannerVersion: candidate.scan.scannerVersion,
      hits: [],
    });
    log.close();

    const release = acquireExclusiveLock(
      verifyLockPath(dir, candidate.contentHash),
      "夹具占位：另一次验证在跑"
    );
    try {
      await assert.rejects(
        () =>
          verifyCandidate({
            ...options(dir, MIN_RERUN_N),
            selector: candidate.contentHash,
          }),
        // 抛的必须是锁错误而不是别的前置错误：取锁排在"有没有对比来源块"这一关之前，
        // 而那一关又排在开任何工作树之前——拒绝停在锁这一层，就意味着一个工作树都没开
        (error: unknown) => error instanceof ExclusiveLockError
      );
    } finally {
      release();
    }
    // 锁放开后不再被挡（此处因候选没有对比来源块而止于前置）
    await assert.rejects(
      () => verifyCandidate({ ...options(dir, MIN_RERUN_N), selector: candidate.contentHash }),
      (error: unknown) =>
        !(error instanceof ExclusiveLockError) && /没有对比来源块/.test(String(error))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
