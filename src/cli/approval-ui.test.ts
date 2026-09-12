// M4 S6（决策 3）审批提示四键测试：[y] 批准一次 / [n] 拒绝 / [a] 本会话允许（工具级 grant）
// / [d] 本会话允许（仅限当前调用所在目录）——[d] 仅当调用带可解析 path 参数时提供。
// 创建 grant 必须写 grant.created 事件（事件写盘失败 = grant 不生效，fail-closed）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { asRunId } from "../state/ids.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolName: "edit_file",
    toolCallId: "toolu_01ABC",
    args: { path: "src/a.ts" },
    runId: asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
    ...overrides,
  };
}

test("[a] 创建工具级 grant：批准本次调用，grant 入 store 且 firstCall 回指本次调用", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    const outputs: string[] = [];
    const ask = async (prompt: string): Promise<string> => {
      outputs.push(prompt);
      return "a";
    };
    const handler = createCliApprovalHandler(ask, (text) => outputs.push(text), {
      grants: store,
    });
    const request = makeRequest();
    const decision = await handler(request);
    assert.deepEqual(decision, { approved: true });

    const grants = store.list();
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.tool, "edit_file");
    assert.equal(grants[0]?.pathPrefix, undefined, "[a] 工具级：不限目录");
    assert.equal(grants[0]?.firstCall.toolCallId, "toolu_01ABC");
    // 四键提示在场：[d] 因 path 参数可解析而提供
    const promptText = outputs.join("");
    assert.ok(promptText.includes("[y]"), promptText);
    assert.ok(promptText.includes("[n]"), promptText);
    assert.ok(promptText.includes("[a] 本会话允许"), promptText);
    assert.ok(promptText.includes("[d]"), promptText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[d] 创建目录限定 grant：pathPrefix = 调用所在目录；无 path 参数时不提供 [d]", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({ workspaceRoot: root });
    // 目录限定：src/deep/a.ts → 仅限 src/deep
    const outputs: string[] = [];
    const handler = createCliApprovalHandler(
      async () => "d",
      (text) => outputs.push(text),
      { grants: store }
    );
    const decision = await handler(makeRequest({ args: { path: "src/deep/a.ts" } }));
    assert.deepEqual(decision, { approved: true });
    assert.equal(store.list()[0]?.pathPrefix, "src/deep");

    // 根级文件：所在目录 = 工作区根（"."），依旧提供 [d]（与 [a] 语义不同：仅限根内）
    const first = store.list()[0];
    assert.ok(first);
    store.revoke(first.grantId);
    const outputs2: string[] = [];
    const handler2 = createCliApprovalHandler(
      async () => "d",
      (text) => outputs2.push(text),
      { grants: store }
    );
    await handler2(makeRequest({ args: { path: "a.ts" } }));
    assert.equal(store.list()[0]?.pathPrefix, ".");

    // 非路径调用（args 无 path）：不提供 [d]，输入 d 回落拒绝流程前的未知键处理
    const outputs3: string[] = [];
    const ask3 = async (): Promise<string> => "y";
    const handler3 = createCliApprovalHandler(ask3, (text) => outputs3.push(text), {
      grants: store,
    });
    const decision3 = await handler3(makeRequest({ args: { code: "x" } }));
    assert.deepEqual(decision3, { approved: true }, "未知键 y 语义不受影响");
    const prompt3 = outputs3.join("");
    assert.ok(!prompt3.includes("[d]"), "无 path 参数不得提供 [d]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grant.created 事件写盘失败 = grant 不生效（fail-closed：免审授权必须留证后才存在）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const store = new SessionGrantStore({
      workspaceRoot: root,
      eventLog: {
        appendGrantCreated: () => {
          throw new Error("磁盘故障");
        },
        appendGrantRevoked: () => {},
      },
    });
    const handler = createCliApprovalHandler(
      async () => "a",
      () => {},
      { grants: store }
    );
    await assert.rejects(() => handler(makeRequest()), /磁盘故障/);
    assert.equal(store.list().length, 0, "事件未落盘的 grant 不得生效");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无 grants 存储时保持 y/N 两键形态（缺省不弹 grant 键）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-"));
  try {
    const outputs: string[] = [];
    const handler = createCliApprovalHandler(
      async (prompt) => {
        outputs.push(prompt);
        return "n";
      },
      (text) => outputs.push(text)
    );
    const decision = await handler(makeRequest());
    assert.equal(decision.approved, false);
    const promptText = outputs.join("");
    assert.ok(!promptText.includes("[a]"), promptText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
