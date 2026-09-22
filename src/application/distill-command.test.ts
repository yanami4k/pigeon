// pigeon distill（M7 S4，决策 074）：手动提炼。
// - --task <key>：在本治理根里找到派出这组尝试的宿主会话，选对后提炼，记录写回该宿主会话；
// - --eval-results <dir>：只读读取 Eval 结果目录（另一个治理根）下的会话，按任务编号成组；
//   候选暂存到本治理根，记录写进本治理根新建的宿主会话，结果目录一个字节不改；
// - 全成功或全失败的组缺省不提炼并留跳过记录；--force 强制提炼，全失败时只取失败侧、只产出教训。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { createReviewGate } from "../review/scheduler.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { renderDistillReport, runDistillCommand } from "./distill-command.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const HASH = "0".repeat(64);

function distillerFactory(home: string, reply: unknown) {
  return createWorkerRuntimeFactory({
    provider: "fake-provider",
    modelId: "fake-model",
    homeDir: home,
    streamFnFor: () => createFakeStreamFn({ replies: [{ text: JSON.stringify(reply) }] }),
  });
}

// 一次 Eval 尝试：任务消息 + 一条回复 + run.ended + eval.verified
function evalAttempt(
  governanceRoot: string,
  verdict: "pass" | "fail"
): { sessionId: SessionId; runId: RunId } {
  const sessionId = newSessionId();
  const runId = newRunId();
  const log = new JsonlEventLog(join(governanceRoot, ".pigeon", "sessions"), sessionId);
  log.appendEntry({ runSeq: 1, role: "user", runId, message: { role: "user", content: "修 bug" } });
  log.appendEntry({
    runSeq: 2,
    role: "assistant",
    runId,
    message: { role: "assistant", content: [{ type: "text", text: verdict }] },
  });
  const event = (kind: string, payload: unknown) =>
    log.appendRuntimeEvent({
      version: 1,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: Date.now(),
      kind,
      payload,
    } as never);
  event("turn.completed", { stopReason: "stop", syntheticFailure: false });
  event("run.ended", { messageCount: 2 });
  log.appendObservation({
    kind: "eval.verified",
    runId,
    payload: {
      taskId: "fix-a",
      command: ["node", "v.mjs"],
      exitCode: verdict === "pass" ? 0 : 1,
      timedOut: false,
      durationMs: 1,
      outputBytes: 0,
      outputHash: HASH,
      output: "",
      truncated: false,
      verdict,
      assets: [],
      selfReportedDone: true,
      falsePositive: verdict === "fail",
    },
  });
  log.close();
  return { sessionId, runId };
}

function writeResults(dir: string, rows: Array<{ sessionId: string; runId: string }>): void {
  writeFileSync(
    join(dir, "results.jsonl"),
    rows
      .map((row, index) =>
        JSON.stringify({ taskId: "fix-a", condition: "none", run: index + 1, ...row })
      )
      .join("\n")
      .concat("\n")
  );
}

