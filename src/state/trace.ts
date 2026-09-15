// Trace 关联视图（M4 S3，ROADMAP §M4 完成证据：Trace 可以从用户请求追溯到工具参数、
// 审批、Receipt 和最终验证）。纯投影层：输入是冷物化结果（MaterializedSession，D5 派生
// 不落库），输出是轮次 × 工具调用的关联树，供 CLI trace 渲染与 M2 TUI 投影复用。
// 关联纪律：每一跳都按 id 核对——runId 域 + toolCallId（治理族再交叉 executionId），
// 绝不按位置猜测；id 对得上但内容对不上（toolCallId/参数/哈希不符）挂接并标异常，
// 对不上的一律进孤儿清单如实报告。

import type {
  BreakerRecord,
  DecisionRecord,
  EvalVerifiedRecord,
  EventRecord,
  IntentRecord,
  ResolutionRecord,
  RunStartedRecord,
  RuntimeEventRecord,
} from "./event-log.ts";
import type { ExecutionId, RunId, SessionId } from "./ids.ts";
import type {
  ContentGap,
  MaterializedSession,
  RunClassification,
  ToolExecutionClassification,
} from "./materialize.ts";
import type { Receipt } from "./receipt.ts";

export type TurnStartedRecord = Extract<RuntimeEventRecord, { kind: "turn.started" }>;
export type TurnCompletedRecord = Extract<RuntimeEventRecord, { kind: "turn.completed" }>;
export type ToolProposedRecord = Extract<RuntimeEventRecord, { kind: "tool.proposed" }>;
export type ToolSettledRecord = Extract<RuntimeEventRecord, { kind: "tool.settled" }>;

// 单次工具调用的全链证据：提议 → 治理（intent/decision）→ Receipt/确证 → 熔断 → 分类
export interface TraceToolCall {
  toolCallId: string;
  toolName: string;
  proposed?: ToolProposedRecord;
  settled?: ToolSettledRecord;
  intent?: IntentRecord;
  decision?: DecisionRecord;
  receipt?: Receipt;
  resolution?: ResolutionRecord;
  // 由本调用触发落闸的熔断记录（breaker.toolCallId 回指）
  breakers: BreakerRecord[];
  // 失败四分类（D7）；缺省 = 该调用不在分类清单（不应出现，出现即异常）
  classification?: ToolExecutionClassification;
  // OutcomeUnknown 待对账：intent 已落盘但无 Receipt 且未确证（§3.2 禁止盲重放）
  pendingReconcile: boolean;
  // 通俗措辞异常说明（id 错位 / 参数不一致 / 哈希不符 / 事件缺口）
  anomalies: string[];
}

export interface TraceTurn {
  // run 内轮次（1 起）；一轮 = 一条 assistant 消息 + 它触发的工具调用
  index: number;
  started?: TurnStartedRecord;
  completed?: TurnCompletedRecord;
  toolCalls: TraceToolCall[];
}

export interface TraceRun {
  runId: RunId;
  turns: TraceTurn[];
  // run 内全部工具调用（按首见顺序），含未能归入治理族的调用
  toolCalls: TraceToolCall[];
  breakers: BreakerRecord[];
  // run.ended 事件是否在场（缺失 = 崩溃残留可能）
  ended: boolean;
  // 会话文件末尾撕裂写残片归属本 Run（M4 收口决策 ③，D2 冷侧可见化）：只有拥有文件末条
  // 记录的 Run 才为 true（残片只可能写在它之后），口径与 replay 一致
  tornTail: boolean;
  // 本 Run 缺失的 entry runSeq（判据在 materializeSession，三视图同一份）
  entryGaps: number[];
  // 本 Run 的正文缺口（M5 S1，决策 037；判据在冷物化，三视图同一份）
  contentGaps: ContentGap[];
  // M5 S5（决策 044）：Run 启动快照摘要（M5 前的 Run 无）与模型请求次数（llm.request 条数）
  started?: RunStartedRecord;
  llmRequestCount: number;
  // M6.5 S3（决策 058）：Eval 验证器判决（非 Eval 运行无）；同一 Run 多次验证取最后一条
  verified?: EvalVerifiedRecord;
  classification?: RunClassification;
  // run 级异常（轮次边界缺口等）
  anomalies: string[];
}

