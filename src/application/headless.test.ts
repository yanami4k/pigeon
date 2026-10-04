// headless 运行入口（M6.5 S1，决策 056）：无父会话装出完整运行面跑到收尾，返回结构化结果；
// 无审批通道时 prompt 模式 fail-closed（006 既有）；需审批次数从会话存储现算；skillRoots 显式指定时只用给定的根
// （不扫治理根与用户级目录），agentsMd 关掉时不读人写的说明。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import {
  FAIL_CLOSED_APPROVAL_REASON,
  type StoreSessionView,
  storeAttemptLabel,
  toolResultMark,
} from "../state/session-judge.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { runHeadless } from "./headless-core.ts";
import { statusTextOf } from "./status-fixtures.ts";

const ORIGINAL = "alpha\nbeta\ngamma\n";

// 读新会话存储里的会话视图（会话必须存在）
function storeView(root: string, sessionId: string): StoreSessionView {
  const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, `会话存储里应有会话 ${sessionId}`);
  return loaded.view;
}

function makeWorkspace(): { root: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-headless-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-headless-home-"));
  writeFileSync(join(root, "a.ts"), ORIGINAL);
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const editArgs = {
  path: "a.ts",
  snapshot: snapshotTag(ORIGINAL),
  edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
};

function readThenEdit() {
  return createFakeStreamFn({
    replies: [
      { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { text: "再改", toolCalls: [{ name: "edit_file", args: editArgs }] },
      { text: "完成" },
    ],
  });
}

test("headless：yolo 下跑到收尾，结构化结果齐全；需审批次数只计 write / exec 档（read 不计）；不写 worker 来历", async () => {
  const { root, home, cleanup } = makeWorkspace();
  try {
    const result = await runHeadless({
      task: "把 beta 改成 BETA",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: readThenEdit(),
      yolo: true,
      homeDir: home,
      // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
      editMode: "hashline",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.failure, null);
    assert.equal(result.turns, 3);
    assert.equal(result.toolCalls, 2);
    assert.equal(result.approvalsNeeded, 1);
    assert.ok(result.usage.totalTokens > 0, JSON.stringify(result.usage));
    assert.ok(result.durationMs >= 0);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");

    const view = storeView(root, result.sessionId);
    assert.equal(view.metadata, undefined, "headless 会话是普通会话，文件头不写 worker 来历");
    assert.equal(view.parentSessionId, undefined);
    assert.equal(view.runs.length, 1);
    assert.equal(result.runId, view.runs[0]?.runId);
    assert.equal(view.runs[0]?.start.policy.approvalMode, "yolo");
  } finally {
    cleanup();
  }
});

test("headless：prompt 模式无审批通道一律 fail-closed——写调用的工具结果带审批闸拒绝标记（policy:deny 固定理由），文件不变", async () => {
  const { root, home, cleanup } = makeWorkspace();
  try {
    const result = await runHeadless({
      task: "把 beta 改成 BETA",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: readThenEdit(),
      yolo: false,
      homeDir: home,
      editMode: "hashline",
    });
    assert.equal(result.status, "completed");
    // 因无审批通道而拒绝的写调用正是"需要人来批"的一次（读档不计）
    assert.equal(result.approvalsNeeded, 1);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), ORIGINAL);
    const view = storeView(root, result.sessionId);
    const results = (view.runs[0]?.messages ?? [])
      .map((ref) => ref.message)
      .filter((message) => message.role === "toolResult");
    assert.deepEqual(
      results.map((message) => message.toolName),
      ["read_file", "edit_file"]
    );
    const rejected = results[1];
    assert.ok(rejected !== undefined);
    assert.equal(rejected.isError, true);
    assert.deepEqual(toolResultMark(rejected)?.gate, {
      outcome: "rejected",
      approvedBy: "policy:deny",
    });
    const rejectedText = (rejected.content as Array<{ type: string; text?: string }>)
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("");
    assert.equal(rejectedText, FAIL_CLOSED_APPROVAL_REASON);
    // 读档调用在 prompt 档自动放行
    assert.deepEqual(toolResultMark(results[0] ?? { role: "none" })?.gate, {
      outcome: "approved",
      approvedBy: "policy:auto",
    });
  } finally {
    cleanup();
  }
});

test("headless：轮次上限触发中止，终态 turn-limit", async () => {
  const { root, home, cleanup } = makeWorkspace();
  try {
    const result = await runHeadless({
      task: "一直读",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({
        replies: [{ text: "读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] }],
      }),
      yolo: true,
      maxTurns: 2,
      homeDir: home,
    });
    assert.equal(result.status, "turn-limit");
    assert.ok(result.turns >= 2, String(result.turns));
    // M7（决策 072）：撞上限记在被中止那次 Run 的收尾条目的结束方式上，标签由此现算为失败
    const view = storeView(root, result.sessionId);
    assert.deepEqual(
      view.runs.map((run) => run.end?.ending),
      ["turn-limit"]
    );
    const limitRun = view.runs[0]?.runId;
    assert.equal(limitRun, result.runId, "结束方式落在被中止的那次 Run 上");
    assert.ok(limitRun !== undefined);
    assert.equal(storeAttemptLabel(view, limitRun), "Failed");
  } finally {
    cleanup();
  }
});

// 072 修订：只有运行确实因上限被中止才记撞上限；恰好用满最后一轮、自然收尾的运行以正常完成收尾
test("headless：最后一轮恰好用满上限而自然收尾——终态 completed，收尾条目为正常完成，标签不判失败", async () => {
  const { root, home, cleanup } = makeWorkspace();
  try {
    const result = await runHeadless({
      task: "答一句",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "完成" }] }),
      yolo: true,
      maxTurns: 1,
      homeDir: home,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.turns, 1);
    const view = storeView(root, result.sessionId);
    assert.deepEqual(
      view.runs.map((run) => run.end?.ending),
      ["completed"]
    );
    assert.ok(result.runId !== undefined);
    // 未配验证命令、正常完成 → 未知（072）；不因撞上限判失败
    assert.equal(storeAttemptLabel(view, result.runId), "Unknown");
  } finally {
    cleanup();
  }
});

