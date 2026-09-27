// 装配根冒烟（M2 S1，决策 025）：buildRuntime 从 cli/index.ts 抽到 Controller 层后，
// 装配接线本身是被改动的部分——本测试钉住"装配出的 bundle 真能跑通一次写调用"：
// 注入的审批 handler 工厂收到装配根自建的 grantStore、prompt 模式下批准生效、
// 文件被真实编辑、工具结果消息上挂着审批闸的决定（会话存储）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { toolResultMark } from "../state/session-judge.ts";
import type { EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { buildRuntime } from "./runtime.ts";

// 取值并断言在场（替代非空断言）
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "值应在场");
  return value;
}

test("装配根：注入审批 handler 的 bundle 跑通 prompt 模式写调用，审批决定记在工具结果上", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const root = mkdtempSync(join(tmpdir(), "pigeon-runtime-"));
  try {
    writeFileSync(join(root, "a.ts"), original);
    const editArgs: EditFileParams = {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
    };
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "改一下", toolCalls: [{ name: "edit_file", args: editArgs }] },
        { text: "已完成" },
      ],
    });
    const sessionId = newSessionId();
    // 注入的工厂：捕获装配根传入的 grantStore，handler 一律批准
    let factoryGrants: SessionGrantStore | undefined;
    let handlerCalls = 0;
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
      editMode: "hashline",
      createApprovalHandler: (grants) => {
        factoryGrants = grants;
        return async () => {
          handlerCalls += 1;
          return { approved: true };
        };
      },
    });
    try {
      const result = await bundle.adapter.run("把 beta 改成 BETA");

      assert.equal(result.status, "completed");
      // 审批 handler 由调用方注入并真的被调用；工厂收到的是 bundle 里的同一个 store
      assert.equal(handlerCalls, 1);
      assert.ok(factoryGrants !== undefined);
      assert.equal(factoryGrants, bundle.grantStore);
      // 批准后写调用真实生效
      assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    // 审批决定落会话存储：edit_file 的工具结果消息上挂着"人工批准"的审批闸标记，且只有这一条工具结果
    const loaded = loadStoreSession(join(root, ".pigeon", "sessions"), sessionId);
    assert.ok(loaded !== undefined, "会话存储里应有本会话");
    const results = (loaded.view.runs[0]?.messages ?? [])
      .map((ref) => ref.message)
      .filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.toolName, "edit_file");
    assert.equal(results[0]?.isError, false);
    assert.deepEqual(toolResultMark(required(results[0]))?.gate, {
      outcome: "approved",
      approvedBy: "human",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
