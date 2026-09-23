// Event Log 内嵌 receipt 的读路径迁移（M5.7 S3，决策 053）：receipt 升 v5 时事件记录升 v8，v7 → v8 一步把内嵌
// receipt 经其迁移链升到当前版本——此前各版本的会话文件（含 v6 记录里的 v3 receipt、v7 记录里的 v4 receipt）
// 都能读回，不被当成日志损坏。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EVENT_LOG_VERSION } from "../state/event-log.ts";
import { newEntryId, newExecutionId, newReceiptId, newRunId, newSessionId } from "../state/ids.ts";
import { RECEIPT_VERSION } from "../state/receipt.ts";
import { readEventLogFile } from "./event-log.ts";

function receiptBody(version: number) {
  return {
    version,
    id: newReceiptId(),
    executionId: newExecutionId(),
    toolCallId: "toolu_old",
    approvedBy: "human",
    executed: true,
    isError: false,
    startedAt: 1,
    finishedAt: 2,
    summary: "edit_file 执行完成",
    contentAfterHash: "0123456789abcdef",
  };
}

test("读路径迁移：v6 记录里的 v3 receipt 与 v7 记录里的 v4 receipt 都升到当前版本读回", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-receipt-migration-"));
  try {
    const sessionId = newSessionId();
    const runId = newRunId();
    const envelope = (version: number, timestamp: number) => ({
      version,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp,
    });
    const v6 = { ...envelope(6, 1), kind: "receipt", receipt: receiptBody(3) };
    const v7 = { ...envelope(7, 2), kind: "receipt", receipt: receiptBody(4) };
    const path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(v6)}\n${JSON.stringify(v7)}\n`, "utf8");
    const records = readEventLogFile(path);
    assert.equal(EVENT_LOG_VERSION, 17);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.version, EVENT_LOG_VERSION);
      assert.ok(record.kind === "receipt");
      assert.equal(record.receipt.version, RECEIPT_VERSION);
      assert.equal(record.receipt.contentAfterHash, "0123456789abcdef");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
