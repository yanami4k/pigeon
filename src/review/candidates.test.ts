// 候选落盘（M6 S3，决策 065 及其子裁决）：解析 Reviewer 的结构化收尾结果（解析失败只记一条"结果不可解析"、
// 不落任何文件）；按内容哈希写入 .pigeon/candidates/<种类>/<名字>-<哈希>/，写入后不可变、同哈希跳过；
// Policy 只写自然语言建议；Memory 以整文件为粒度；扫描命中照常暂存并标拒收；同名改内容即新候选并标取代。
// 提出与筛查两族记录写进被审主会话的会话文件，候选状态由这两族现算。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { projectCandidates } from "../state/candidate-status.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { persistReviewerCandidates } from "./candidates.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-candidates-"));
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  const source = { sessionId, runId: newRunId(), producerSessionId: newSessionId() };
  const persist = (structured: unknown) =>
    persistReviewerCandidates({
      governanceRoot: root,
      sessionsDir,
      sink: log,
      structured,
      source,
      model: { provider: "custom", id: "custom" },
      usage: { turns: 2, totalTokens: 1200 },
    });
  return {
    root,
    sessionsDir,
    sessionId,
    log,
    persist,
    cleanup: () => {
      log.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const skill = (content: string) => ({
  kind: "skill",
  name: "read-before-edit",
  summary: "改之前先读",
  strength: 0.7,
  content,
  sourceRunSeqs: [1, 2],
});

test("合法结果：按种类写入 <名字>-<哈希>/，元数据为当前版本（v3，单来源不带对比来源块），提出与筛查两族各一条", () => {
  const f = fixture();
  try {
    const result = f.persist({
      candidates: [skill("---\nname: read-before-edit\ndescription: 改前先读\n---\n先读再改。")],
    });
    assert.equal(result.written.length, 1);
    const skillDir = join(f.root, ".pigeon", "candidates", "skill");
    const dirs = readdirSync(skillDir);
    assert.equal(dirs.length, 1);
    assert.match(dirs[0] ?? "", /^read-before-edit-[0-9a-f]{16}$/);
    const dir = join(skillDir, dirs[0] ?? "");
    assert.ok(existsSync(join(dir, "SKILL.md")), "Skill 正文为 SKILL.md");
    const meta = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8"));
    assert.equal(meta.version, 3);
    assert.equal(meta.contrast, undefined);
    assert.equal(meta.kind, "skill");
    assert.equal(meta.status, undefined, "状态不入元数据，由账本现算");
    assert.deepEqual(meta.source.entryRunSeqs, [1, 2]);

    const session = materializeSession(f.sessionsDir, f.sessionId, { content: false });
    assert.equal(session.candidateProposeds.length, 1);
    assert.equal(session.candidateScreeneds.length, 1);
    assert.equal(session.candidateProposeds[0]?.model.provider, "custom");
    assert.equal(session.candidateProposeds[0]?.usage?.totalTokens, 1200);
    const [projected] = projectCandidates(session);
    assert.equal(projected?.status, "SecurityScanned");
  } finally {
    f.cleanup();
  }
});

test("同哈希重复写入：不产生第二个目录，也不重复记账", () => {
  const f = fixture();
  try {
    const payload = { candidates: [skill("---\nname: read-before-edit\n---\n同一正文")] };
    f.persist(payload);
    const second = f.persist(payload);
    assert.equal(second.written.length, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(readdirSync(join(f.root, ".pigeon", "candidates", "skill")).length, 1);
    const session = materializeSession(f.sessionsDir, f.sessionId, { content: false });
    assert.equal(session.candidateProposeds.length, 1);
  } finally {
    f.cleanup();
  }
});

test("结果不可解析：不落任何文件，只记一条结果不可解析", () => {
  const f = fixture();
  try {
    const result = f.persist({ candidates: [{ kind: "skill" }] });
    assert.ok(result.unparsable !== undefined);
    assert.equal(existsSync(join(f.root, ".pigeon", "candidates")), false);
    const session = materializeSession(f.sessionsDir, f.sessionId, { content: false });
    assert.equal(session.candidateProposeds.length, 0);
    assert.equal(session.reviewUnparsables.length, 1);

    const missing = f.persist(undefined);
    assert.ok(missing.unparsable !== undefined, "没有结构化结果同样算不可解析");
  } finally {
    f.cleanup();
  }
});

test("扫描命中：正文照常暂存，筛查记录带命中项，状态为扫描拒收", () => {
  const f = fixture();
  try {
    f.persist({
      candidates: [
        {
          kind: "memory",
          name: "hidden-note",
          summary: "带零宽字符",
          strength: 0.5,
          content: "项目约定​：先读后改",
          sourceRunSeqs: [3],
        },
      ],
    });
    const dirs = readdirSync(join(f.root, ".pigeon", "candidates", "memory"));
    assert.equal(dirs.length, 1, "命中不丢正文");
    const session = materializeSession(f.sessionsDir, f.sessionId, { content: false });
    assert.ok((session.candidateScreeneds[0]?.hits.length ?? 0) > 0);
    assert.equal(projectCandidates(session)[0]?.status, "ScanRejected");
  } finally {
    f.cleanup();
  }
});

test("按种类的正文：Memory 整文件、Policy 只写自然语言建议", () => {
  const f = fixture();
  try {
    f.persist({
      candidates: [
        {
          kind: "memory",
          name: "project-facts",
          summary: "项目事实",
          strength: 0.6,
          content: "# 项目事实\n\n测试用 node --test。",
          sourceRunSeqs: [1],
        },
        {
          kind: "policy",
          name: "allow-test-command",
          summary: "测试命令可放权",
          strength: 0.4,
          content: "建议把 node --test 升格为固化放权。",
          sourceRunSeqs: [2],
        },
      ],
    });
    const memoryDir = readdirSync(join(f.root, ".pigeon", "candidates", "memory"))[0] ?? "";
    assert.equal(
      readFileSync(
        join(f.root, ".pigeon", "candidates", "memory", memoryDir, "project-facts.md"),
        "utf8"
      ),
      "# 项目事实\n\n测试用 node --test。"
    );
    const policyDir = readdirSync(join(f.root, ".pigeon", "candidates", "policy"))[0] ?? "";
    const policyFiles = readdirSync(
      join(f.root, ".pigeon", "candidates", "policy", policyDir)
    ).sort();
    assert.deepEqual(policyFiles, ["SUGGESTION.txt", "candidate.json"]);
  } finally {
    f.cleanup();
  }
});

test("同名改内容：产生新候选并标记取代旧哈希", () => {
  const f = fixture();
  try {
    const first = f.persist({ candidates: [skill("---\nname: read-before-edit\n---\n第一版")] });
    const second = f.persist({ candidates: [skill("---\nname: read-before-edit\n---\n第二版")] });
    assert.equal(second.written[0]?.supersedes, first.written[0]?.contentHash);
    assert.equal(readdirSync(join(f.root, ".pigeon", "candidates", "skill")).length, 2);
  } finally {
    f.cleanup();
  }
});
