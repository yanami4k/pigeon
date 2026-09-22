// 旧 Policy 候选的读侧兼容（决策 094）：种类枚举保留 policy 取值只为读已入库的旧数据——
// 删值会让那些候选与账本记录不可读，违反加法式原则。它们照常读出、照常列出，
// 但写侧一律拒绝：不可再产出、不可批准、不可激活。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION, type ReviewerCandidate } from "../state/candidate.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { sha256Hex } from "../state/message-content.ts";
import { CandidateDecisionError, decideCandidate } from "./candidate-decision.ts";
import { buildCandidateIndex } from "./candidate-lookup.ts";
import { runCandidateShowCommand, runCandidatesCommand } from "./candidates-list.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "建议把 node --test 升格为固化放权。";

// 手写一条 094 之前入库的 Policy 候选：暂存目录与账本两族都按当时的形状写
function legacyPolicyCandidate(): { root: string; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-legacy-policy-"));
  const sessionId = newSessionId();
  const runId = newRunId();
  const contentHash = sha256Hex(Buffer.from(BODY, "utf8"));
  const dir = join(
    root,
    ".pigeon",
    "candidates",
    "policy",
    `allow-npm-${contentHash.slice(0, 16)}`
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SUGGESTION.txt"), BODY, "utf8");
  const candidate: ReviewerCandidate = {
    version: CANDIDATE_VERSION,
    origin: "distiller",
    kind: "policy",
    name: "allow-npm",
    contentHash,
    bytes: Buffer.byteLength(BODY, "utf8"),
    source: {
      sessionId,
      runId,
      producerSessionId: newSessionId(),
      entryRunSeqs: [1],
      contentDigest: "d".repeat(64),
    },
    summary: "测试命令可放权",
    strength: 0.4,
    scan: { scannerVersion: "1", hits: [] },
    createdAt: 1,
  };
  writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  const log = new JsonlEventLog(sessionsDirOf(root), sessionId);
  log.appendCandidateProposed({ runId, candidate, model: { provider: "p", id: "m" } });
  log.close();
  return { root, contentHash };
}

test("旧 Policy 候选：照常列出，状态仍由账本现算", () => {
  const { root, contentHash } = legacyPolicyCandidate();
  try {
    const listed = runCandidatesCommand({ root });
    assert.match(listed, /policy ｜ allow-npm/);
    assert.match(listed, new RegExp(contentHash.slice(0, 12)));
    assert.match(listed, /已扫描/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧 Policy 候选：详情照常读出，并明说它没有激活落点", () => {
  const { root, contentHash } = legacyPolicyCandidate();
  try {
    const detail = runCandidateShowCommand({ root, selector: contentHash });
    assert.match(detail, /# policy\/allow-npm/);
    assert.match(detail, /## 候选正文/);
    assert.match(detail, /升格为固化放权/);
    assert.match(detail, /已停止产出，没有激活落点/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧 Policy 候选：不可批准，也不可激活", () => {
  const { root, contentHash } = legacyPolicyCandidate();
  try {
    assert.throws(
      () =>
        decideCandidate({
          governanceRoot: root,
          selector: contentHash,
          action: "approve",
          reason: "想批一个",
          skipStalenessCheck: true,
        }),
      (error: unknown) => /已停止产出/.test(String(error))
    );
    assert.equal(
      runCandidatesCommand({ root }).includes("已激活"),
      false,
      "拦下之后状态不会变成已激活"
    );
    // 种类判据必须排在落决定记录之前：只查状态不是已激活挡不住"批过但没生效"——
    // 判据挪到落记录之后时，账本里会留一条批准记录而落点是空的，状态会停在已批准
    const entry = buildCandidateIndex(root).candidates.find(
      (item) => item.candidate.contentHash === contentHash
    );
    assert.equal(entry?.decided, undefined, "拦下时不得留下决定记录");
    assert.equal(entry?.status, "SecurityScanned", "状态停在已扫描");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧 Policy 候选：拒绝这条旧候选仍然走得通——读侧兼容不等于不能处置", () => {
  const { root, contentHash } = legacyPolicyCandidate();
  try {
    const result = decideCandidate({
      governanceRoot: root,
      selector: contentHash,
      action: "reject",
      reason: "形态已废弃",
    });
    assert.equal(result.decision.action, "reject");
    assert.match(runCandidatesCommand({ root }), /已拒绝/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写侧：候选落盘一律拒收已停止产出的种类", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-legacy-policy-write-"));
  try {
    assert.throws(
      () =>
        stageCandidate({
          governanceRoot: root,
          kind: "policy",
          name: "allow-npm",
          content: BODY,
          build: () => {
            throw new Error("不该走到组装元数据这一步");
          },
        }),
      (error: unknown) => /已停止产出/.test(String(error))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("批准拦截用的是种类判据，不是别的：同一条旧候选换成 skill 形态就能批", () => {
  const { root } = legacyPolicyCandidate();
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const content = "---\nname: allow-npm\ndescription: 建议\n---\n正文\n";
    const staged = stageCandidate({
      governanceRoot: root,
      kind: "skill",
      name: "allow-npm",
      content,
      build: (facts) => ({
        version: CANDIDATE_VERSION,
        origin: "distiller",
        kind: "skill",
        name: "allow-npm",
        contentHash: facts.contentHash,
        bytes: facts.bytes,
        source: {
          sessionId,
          runId,
          producerSessionId: newSessionId(),
          entryRunSeqs: [1],
          contentDigest: "d".repeat(64),
        },
        summary: "建议",
        strength: 0.4,
        scan: facts.scan,
        createdAt: 2,
      }),
    });
    if (staged === undefined) {
      throw new Error("候选落盘失败");
    }
    const log = new JsonlEventLog(sessionsDirOf(root), sessionId);
    log.appendCandidateProposed({ runId, candidate: staged, model: { provider: "p", id: "m" } });
    log.close();
    const result = decideCandidate({
      governanceRoot: root,
      selector: staged.contentHash,
      action: "approve",
      reason: "同一条内容，可装载的形态",
      skipStalenessCheck: true,
    });
    assert.equal(result.activation?.path, ".pigeon/skills/allow-npm/SKILL.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 拦截发生在决定层，错误类型是审批错误而不是别的
test("旧 Policy 候选：批准被拦下时抛的是审批错误", () => {
  const { root, contentHash } = legacyPolicyCandidate();
  try {
    assert.throws(
      () =>
        decideCandidate({
          governanceRoot: root,
          selector: contentHash,
          action: "approve",
          reason: "想批一个",
          skipStalenessCheck: true,
        }),
      CandidateDecisionError
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
