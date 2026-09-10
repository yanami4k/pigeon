import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newExecutionId, newReceiptId } from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import { JsonlLedger, LedgerConflictError, type LedgerIntent } from "./ledger.ts";

function makeIntent(overrides: Partial<LedgerIntent> = {}): LedgerIntent {
  return {
    kind: "intent",
    version: 1,
    executionId: newExecutionId(),
    toolCallId: "toolu_01ABC",
    toolName: "edit_file",
    rawArgs: { path: "a.ts", edits: [] },
    decision: { outcome: "approved", approvedBy: "human", decidedAt: 1_757_000_000_001 },
    at: 1_757_000_000_000,
    ...overrides,
  };
}

function makeReceipt(
  executionId: LedgerIntent["executionId"],
  overrides: Partial<Receipt> = {}
): Receipt {
  return {
    version: RECEIPT_VERSION,
    id: newReceiptId(),
    executionId,
    toolCallId: "toolu_01ABC",
    approvedBy: "human",
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_000,
    finishedAt: 1_757_000_000_123,
    summary: "编辑 a.ts",
    ...overrides,
  };
}

function makeLedger(): { ledger: JsonlLedger; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ledger-"));
  const path = join(dir, "ledger.jsonl");
  return {
    ledger: new JsonlLedger(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("append + 冷启动全量读：intent 与 receipt 按行持久化，新实例可恢复", () => {
  const { ledger, path, cleanup } = makeLedger();
  try {
    const intent = makeIntent();
    const receipt = makeReceipt(intent.executionId);
    ledger.appendIntent(intent);
    ledger.appendReceipt(receipt);

    // 文件内容是可逐行解析的 JSONL
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] as string), intent);
    assert.deepEqual(JSON.parse(lines[1] as string), { kind: "receipt", ...receipt });

    // 新实例冷启动恢复
    const revived = new JsonlLedger(path);
    const report = revived.reconcile();
    assert.equal(report.unknown.length, 0);
    assert.equal(report.orphanReceipts.length, 0);
    assert.equal(report.settled.length, 1);
    assert.deepEqual(report.settled[0]?.intent, intent);
    assert.deepEqual(report.settled[0]?.receipt, receipt);
  } finally {
    cleanup();
  }
});

test("幂等：同一 executionId 重复写 intent/receipt 一律冲突拒绝（可检测，不静默去重）", () => {
  const { ledger, path, cleanup } = makeLedger();
  try {
    const intent = makeIntent();
    ledger.appendIntent(intent);
    ledger.appendReceipt(makeReceipt(intent.executionId));
    assert.throws(() => ledger.appendIntent(intent), LedgerConflictError);
    assert.throws(() => ledger.appendReceipt(makeReceipt(intent.executionId)), LedgerConflictError);
    // 冲突拒绝不产生新行
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  } finally {
    cleanup();
  }
});

test("对账：intent 无 receipt → OutcomeUnknown（留证，不重放）；孤立 receipt 如实报告", () => {
  const { ledger, cleanup } = makeLedger();
  try {
    const orphan = makeReceipt(newExecutionId());
    ledger.appendReceipt(orphan);
    const crashed = makeIntent();
    ledger.appendIntent(crashed);

    const report = ledger.reconcile();
    assert.equal(report.settled.length, 0);
    assert.equal(report.unknown.length, 1);
    assert.deepEqual(report.unknown[0]?.intent, crashed);
    assert.equal(report.unknown[0]?.receipt, undefined);
    assert.equal(report.orphanReceipts.length, 1);
    assert.deepEqual(report.orphanReceipts[0], orphan);
  } finally {
    cleanup();
  }
});

test("torn tail 容忍：进程死于写盘中途留下的半截末行按「未持久化」处理，中间坏行报错", () => {
  const { ledger, path, cleanup } = makeLedger();
  try {
    const intent = makeIntent();
    ledger.appendIntent(intent);
    // 模拟半截写入的 receipt 行
    appendFileSync(path, '{"kind":"receipt","version":2,"id":"rcpt_', "utf8");

    const report = new JsonlLedger(path).reconcile();
    // 半截 receipt 视为不存在 → intent 落入 OutcomeUnknown
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0]?.intent.executionId, intent.executionId);
  } finally {
    cleanup();
  }
});

test("坏行（非末尾）拒绝启动：账本损坏必须响亮失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ledger-"));
  const path = join(dir, "ledger.jsonl");
  try {
    const intent = makeIntent();
    appendFileSync(path, `${JSON.stringify(intent)}\n`, "utf8");
    appendFileSync(path, "这不是 JSON\n", "utf8");
    appendFileSync(path, `${JSON.stringify(makeIntent())}\n`, "utf8");
    assert.throws(() => new JsonlLedger(path), /损坏/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intent 记录必填字段缺失被拒绝（写入即校验）", () => {
  const { ledger, cleanup } = makeLedger();
  try {
    const bad = { ...makeIntent(), decision: { outcome: "approved", approvedBy: "robot" } };
    assert.throws(() => ledger.appendIntent(bad as never));
  } finally {
    cleanup();
  }
});
