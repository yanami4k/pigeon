// 编辑连发（决策 366）：同一次回复里的几个 edit_file 按顺序执行，后一个基于前一个的结果。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

async function run(root: string, replies: Parameters<typeof createFakeStreamFn>[0]["replies"]) {
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({ replies }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "fake",
    modelId: "fake",
    editMode: "replace",
  });
  try {
    await bundle.adapter.run("做");
  } finally {
    await disposeRuntime(bundle);
  }
}

test("同一次回复里连发的几个 edit_file 按顺序执行，后一个基于前一个的结果", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-edit-batch-"));
  try {
    writeFileSync(join(root, "a.txt"), "one\n");
    await run(root, [
      { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      {
        text: "改",
        toolCalls: [
          { name: "edit_file", args: { path: "a.txt", old_string: "one", new_string: "two" } },
          { name: "edit_file", args: { path: "a.txt", old_string: "two", new_string: "three" } },
        ],
      },
      { text: "完" },
    ]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "three\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
