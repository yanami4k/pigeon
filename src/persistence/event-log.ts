// Event Log 存储引擎（M4 S1，D1/D2）：每 session 一文件 `.pigeon/sessions/sess_<ulid>.jsonl`，
// 逐条同步写、治理族 fsync、按 executionId 的幂等索引（构造时从磁盘恢复）、撕裂尾巴容忍。
// M5 S1（决策 037）：旁置内容文件 `sess_<ulid>.messages.jsonl` 存消息正文，entry 带 contentHash
// 回指；写序先内容后 entry，均观察族耐久（同步写不 fsync）。构造时不读内容文件（冷启动零增量）。
// 记录族 schema 在 state/event-log.ts 与 state/message-content.ts；冷物化的纯函数在
// state/materialize.ts，本文件的 materializeSession = 读文件 + materializeRecords。
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  type BreakerInput,
  type BreakerRecord,
  BreakerRecordSchema,
  type CandidateProposedInput,
  type CandidateProposedRecord,
  CandidateProposedRecordSchema,
  type CandidateScreenedInput,
  type CandidateScreenedRecord,
  CandidateScreenedRecordSchema,
  type ChildSettledInput,
  type ChildSettledRecord,
  ChildSettledRecordSchema,
  type ChildSpawnedInput,
  type ChildSpawnedRecord,
  ChildSpawnedRecordSchema,
  type DecisionInput,
  type DecisionRecord,
  DecisionRecordSchema,
  type EntryAppendInput,
  type EntryRecord,
  EntryRecordSchema,
  EVENT_LOG_VERSION,
  type EventRecord,
  EventRecordSchema,
  type GrantConfigRemovedInput,
  type GrantConfigRemovedRecord,
  GrantConfigRemovedRecordSchema,
  type GrantCreatedInput,
  type GrantCreatedRecord,
  GrantCreatedRecordSchema,
  type GrantPromotedInput,
  type GrantPromotedRecord,
  GrantPromotedRecordSchema,
  type GrantRevokedInput,
  type GrantRevokedRecord,
  GrantRevokedRecordSchema,
  type IntentInput,
  type IntentRecord,
  IntentRecordSchema,
  type ObservationInput,
  type ObservationRecord,
  ObservationRecordSchema,
  parseEventRecord,
  type ReceiptInput,
  type ReceiptRecord,
  ReceiptRecordSchema,
  type ResolutionInput,
  type ResolutionRecord,
  ResolutionRecordSchema,
  type RuntimeEventRecord,
  RuntimeEventRecordSchema,
  type SessionHeaderInput,
  type SessionHeaderRecord,
  SessionHeaderRecordSchema,
} from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import {
  asSessionId,
  type ExecutionId,
  newEntryId,
  type RunId,
  type SessionId,
} from "../state/ids.ts";
import { type MaterializedSession, materializeRecords } from "../state/materialize.ts";
import {
  buildMessageContent,
  MESSAGE_CONTENT_VERSION,
  type MessageContentOptions,
  type MessageContentRecord,
  parseMessageContentRecord,
  recomputeContentHash,
} from "../state/message-content.ts";
import { acquireSessionLock } from "./session-lock.ts";

// M5.5 S1（决策 040）：会话打开锁冲突——另一个存活进程正在写同一会话
export { EventLogLockedError } from "./session-lock.ts";
export class EventLogConflictError extends Error {}
export class EventLogCorruptionError extends Error {}

// 写盘接缝：唯一的字节写出口（事件文件与内容文件共用）。缺省 = fs.writeSync；
// 测试注入故障探针模拟"死于某次写盘"的崩溃点（写序可观测的唯一方式）
export interface EventLogIo {
  write(fd: number, data: string): void;
}

const defaultIo: EventLogIo = {
  write(fd, data) {
    writeSync(fd, data);
  },
};

export interface JsonlEventLogOptions {
  // 内容记录选项（单块上限、thinking 是否持久化）；缺省 64 KiB、thinking 持久化开
  content?: MessageContentOptions;
  io?: EventLogIo;
}

// 治理族 kind（幂等索引按族分立：跨族同 executionId 合法，同族重复一律冲突拒绝——M3 语义）；
// 键是静态字面量，索引容器用 Record 而非 Map。
// resolution 按 executionId 幂等（一次悬账只确证一次）；breaker 无 executionId 键，不进索引
type GovernanceKind = "intent" | "decision" | "receipt" | "resolution";

