// M3 旧账本只读解析器（readLegacyLedger）测试：D8 迁移的唯一读取入口。
// 写盘路径已随 JsonlLedger 退役（M4 S1 起一切写入走 JsonlEventLog），此处只保解析语义：
// torn tail 容忍、损坏响亮失败、receipt v1→v2 迁移链、同族重复 executionId 拒绝。
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newExecutionId, newReceiptId } from "../state/ids.ts";
import { RECEIPT_VERSION, type Receipt } from "../state/receipt.ts";
import {
  LedgerCorruptionError,
  type LedgerDecision,
  type LedgerIntent,
  readLegacyLedger,
} from "./ledger.ts";

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

function makeDecision(overrides: Partial<LedgerDecision> = {}): LedgerDecision {
  return {
    kind: "decision",
    version: 1,
    executionId: newExecutionId(),
    toolCallId: "toolu_01ABC",
    toolName: "edit_file",
    rawArgs: { path: "a.ts", edits: [] },
    decision: {
      outcome: "rejected",
      approvedBy: "policy:deny",
      reason: "deny 清单精确匹配",
      decidedAt: 1_757_000_000_001,
    },
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

function makeLegacyFile(lines: unknown[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ledger-"));
  const path = join(dir, "ledger.jsonl");
  writeFileSync(
    path,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") +
      (lines.length > 0 ? "\n" : ""),
    "utf8"
  );
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("三族按行解析：intent/decision/receipt 全量读回，逐字保留拒绝理由", () => {
  const intent = makeIntent();
  const decision = makeDecision({
    decision: {
      outcome: "rejected",
      approvedBy: "human",
      reason: "会破坏现有逻辑",
      decidedAt: 1_757_000_000_001,
    },
  });
  const receipt = makeReceipt(intent.executionId);
  const { path, cleanup } = makeLegacyFile([intent, decision, { kind: "receipt", ...receipt }]);
  try {
    const rows = readLegacyLedger(path);
    assert.deepEqual(rows.intents, [intent]);
    assert.deepEqual(rows.decisions, [decision]);
    assert.equal(rows.decisions[0]?.decision.reason, "会破坏现有逻辑");
    assert.deepEqual(rows.receipts, [receipt]);
  } finally {
    cleanup();
  }
});

test("torn tail 容忍：半截末行按「未持久化」处理；中间坏行响亮失败", () => {
  const intent = makeIntent();
  const { path, cleanup } = makeLegacyFile([intent]);
  try {
    appendFileSync(path, '{"kind":"receipt","version":2,"id":"rcpt_', "utf8");
    const rows = readLegacyLedger(path);
    assert.equal(rows.intents.length, 1);
    assert.equal(rows.receipts.length, 0);

    appendFileSync(path, "这不是 JSON\n", "utf8");
    appendFileSync(path, `${JSON.stringify(makeIntent())}\n`, "utf8");
    assert.throws(() => readLegacyLedger(path), LedgerCorruptionError);
  } finally {
    cleanup();
  }
});

test("同族重复 executionId / 未知 kind / 缺 kind 一律响亮失败（账本损坏不猜测）", () => {
  const intent = makeIntent();
  const { path, cleanup } = makeLegacyFile([intent, intent]);
  try {
    assert.throws(() => readLegacyLedger(path), /重复 intent/);
  } finally {
    cleanup();
  }
  const unknown = makeLegacyFile([{ kind: "grant", version: 1 }]);
  try {
    assert.throws(() => readLegacyLedger(unknown.path), /未知 kind/);
  } finally {
    unknown.cleanup();
  }
  const noKind = makeLegacyFile([{ version: 1 }]);
  try {
    assert.throws(() => readLegacyLedger(noKind.path), /缺少 kind/);
  } finally {
    noKind.cleanup();
  }
});

test("receipt v1 行经迁移管线升级 v2：占位字段与 Receipt v1→v2 迁移语义一致", () => {
  const executionId = newExecutionId();
  // v1 Receipt：无 toolCallId / approvedBy（M0 占位版本，从未被真实路径持久化）
  const legacyReceipt = {
    kind: "receipt",
    version: 1,
    id: newReceiptId(),
    executionId,
    executed: true,
    isError: false,
    startedAt: 1_757_000_000_000,
    finishedAt: 1_757_000_000_123,
    summary: "编辑 a.ts",
  };
  const { path, cleanup } = makeLegacyFile([legacyReceipt]);
  try {
    const rows = readLegacyLedger(path);
    assert.equal(rows.receipts.length, 1);
    const receipt = rows.receipts[0];
    assert.equal(receipt?.version, RECEIPT_VERSION);
    // 迁移占位语义（state/receipt.ts migrateReceiptV1toV2）
    assert.equal(receipt?.toolCallId, "legacy-v1");
    assert.equal(receipt?.approvedBy, "policy:auto");
    assert.equal(receipt?.executionId, executionId);
  } finally {
    cleanup();
  }
});

test("缺失文件 = 空结果（不是损坏）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-ledger-"));
  try {
    const rows = readLegacyLedger(join(dir, "ledger.jsonl"));
    assert.equal(rows.intents.length, 0);
    assert.equal(rows.decisions.length, 0);
    assert.equal(rows.receipts.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
