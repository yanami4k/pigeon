// 装配根冒烟（M2 S1，决策 025）：buildRuntime 从 cli/index.ts 抽到 Controller 层后，
// 装配接线本身是被改动的部分——本测试钉住"装配出的 bundle 真能跑通一次写调用"：
// 注入的审批 handler 工厂收到装配根自建的 grantStore、prompt 模式下批准生效、
// 文件被真实编辑、intent/receipt 治理族落盘。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { JsonlEventLog, readEventLogFile } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { buildRuntime } from "./runtime.ts";

test("装配根：注入审批 handler 的 bundle 跑通 prompt 模式写调用，治理族落盘", async () => {
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
      bundle.eventLog.close();
    }
    // 治理族落盘：批准路径写 intent（自带 decision 快照）与 receipt 到同一会话文件
    const records = readEventLogFile(
      JsonlEventLog.filePathFor(join(root, ".pigeon", "sessions"), sessionId)
    );
    const kinds = records.map((record) => record.kind);
    assert.ok(kinds.includes("intent"), `应有 intent 记录：${kinds.join(",")}`);
    assert.ok(kinds.includes("receipt"), `应有 receipt 记录：${kinds.join(",")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
