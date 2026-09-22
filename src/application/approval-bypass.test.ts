// 完成证据第一条（ROADMAP §M8）：候选不能通过改字段或内部工具调用跳过审批。
// 四条钉死：
//   1. 候选元数据 schema 拒收多余字段——状态写不进候选文件；
//   2. 改暂存目录里的 candidate.json 造不出"已批准"：状态由账本现算，文件不是事实源；
//   3. 改暂存目录里的正文后批准会被摘要比对拦下——激活内容必须与批准内容逐字一致；
//   4. 模型可达的那一层（tools / pi-runtime）在源码里够不着决定族、激活族与激活器。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { candidateBodyPath, stageCandidate } from "../review/candidates.ts";
import { CANDIDATE_VERSION, ReviewerCandidateSchema } from "../state/candidate.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { decideCandidate } from "./candidate-decision.ts";
import { buildCandidateIndex } from "./candidate-lookup.ts";
import { runCandidateShowCommand } from "./candidates-list.ts";
import { sessionsDirOf } from "./workspace.ts";

const BODY = "# 先读后改\n";

function staged(): { root: string; sessionId: SessionId; contentHash: string } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-bypass-"));
  const sessionId = newSessionId();
  const runId = newRunId();
  const candidate = stageCandidate({
    governanceRoot: root,
    kind: "skill",
    name: "read-before-edit",
    content: BODY,
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
  const log = new JsonlEventLog(sessionsDirOf(root), sessionId);
  log.appendCandidateProposed({ runId, candidate, model: { provider: "p", id: "m" } });
  log.close();
  return { root, sessionId, contentHash: candidate.contentHash };
}

test("绕过审批：候选元数据 schema 拒收 status 字段——状态写不进候选文件", () => {
  const { root, contentHash } = staged();
  try {
    const metaPath = join(
      root,
      path.dirname(candidateBodyPath("skill", "read-before-edit", contentHash)),
      "candidate.json"
    );
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    assert.ok(Value.Check(ReviewerCandidateSchema, meta));
    assert.ok(!Value.Check(ReviewerCandidateSchema, { ...meta, status: "Active" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("绕过审批：改 candidate.json 造不出已批准——状态由账本现算", () => {
  const { root, contentHash } = staged();
  try {
    const metaPath = join(
      root,
      path.dirname(candidateBodyPath("skill", "read-before-edit", contentHash)),
      "candidate.json"
    );
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify({ ...meta, status: "Active" }, null, 2), "utf8");
    const entry = buildCandidateIndex(root).candidates.find(
      (item) => item.candidate.contentHash === contentHash
    );
    assert.equal(entry?.status, "SecurityScanned", "状态仍是账本算出来的那个");
    assert.equal(entry?.decided, undefined);
    assert.equal(entry?.activated, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("绕过审批：改暂存正文后批准被摘要比对拦下，落点不会被写成改过的样子", () => {
  const { root, contentHash } = staged();
  try {
    const bodyPath = join(root, candidateBodyPath("skill", "read-before-edit", contentHash));
    writeFileSync(bodyPath, "# 换成了别的内容\n", "utf8");
    assert.throws(() =>
      decideCandidate({
        governanceRoot: root,
        selector: contentHash,
        action: "approve",
        reason: "批一个",
        skipStalenessCheck: true,
      })
    );
    // 比对必须发生在写盘之前：落点不能出现，被篡改的正文更不能进装载目录
    assert.equal(
      existsSync(join(root, ".pigeon", "skills", "read-before-edit")),
      false,
      "被篡改的正文不得写进装载目录"
    );
    // 决定也不能落盘：账本里留下一条批准记录而文件没动，事后看就是"批过但没生效"。
    // 必须按跨会话索引查——决定与激活写进执行命令的那次会话自己的文件，不在候选的来源会话里，
    // 只查来源会话的断言是恒真的空转断言
    const entry = buildCandidateIndex(root).candidates.find(
      (item) => item.candidate.contentHash === contentHash
    );
    assert.ok(entry !== undefined, "候选仍应在索引里");
    assert.equal(entry.decided, undefined, "比对不过时不得留下批准记录");
    assert.equal(entry.activated, undefined);
    assert.equal(entry.status, "SecurityScanned", "状态停在已扫描，没有前进到已批准");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("绕过审批：改暂存正文后连详情都读不出来——正文按哈希不可变，读到对不上就响亮失败", () => {
  const { root, contentHash } = staged();
  try {
    writeFileSync(
      join(root, candidateBodyPath("skill", "read-before-edit", contentHash)),
      "# 换成了别的内容\n",
      "utf8"
    );
    assert.throws(
      () => runCandidateShowCommand({ root, selector: contentHash }),
      (error: unknown) => /正文与内容哈希对不上/.test(String(error))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 模型可达的那一层：工具实现与 Adapter。它们在源码里就够不着决定族、激活族与激活器——
// 没有"内部工具调用"这条路可以把候选推到已激活
const FORBIDDEN_IN_MODEL_REACHABLE = [
  "appendCandidateDecided",
  "appendCandidateActivated",
  "activateExperience",
  "decideCandidate",
  "../activation/",
];

test("绕过审批：模型可达的 tools 与 pi-runtime 在源码里够不着决定、激活与激活器", () => {
  const srcRoot = fileURLToPath(new URL("..", import.meta.url));
  const offenders: string[] = [];
  for (const dir of ["tools", "pi-runtime"]) {
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const text = readFileSync(full, "utf8");
          for (const needle of FORBIDDEN_IN_MODEL_REACHABLE) {
            if (text.includes(needle)) {
              offenders.push(`${full} 含 ${needle}`);
            }
          }
        }
      }
    };
    walk(join(srcRoot, dir));
  }
  assert.deepEqual(offenders, []);
});
