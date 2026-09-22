// worker 编排三族（M5.5 S2，决策 040）：session.header / child.spawned / child.settled 落盘、
// 冷物化配对、孤立 settled 如实归类、schema 拒绝未知角色与状态、v6 文件读路径迁移到 v7。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ChildSpawnedInput, EVENT_LOG_VERSION } from "../state/event-log.ts";
import {
  newEntryId,
  newGrantId,
  newReceiptId,
  newSessionId,
  type SessionId,
} from "../state/ids.ts";
import { JsonlEventLog, materializeSession, readEventLogFile } from "./event-log.ts";

function spawnedInput(childSessionId: SessionId, name: string): ChildSpawnedInput {
  return {
    childSessionId,
    name,
    role: "implementer",
    task: `改 ${name}`,
    policy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "prompt" },
    limits: { maxTurns: 10, wallClockMs: 60_000 },
    workspace: {
      kind: "git-worktree",
      path: `/repo/.pigeon/worktrees/x-${name}`,
      branch: `pigeon/${name}`,
    },
    spawnedAt: 1_757_000_000_000,
  };
}

test("worker 编排三族：父会话 spawned / settled 落盘并按 childSessionId 配对；worker 会话头冷物化", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-children-"));
  try {
    const parent = newSessionId();
    const first = newSessionId();
    const second = newSessionId();
    const log = new JsonlEventLog(dir, parent);
    log.appendChildSpawned(spawnedInput(first, "fix-a"));
    log.appendChildSpawned(spawnedInput(second, "fix-b"));
    const receiptId = newReceiptId();
    log.appendChildSettled({
      childSessionId: first,
      name: "fix-a",
      status: "completed",
      turns: 2,
      settledAt: 1_757_000_000_100,
      result: {
        branch: "pigeon/fix-a",
        changedFiles: ["a.ts"],
        receiptIds: [receiptId],
        summary: "已改完",
        summaryTruncated: false,
      },
    });
    log.close();

    const parentView = materializeSession(dir, parent);
    assert.equal(parentView.sessionHeader, undefined);
    assert.equal(parentView.children.length, 2);
    assert.equal(parentView.children[0]?.spawned.childSessionId, first);
    assert.equal(parentView.children[0]?.settled?.status, "completed");
    assert.deepEqual(parentView.children[0]?.settled?.result?.receiptIds, [receiptId]);
    // 第二个派出后未收尾：配对缺 settled（崩溃可能），不猜
    assert.equal(parentView.children[1]?.settled, undefined);
    assert.deepEqual(parentView.orphanChildSettleds, []);
    // 三族无 runId：不算崩溃残留 Run
    assert.deepEqual(parentView.unfinishedRuns, []);

    const worker = new JsonlEventLog(dir, first);
    worker.appendSessionHeader({
      parentSessionId: parent,
      worker: { name: "fix-a", role: "implementer" },
      workspace: {
        kind: "git-worktree",
        path: "/repo/.pigeon/worktrees/x-fix-a",
        branch: "pigeon/fix-a",
      },
      startedAt: 1_757_000_000_001,
    });
    worker.close();
    const workerView = materializeSession(dir, first);
    assert.equal(workerView.sessionHeader?.parentSessionId, parent);
    assert.equal(workerView.sessionHeader?.worker.role, "implementer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker 编排三族：找不到 spawned 的 settled 归孤立清单；未知角色与状态被 schema 拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-children-"));
  try {
    const parent = newSessionId();
    const log = new JsonlEventLog(dir, parent);
    const stray = newSessionId();
    log.appendChildSettled({
      childSessionId: stray,
      name: "ghost",
      status: "spawn-failed",
      error: "工作树建不起来",
      turns: 0,
      settledAt: 1,
    });
    assert.throws(() =>
      log.appendChildSpawned({ ...spawnedInput(newSessionId(), "x"), role: "admin" as never })
    );
    assert.throws(() =>
      log.appendChildSettled({
        childSessionId: stray,
        name: "ghost",
        status: "exploded" as never,
        turns: 0,
        settledAt: 1,
      })
    );
    log.close();
    const view = materializeSession(dir, parent);
    assert.equal(view.children.length, 0);
    assert.equal(view.orphanChildSettleds[0]?.childSessionId, stray);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v6 事件文件读路径迁移到当前版本：纯版本推进，旧记录逐字有效", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-children-"));
  try {
    const sessionId = newSessionId();
    const v6Grant = {
      version: 6,
      id: newEntryId(),
      sessionId,
      timestamp: 1_757_000_000_001,
      kind: "grant.created",
      grantId: newGrantId(),
      tool: "edit_file",
      createdAt: 1_757_000_000_001,
      firstCall: { toolCallId: "toolu_01ABC", args: { path: "a.ts" } },
    };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v6Grant)}\n`, "utf8");
    const records = readEventLogFile(path);
    assert.equal(EVENT_LOG_VERSION, 13);
    assert.equal(records[0]?.version, EVENT_LOG_VERSION);
    assert.equal(records[0]?.kind, "grant.created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
