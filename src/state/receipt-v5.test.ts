// Receipt v5（M5.7 S3，决策 053）：第三个可选证据块 mcp，与 contentAfterHash（write）、exec（exec）并列；
// v4 → v5 纯版本推进，旧回执逐字有效。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { newExecutionId, newReceiptId } from "./ids.ts";
import {
  migrateReceiptToCurrent,
  RECEIPT_VERSION,
  type Receipt,
  ReceiptSchema,
} from "./receipt.ts";

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId: newExecutionId(),
    toolCallId: "toolu_mcp",
    approvedBy: "human",
    executed: true,
    isError: false,
    startedAt: 1,
    finishedAt: 2,
    summary: "mcp__fs__write_file 执行完成",
    ...overrides,
  };
}

test("Receipt v5：mcp 块可缺省、可往返；形状不符被拒绝", () => {
  assert.equal(RECEIPT_VERSION, 5);
  assert.ok(Value.Check(ReceiptSchema, receipt()));
  const withMcp = receipt({
    mcp: {
      server: "fs",
      tool: "write_file",
      argsHash: "a".repeat(64),
      isError: false,
      resultSummary: "ok",
      resultHash: "b".repeat(64),
      resultBytes: 12,
      truncated: false,
      structuredHash: "c".repeat(64),
      serverEvidence: { value: { path: "x" }, bytes: 12, hash: "d".repeat(64), truncated: false },
    },
  });
  const revived: unknown = JSON.parse(JSON.stringify(withMcp));
  assert.ok(Value.Check(ReceiptSchema, revived));
  assert.deepStrictEqual(revived, withMcp);
  const bad = { ...withMcp, mcp: { ...withMcp.mcp, argsHash: "short" } };
  assert.ok(!Value.Check(ReceiptSchema, bad));
});

test("迁移链：v4 → v5 仅升版本，exec 等既有字段逐一保留", () => {
  const legacy = {
    ...receipt(),
    version: 4,
    exec: {
      command: "node -v",
      argv: ["node", "-v"],
      launcher: false,
      shell: false,
      exitCode: 0,
      timedOut: false,
      outputBytes: 3,
      outputHash: "e".repeat(64),
      output: "v24",
      truncated: false,
      fileChanges: { added: [], removed: [], modified: [], truncated: false },
    },
  };
  const migrated = migrateReceiptToCurrent(legacy);
  assert.equal(migrated.version, 5);
  assert.equal(migrated.exec?.output, "v24");
  assert.equal(migrated.mcp, undefined);
});