function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(`${full}:${statSync(full).size}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const PROCEDURE = {
  candidates: [
    {
      kind: "skill",
      name: "check-before-done",
      summary: "收工前核对",
      strength: 0.5,
      form: "procedure",
      content: "---\nname: check-before-done\ndescription: 收工前核对\n---\n1. 核对\n",
      evidence: { successful: [2], failed: [2] },
    },
  ],
};

test("--eval-results：按任务编号成组，只读读取结果目录，候选与记录写进本治理根的宿主会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-root-"));
  const evalDir = mkdtempSync(join(tmpdir(), "pigeon-distill-eval-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-distill-home-"));
  try {
    const pass = evalAttempt(evalDir, "pass");
    const fail = evalAttempt(evalDir, "fail");
    writeResults(evalDir, [pass, fail]);
    const before = snapshotTree(evalDir);
    const result = await runDistillCommand({
      root,
      evalResults: evalDir,
      createRuntime: distillerFactory(home, PROCEDURE),
      gate: createReviewGate(),
    });
    assert.deepEqual(snapshotTree(evalDir), before, "结果目录一个字节不改");
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0]?.key, "fix-a");
    assert.equal(result.groups[0]?.distill?.persisted?.written.length, 1);
    const host = materializeSession(join(root, ".pigeon", "sessions"), result.hostSessionId);
    const candidate = host.candidateProposeds[0]?.candidate;
    assert.equal(candidate?.contrast?.successful[0]?.governanceRoot, evalDir);
    assert.equal(candidate?.contrast?.successful[0]?.sessionId, pass.sessionId);
    assert.equal(candidate?.contrast?.failed[0]?.sessionId, fail.sessionId);
    assert.deepEqual(host.unfinishedRuns, []);
    assert.equal(readdirSync(join(root, ".pigeon", "candidates", "skill")).length, 1);
  } finally {
    for (const dir of [root, evalDir, home]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("快照直接放进提炼器的首轮输入（121）：不调任何工具也看得到两侧原文；空结果附理由时照实交回", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-first-"));
  const evalDir = mkdtempSync(join(tmpdir(), "pigeon-distill-eval-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-distill-home-"));
  try {
    const pass = evalAttempt(evalDir, "pass");
    const fail = evalAttempt(evalDir, "fail");
    writeResults(evalDir, [pass, fail]);
    const firstInputs: string[] = [];
    const reply = {
      candidates: [],
      emptyReason: { read: ["successful", "failed"], why: "两侧只差一句回复" },
    };
    const result = await runDistillCommand({
      root,
      evalResults: evalDir,
      createRuntime: createWorkerRuntimeFactory({
        provider: "fake-provider",
        modelId: "fake-model",
        homeDir: home,
        streamFnFor: () => (model, context, options) => {
          firstInputs.push(JSON.stringify(context.messages[0] ?? {}));
          return createFakeStreamFn({ replies: [{ text: JSON.stringify(reply) }] })(
            model,
            context,
            options
          );
        },
      }),
      gate: createReviewGate(),
    });
    // 首轮输入里就有快照：两侧的侧头与各自的原文（pass / fail 两条回复）
    const first = firstInputs[0] ?? "";
    const firstText =
      (JSON.parse(first) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    assert.ok(firstText.includes("修 bug"), "首轮输入里有任务描述");
    assert.match(firstText, /--- 成功侧[^\n]*---\n\[第 2 条 assistant\]\npass/);
    assert.match(firstText, /--- 失败侧[^\n]*---\n\[第 2 条 assistant\]\nfail/);
    const persisted = result.groups[0]?.distill?.persisted;
    assert.equal(persisted?.unparsable, undefined);
    assert.deepEqual(persisted?.emptyReason, reply.emptyReason);
    // 人读报告逐组写出空结果的理由
    assert.match(
      renderDistillReport(result),
      /fix-a ｜ 尝试 [^｜]+｜ 提炼 completed ｜ 候选 0 个 ｜ 空结果（读了 successful、failed）：两侧只差一句回复/
    );
  } finally {
    for (const dir of [root, evalDir, home]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("全失败：缺省不提炼，跳过原因写进命令报告；--force 只取失败侧，只产出教训", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-force-"));
  const evalDir = mkdtempSync(join(tmpdir(), "pigeon-distill-force-eval-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-distill-force-home-"));
  try {
    const first = evalAttempt(evalDir, "fail");
    const second = evalAttempt(evalDir, "fail");
    writeResults(evalDir, [first, second]);
    const skipped = await runDistillCommand({
      root,
      evalResults: evalDir,
      createRuntime: distillerFactory(home, PROCEDURE),
      gate: createReviewGate(),
    });
    assert.equal(skipped.groups[0]?.skip, "all-failed");
    assert.match(renderDistillReport(skipped), /不提炼：all-failed/);
    const skipHost = materializeSession(join(root, ".pigeon", "sessions"), skipped.hostSessionId);
    assert.equal(skipHost.childSpawneds.length, 0);

    const lessonReply = {
      candidates: [
        { ...PROCEDURE.candidates[0], name: "proc-without-success" },
        {
          kind: "skill",
          name: "lesson-from-failures",
          summary: "失败教训",
          strength: 0.4,
          form: "lesson",
          content: "---\nname: lesson-from-failures\ndescription: 教训\n---\n别这样做\n",
          evidence: { failed: [2] },
        },
      ],
    };
    const forced = await runDistillCommand({
      root,
      evalResults: evalDir,
      force: true,
      createRuntime: distillerFactory(home, lessonReply),
      gate: createReviewGate(),
    });
    const persisted = forced.groups[0]?.distill?.persisted;
    assert.equal(persisted?.written.length, 1);
    assert.equal(persisted?.written[0]?.contrast?.form, "lesson");
    assert.equal(persisted?.written[0]?.contrast?.successful.length, 0);
    assert.equal(persisted?.rejected[0]?.name, "proc-without-success");
  } finally {
    for (const dir of [root, evalDir, home]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("--task：在本治理根里找到派出记录带该任务标识的宿主会话，记录写回该会话；找不到时响亮失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-task-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-distill-task-home-"));
  try {
    const pass = evalAttempt(root, "pass");
    const fail = evalAttempt(root, "fail");
    const hostId = newSessionId();
    const hostLog = new JsonlEventLog(join(root, ".pigeon", "sessions"), hostId);
    for (const attempt of [pass, fail]) {
      hostLog.appendChildSpawned({
        childSessionId: attempt.sessionId,
        name: `implementer-${attempt.sessionId.slice(-4).toLowerCase()}`,
        role: "implementer",
        task: "修 bug",
        taskKey: "task_demo",
        policy: { allow: [], deny: [], approvalMode: "yolo" },
        limits: { maxTurns: 1, wallClockMs: 1 },
        workspace: { kind: "git-worktree", path: join(root, "w"), branch: "b" },
        spawnedAt: 1,
      });
    }
    hostLog.close();
    mkdirSync(join(root, "w"), { recursive: true });
    const result = await runDistillCommand({
      root,
      taskKey: "task_demo",
      createRuntime: distillerFactory(home, PROCEDURE),
      gate: createReviewGate(),
    });
    assert.equal(result.hostSessionId, hostId);
    assert.equal(result.groups[0]?.distill?.persisted?.written.length, 1);
    const host = materializeSession(join(root, ".pigeon", "sessions"), hostId);
    assert.equal(host.candidateProposeds.length, 1);
    await assert.rejects(
      () =>
        runDistillCommand({
          root,
          taskKey: "task_missing",
          createRuntime: distillerFactory(home, PROCEDURE),
          gate: createReviewGate(),
        }),
      /找不到/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
