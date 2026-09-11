import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { newExecutionId, newReceiptId } from "./ids.ts";
import {
  migrateReceiptToCurrent,
  migrateReceiptV1toV2,
  RECEIPT_VERSION,
  type Receipt,
  ReceiptSchema,
} from "./receipt.ts";

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

test("Receipt v3：contentAfterHash（执行后实测目标内容哈希，M4 S2）可缺省、可往返", () => {
  const without = makeReceipt();
  assert.ok(Value.Check(ReceiptSchema, without));
  assert.equal(without.contentAfterHash, undefined);
  const withHash = makeReceipt({ contentAfterHash: "0123456789abcdef" });
  const revived: unknown = JSON.parse(JSON.stringify(withHash));
  assert.ok(Value.Check(ReceiptSchema, revived));
  assert.deepStrictEqual(revived, withHash);
});

test("迁移链：v1 → v3 逐级升级（v1→v2 补占位，v2→v3 仅升版本，新字段可缺省）", () => {
  const v3 = makeReceipt();
  const { approvedBy: _a, toolCallId: _t, ...rest } = v3;
  const legacy = { ...rest, version: 1 };

  const migrated = migrateReceiptToCurrent(legacy);
  assert.equal(migrated.version, RECEIPT_VERSION);
  assert.equal(migrated.id, v3.id);
  assert.equal(migrated.summary, v3.summary);
  assert.equal(migrated.approvedBy, "policy:auto");
  assert.equal(migrated.contentAfterHash, undefined);
});

test("迁移链：v2 → v3 仅升版本（contentAfterHash 可缺省），既有字段逐一保留", () => {
  const { contentAfterHash: _c, ...rest } = makeReceipt();
  const legacyV2 = { ...rest, version: 2 };
  const migrated = migrateReceiptToCurrent(legacyV2);
  assert.equal(migrated.version, RECEIPT_VERSION);
  assert.equal(migrated.id, legacyV2.id);
  assert.equal(migrated.approvedBy, "human");
  assert.equal(migrated.summary, legacyV2.summary);
});
