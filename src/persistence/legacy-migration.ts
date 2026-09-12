// D8：M3 旧 JSONL 账本的一次性迁移——M4 版首次启动检测旧账本文件，
// 逐行转换为 Event Log 记录（旧行内无 sessionId/runId：整个旧账本归入一个合成 session
// 与一个合成 run，M3 本就不记录 run 边界，迁移无法重建）→ 写入 .pigeon/sessions/
// 下对应 session 事件文件 → 旧文件改名 *.legacy.jsonl 物理保留、逻辑退役。
// 机制走 M0 迁移管线（MigrationRegistry）：旧账本整体视作 v0 文档，迁移到 v1 事件记录集，
// 输出经 EventRecordSchema 校验；receipt 行的 v1→v2 升级由 readLegacyLedger 内的
// "receipt" 迁移链承担（同一条管线的两段职责）。
// 迁移是启动期的 commit-point 语义：全部记录写完才改名旧文件；写盘中途失败旧文件原样保留，
// 下次启动重试（重试会生成新的合成 session——旧账本未持久化会话身份，无法幂等回指，
// 可接受代价：迁移只跑一次，改名成功后旧文件不再被检测）。
import { existsSync, renameSync } from "node:fs";
import { Type } from "typebox";
import {
  type DecisionRecord,
  EVENT_LOG_VERSION,
  type EventRecord,
  EventRecordSchema,
  type IntentRecord,
  type ReceiptRecord,
} from "../state/event-log.ts";
import { newEntryId, newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { MigrationRegistry } from "../state/migration.ts";
import { JsonlEventLog } from "./event-log.ts";
import { type LegacyLedgerRows, readLegacyLedger } from "./ledger.ts";

// 迁移管线输出文档：v1 = 排好序的事件记录集
const LegacyMigrationOutputSchema = Type.Object({
  version: Type.Literal(1),
  records: Type.Array(EventRecordSchema),
});

export interface LegacyMigrationResult {
  // 是否执行了迁移（旧账本不存在 = false，纯 no-op）
  migrated: boolean;
  legacyPath: string;
  // 改名后的归档路径（*.legacy.jsonl）；仅 migrated=true 时有值
  archivedPath?: string;
  // 旧账本归入的合成 session 及其事件文件；空账本（0 记录）不落文件，两者缺省
  sessionId?: SessionId;
  eventFile?: string;
  recordCount: number;
}

// 迁移入口：legacyPath 是 M3 默认账本单位置（<工作区根>/.pigeon/ledger.jsonl），
// sessionsDir 是 D1 布局目录（<工作区根>/.pigeon/sessions）
export function migrateLegacyLedger(
  legacyPath: string,
  sessionsDir: string
): LegacyMigrationResult {
  if (!existsSync(legacyPath)) {
    return { migrated: false, legacyPath, recordCount: 0 };
  }
  // 读旧账本：torn tail 容忍、receipt v1→v2 经迁移链升级；损坏响亮失败（不迁移坏数据）
  const rows = readLegacyLedger(legacyPath);
  const recordTotal = rows.intents.length + rows.decisions.length + rows.receipts.length;
  const archivedPath = `${legacyPath.replace(/\.jsonl$/, "")}.legacy.jsonl`;
  if (recordTotal === 0) {
    // 空账本：无记录可迁，直接归档退役
    renameSync(legacyPath, archivedPath);
    return { migrated: true, legacyPath, archivedPath, recordCount: 0 };
  }

  // 整个旧账本归入一个合成 session / 一个合成 run（M3 行内无 sessionId/runId，见文件头注释）
  const sessionId = newSessionId();
  const runId = newRunId();
  const records = convertRows(rows, sessionId, runId);

  const log = new JsonlEventLog(sessionsDir, sessionId);
  try {
    for (const record of records) {
      log.appendRecord(record);
    }
  } finally {
    log.close();
  }
  // commit point：事件文件写齐后才改名退役旧文件
  renameSync(legacyPath, archivedPath);
  return {
    migrated: true,
    legacyPath,
    archivedPath,
    sessionId,
    eventFile: log.path,
    recordCount: records.length,
  };
}

// 旧账本行 → 事件记录：经 M0 迁移管线承载（注册 "legacy-ledger" v0→v1 迁移）。
// 迁移函数按 Migration 约定是纯文档变换；合成 sessionId/runId 由闭包注入
// （每次调用新建 Registry，避免跨调用的身份串扰）
function convertRows(rows: LegacyLedgerRows, sessionId: SessionId, runId: RunId): EventRecord[] {
  const registry = new MigrationRegistry();
  registry.register("legacy-ledger", 0, (doc) => {
    const input = doc as unknown as { rows: LegacyLedgerRows };
    const records: EventRecord[] = [
      ...input.rows.intents.map(
        (row): IntentRecord => ({
          ...envelope(sessionId, runId, row.at),
          kind: "intent",
          executionId: row.executionId,
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          rawArgs: row.rawArgs,
          decision: row.decision,
          at: row.at,
        })
      ),
      ...input.rows.decisions.map(
        (row): DecisionRecord => ({
          ...envelope(sessionId, runId, row.at),
          kind: "decision",
          executionId: row.executionId,
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          rawArgs: row.rawArgs,
          decision: row.decision,
          at: row.at,
        })
      ),
      ...input.rows.receipts.map(
        (receipt): ReceiptRecord => ({
          ...envelope(sessionId, runId, receipt.finishedAt),
          kind: "receipt",
          receipt,
        })
      ),
    ];
    // 按业务时间戳排序：保持"intent/decision 在前、receipt 在后"的因果序，事件文件即时间线
    records.sort((a, b) => a.timestamp - b.timestamp);
    return { version: 1, records };
  });
  const output = registry.migrate(
    "legacy-ledger",
    { version: 0, rows },
    1,
    LegacyMigrationOutputSchema
  );
  return output.records;
}

// 迁移记录的信封：版本/EntryId/时间戳在此盖章（时间戳沿用业务时刻，不用迁移时刻——
// 事件语义是"那次调用发生的时间"，不是"这条记录被搬迁的时间"）
function envelope(sessionId: SessionId, runId: RunId, timestamp: number) {
  return { version: EVENT_LOG_VERSION, id: newEntryId(), sessionId, runId, timestamp } as const;
}
