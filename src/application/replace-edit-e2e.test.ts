// replace 编辑模式经治理层的集成（决策 061 S1）：headless 以 replace 模式装配——edit_file 参数与描述、read_file 输出、
// system prompt 的编辑说明随模式切换；yolo 下写档调用经审批闸自动放行，决定记在会话存储的工具结果上
// （内容哈希随账本重构停写，原哈希断言一并删去）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { toolResultMark } from "../state/session-judge.ts";
import { runHeadless } from "./headless-core.ts";

// 取值并断言在场（替代非空断言）
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "值应在场");
  return value;
}

const ORIGINAL = "alpha\nbeta\ngamma\n";
const EXPECTED = "alpha\nBETA\ngamma\n";

interface AdvertisedTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
}

test("replace 模式经治理层：工具与 prompt 随模式切换，yolo 下写档调用经审批闸自动放行", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-replace-e2e-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-replace-e2e-home-"));
  try {
    writeFileSync(join(root, "a.ts"), ORIGINAL);
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
        {
          text: "改",
          toolCalls: [
            { name: "edit_file", args: { path: "a.ts", old_string: "beta", new_string: "BETA" } },
          ],
        },
        { text: "完成" },
      ],
    });
    const result = await runHeadless({
      task: "把 beta 改成 BETA",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      memoryRoots: [],
      editMode: "replace",
    });
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), EXPECTED);

    const context = streamFn.calls[0]?.context;
    assert.match(context?.systemPrompt ?? "", /old_string/);
    assert.doesNotMatch(context?.systemPrompt ?? "", /N#TAG/);
    const tools = (context?.tools ?? []) as unknown as AdvertisedTool[];
    const edit = tools.find((tool) => tool.name === "edit_file");
    assert.deepEqual(Object.keys(edit?.parameters.properties ?? {}).sort(), [
      "new_string",
      "old_string",
      "path",
    ]);
    // 模型第二次调用时看到的 read_file 结果是 `行号| 内容`
    const readResult = JSON.stringify(streamFn.calls[1]?.context.messages ?? []);
    assert.ok(readResult.includes("2| beta"), readResult);

    // 会话存储：edit_file 的工具结果成功，审批闸决定为 yolo 自动放行（只有这一次写档调用）
    const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), result.sessionId);
    assert.ok(loaded !== undefined, "会话存储里应有本会话");
    const edits = (loaded.view.runs[0]?.messages ?? [])
      .map((ref) => ref.message)
      .filter((message) => message.role === "toolResult" && message.toolName === "edit_file");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.isError, false);
    assert.deepEqual(toolResultMark(required(edits[0]))?.gate, {
      outcome: "approved",
      approvedBy: "policy:yolo",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
