// 决策 286：运行面给终端界面的两个只读观察口——工具结果（结果文本与 details，编辑类带 diff）与上下文用量
// （同压缩判据的 token 数与模型窗口）。只观察，不改事件载荷与会话记录。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ToolResultNotice } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

test("工具结果观察口：读文件交出结果文本，编辑交出 details 里的 diff；上下文用量随回复增长", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-observe-"));
  try {
    writeFileSync(join(root, "a.txt"), "第一行\n第二行\n");
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          { text: "先读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
          {
            text: "再改",
            toolCalls: [
              {
                name: "edit_file",
                args: { path: "a.txt", old_string: "第二行", new_string: "改过的第二行" },
              },
            ],
          },
          { text: "好了", contextTokens: 4321 },
        ],
      }),
      workspaceRoot: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
    });
    const notices: ToolResultNotice[] = [];
    const unsubscribe = bundle.adapter.subscribeToolResults((notice) => notices.push(notice));
    const before = bundle.adapter.contextUsage();
    assert.equal(before?.tokens, 0);
    assert.ok((before?.contextWindow ?? 0) > 0);
    const result = await bundle.adapter.run("动手");
    unsubscribe();
    await disposeRuntime(bundle);
    assert.equal(result.status, "completed");
    assert.deepEqual(
      notices.map((notice) => [notice.toolName, notice.isError, notice.runId === result.runId]),
      [
        ["read_file", false, true],
        ["edit_file", false, true],
      ]
    );
    assert.ok(notices[0]?.text.includes("第一行"), notices[0]?.text);
    const diff = (notices[1]?.details as { diff?: string } | undefined)?.diff ?? "";
    assert.ok(diff.includes("+改过的第二行"), diff);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "第一行\n改过的第二行\n");
    assert.ok((bundle.adapter.contextUsage()?.tokens ?? 0) >= 4321);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
