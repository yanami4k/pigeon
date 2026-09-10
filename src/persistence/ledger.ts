// JSONL 执行账本（ROADMAP §3.2）：append-only，两条记录族——
//   intent（dispatch 前写：谁在何时被批准做什么）与 receipt（tool_execution_end 后写：结果如何）。
// M3 最小账本：同步写、单行一条 JSON；持久化 Session/Trace 是 M4。
// 冷启动恢复 = 全量读 + 按 executionId 对账（reconcile）；intent 无 receipt = OutcomeUnknown，
// 只标记留证，任何路径不得自动重放（§3.2 禁止盲重放）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

// 对账报告：pairing 按 executionId
export interface ReconcileEntry {
  intent: LedgerIntent;
  receipt?: Receipt;
}
export interface ReconcileReport {
  // intent + receipt 配对完成
  settled: ReconcileEntry[];
  // intent 无 receipt：死于 dispatch/execute/receipt 任一窗口——副作用是否发生未知（OutcomeUnknown）
  unknown: ReconcileEntry[];
  // receipt 无 intent：账本损坏或手写——如实报告，不猜测
  orphanReceipts: Receipt[];
}

export class LedgerConflictError extends Error {}
export class LedgerCorruptionError extends Error {}

// receipt 行的迁移管线：v1 → v2（首个真实使用迁移管线的读取方）
const receiptMigrations = new MigrationRegistry();
receiptMigrations.register("receipt", 1, migrateReceiptV1toV2);

export class JsonlLedger {
  readonly #path: string;
  // 已写入的 executionId 索引（幂等判定）；构造时从磁盘恢复
  readonly #intentIds = new Set<string>();
  readonly #receiptIds = new Set<string>();
  readonly #intents: LedgerIntent[] = [];
  readonly #receipts: Receipt[] = [];

  constructor(path: string) {
    this.#path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(path)) {
      writeFileSync(path, "", "utf8");
      return;
    }
    // 冷启动恢复：全量读。进程死于写盘中途会留下半截末行——按"未持久化"容忍；
    // 非末行损坏说明账本被外部破坏，响亮失败。
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
      this.#ingest(record, path, index);
    }
  }

  // 幂等：同一 executionId 重复写一律冲突拒绝（可检测）。
  // 选"冲突拒绝"而非"静默去重"：ExecutionId 由 Pigeon 生成且唯一，
  // 重复出现即逻辑错误或重放嫌疑，必须响亮失败而不是悄悄吞掉（§3.2 不盲重放）。
  appendIntent(intent: LedgerIntent): void {
    const parsed = Value.Parse(LedgerIntentSchema, intent);
    if (this.#intentIds.has(parsed.executionId)) {
      throw new LedgerConflictError(`重复 intent：${parsed.executionId}`);
    }
    appendFileSync(this.#path, `${JSON.stringify(parsed)}\n`, "utf8");
    this.#intentIds.add(parsed.executionId);
    this.#intents.push(parsed);
  }

  appendReceipt(receipt: Receipt): void {
    const parsed = Value.Parse(ReceiptSchema, receipt);
    if (this.#receiptIds.has(parsed.executionId)) {
      throw new LedgerConflictError(`重复 receipt：${parsed.executionId}`);
    }
    appendFileSync(this.#path, `${JSON.stringify({ kind: "receipt", ...parsed })}\n`, "utf8");
    this.#receiptIds.add(parsed.executionId);
    this.#receipts.push(parsed);
  }

  // 冷启动对账：intent 无 receipt → OutcomeUnknown（只留证，不重放）
  reconcile(): ReconcileReport {
    const receiptByExecution = new Map(this.#receipts.map((r) => [r.executionId, r]));
    const settled: ReconcileEntry[] = [];
    const unknown: ReconcileEntry[] = [];
    for (const intent of this.#intents) {
      const receipt = receiptByExecution.get(intent.executionId);
      receiptByExecution.delete(intent.executionId);
      if (receipt === undefined) {
        unknown.push({ intent });
      } else {
        settled.push({ intent, receipt });
      }
    }
    return { settled, unknown, orphanReceipts: [...receiptByExecution.values()] };
  }

  #ingest(record: unknown, path: string, index: number): void {
    if (typeof record !== "object" || record === null || !("kind" in record)) {
      throw new LedgerCorruptionError(`账本损坏：${path} 第 ${index + 1} 行缺少 kind`);
    }
    const { kind, ...fields } = record as { kind: unknown } & Record<string, unknown>;
    if (kind === "intent") {
      const intent = Value.Parse(LedgerIntentSchema, { kind, ...fields });
      if (this.#intentIds.has(intent.executionId)) {
        throw new LedgerCorruptionError(`账本损坏：重复 intent ${intent.executionId}`);
      }
      this.#intentIds.add(intent.executionId);
      this.#intents.push(intent);
      return;
    }
    if (kind === "receipt") {
      // 经迁移管线升级到当前 Receipt 版本再校验
      const receipt = receiptMigrations.migrate("receipt", fields, RECEIPT_VERSION, ReceiptSchema);
      if (this.#receiptIds.has(receipt.executionId)) {
        throw new LedgerCorruptionError(`账本损坏：重复 receipt ${receipt.executionId}`);
      }
      this.#receiptIds.add(receipt.executionId);
      this.#receipts.push(receipt);
      return;
    }
    throw new LedgerCorruptionError(
      `账本损坏：${path} 第 ${index + 1} 行未知 kind ${String(kind)}`
    );
  }
}
