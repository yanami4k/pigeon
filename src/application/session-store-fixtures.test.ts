// 用新存储造会话数据的测试夹具：造出的文件经只读读取器读回，形状与生产一致（消息、七种自定义条目全部通过 v1 schema），
// worker 子会话、分叉、撕裂末行与不认识的条目这些常用形状都能造。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  branchEntries,
  readSessionFile,
  type SessionFileView,
  type StoredEntry,
} from "../persistence/session-reader.ts";
import { SESSION_ENTRY_SCHEMAS, SessionEntryType } from "../state/session-entries.ts";
import {
  appendRawLine,
  createFixtureSession,
  forkFixture,
  spawnFixtureWorker,
  tearTail,
} from "./session-store-fixtures.ts";

function withRoot(run: (sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-fixture-"));
  return run(join(root, ".pigeon", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

function mainOf(view: SessionFileView | undefined): StoredEntry[] {
  assert.ok(view !== undefined);
  return branchEntries(view, view.lanes.get("main") ?? null);
}

function shape(entries: StoredEntry[]): string[] {
  return entries.map((entry) =>
    entry.type === "custom"
      ? String(entry.customType).replace("pigeon.", "")
      : String((entry.message as { role: string }).role)
  );
}

test("夹具：一次 Run 的消息与七种自定义条目按生产的顺序落盘，自定义条目全部通过 v1 schema", async () => {
  await withRoot(async (sessionsDir) => {
    const s = createFixtureSession({ sessionsDir });
    const runId = s.startRun({ task: "改 a.txt" });
    s.toolTurn({ name: "edit_file", args: { path: "a.txt" }, checkpoint: true });
    s.assistant({ text: "好了", thinking: "想一下" });
    s.endRun();
    s.verification({
      verdict: "fail",
      steps: [{ name: "测试", verdict: "fail", toolFault: true }],
    });
    const grant = s.grantCreated({ pathPrefix: "src" });
    s.grantRevoked(grant);
    const { path } = await s.close();
    const view = readSessionFile(path);
    assert.deepEqual(view?.warnings, []);
    const main = mainOf(view);
    assert.deepEqual(shape(main), [
      "run-start",
      "user",
      "assistant",
      "checkpoint",
      "toolResult",
      "assistant",
      "run-end",
      "verification",
      "grant",
      "grant",
    ]);
    for (const entry of main.filter((item) => item.type === "custom")) {
      const schema = SESSION_ENTRY_SCHEMAS[entry.customType as keyof typeof SESSION_ENTRY_SCHEMAS];
      assert.ok(Value.Check(schema, entry.data), `${String(entry.customType)} 通过 schema`);
    }
    const end = main.find((entry) => entry.customType === SessionEntryType.RunEnd)?.data as {
      runId: string;
      messageCount: number;
      ending: string;
      stopReason: string;
    };
    assert.deepEqual(
      [end.runId, end.messageCount, end.ending, end.stopReason],
      [runId, 4, "completed", "stop"]
    );
  });
});

test("夹具：worker 子会话——父会话记派出与收尾，子会话文件头记父会话号与来历", async () => {
  await withRoot(async (sessionsDir) => {
    const parent = createFixtureSession({ sessionsDir });
    const parentRun = parent.startRun({ task: "派个 worker" });
    const child = spawnFixtureWorker(parent, { sessionsDir, name: "implementer-1", task: "干活" });
    child.startRun({ task: "干活" });
    child.assistant({ text: "干完了" });
    child.endRun();
    const { path: childPath } = await child.close();
    parent.workerSettled({ childSessionId: child.sessionId, name: "implementer-1" });
    parent.endRun();
    const { path: parentPath } = await parent.close();
    const workers = mainOf(readSessionFile(parentPath)).filter(
      (entry) => entry.customType === SessionEntryType.Worker
    );
    assert.deepEqual(
      workers.map((entry) => (entry.data as { event: string }).event),
      ["spawned", "settled"]
    );
    const childView = readSessionFile(childPath);
    assert.equal(childView?.header.parentSessionId, parent.sessionId);
    const lineage = (
      childView?.header.metadata?.pigeon as { worker?: { parentRunId?: string } } | undefined
    )?.worker;
    assert.equal(lineage?.parentRunId, parentRun);
  });
});

test("夹具：分叉——来源记分叉条目，分支文件复制分叉点（含）之前的历史并可续写", async () => {
  await withRoot(async (sessionsDir) => {
    const source = createFixtureSession({ sessionsDir });
    const runId = source.startRun({ task: "原任务" });
    source.toolTurn({ name: "read_file" });
    source.endRun();
    await source.close();
    const branch = await forkFixture({
      sessionsDir,
      sourceSessionId: source.sessionId,
      runId,
      runSeq: 1,
    });
    branch.startRun();
    branch.assistant({ text: "分支里接着干" });
    branch.endRun();
    const { path } = await branch.close();
    const view = readSessionFile(path);
    assert.equal(view?.header.parentSessionId, source.sessionId);
    assert.deepEqual(shape(mainOf(view)), [
      "run-start",
      "user",
      "run-start",
      "assistant",
      "run-end",
    ]);
  });
});

test("夹具：撕裂末行与不认识的条目类型——读取器跳过末行、告警跳过未知条目，其余照读", async () => {
  await withRoot(async (sessionsDir) => {
    const s = createFixtureSession({ sessionsDir });
    s.startRun({ task: "一" });
    const { path } = await s.close();
    appendRawLine(path, {
      kind: "entry",
      lane: "main",
      type: "pigeon_raw",
      id: "x",
      parentId: null,
      seq: 99,
      timestamp: 1,
    });
    tearTail(path);
    const view = readSessionFile(path);
    assert.equal(view?.entries.length, 2);
    assert.equal(view?.warnings.length, 1);
  });
});