export interface SessionTrace {
  sessionId: SessionId;
  runs: TraceRun[];
  // 文件级事实：会话文件末尾存在撕裂写残片。--run 过滤掉拥有者、或末条记录不属于任何 Run
  // （REPL 期 grant 事件）时，Run 级 tornTail 全为 false，会话级仍如实为 true
  tornTail: boolean;
  // Receipt 找不到对应 intent/decision（日志损坏或手写）：如实报告，附信封 runId
  orphanReceipts: Array<{ receipt: Receipt; runId: RunId }>;
  orphanResolutions: ResolutionRecord[];
}

export interface TraceBuildOptions {
  // 只投影指定 Run（CLI --run 过滤）
  runId?: RunId;
}

export function buildSessionTrace(
  session: MaterializedSession,
  options: TraceBuildOptions = {}
): SessionTrace {
  // 按 runId 分组（组内保持文件顺序）；runId 是关联的第一域——
  // toolCallId 只保证 run 内唯一，跨 Run 可能相撞（fake/上游均如此）。
  // grant 族 runId 可选（REPL 时段事件无活动 Run）——不进任何 Run 组：
  // grant 是 session 级治理状态，/grants 是其唯一展示入口（决策 3b）
  const runRecords = new Map<RunId, EventRecord[]>();
  for (const record of session.records) {
    if (record.runId === undefined) {
      continue;
    }
    const list = runRecords.get(record.runId);
    if (list === undefined) {
      runRecords.set(record.runId, [record]);
    } else {
      list.push(record);
    }
  }
  const pending = new Set<ExecutionId>(
    session.reconcile.unknown.map((entry) => entry.intent.executionId)
  );
  const trace: SessionTrace = {
    sessionId: session.sessionId,
    runs: [],
    tornTail: session.tornTail,
    orphanReceipts: [],
    orphanResolutions: [],
  };
  for (const [runId, records] of runRecords) {
    if (options.runId !== undefined && options.runId !== runId) {
      continue;
    }
    trace.runs.push(buildRunTrace(session, runId, records, pending, trace));
  }
  return trace;
}