// 全量读 + 校验的结果：记录集 + 撕裂尾巴标记。
// tornTail：进程死于写盘中途的痕迹——追加协议保证每条记录以 \n 结尾，
// 故「文件非空且不以 \n 结尾」或「末行不是合法 JSON」都意味着最后一次写盘未完整落盘；
// 记录本身仍按「未持久化」容忍（不进记录集），该标记供 replay 等视图如实标注（D2 可见化）
export interface EventLogReadResult {
  records: EventRecord[];
  tornTail: boolean;
}

// 全量读 + 校验：进程死于写盘中途会留下半截末行——按"未持久化"容忍（torn tail）；
// 非末行损坏说明日志被外部破坏，响亮失败。
// 读路径迁移（M0 管线）：version 低于当前格式的记录先经 eventLogMigrations 逐级升级再校验
export function readEventLogFileDetailed(path: string): EventLogReadResult {
  if (!existsSync(path)) {
    return { records: [], tornTail: false };
  }
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  let tornTail = content.length > 0 && !content.endsWith("\n");
  const records: EventRecord[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) {
        tornTail = true;
        break; // torn tail：半截末行视为未写入
      }
      throw new EventLogCorruptionError(`事件日志损坏：${path} 第 ${index + 1} 行不是合法 JSON`);
    }
    let record: EventRecord;
    try {
      record = parseEventRecord(raw);
    } catch (error) {
      throw new EventLogCorruptionError(
        `事件日志损坏：${path} 第 ${index + 1} 行校验失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    records.push(record);
  }
  return { records, tornTail };
}

// 只取记录集的既有入口（tornTail 标记的调用方用 readEventLogFileDetailed）
export function readEventLogFile(path: string): EventRecord[] {
  return readEventLogFileDetailed(path).records;
}

// 内容文件读结果（M5 S1）：与事件文件同样容忍撕裂尾巴；不同的是中段坏行不响亮失败——
// 内容文件是证据材料不是状态权威，坏行只让对应 entry 在冷侧落"正文缺失"缺口，
// 不能因正文损坏挡住治理视图（trace / resume）。坏行计数如实返回
export interface MessageContentReadResult {
  records: MessageContentRecord[];
  tornTail: boolean;
  invalidLines: number;
}

export function readMessageContentFileDetailed(path: string): MessageContentReadResult {
  if (!existsSync(path)) {
    return { records: [], tornTail: false, invalidLines: 0 };
  }
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  let tornTail = content.length > 0 && !content.endsWith("\n");
  let invalidLines = 0;
  const records: MessageContentRecord[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) {
        tornTail = true;
        break;
      }
      invalidLines += 1;
      continue;
    }
    try {
      records.push(parseMessageContentRecord(raw));
    } catch {
      invalidLines += 1;
    }
  }
  return { records, tornTail, invalidLines };
}

// Session 列表 = 列目录（D1：ULID 字典序即时间序）；目录不存在 = 尚无会话（空清单），
// 旧账本退役文件（*.legacy.jsonl，D8）、旁置内容文件（*.messages.jsonl，037）与无关文件不进清单
export function listSessionIds(dir: string): SessionId[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith(".jsonl") &&
        !name.endsWith(".legacy.jsonl") &&
        !name.endsWith(".messages.jsonl")
    )
    .sort()
    .map((name) => asSessionId(name.slice(0, -".jsonl".length)));
}

// 治理族记录的幂等键（executionId）；receipt 的键在载荷里
function governanceKey(
  record: IntentRecord | DecisionRecord | ReceiptRecord | ResolutionRecord
): ExecutionId {
  return record.kind === "receipt" ? record.receipt.executionId : record.executionId;
}

// 按 executionId 幂等的治理族集合——构造器索引恢复 / appendRecord / #append 三处判定
// 必须恒同（漏一处 = 崩溃重开后幂等失守或写盘不 fsync），故收口为唯一类型谓词
function isExecutionKeyedGovernance(
  record: EventRecord
): record is IntentRecord | DecisionRecord | ReceiptRecord | ResolutionRecord {
  return (
    record.kind === "intent" ||
    record.kind === "decision" ||
    record.kind === "receipt" ||
    record.kind === "resolution"
  );
}

export class JsonlEventLog {
  readonly sessionId: SessionId;
  readonly path: string;
  // M5 S1（决策 037）：旁置内容文件路径（首次写正文时才打开句柄）
  readonly contentPath: string;
  // 治理族幂等索引；构造时从磁盘恢复，崩溃后重开追加仍幂等
  readonly #governanceIds: Record<GovernanceKind, Set<string>> = {
    intent: new Set<string>(),
    decision: new Set<string>(),
    receipt: new Set<string>(),
    resolution: new Set<string>(),
  };
  // 常驻 append 句柄：治理族 fsync 与观察族写盘共用（fsync 按文件刷脏页，无需逐次重开）
  readonly #fd: number;
  #contentFd: number | null = null;
  readonly #contentOptions: MessageContentOptions;
  readonly #io: EventLogIo;
  // M5.5 S1（决策 040）：会话打开锁的释放函数（幂等）
  readonly #releaseLock: () => void;
  #closed = false;

  constructor(dir: string, sessionId: SessionId, options: JsonlEventLogOptions = {}) {
    this.sessionId = sessionId;
    this.path = JsonlEventLog.filePathFor(dir, sessionId);
    this.contentPath = JsonlEventLog.contentFilePathFor(dir, sessionId);
    this.#contentOptions = options.content ?? {};
    this.#io = options.io ?? defaultIo;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // M5.5 S1（决策 040）：先取会话打开锁再读索引——另一个存活进程在写同一会话时响亮拒绝，
    // 两个进程各持一份幂等索引写出重复 resolution 的路径由此关闭；构造失败时释放锁
    this.#releaseLock = acquireSessionLock(dir, sessionId);
    try {
      // 冷启动恢复幂等索引（torn tail 容忍同 M3）；重复记录 = 外部破坏，响亮失败
      for (const record of readEventLogFile(this.path)) {
        if (isExecutionKeyedGovernance(record)) {
          const key = governanceKey(record);
          if (this.#governanceIds[record.kind].has(key)) {
            throw new EventLogCorruptionError(
              `事件日志损坏：${this.path} 重复 ${record.kind} ${key}`
            );
          }
          this.#governanceIds[record.kind].add(key);
        }
      }
      this.#fd = openSync(this.path, "a");
    } catch (error) {
      this.#releaseLock();
      throw error;
    }
  }

  static filePathFor(dir: string, sessionId: SessionId): string {
    return join(dir, `${sessionId}.jsonl`);
  }

  // M5 S1（决策 037）：旁置内容文件的唯一路径约定
  static contentFilePathFor(dir: string, sessionId: SessionId): string {
    return join(dir, `${sessionId}.messages.jsonl`);
  }

  // 观察族落盘：归一化事件信封直接转记录（D2：appendFileSync 级耐久，不 fsync）。
  // 信封 version 被记录版本覆盖：内存信封版本（state/events.ts）与落盘格式版本（本文件）
  // 当前同为 1，将来演进以 EVENT_LOG_VERSION 为准
  appendRuntimeEvent(event: EventEnvelope): RuntimeEventRecord {
    const record = Value.Parse(RuntimeEventRecordSchema, {
      ...event,
      version: EVENT_LOG_VERSION,
    });
    this.#append(record, false);
    return record;
  }

  // D3 entry 映射落盘（M4 S5）：观察族耐久（同步写不 fsync，与运行时事件同级）。
  // 信封 id 即分配给该条 transcript 消息的 EntryId；无 executionId，不进治理幂等索引。
  // M5 S1（决策 037）：携带 message 时由本日志抽取内容块、盖 contentHash，写序先内容后 entry——
  // 死于两次写盘之间只会留下"内容在、entry 缺"（entry 断号判据负责），绝不出现"entry 回指
  // 一条从未写出的正文"之外的静默状态。内容写失败不挡 entry：entry 照写并回指，冷侧据此派生
  // 正文缺失缺口，写失败原样上抛由调用方进 listenerErrors（D2 同一口径）
  appendEntry(input: EntryAppendInput): EntryRecord {
    const { runId, message, ...body } = input;
    const envelope = this.#envelope(runId);
    if (message === undefined) {
      const record = Value.Parse(EntryRecordSchema, { ...envelope, kind: "entry", ...body });
      this.#append(record, false);
      return record;
    }
    const content = buildMessageContent(message, this.#contentOptions);
    const record = Value.Parse(EntryRecordSchema, {
      ...envelope,
      kind: "entry",
      ...body,
      contentHash: content.contentHash,
    });
    const contentRecord: MessageContentRecord = {
      version: MESSAGE_CONTENT_VERSION,
      sessionId: this.sessionId,
      runId,
      runSeq: body.runSeq,
      entryId: record.id,
      timestamp: record.timestamp,
      ...content,
    };
    let contentError: unknown = null;
    try {
      this.#appendContent(contentRecord);
    } catch (error) {
      contentError = error;
    }
    this.#append(record, false);
    if (contentError !== null) {
      throw contentError;
    }
    return record;
  }

  // M5 S5（决策 044）：system prompt 全文以 role 为 system 的内容记录写进旁置内容文件——runSeq 取 0、
  // 不对应 transcript 消息、无 entry 回指；run.started 与 llm.request 以原文 sha256 回指它
  appendSystemPrompt(input: { runId: RunId; text: string }): MessageContentRecord {
    const content = buildMessageContent(
      { role: "system", content: input.text },
      this.#contentOptions
    );
    const record: MessageContentRecord = {
      version: MESSAGE_CONTENT_VERSION,
      sessionId: this.sessionId,
      runId: input.runId,
      runSeq: 0,
      entryId: newEntryId(),
      timestamp: Date.now(),
      ...content,
    };
    this.#appendContent(record);
    return record;
  }

  // M5 观察族落盘（决策 043 / 044：skill.loaded、run.started、llm.request）：同步写不 fsync，
  // 无幂等键；只进治理日志的是摘要与哈希，全文在旁置内容文件
  appendObservation(input: ObservationInput): ObservationRecord {
    const record = Value.Parse(ObservationRecordSchema, {
      ...this.#envelope(input.runId),
      kind: input.kind,
      payload: input.payload,
    });
    this.#append(record, false);
    return record;
  }

  appendIntent(input: IntentInput): IntentRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(IntentRecordSchema, {
      ...this.#envelope(runId),
      kind: "intent",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  appendDecision(input: DecisionInput): DecisionRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(DecisionRecordSchema, {
      ...this.#envelope(runId),
      kind: "decision",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  appendReceipt(input: ReceiptInput): ReceiptRecord {
    const record = Value.Parse(ReceiptRecordSchema, {
      ...this.#envelope(input.runId),
      kind: "receipt",
      receipt: input.receipt,
    });
    this.#append(record, true);
    return record;
  }

  // 熔断落闸留证（M4 S2，D7 治理熔断判据行）：治理族耐久（fsync），无 executionId 幂等键
  appendBreaker(input: BreakerInput): BreakerRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(BreakerRecordSchema, {
      ...this.#envelope(runId),
      kind: "breaker",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // 悬账确证落盘（M4 S2，D5）：治理族耐久（fsync）+ 按 executionId 幂等（重复确证冲突拒绝）
  appendResolution(input: ResolutionInput): ResolutionRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(ResolutionRecordSchema, {
      ...this.#envelope(runId),
      kind: "resolution",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.created 落盘（M4 S6，决策 3）：治理族耐久（fsync），无 executionId 幂等键
  appendGrantCreated(input: GrantCreatedInput): GrantCreatedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantCreatedRecordSchema, {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      timestamp: Date.now(),
      kind: "grant.created",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.revoked 落盘（M4 S6）：治理族耐久（fsync）；撤销以新事件表达，append-only 不删 created 行
  appendGrantRevoked(input: GrantRevokedInput): GrantRevokedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantRevokedRecordSchema, {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      timestamp: Date.now(),
      kind: "grant.revoked",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.promoted 落盘（M4 收口决策 ①）：治理族耐久（fsync）；/grants save 先落本记录再写配置
  appendGrantPromoted(input: GrantPromotedInput): GrantPromotedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantPromotedRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "grant.promoted",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // grant.config-removed 落盘（M4 收口决策 ①）：治理族耐久（fsync）；/revoke config#N 先改配置再落本记录
  appendGrantConfigRemoved(input: GrantConfigRemovedInput): GrantConfigRemovedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(GrantConfigRemovedRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "grant.config-removed",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // 迁移/外部构造记录的直通入口：全量校验 + 幂等判定 + 按族耐久写盘
  appendRecord(record: EventRecord): void {
    const parsed = Value.Parse(EventRecordSchema, record);
    this.#append(parsed, isExecutionKeyedGovernance(parsed));
  }

  // M5.5 S2（决策 040）：worker 会话头——worker 会话文件的首条记录（父会话、父 Run、角色、工作树）；
  // 治理族耐久（fsync）
  appendSessionHeader(input: SessionHeaderInput): SessionHeaderRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(SessionHeaderRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "session.header",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // child.spawned 落盘（M5.5 S2）：派出意图先于建工作树与运行面落盘——写不进就不派（fail-closed）
  appendChildSpawned(input: ChildSpawnedInput): ChildSpawnedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(ChildSpawnedRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "child.spawned",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // child.settled 落盘（M5.5 S2）：worker 会话关闭后写结构化结果；治理族耐久（fsync）
  appendChildSettled(input: ChildSettledInput): ChildSettledRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(ChildSettledRecordSchema, {
      ...this.#grantEnvelope(runId),
      kind: "child.settled",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // 候选提出（M6，决策 065）：候选文件写好后落盘；治理族耐久（fsync）
  appendCandidateProposed(input: CandidateProposedInput): CandidateProposedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(CandidateProposedRecordSchema, {
      ...this.#envelope(runId),
      kind: "candidate.proposed",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  // 候选筛查（M6，决策 065）：确定性扫描结果；治理族耐久（fsync）
  appendCandidateScreened(input: CandidateScreenedInput): CandidateScreenedRecord {
    const { runId, ...body } = input;
    const record = Value.Parse(CandidateScreenedRecordSchema, {
      ...this.#envelope(runId),
      kind: "candidate.screened",
      ...body,
    });
    this.#append(record, true);
    return record;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    closeSync(this.#fd);
    if (this.#contentFd !== null) {
      closeSync(this.#contentFd);
    }
    this.#releaseLock();
  }

  #envelope(runId: RunId) {
    return {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      runId,
      timestamp: Date.now(),
    };
  }

  // grant 族信封：runId 可选（REPL 时段的配置面动作无活动 Run）
  #grantEnvelope(runId: RunId | undefined) {
    return {
      version: EVENT_LOG_VERSION,
      id: newEntryId(),
      sessionId: this.sessionId,
      ...(runId !== undefined ? { runId } : {}),
      timestamp: Date.now(),
    };
  }

  // 内容文件写盘（M5 S1）：观察族耐久（同步写不 fsync）；句柄懒打开——无正文的会话不建文件
  #appendContent(record: MessageContentRecord): void {
    if (this.#closed) {
      throw new EventLogCorruptionError("事件日志已关闭，拒绝追加");
    }
    if (this.#contentFd === null) {
      this.#contentFd = openSync(this.contentPath, "a");
    }
    this.#io.write(this.#contentFd, `${JSON.stringify(record)}\n`);
  }

  // 唯一写盘路径：逐条同步写（D2），治理族写后 fsync；写失败原样上抛，
  // 语义由调用方裁决（intent fail-closed / decision、receipt 进 listenerErrors）。
  // 幂等：同一 executionId 同族重复写一律冲突拒绝（可检测，不静默去重）——
  // ExecutionId 由 Pigeon 生成且唯一，重复出现即逻辑错误或重放嫌疑（§3.2 不盲重放）
  #append(record: EventRecord, durable: boolean): void {
    if (this.#closed) {
      throw new EventLogCorruptionError("事件日志已关闭，拒绝追加");
    }
    if (isExecutionKeyedGovernance(record)) {
      const key = governanceKey(record);
      if (this.#governanceIds[record.kind].has(key)) {
        throw new EventLogConflictError(`重复 ${record.kind}：${key}`);
      }
      this.#io.write(this.#fd, `${JSON.stringify(record)}\n`);
      fsyncSync(this.#fd);
      this.#governanceIds[record.kind].add(key);
      return;
    }
    this.#io.write(this.#fd, `${JSON.stringify(record)}\n`);
    if (durable) {
      fsyncSync(this.#fd);
    }
  }
}

export interface MaterializeSessionOptions {
  // 是否读旁置内容文件派生正文缺口；缺省 true。会话列表冷路径传 false（037：冷启动零增量）
  content?: boolean;
}

// 冷物化：读 session 事件文件（与内容文件）→ materializeRecords（state，纯函数）。
// 文件不存在 = 全新 session，返回空态（不是损坏）
export function materializeSession(
  dir: string,
  sessionId: SessionId,
  options: MaterializeSessionOptions = {}
): MaterializedSession {
  const path = JsonlEventLog.filePathFor(dir, sessionId);
  const { records, tornTail } = readEventLogFileDetailed(path);
  if (options.content === false) {
    return materializeRecords({ sessionId, path, records, tornTail });
  }
  // entryId → 按现有正文重算的哈希（同一 entryId 多条时以最后一条为准）
  const contentHashes = new Map<string, string>();
  const content = readMessageContentFileDetailed(JsonlEventLog.contentFilePathFor(dir, sessionId));
  for (const record of content.records) {
    contentHashes.set(record.entryId, recomputeContentHash(record));
  }
  return materializeRecords({ sessionId, path, records, tornTail, contentHashes });
}
