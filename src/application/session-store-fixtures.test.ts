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
import { createFixtureSession } from "./session-store-fixtures.ts";

function withRoot(run: (sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-fixture-"));
  return run(join(root, ".pigeon", "state", "sessions")).finally(() =>
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
