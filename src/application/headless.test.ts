// headless 运行入口（M6.5 S1，决策 056）：无父会话装出完整运行面跑到收尾，返回结构化结果；
// 无审批通道时 prompt 模式 fail-closed（006 既有）；需审批次数从回执反推；skillRoots / memoryRoots 显式指定时
// 只用给定的根（不扫治理根与用户级目录）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { attemptOutcomeFacts, labelAttempt } from "../state/outcome-label.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { runHeadless } from "./headless.ts";

const ORIGINAL = "alpha\nbeta\ngamma\n";

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

test("headless：yolo 下跑到收尾，结构化结果齐全；需审批次数只计 write / exec 档（read 不计）；不写 session.header", async () => {
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

    const session = materializeSession(join(root, ".pigeon", "sessions"), result.sessionId);
    assert.equal(session.sessionHeader, undefined, "headless 会话是普通会话，不写 worker 会话头");
    assert.equal(session.runStarteds.length, 1);
    assert.equal(result.runId, session.runStarteds[0]?.runId);
    assert.equal(session.runStarteds[0]?.payload.policy.approvalMode, "yolo");
  } finally {
    cleanup();
  }
});

test("headless：prompt 模式无审批通道一律 fail-closed——写调用落 decision（policy:deny 逐字理由），文件不变", async () => {
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
    assert.equal(result.approvalsNeeded, 0);
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), ORIGINAL);
    const session = materializeSession(join(root, ".pigeon", "sessions"), result.sessionId);
    assert.equal(session.decisions.length, 1);
    assert.equal(session.decisions[0]?.toolName, "edit_file");
    assert.equal(session.decisions[0]?.decision.approvedBy, "policy:deny");
    assert.match(session.decisions[0]?.decision.reason ?? "", /未配置审批通道（fail-closed）/);
    assert.equal(session.intents.length, 0);
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
    // M7（决策 072）：撞上限写进本会话账本，标签由账本现算为失败
    const session = materializeSession(join(root, ".pigeon", "sessions"), result.sessionId);
    assert.deepEqual(
      session.limitHits.map((record) => record.payload.limit),
      ["turn-limit"]
    );
    const limitRun = session.limitHits[0]?.runId;
    assert.ok(limitRun !== undefined);
    assert.equal(labelAttempt(attemptOutcomeFacts(session, limitRun)), "Failed");
  } finally {
    cleanup();
  }
});

test("headless：显式 skillRoots / memoryRoots 只用给定的根——空数组不注入任何 Skill 与 Memory；Skill 根自带 SKILL.md 即一个 Skill", async () => {
  const { root, home, cleanup } = makeWorkspace();
  try {
    // 治理根与用户级目录都放了 Skill 与 Memory：显式根时一律不扫
    mkdirSync(join(root, ".pigeon", "skills", "local"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: 本地\n---\n正文\n"
    );
    mkdirSync(join(root, ".pigeon", "memory"), { recursive: true });
    writeFileSync(join(root, ".pigeon", "memory", "a.md"), "项目记忆\n");
    mkdirSync(join(home, ".pigeon"), { recursive: true });
    writeFileSync(join(home, ".pigeon", "preferences.md"), "偏好\n");
    const candidate = join(root, "eval-skill", "candidate");
    mkdirSync(candidate, { recursive: true });
    writeFileSync(
      join(candidate, "SKILL.md"),
      "---\nname: pitfalls\ndescription: 踩过的坑\n---\n先读再改\n"
    );

    const none = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
      skillRoots: [],
      memoryRoots: [],
    });
    const sessionsDir = join(root, ".pigeon", "sessions");
    const noneStarted = materializeSession(sessionsDir, none.sessionId).runStarteds[0]?.payload;
    assert.deepEqual(noneStarted?.skills, []);
    assert.deepEqual(noneStarted?.memory, []);
    assert.equal(noneStarted?.advertisedTools.includes("load_skill"), false);

    const withSkill = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
      skillRoots: [{ path: candidate, label: "eval-skill/candidate" }],
      memoryRoots: [],
    });
    const started = materializeSession(sessionsDir, withSkill.sessionId).runStarteds[0]?.payload;
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