function buildRunTrace(
  session: MaterializedSession,
  runId: RunId,
  records: EventRecord[],
  pending: ReadonlySet<ExecutionId>,
  trace: SessionTrace
): TraceRun {
  // 撕裂尾巴归属（与 replay.ts 同一判定）：残片只可能写在文件末条记录之后
  const ownsFileTail = records[records.length - 1] === session.records[session.records.length - 1];
  const run: TraceRun = {
    runId,
    turns: [],
    toolCalls: [],
    breakers: [],
    ended: false,
    tornTail: session.tornTail && ownsFileTail,
    entryGaps: session.entryGaps.find((gap) => gap.runId === runId)?.missingSeqs ?? [],
    contentGaps: session.contentGaps.filter((gap) => gap.runId === runId),
    llmRequestCount: 0,
    anomalies: [],
  };
  const callsByToolCallId = new Map<string, TraceToolCall>();
  const callsByExecutionId = new Map<ExecutionId, TraceToolCall>();

  // 当前轮次：turn.started 开新一轮；工具事件落在「发起它的 assistant 轮」里
  // （上游时序：turn.completed(toolUse) → tool 事件 → 下一 turn.started）
  const currentTurn = (): TraceTurn => {
    const last = run.turns[run.turns.length - 1];
    if (last !== undefined) {
      return last;
    }
    const turn: TraceTurn = { index: 1, toolCalls: [] };
    run.turns.push(turn);
    return turn;
  };
  const callBucket = (toolCallId: string, toolName: string): TraceToolCall => {
    let call = callsByToolCallId.get(toolCallId);
    if (call === undefined) {
      call = {
        toolCallId,
        toolName,
        breakers: [],
        pendingReconcile: false,
        anomalies: [],
      };
      callsByToolCallId.set(toolCallId, call);
      run.toolCalls.push(call);
      currentTurn().toolCalls.push(call);
    }
    return call;
  };

  for (const record of records) {
    if (record.kind === "turn.started") {
      const previous = run.turns[run.turns.length - 1];
      if (previous !== undefined && previous.completed === undefined) {
        run.anomalies.push(`第 ${previous.index} 轮缺 turn.completed 事件（证据缺口）`);
      }
      run.turns.push({ index: run.turns.length + 1, started: record, toolCalls: [] });
    } else if (record.kind === "turn.completed") {
      const turn = run.turns[run.turns.length - 1];
      if (turn === undefined || turn.completed !== undefined) {
        run.anomalies.push("turn.completed 无对应 turn.started（证据缺口）");
      } else {
        turn.completed = record;
      }
    } else if (record.kind === "tool.proposed") {
      const call = callBucket(record.payload.toolCallId, record.payload.toolName);
      if (call.proposed !== undefined) {
        call.anomalies.push("重复 tool.proposed 事件");
      } else {
        call.proposed = record;
      }
    } else if (record.kind === "tool.settled") {
      const call = callBucket(record.payload.toolCallId, record.payload.toolName);
      if (call.settled !== undefined) {
        call.anomalies.push("重复 tool.settled 事件");
      } else {
        call.settled = record;
      }
      if (call.toolName !== record.payload.toolName) {
        call.anomalies.push(
          `工具名不一致：proposed=${call.toolName}，settled=${record.payload.toolName}`
        );
      }
    } else if (record.kind === "run.ended") {
      run.ended = true;
    } else if (record.kind === "run.started") {
      run.started = record;
    } else if (record.kind === "eval.verified") {
      run.verified = record;
    } else if (record.kind === "llm.request") {
      run.llmRequestCount += 1;
    } else if (record.kind === "intent") {
      const call = callBucket(record.toolCallId, record.toolName);
      call.intent = record;
      callsByExecutionId.set(record.executionId, call);
      call.pendingReconcile = pending.has(record.executionId);
      verifyAgainstProposed(call, record.toolName, record.rawArgs);
    } else if (record.kind === "decision") {
      const call = callBucket(record.toolCallId, record.toolName);
      call.decision = record;
      callsByExecutionId.set(record.executionId, call);
      verifyAgainstProposed(call, record.toolName, record.rawArgs);
    } else if (record.kind === "receipt") {
      const receipt = record.receipt;
      const call = callsByExecutionId.get(receipt.executionId);
      if (call === undefined) {
        // 孤儿：executionId 找不到对应 intent/decision——如实报告，不猜测挂接
        trace.orphanReceipts.push({ receipt, runId });
      } else {
        call.receipt = receipt;
        if (receipt.toolCallId !== call.toolCallId) {
          call.anomalies.push(
            `Receipt 的 toolCallId 与意图不一致：${receipt.toolCallId} ≠ ${call.toolCallId}`
          );
        }
        const expected = call.intent?.contentHashes?.expectedAfterHash;
        if (
          expected !== undefined &&
          receipt.contentAfterHash !== undefined &&
          receipt.contentAfterHash !== expected
        ) {
          call.anomalies.push("实测改后哈希与预期不符（撕裂写/第三方改动嫌疑）");
        }
      }
    } else if (record.kind === "resolution") {
      const call = callsByExecutionId.get(record.executionId);
      if (call === undefined) {
        trace.orphanResolutions.push(record);
      } else {
        call.resolution = record;
      }
    } else if (record.kind === "breaker") {
      run.breakers.push(record);
      callsByToolCallId.get(record.toolCallId)?.breakers.push(record);
    }
  }

  // 分类挂接（M4 S2 判据装配结果）：executionId 权威键优先；
  // 上游拦截调用（executionId=null，无治理记录）按 runId 域内的 toolCallId 挂接
  const runClassification = session.classification.runs.find((entry) => entry.runId === runId);
  if (runClassification !== undefined) {
    run.classification = runClassification;
  }
  for (const entry of session.classification.toolExecutions) {
    const call =
      entry.executionId !== null
        ? callsByExecutionId.get(entry.executionId)
        : callsByToolCallId.get(entry.toolCallId);
    if (call !== undefined) {
      call.classification = entry;
    }
  }
  return run;
}

// 治理记录与提议事件的内容交叉核对：toolCallId 挂接是键，但 toolName/参数必须同时一致，
// 不一致说明日志被篡改或上游行为漂移——标异常而非静默吞掉
function verifyAgainstProposed(call: TraceToolCall, toolName: string, rawArgs: unknown): void {
  if (call.proposed === undefined) {
    call.anomalies.push("治理记录无对应 tool.proposed 事件（事件落盘缺口）");
    return;
  }
  if (call.proposed.payload.toolName !== toolName) {
    call.anomalies.push(
      `工具名不一致：proposed=${call.proposed.payload.toolName}，治理记录=${toolName}`
    );
  }
  const proposedArgs = JSON.stringify(call.proposed.payload.args);
  const ledgerArgs = JSON.stringify(rawArgs);
  if (proposedArgs !== ledgerArgs) {
    call.anomalies.push("落账参数与提议事件的模型原始参数不一致");
  }
}
