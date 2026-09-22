// 提炼候选落盘（M7 S4，决策 074 / 075）：候选走 M6 的暂存、扫描与账本链路，元数据为 v3 并带对比来源块。
// 产出规则：失败侧只产出教训（lesson），且不写成长期事实（不产出 memory）；流程与步骤集必须有成功侧证据。
// 违反规则的条目丢弃并留一条不可解析记录说明原因；整体不合格式时只留痕、不落文件。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { DistillTarget } from "../state/distill.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { persistDistillerCandidates } from "./candidates.ts";

function attempt(root: string, texts: string[]): { sessionId: SessionId; runId: RunId } {
  const sessionId = newSessionId();
  const runId = newRunId();
  const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), sessionId);
  for (const [index, text] of texts.entries()) {
    log.appendEntry({
      runSeq: index + 1,
      role: index === 0 ? "user" : "assistant",
      runId,
      message:
        index === 0
          ? { role: "user", content: text }
          : { role: "assistant", content: [{ type: "text", text }] },
    });
  }
  log.close();
  return { sessionId, runId };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-distill-cand-"));
  const ok = attempt(root, ["任务", "先跑测试", "改", "再跑测试"]);
  const bad = attempt(root, ["任务", "直接改", "没跑测试就收工"]);
  const host = newSessionId();
  const target: DistillTarget = {
    kind: "task",
    taskKey: "task_01",
    task: { governanceRoot: root, ...ok },
    successful: {
      governanceRoot: root,
      ...ok,
      from: 1,
      to: 4,
      label: "Passed",
      verification: { sessionId: host, recordId: newEntryId() },
    },
    failed: { governanceRoot: root, ...bad, from: 1, to: 3, label: "Failed" },
    others: [
      {
        governanceRoot: root,
        sessionId: newSessionId(),
        runId: newRunId(),
        entryRange: { from: 1, to: 2 },
        label: "Abandoned",
      },
    ],
  };
  return { root, ok, bad, host, target };
}

const item = (overrides: Record<string, unknown>) => ({
  kind: "skill",
  name: "run-tests-before-done",
  summary: "收工前先跑测试",
  strength: 0.7,
  form: "procedure",
  content: "---\nname: run-tests-before-done\ndescription: 收工前先跑测试\n---\n1. 改完先跑测试\n",
  evidence: { successful: [2, 4], failed: [3] },
  ...overrides,
});

