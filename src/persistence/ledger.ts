// M3 旧 JSONL 账本的只读解析器（D8：M4 首次启动一次性迁移的唯一读取方）。
// 旧账本三记录族——intent（dispatch 前写）、decision（拒绝时写，理由逐字留证）、
// receipt（tool_execution_end 后写）；行内无 sessionId/runId（M3 未记录），
// 迁移时由 legacy-migration.ts 归并进 Event Log（决策 2：不双写）。
// JsonlLedger 类已于 M4 S1 退役：所有新写入走 JsonlEventLog，此处只保留旧格式解析
// 与 receipt v1→v2 迁移链（M0 迁移管线的首个真实跨代使用）。
import { existsSync, readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ExecutionIdSchema } from "../state/ids.ts";
import { MigrationRegistry } from "../state/migration.ts";
import {
  migrateReceiptV1toV2,
  RECEIPT_VERSION,
  type Receipt,
  ReceiptSchema,
} from "../state/receipt.ts";
import { ToolExecutionDecisionSchema } from "../state/tool-execution.ts";

export const LEDGER_INTENT_VERSION = 1;
export const LEDGER_DECISION_VERSION = 1;

// intent：调用前持久化意图（§3.2：副作用 = 稳定 ExecutionId + 调用前意图 + 调用后 Receipt）
export const LedgerIntentSchema = Type.Object({
  kind: Type.Literal("intent"),
  version: Type.Literal(LEDGER_INTENT_VERSION),
  executionId: ExecutionIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  // 模型原始参数快照（与 ToolExecution.rawArgs 同源，spike S5）
  rawArgs: Type.Unknown(),
  // 批准决定快照（含 approvedBy，决策 4 证据链）
  decision: ToolExecutionDecisionSchema,
  at: Type.Integer({ minimum: 0 }),
});
export type LedgerIntent = Static<typeof LedgerIntentSchema>;

// decision：拒绝决定落盘（决策 4 证据链）——拒绝路径不写 intent（dispatch 前才写），
// 若没有 decision 行，拒绝理由只活在内存里、进程退出即蒸发。形状与 LedgerIntent 对齐
export const LedgerDecisionSchema = Type.Object({
  kind: Type.Literal("decision"),
  version: Type.Literal(LEDGER_DECISION_VERSION),
  executionId: ExecutionIdSchema,
  toolCallId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
  // 模型原始参数快照（与 ToolExecution.rawArgs 同源，spike S5）
  rawArgs: Type.Unknown(),
  // 拒绝决定快照（含 approvedBy 与逐字理由，决策 4 证据链）
  decision: ToolExecutionDecisionSchema,
  at: Type.Integer({ minimum: 0 }),
});
export type LedgerDecision = Static<typeof LedgerDecisionSchema>;

export class LedgerCorruptionError extends Error {}

// 旧账本的全量解析结果（按族分列，行序不保留——对账本就不依赖行序）
export interface LegacyLedgerRows {
  intents: LedgerIntent[];
  decisions: LedgerDecision[];
  receipts: Receipt[];
}

// receipt 行的迁移管线：v1 → v2（M0 管线的首个真实使用方，D8 迁移时经此升级）
const receiptMigrations = new MigrationRegistry();
receiptMigrations.register("receipt", 1, migrateReceiptV1toV2);

// 解析 M3 旧账本文件：全量读 + 逐行校验。torn tail 容忍（半截末行视为未写入）；
// 非末行损坏、未知 kind、同族重复 executionId 一律响亮失败（账本损坏不猜测）
export function readLegacyLedger(path: string): LegacyLedgerRows {
  const rows: LegacyLedgerRows = { intents: [], decisions: [], receipts: [] };
  if (!existsSync(path)) {
    return rows;
  }
  const intentIds = new Set<string>();
  const decisionIds = new Set<string>();
  const receiptIds = new Set<string>();
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) {
        break; // torn tail：半截末行视为未写入
      }
      throw new LedgerCorruptionError(`账本损坏：${path} 第 ${index + 1} 行不是合法 JSON`);
    }
    if (typeof record !== "object" || record === null || !("kind" in record)) {
      throw new LedgerCorruptionError(`账本损坏：${path} 第 ${index + 1} 行缺少 kind`);
    }
    const { kind, ...fields } = record as { kind: unknown } & Record<string, unknown>;
    if (kind === "intent") {
      const intent = Value.Parse(LedgerIntentSchema, { kind, ...fields });
      if (intentIds.has(intent.executionId)) {
        throw new LedgerCorruptionError(`账本损坏：重复 intent ${intent.executionId}`);
      }
      intentIds.add(intent.executionId);
      rows.intents.push(intent);
      continue;
    }
    if (kind === "decision") {
      const decision = Value.Parse(LedgerDecisionSchema, { kind, ...fields });
      if (decisionIds.has(decision.executionId)) {
        throw new LedgerCorruptionError(`账本损坏：重复 decision ${decision.executionId}`);
      }
      decisionIds.add(decision.executionId);
      rows.decisions.push(decision);
      continue;
    }
    if (kind === "receipt") {
      // 经迁移管线升级到当前 Receipt 版本再校验
      const receipt = receiptMigrations.migrate("receipt", fields, RECEIPT_VERSION, ReceiptSchema);
      if (receiptIds.has(receipt.executionId)) {
        throw new LedgerCorruptionError(`账本损坏：重复 receipt ${receipt.executionId}`);
      }
      receiptIds.add(receipt.executionId);
      rows.receipts.push(receipt);
      continue;
    }
    throw new LedgerCorruptionError(
      `账本损坏：${path} 第 ${index + 1} 行未知 kind ${String(kind)}`
    );
  }
  return rows;
}
