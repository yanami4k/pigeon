// replace 编辑模式经治理层的集成（决策 061 S1）：headless 以 replace 模式装配——edit_file 参数与描述、read_file 输出、
// system prompt 的编辑说明随模式切换；yolo 下写档调用落 intent 与 receipt，receipt 的实测改后哈希等于 intent 的预期改后
// 哈希；崩溃恢复的哈希自动确证（形态同 M4 D5）对 replace 工具的内容证据同样走通。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recoverSession } from "../execution/recovery.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newExecutionId, newRunId, newSessionId } from "../state/ids.ts";
import { snapshotTag } from "../tools/hashline.ts";
import { createReplaceEditTool } from "../tools/replace-edit.ts";
import { runHeadless } from "./headless.ts";

const ORIGINAL = "alpha\nbeta\ngamma\n";
const EXPECTED = "alpha\nBETA\ngamma\n";

interface AdvertisedTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
}

test("replace 模式经治理层：工具与 prompt 随模式切换，yolo 下 intent 预期改后哈希与 receipt 实测改后哈希一致", async () => {
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

    const session = materializeSession(join(root, ".pigeon", "sessions"), result.sessionId);
    assert.equal(session.intents.length, 1);
    assert.equal(session.intents[0]?.contentHashes?.expectedAfterHash, snapshotTag(EXPECTED));
    assert.equal(session.intents[0]?.contentHashes?.beforeHash, snapshotTag(ORIGINAL));
    assert.equal(session.receipts[0]?.contentAfterHash, snapshotTag(EXPECTED));
    assert.equal(session.receipts[0]?.approvedBy, "policy:yolo");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("replace 工具的内容证据经崩溃恢复哈希自动确证：dispatch 未发生确证 not-executed，已执行未写 receipt 确证 executed，零重放", async () => {
  for (const executed of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "pigeon-replace-recovery-"));
    try {
      writeFileSync(join(root, "a.ts"), ORIGINAL);
      const tool = createReplaceEditTool(root);
      const params = { path: "a.ts", old_string: "beta", new_string: "BETA" };
      const evidence = await tool.probeContentEvidence(params);
      assert.ok(evidence !== null);
      const sessionsDir = join(root, ".pigeon", "sessions");
      const sessionId = newSessionId();
      const eventLog = new JsonlEventLog(sessionsDir, sessionId);
      eventLog.appendIntent({
        executionId: newExecutionId(),
        toolCallId: "toolu_crash",
        toolName: "edit_file",
        rawArgs: params,
        decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
        contentHashes: evidence,
        at: 1_757_000_000_000,
        runId: newRunId(),
      });
      eventLog.close();
      if (executed) {
        // 进程死于 execute 之后、receipt 之前：文件已是改后内容
        await tool.execute("toolu_crash", params);
      }
      const before = readFileSync(join(root, "a.ts"), "utf8");

      const recovery = recoverSession(sessionsDir, sessionId, root);
      assert.equal(recovery.resolutions.length, 1);
      assert.equal(recovery.resolutions[0]?.method, "hash-auto");
      assert.equal(recovery.resolutions[0]?.outcome, executed ? "executed" : "not-executed");
      assert.equal(recovery.materialized.reconcile.unknown.length, 0);
      // 零重放：恢复不改动文件
      assert.equal(readFileSync(join(root, "a.ts"), "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