test("合法结果：步骤集取成功侧为来源、教训取失败侧为来源，v3 元数据带对比来源块，提出与筛查两族落在宿主会话", () => {
  const { root, ok, bad, host, target } = setup();
  try {
    const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), host);
    const distillSessionId = newSessionId();
    const result = persistDistillerCandidates({
      governanceRoot: root,
      sink: log,
      target,
      distillSessionId,
      structured: {
        candidates: [
          item({}),
          item({
            name: "no-done-without-tests",
            form: "lesson",
            summary: "没跑测试不要收工",
            content:
              "---\nname: no-done-without-tests\ndescription: 教训\n---\n没跑测试就收工会漏掉回归\n",
            evidence: { failed: [3] },
          }),
        ],
      },
      model: { provider: "p", id: "m" },
      usage: { turns: 2, totalTokens: 10 },
      hostRunId: bad.runId,
    });
    log.close();
    assert.equal(result.written.length, 2);
    const [procedure, lesson] = result.written;
    assert.equal(procedure?.version, 3);
    assert.equal(procedure?.origin, "distiller");
    assert.equal(procedure?.source.sessionId, ok.sessionId, "步骤集以成功侧为主证据");
    assert.deepEqual(procedure?.source.entryRunSeqs, [2, 4]);
    assert.equal(procedure?.source.producerSessionId, distillSessionId);
    assert.equal(lesson?.source.sessionId, bad.sessionId, "教训以失败侧为主证据");
    const contrast = procedure?.contrast;
    assert.ok(contrast !== undefined);
    assert.equal(contrast.form, "procedure");
    assert.equal(contrast.successful[0]?.sessionId, ok.sessionId);
    assert.equal(contrast.successful[0]?.label, "Passed");
    assert.deepEqual(contrast.successful[0]?.entryRange, { from: 1, to: 4 });
    assert.equal(contrast.successful[0]?.verification?.sessionId, host);
    assert.equal(contrast.failed[0]?.label, "Failed");
    assert.equal(contrast.others?.[0]?.label, "Abandoned", "其余尝试只记在来源块里");
    const dir = join(root, ".pigeon", "candidates", "skill");
    const meta = JSON.parse(
      readFileSync(
        join(dir, `run-tests-before-done-${procedure?.contentHash.slice(0, 16)}`, "candidate.json"),
        "utf8"
      )
    );
    assert.equal(meta.contrast.form, "procedure");
    const session = materializeSession(join(root, ".pigeon", "sessions"), host);
    assert.equal(session.candidateProposeds.length, 2);
    assert.equal(session.candidateScreeneds.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("产出规则：只有失败侧证据的流程或步骤集、只有失败侧证据的 memory 一律丢弃并留痕；没有成功侧时步骤集也丢弃", () => {
  const { root, bad, host, target } = setup();
  try {
    const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), host);
    const result = persistDistillerCandidates({
      governanceRoot: root,
      sink: log,
      target,
      distillSessionId: newSessionId(),
      structured: {
        candidates: [
          item({ name: "failed-workflow", form: "workflow", evidence: { failed: [2] } }),
          item({
            name: "failed-fact",
            kind: "memory",
            form: "lesson",
            content: "# 项目事实\n",
            evidence: { failed: [2] },
          }),
        ],
      },
      model: { provider: "p", id: "m" },
      hostRunId: bad.runId,
    });
    const onlyFailed: DistillTarget = { ...target };
    delete onlyFailed.successful;
    const forced = persistDistillerCandidates({
      governanceRoot: root,
      sink: log,
      target: onlyFailed,
      distillSessionId: newSessionId(),
      structured: { candidates: [item({ name: "no-success-procedure" })] },
      model: { provider: "p", id: "m" },
      hostRunId: bad.runId,
    });
    log.close();
    assert.equal(result.written.length, 0);
    assert.equal(result.rejected.length, 2);
    assert.equal(forced.written.length, 0);
    assert.equal(forced.rejected.length, 1);
    assert.equal(existsSync(join(root, ".pigeon", "candidates")), false, "被丢弃的条目不落文件");
    const session = materializeSession(join(root, ".pigeon", "sessions"), host);
    assert.equal(session.reviewUnparsables.length, 2, "每次提炼有丢弃时留一条说明");
    assert.ok(session.reviewUnparsables[0]?.payload.reason.includes("failed-workflow"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("结果整体不合格式（没有 candidates 数组）：只留一条不可解析记录，不落任何文件", () => {
  const { root, bad, host, target } = setup();
  try {
    const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), host);
    const result = persistDistillerCandidates({
      governanceRoot: root,
      sink: log,
      target,
      distillSessionId: newSessionId(),
      structured: { items: [{ kind: "skill" }] },
      model: { provider: "p", id: "m" },
      hostRunId: bad.runId,
    });
    log.close();
    assert.ok(result.unparsable !== undefined);
    assert.equal(existsSync(join(root, ".pigeon", "candidates")), false);
    assert.equal(
      materializeSession(join(root, ".pigeon", "sessions"), host).reviewUnparsables.length,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("逐项校验：单项不合格（种类不存在、缺字段）只丢弃该项并留痕，其余合格项照常落盘", () => {
  const { root, bad, host, target } = setup();
  try {
    const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), host);
    const result = persistDistillerCandidates({
      governanceRoot: root,
      sink: log,
      target,
      distillSessionId: newSessionId(),
      structured: {
        candidates: [
          item({}),
          item({ name: "wrong-kind", kind: "procedure" }),
          { name: "missing-fields" },
        ],
      },
      model: { provider: "p", id: "m" },
      hostRunId: bad.runId,
    });
    log.close();
    assert.equal(result.written.length, 1);
    assert.equal(result.rejected.length, 2);
    assert.equal(result.unparsable, undefined);
    const session = materializeSession(join(root, ".pigeon", "sessions"), host);
    assert.equal(session.reviewUnparsables.length, 1);
    assert.ok(session.reviewUnparsables[0]?.payload.reason.includes("wrong-kind"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("空结果必须附理由（121）：写明读了哪几侧、为什么没有可学的；缺理由或漏报某一侧按不合格式留痕，有理由的空结果照实交回", () => {
  const { root, bad, host, target } = setup();
  try {
    const log = new JsonlEventLog(join(root, ".pigeon", "sessions"), host);
    const persist = (structured: unknown) =>
      persistDistillerCandidates({
        governanceRoot: root,
        sink: log,
        target,
        distillSessionId: newSessionId(),
        structured,
        model: { provider: "p", id: "m" },
        hostRunId: bad.runId,
      });
    const why = "两侧做法一致，差别只在测试是否恰好通过";
    const explained = persist({
      candidates: [],
      emptyReason: { read: ["successful", "failed"], why },
    });
    assert.equal(explained.unparsable, undefined);
    assert.deepEqual(explained.emptyReason, { read: ["successful", "failed"], why });
    assert.equal(explained.written.length, 0);
    // 缺理由、漏报一侧、理由为空：都不算合格的空结果
    const bare = persist({ candidates: [] });
    assert.match(bare.unparsable ?? "", /空结果必须附理由/);
    const oneSide = persist({ candidates: [], emptyReason: { read: ["failed"], why } });
    assert.match(oneSide.unparsable ?? "", /没有读成功侧/);
    const blank = persist({
      candidates: [],
      emptyReason: { read: ["successful", "failed"], why: "" },
    });
    assert.match(blank.unparsable ?? "", /空结果必须附理由/);
    log.close();
    assert.equal(
      materializeSession(join(root, ".pigeon", "sessions"), host).reviewUnparsables.length,
      3
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