test("headless：显式 skillRoots 只用给定的根、agentsMd 关掉——空数组不注入任何 Skill，不读 AGENTS.md；Skill 根自带 SKILL.md 即一个 Skill", async () => {
  const { root, home, cleanup } = makeWorkspace();
  try {
    // 治理根与用户级目录都放了 Skill 与人写的说明：显式根、关掉说明时一律不读
    mkdirSync(join(root, ".pigeon", "skills", "local"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: 本地\n---\n正文\n"
    );
    writeFileSync(join(root, "AGENTS.md"), "项目说明\n");
    mkdirSync(join(home, ".pigeon"), { recursive: true });
    writeFileSync(join(home, ".pigeon", "AGENTS.md"), "用户说明\n");
    const candidate = join(root, "eval-skill", "candidate");
    mkdirSync(candidate, { recursive: true });
    writeFileSync(
      join(candidate, "SKILL.md"),
      "---\nname: pitfalls\ndescription: 踩过的坑\n---\n先读再改\n"
    );

    const noneModel = createFakeStreamFn({ replies: [{ text: "好" }] });
    const none = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: noneModel,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
    });
    const noneStarted = storeView(root, none.sessionId).runs[0]?.start;
    assert.deepEqual(noneStarted?.skills, []);
    assert.deepEqual(noneStarted?.memory, []);
    // agentsMd 关掉：开工状态块（决策 363：人写的说明在它的「项目说明」一节）照常发出，但没有说明一节，两层内容都不在
    const noneStatus = statusTextOf(noneModel.calls[0]);
    assert.match(noneStatus, /name="环境"/);
    assert.doesNotMatch(noneStatus, /name="项目说明"/);
    assert.ok(!noneStatus.includes("用户说明"));
    assert.equal(noneStarted?.advertisedTools.includes("load_skill"), false);

    const withSkill = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
      skillRoots: [{ path: candidate, label: "eval-skill/candidate" }],
      agentsMd: false,
    });
    const started = storeView(root, withSkill.sessionId).runs[0]?.start;
    assert.deepEqual(
      started?.skills.map((skill) => [skill.name, skill.path, skill.files.map((f) => f.path)]),
      [["pitfalls", "eval-skill/candidate", ["SKILL.md"]]]
    );
    assert.deepEqual(started?.memory, []);
    assert.equal(started?.advertisedTools.includes("load_skill"), true);
  } finally {
    cleanup();
  }
});
