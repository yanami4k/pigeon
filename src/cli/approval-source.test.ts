// CLI 审批的来源与放权落点（M5.5 S3，决策 040）：worker 请求标明来源；[a] 放权写进 worker 自己的
// 存储，主会话存储不动；主会话请求无来源行、放权进绑定存储。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { newSessionId } from "../state/ids.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";

test("CLI 审批：worker 请求标明来源，[a] 放权只进 worker 存储；主会话请求无来源行、放权进绑定存储", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cli-source-"));
  try {
    const parentStore = new SessionGrantStore({ workspaceRoot: root });
    const workerStore = new SessionGrantStore({ workspaceRoot: root });
    let output = "";
    const handler = createCliApprovalHandler(
      async () => "a",
      (text) => {
        output += text;
      },
      { grants: parentStore }
    );

    const workerSession = newSessionId();
    const decision = await handler({
      toolName: "edit_file",
      toolCallId: "toolu_1",
      args: { path: "src/a.ts" },
      sessionId: workerSession,
      worker: { name: "fix-a", role: "implementer" },
      grants: workerStore,
    });
    assert.deepEqual(decision, { approved: true });
    assert.ok(output.includes("来源：worker fix-a（implementer）"), output);
    assert.ok(output.includes("只在 worker fix-a 会话内生效"), output);
    assert.equal(workerStore.list().length, 1);
    assert.equal(parentStore.list().length, 0);

    output = "";
    await handler({ toolName: "edit_file", toolCallId: "toolu_2", args: { path: "src/b.ts" } });
    assert.equal(output.includes("来源："), false, output);
    assert.equal(parentStore.list().length, 1);
    assert.equal(workerStore.list().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI 审批：主会话 handler 未配放权通道时，worker 请求自带的存储照样提供 [a]/[d]", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cli-source-"));
  try {
    const workerStore = new SessionGrantStore({ workspaceRoot: root });
    const prompts: string[] = [];
    const handler = createCliApprovalHandler(
      async (prompt) => {
        prompts.push(prompt);
        return "d";
      },
      () => {}
    );
    await handler({
      toolName: "edit_file",
      toolCallId: "toolu_1",
      args: { path: "src/a.ts" },
      sessionId: newSessionId(),
      worker: { name: "fix-a", role: "implementer" },
      grants: workerStore,
    });
    assert.ok(prompts[0]?.includes("[d] 本会话允许"), prompts[0]);
    assert.equal(workerStore.list()[0]?.pathPrefix, "src");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
