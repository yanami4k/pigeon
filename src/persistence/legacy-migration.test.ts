// D8 旧账本一次性迁移测试：M3 JSONL 账本 → Event Log 治理族记录，
// 旧文件改名 *.legacy.jsonl 物理保留；迁移经 M0 迁移管线（legacy-ledger v0→v1 +
// receipt v1→v2 链），重跑 no-op。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newExecutionId, newReceiptId } from "../state/ids.ts";
import { RECEIPT_VERSION } from "../state/receipt.ts";
import { JsonlEventLog, materializeSession } from "./event-log.ts";
import type { LedgerDecision, LedgerIntent } from "./ledger.ts";
import { migrateLegacyLedger } from "./legacy-migration.ts";

function makeIntentRow(overrides: Partial<LedgerIntent> = {}): LedgerIntent {
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

function makeDecisionRow(overrides: Partial<LedgerDecision> = {}): LedgerDecision {
  return {
    kind: "decision",
    version: 1,
    executionId: newExecutionId(),
    toolCallId: "toolu_01DEF",
    toolName: "edit_file",
    rawArgs: { path: "b.ts", edits: [] },
    decision: {
      outcome: "rejected",
      approvedBy: "human",
      reason: "会破坏现有逻辑",
      decidedAt: 1_757_000_000_011,
    },
    at: 1_757_000_000_010,
    ...overrides,
  };
}

function makeReceiptRow(executionId: LedgerIntent["executionId"]) {
  return {
    kind: "receipt",
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
  };
}

function makeWorkspace(rows: unknown[]): {
  legacyPath: string;
  sessionsDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pigeon-migrate-"));
  const legacyPath = join(root, "ledger.jsonl");
  writeFileSync(
    legacyPath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""),
    "utf8"
  );
  return {
    legacyPath,
    sessionsDir: join(root, "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("旧账本不存在 = no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-migrate-"));
  try {
    const result = migrateLegacyLedger(join(root, "ledger.jsonl"), join(root, "sessions"));
    assert.equal(result.migrated, false);
    assert.equal(result.recordCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("三族行迁为事件记录：对账分类保持 M3 语义，旧文件改名保留，重跑 no-op", () => {
  const intent = makeIntentRow();
  const receipt = makeReceiptRow(intent.executionId);
  const decision = makeDecisionRow();
  // v1 receipt（孤立）：走 receipt 迁移链升级，落为 orphanReceipt
  const orphanV1 = {
    kind: "receipt",
    version: 1,
    id: newReceiptId(),
    executionId: newExecutionId(),
    executed: false,
    isError: false,
    startedAt: 1_757_000_000_020,
    finishedAt: 1_757_000_000_021,
    summary: "旧格式回执",
  };
  const { legacyPath, sessionsDir, cleanup } = makeWorkspace([intent, receipt, decision, orphanV1]);
  try {
    const legacyContent = readFileSync(legacyPath, "utf8");
    const result = migrateLegacyLedger(legacyPath, sessionsDir);
    assert.equal(result.migrated, true);
    assert.equal(result.recordCount, 4);

    // 旧文件物理保留、逻辑退役
    assert.equal(existsSync(legacyPath), false);
    assert.ok(result.archivedPath?.endsWith(".legacy.jsonl"));
    assert.equal(readFileSync(result.archivedPath as string, "utf8"), legacyContent);

    // 事件文件落在 D1 布局路径，冷物化对账 = M3 分类语义
    assert.ok(result.sessionId);
    assert.equal(result.eventFile, JsonlEventLog.filePathFor(sessionsDir, result.sessionId));
    const materialized = materializeSession(sessionsDir, result.sessionId);
    assert.equal(materialized.records.length, 4);
    assert.equal(materialized.reconcile.settled.length, 1);
    assert.equal(materialized.reconcile.settled[0]?.intent.executionId, intent.executionId);
    assert.equal(materialized.reconcile.unknown.length, 0);
    assert.equal(materialized.reconcile.rejected.length, 1);
    assert.equal(materialized.reconcile.rejected[0]?.decision.decision.reason, "会破坏现有逻辑");
    // v1 receipt 经迁移链升级（占位字段）且归入孤立 receipt
    assert.equal(materialized.reconcile.orphanReceipts.length, 1);
    const orphan = materialized.reconcile.orphanReceipts[0];
    assert.equal(orphan?.version, RECEIPT_VERSION);
    assert.equal(orphan?.toolCallId, "legacy-v1");
    assert.equal(orphan?.approvedBy, "policy:auto");

    // 记录信封：合成 session/run，时间戳沿用业务时刻（receipt 取 finishedAt）
    const migratedIntent = materialized.intents[0];
    assert.equal(migratedIntent?.sessionId, result.sessionId);
    assert.equal(migratedIntent?.timestamp, intent.at);
    const migratedReceipt = materialized.records.find(
      (record) => record.kind === "receipt" && record.receipt.executionId === intent.executionId
    );
    assert.equal(migratedReceipt?.timestamp, receipt.finishedAt);
    // 因果序：intent(at) < receipt(finishedAt) < decision(at) 之后排序稳定
    const kinds = materialized.records.map((record) => record.kind);
    assert.ok(kinds.indexOf("intent") < kinds.lastIndexOf("receipt"));

    // 重跑 no-op：旧文件已退役，不再产生第二份迁移
    const second = migrateLegacyLedger(legacyPath, sessionsDir);
    assert.equal(second.migrated, false);
  } finally {
    cleanup();
  }
});

test("空账本：无记录可迁，直接归档退役，不落事件文件", () => {
  const { legacyPath, sessionsDir, cleanup } = makeWorkspace([]);
  try {
    const result = migrateLegacyLedger(legacyPath, sessionsDir);
    assert.equal(result.migrated, true);
    assert.equal(result.recordCount, 0);
    assert.equal(existsSync(legacyPath), false);
    assert.ok(result.archivedPath && existsSync(result.archivedPath));
    assert.equal(result.sessionId, undefined);
    assert.equal(existsSync(sessionsDir), false);
  } finally {
    cleanup();
  }
});
