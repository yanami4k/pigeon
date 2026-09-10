import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { newExecutionId, newReceiptId } from "./ids.ts";
import { MigrationRegistry } from "./migration.ts";
import { migrateReceiptV1toV2, RECEIPT_VERSION, type Receipt, ReceiptSchema } from "./receipt.ts";

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId: newExecutionId(),
    toolCallId: "toolu_01ABC",
    // 审批来源（决策 4：human / policy:yolo / policy:auto / policy:deny）
    approvedBy: "human",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_000,
    finishedAt: 1_757_000_000_123,
    summary: "写入 src/state/ids.ts",
    ...overrides,
  };
}

test("Receipt JSON 往返后深度相等且校验通过", () => {
  const receipt = makeReceipt();
  const revived: unknown = JSON.parse(JSON.stringify(receipt));
  assert.ok(Value.Check(ReceiptSchema, revived));
  assert.deepStrictEqual(revived, receipt);
});

test("executed=false 的回执（Rejected/参数非法/执行前取消）合法", () => {
  const receipt = makeReceipt({ executed: false, summary: "审批拒绝，副作用未发生" });
  assert.ok(Value.Check(ReceiptSchema, receipt));
});

test("executed 非布尔被拒绝", () => {
  const bad = { ...makeReceipt(), executed: "yes" };
  assert.ok(!Value.Check(ReceiptSchema, bad));
});

test("version 不符被拒绝", () => {
  const bad = { ...makeReceipt(), version: RECEIPT_VERSION + 1 };
  assert.ok(!Value.Check(ReceiptSchema, bad));
});

test("approvedBy 缺失或越界被拒绝（批准来源是必备证据）", () => {
  const { approvedBy: _, ...missing } = makeReceipt();
  assert.ok(!Value.Check(ReceiptSchema, missing));
  assert.ok(!Value.Check(ReceiptSchema, makeReceipt({ approvedBy: "robot" as never })));
  for (const approvedBy of ["human", "policy:yolo", "policy:auto", "policy:deny"] as const) {
    assert.ok(Value.Check(ReceiptSchema, makeReceipt({ approvedBy })), approvedBy);
  }
});

test("v1 → v2 迁移：补 approvedBy/toolCallId 占位，其余字段不变", () => {
  const v2 = makeReceipt();
  const { approvedBy: _a, toolCallId: _t, ...v1 } = v2;
  const legacy = { ...v1, version: 1 };

  const registry = new MigrationRegistry();
  registry.register("receipt", 1, migrateReceiptV1toV2);
  const migrated = registry.migrate("receipt", legacy, 2, ReceiptSchema);

  assert.equal(migrated.version, 2);
  assert.equal(migrated.id, v2.id);
  assert.equal(migrated.summary, v2.summary);
  assert.equal(migrated.approvedBy, "policy:auto");
});
