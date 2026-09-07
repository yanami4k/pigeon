import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { newExecutionId, newReceiptId } from "./ids.ts";
import { RECEIPT_VERSION, type Receipt, ReceiptSchema } from "./receipt.ts";

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId: newExecutionId(),
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
