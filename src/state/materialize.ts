// 冷物化与对账（ROADMAP §4 state：物化与投影；M4 S1/S2/S5/S6 + 收口决策 ③）：
// 从 Event Log 记录集重建一个 session 的完整派生状态——按族分拣、对账（intent/receipt/
// resolution 按 executionId 配对，语义与 M3 账本逐字一致）、生效 grant 还原、entry 断号
// 检测、失败四分类装配。纯函数，无 IO；D5：派生不落库，视图（trace/replay/session
// 摘要）都是本结果的投影。
import {
  classifyRunOutcome,
  classifyToolOutcome,
  type FailureClass,
  type RunOutcomeFacts,
  type ToolOutcomeFacts,
} from "./classification.ts";
import type {
  AttemptVerifiedRecord,
  BranchHeaderRecord,
  BreakerRecord,
  CandidateActivatedRecord,
  CandidateDecidedRecord,
  CandidateProposedRecord,
  CandidateScreenedRecord,
  CandidateVerifiedRecord,
  ChildSettledRecord,
  ChildSpawnedRecord,
  DecisionRecord,
  DistillSkippedRecord,
  EntryRecord,
  EvalVerifiedRecord,
  EventRecord,
  GrantConfigRemovedRecord,
  GrantCreatedRecord,
  GrantPromotedRecord,
  GrantRevokedRecord,
  IntentRecord,
  LlmRequestRecord,
  ResolutionRecord,
  ReviewSkippedRecord,
  ReviewUnparsableRecord,
  RunLimitHitRecord,
  RunStartedRecord,
  RuntimeEventRecord,
  SessionForkedRecord,
  SessionHeaderRecord,
  SkillLoadedRecord,
  WorkspaceCheckpointRecord,
} from "./event-log.ts";
import type { ExecutionId, RunId, SessionId } from "./ids.ts";
import type { Receipt } from "./receipt.ts";
import type { ToolSettledPayload } from "./runtime-events.ts";

// 对账报告：pairing 按 executionId（分类语义与 M3 账本逐字一致）
export interface ReconcileEntry {
  intent: IntentRecord;
  receipt?: Receipt;
}
export interface RejectedEntry {
  decision: DecisionRecord;
  receipt?: Receipt;
}
// M4 S2：悬账与确证记录的配对（D5 哈希自动确证销账）
export interface ResolvedEntry {
  intent: IntentRecord;
  resolution: ResolutionRecord;
}
export interface ReconcileReport {
  // intent + receipt 配对完成
  settled: ReconcileEntry[];
  // intent 无 receipt 且无 resolution：死于 dispatch/execute/receipt 任一窗口——
  // 副作用是否发生未知（OutcomeUnknown）
  unknown: ReconcileEntry[];
  // decision（拒绝）：闭环——拒绝发生于 dispatch 前，无副作用可能，永不入 OutcomeUnknown
  rejected: RejectedEntry[];
  // intent 无 receipt 但有 resolution：哈希自动确证已销账（executed / not-executed）
  resolved: ResolvedEntry[];
  // receipt 既无 intent 也无 decision：日志损坏或手写——如实报告，不猜测
  orphanReceipts: Receipt[];
  // resolution 找不到对应 intent：同上，如实报告
  orphanResolutions: ResolutionRecord[];
}

// 冷物化结果：一个 session 的完整派生状态（D5：派生不落库，视图是投影）
// 生效 grant（决策 3b 冷恢复还原面）：grant.created 减去 grant.revoked 的纯派生
export interface ActiveGrant {
  grantId: GrantCreatedRecord["grantId"];
  tool: string;
  pathPrefix?: string;
  // M5.5 S5（决策 048）：exec 档精确命令串
  command?: string;
  // 048 修订：经 shell 已由人确认
  shell?: boolean;
  createdAt: number;
  firstCall: GrantCreatedRecord["firstCall"];
}
export interface MaterializedSession {
  sessionId: SessionId;
  path: string;
  // 全量记录（按文件顺序）
  records: EventRecord[];
  // 撕裂尾巴标记（D2 可见化）：文件末尾存在未完整落盘的记录残片；
  // 残片不进 records（按未持久化容忍），但视图必须如实标注而非假装证据链完整
  tornTail: boolean;
  runtimeEvents: RuntimeEventRecord[];
  intents: IntentRecord[];
  decisions: DecisionRecord[];
  receipts: Receipt[];
  breakers: BreakerRecord[];
  resolutions: ResolutionRecord[];
  // entry 族（M4 S5，D3）：transcript 消息的 EntryId 映射，按落盘顺序
  entries: EntryRecord[];
  // grant 族（M4 S6，决策 3）：created / revoked 原始记录与生效集（created − revoked，
  // 按 createdAt 排序）——冷恢复的 grant 还原面（决策 3b：静默继续有效，/grants 唯一展示入口）
  grantCreateds: GrantCreatedRecord[];
  grantRevokeds: GrantRevokedRecord[];
  grants: ActiveGrant[];
  // 固化规则升格/移除留痕（M4 收口决策 ①）：配置面动作的原始记录，不参与会话 grant 生效集
  grantPromoteds: GrantPromotedRecord[];
  grantConfigRemoveds: GrantConfigRemovedRecord[];
  // entry runSeq 断号（M4 收口决策 ③，D2 冷侧可见化）：按 Run 汇总的缺失序号——
  // entry 写盘失败按 D3 不占位重试，空洞就是"这条消息的映射没落盘"的确切信号；
  // 判据只在此算一次，trace/replay/resume 三个视图消费同一份结果（活冷同判据原则）
  entryGaps: EntryGap[];
  // 崩溃残留（M4 验收 O-1/O-3）：有记录但无 run.ended 的 Run，按首见顺序。进程死于中途的
  // 确切信号（abort 路径上游照常发 agent_end）；resume 汇总与 trace 会话头共用本清单
  unfinishedRuns: RunId[];
  // M5 观察族（决策 043 / 044）：按落盘顺序；不参与分类判据
  runStarteds: RunStartedRecord[];
  llmRequests: LlmRequestRecord[];
  skillLoadeds: SkillLoadedRecord[];
  // M6.5 S3（决策 058）：Eval 验证器判决（按落盘顺序）；不参与分类判据
  evalVerifieds: EvalVerifiedRecord[];
  // M6（决策 064）：后台审阅因上一次未收尾而跳过的记录
  reviewSkippeds: ReviewSkippedRecord[];
  reviewUnparsables: ReviewUnparsableRecord[];
  // M6（决策 065）：候选提出与筛查两族（候选状态由二者现算，见 candidate-status.ts）
  candidateProposeds: CandidateProposedRecord[];
  candidateScreeneds: CandidateScreenedRecord[];
  // M8（决策 089）：候选验证回执、决定与激活三族（按落盘顺序）——候选状态由它们与前两族现算
  candidateVerifieds: CandidateVerifiedRecord[];
  candidateDecideds: CandidateDecidedRecord[];
  candidateActivateds: CandidateActivatedRecord[];
  // M7（决策 071 / 072 / 074 / 077 / 078）：通用验证、撞上限、工作区快照、分叉、提炼跳过、树写穿失败（按落盘顺序）；
  // branchHeader 在场 = 本会话是分叉出来的分支会话
  attemptVerifieds: AttemptVerifiedRecord[];
  limitHits: RunLimitHitRecord[];
  checkpoints: WorkspaceCheckpointRecord[];
  sessionForkeds: SessionForkedRecord[];
  distillSkippeds: DistillSkippedRecord[];
  branchHeader?: BranchHeaderRecord;
  // M5.5 S2（决策 040）：worker 编排三族。sessionHeader 在场 = 本会话是 worker 会话；
  // children 按 child.spawned 顺序配对 child.settled（缺 settled = 派出后未收尾，崩溃可能）；
  // 找不到 spawned 的 settled 如实归孤立清单
  sessionHeader?: SessionHeaderRecord;
  childSpawneds: ChildSpawnedRecord[];
  childSettleds: ChildSettledRecord[];
  children: ChildLink[];
  orphanChildSettleds: ChildSettledRecord[];
  // 正文缺口（M5 S1，决策 037，按 012 / 021 口径）：entry 带 contentHash 而内容文件无对应记录
  // 或重算哈希不符。未加载内容文件（会话列表冷路径）时恒为空——不知道就不报
  contentGaps: ContentGap[];
  reconcile: ReconcileReport;
  // 失败四分类（M4 S2，D7）：从本 session 事件现算（派生不落库；判据纯函数在 classification.ts）
  classification: SessionClassification;
}

export interface ChildLink {
  spawned: ChildSpawnedRecord;
  settled?: ChildSettledRecord;
}

export interface ContentGap {
  runId: RunId;
  entryId: EntryRecord["id"];
  runSeq: number;
  // missing = 内容文件无该 entry 的记录；mismatch = 记录在但重算哈希与 entry 回指不符
  reason: "missing" | "mismatch";
}

export interface EntryGap {
  runId: RunId;
  // 缺失的 runSeq（升序）：中段空洞由相邻 entry 序号推出；末尾缺失由 run.ended.messageCount
  // 推出（agent_end 的新增消息数 = 本 Run 的 message_end 条数，D3 同一口径）
  missingSeqs: number[];
}

// Run 级失败分类（D7 左列判据）；failure=null 表示正常收尾
export interface RunClassification {
  runId: RunId;
  failure: FailureClass | null;
}
// ToolExecution 级失败分类（D7 右列判据）；executionId=null 表示上游拦截调用（无账本记录）
export interface ToolExecutionClassification {
  executionId: ExecutionId | null;
  toolCallId: string;
  toolName: string;
  failure: FailureClass | null;
}
export interface SessionClassification {
  runs: RunClassification[];
  toolExecutions: ToolExecutionClassification[];
}

// 冷物化（纯函数）：已读出的记录集 → 派生状态 + 对账报告。读文件在 persistence
// （materializeSession = 读 + 本函数）；此处无 IO，活侧与冷侧的判据在此收口
export interface MaterializeInput {
  sessionId: SessionId;
  path: string;
  records: EventRecord[];
  tornTail: boolean;
  // 内容文件的 entryId → 按现有正文重算的内容哈希（persistence 读出后传入）；缺省 = 未加载内容
  contentHashes?: ReadonlyMap<string, string>;
}

export function materializeRecords(input: MaterializeInput): MaterializedSession {
  const { sessionId, path, records, tornTail } = input;
  const runStarteds: RunStartedRecord[] = [];
  const llmRequests: LlmRequestRecord[] = [];
  const skillLoadeds: SkillLoadedRecord[] = [];
  const evalVerifieds: EvalVerifiedRecord[] = [];
  const reviewSkippeds: ReviewSkippedRecord[] = [];
  const reviewUnparsables: ReviewUnparsableRecord[] = [];
  const candidateProposeds: CandidateProposedRecord[] = [];
  const candidateScreeneds: CandidateScreenedRecord[] = [];
  const candidateVerifieds: CandidateVerifiedRecord[] = [];
  const candidateDecideds: CandidateDecidedRecord[] = [];
  const candidateActivateds: CandidateActivatedRecord[] = [];
  const attemptVerifieds: AttemptVerifiedRecord[] = [];
  const limitHits: RunLimitHitRecord[] = [];
  const checkpoints: WorkspaceCheckpointRecord[] = [];
  const sessionForkeds: SessionForkedRecord[] = [];
  const distillSkippeds: DistillSkippedRecord[] = [];
  let branchHeader: BranchHeaderRecord | undefined;
  const runtimeEvents: RuntimeEventRecord[] = [];
  const intents: IntentRecord[] = [];
  const decisions: DecisionRecord[] = [];
  const receipts: Receipt[] = [];
  const breakers: BreakerRecord[] = [];
  const resolutions: ResolutionRecord[] = [];
  const entries: EntryRecord[] = [];
  const grantCreateds: GrantCreatedRecord[] = [];
  const grantRevokeds: GrantRevokedRecord[] = [];
  const grantPromoteds: GrantPromotedRecord[] = [];
  const grantConfigRemoveds: GrantConfigRemovedRecord[] = [];
  let sessionHeader: SessionHeaderRecord | undefined;
  const childSpawneds: ChildSpawnedRecord[] = [];
  const childSettleds: ChildSettledRecord[] = [];
  for (const record of records) {
    if (record.kind === "session.header") {
      // 会话头只认首个（worker 会话只写一次）
      sessionHeader ??= record;
    } else if (record.kind === "child.spawned") {
      childSpawneds.push(record);
    } else if (record.kind === "child.settled") {
      childSettleds.push(record);
    } else if (record.kind === "intent") {
      intents.push(record);
    } else if (record.kind === "decision") {
      decisions.push(record);
    } else if (record.kind === "receipt") {
      receipts.push(record.receipt);
    } else if (record.kind === "breaker") {
      breakers.push(record);
    } else if (record.kind === "resolution") {
      resolutions.push(record);
    } else if (record.kind === "entry") {
      entries.push(record);
    } else if (record.kind === "grant.created") {
      grantCreateds.push(record);
    } else if (record.kind === "grant.revoked") {
      grantRevokeds.push(record);
    } else if (record.kind === "grant.promoted") {
      grantPromoteds.push(record);
    } else if (record.kind === "grant.config-removed") {
      grantConfigRemoveds.push(record);
    } else if (record.kind === "run.started") {
      runStarteds.push(record);
    } else if (record.kind === "llm.request") {
      llmRequests.push(record);
    } else if (record.kind === "skill.loaded") {
      skillLoadeds.push(record);
    } else if (record.kind === "eval.verified") {
      evalVerifieds.push(record);
    } else if (record.kind === "review.skipped") {
      reviewSkippeds.push(record);
    } else if (record.kind === "review.unparsable") {
      reviewUnparsables.push(record);
    } else if (record.kind === "candidate.proposed") {
      candidateProposeds.push(record);
    } else if (record.kind === "candidate.screened") {
      candidateScreeneds.push(record);
    } else if (record.kind === "candidate.verified") {
      candidateVerifieds.push(record);
    } else if (record.kind === "candidate.decided") {
      candidateDecideds.push(record);
    } else if (record.kind === "candidate.activated") {
      candidateActivateds.push(record);
    } else if (record.kind === "attempt.verified") {
      attemptVerifieds.push(record);
    } else if (record.kind === "run.limit-hit") {
      limitHits.push(record);
    } else if (record.kind === "workspace.checkpoint") {
      checkpoints.push(record);
    } else if (record.kind === "session.forked") {
      sessionForkeds.push(record);
    } else if (record.kind === "distill.skipped") {
      distillSkippeds.push(record);
    } else if (record.kind === "branch.header") {
      // 分支会话头只认首个
      branchHeader ??= record;
    } else {
      runtimeEvents.push(record);
    }
  }
  const reconcile = reconcileRecords(intents, decisions, receipts, resolutions);
  const { children, orphanChildSettleds } = pairChildren(childSpawneds, childSettleds);
  return {
    ...(sessionHeader !== undefined ? { sessionHeader } : {}),
    ...(branchHeader !== undefined ? { branchHeader } : {}),
    attemptVerifieds,
    limitHits,
    checkpoints,
    sessionForkeds,
    distillSkippeds,
    childSpawneds,
    childSettleds,
    children,
    orphanChildSettleds,
    sessionId,
    path,
    records,
    tornTail,
    runtimeEvents,
    intents,
    decisions,
    receipts,
    breakers,
    resolutions,
    entries,
    grantCreateds,
    grantRevokeds,
    grants: activeGrants(grantCreateds, grantRevokeds),
    grantPromoteds,
    grantConfigRemoveds,
    entryGaps: detectEntryGaps(entries, runtimeEvents),
    unfinishedRuns: collectUnfinishedRuns(records, runtimeEvents),
    runStarteds,
    llmRequests,
    skillLoadeds,
    evalVerifieds,
    reviewSkippeds,
    reviewUnparsables,
    candidateProposeds,
    candidateScreeneds,
    candidateVerifieds,
    candidateDecideds,
    candidateActivateds,
    contentGaps: detectContentGaps(entries, input.contentHashes),
    reconcile,
    classification: classifySessionRecords(records, runtimeEvents, breakers, reconcile),
  };
}

// 快照与条目号的对应（M7，决策 078）：某次 Run 在条目号 runSeq（含）之前最近的快照——该 Run 内 afterRunSeq 不大于
// runSeq 的最后一条。只看同一 Run：分叉点所在 Run 之前的 Run 的快照由调用方按 Run 顺序回退查找。纯函数
export function checkpointAtOrBefore(
  session: Pick<MaterializedSession, "checkpoints">,
  runId: RunId,
  runSeq: number
): WorkspaceCheckpointRecord["payload"] | undefined {
  let found: WorkspaceCheckpointRecord["payload"] | undefined;
  for (const record of session.checkpoints) {
    if (record.runId === runId && record.payload.afterRunSeq <= runSeq) {
      found = record.payload;
    }
  }
  return found;
}

// worker 父子配对（M5.5 S2）：按 childSessionId 配对，保持 spawned 顺序；纯函数
export function pairChildren(
  spawneds: readonly ChildSpawnedRecord[],
  settleds: readonly ChildSettledRecord[]
): { children: ChildLink[]; orphanChildSettleds: ChildSettledRecord[] } {
  const settledById = new Map<string, ChildSettledRecord>();
  for (const settled of settleds) {
    if (!settledById.has(settled.childSessionId)) {
      settledById.set(settled.childSessionId, settled);
    }
  }
  const spawnedIds = new Set(spawneds.map((spawned) => spawned.childSessionId));
  return {
    children: spawneds.map((spawned) => {
      const settled = settledById.get(spawned.childSessionId);
      return settled !== undefined ? { spawned, settled } : { spawned };
    }),
    orphanChildSettleds: settleds.filter((settled) => !spawnedIds.has(settled.childSessionId)),
  };
}

// 正文缺口派生（M5 S1，决策 037）：只查带 contentHash 的 entry（无哈希 = M5 前会话，不是缺口）。
// 比对的是内容文件按现有正文重算的哈希，而不是记录自报的 contentHash——正文被改而字段未改
// 同样现形。contentHashes 缺省（未加载内容文件）不猜，返回空。纯函数，无 IO
export function detectContentGaps(
  entries: readonly EntryRecord[],
  contentHashes: ReadonlyMap<string, string> | undefined
): ContentGap[] {
  if (contentHashes === undefined) {
    return [];
  }
  const gaps: ContentGap[] = [];
  for (const entry of entries) {
    if (entry.contentHash === undefined) {
      continue;
    }
    const actual = contentHashes.get(entry.id);
    if (actual === undefined) {
      gaps.push({ runId: entry.runId, entryId: entry.id, runSeq: entry.runSeq, reason: "missing" });
    } else if (actual !== entry.contentHash) {
      gaps.push({
        runId: entry.runId,
        entryId: entry.id,
        runSeq: entry.runSeq,
        reason: "mismatch",
      });
    }
  }
  return gaps;
}

// 崩溃残留 Run 清单（M4 验收 O-1/O-3）：出现过任何带 runId 的记录、却没有 run.ended 的 Run。
// 纯函数；grant 族无 runId 的记录不算 Run
// 引用型记录（M7）：候选两族与不可解析记录可能引用别的会话甚至别的治理根里的 Run（提炼宿主会话），
// 不凭空在本会话造出 Run；同会话的引用（M6 审阅）本会话自有其他记录，不受影响
const REFERENCE_KINDS: ReadonlySet<string> = new Set([
  "candidate.proposed",
  "candidate.screened",
  "review.unparsable",
  // M8：验证、决定与激活三族写在发起命令自己的会话文件里，信封 Run 若在场也指向别的会话
  "candidate.verified",
  "candidate.decided",
  "candidate.activated",
]);

export function collectUnfinishedRuns(
  records: readonly EventRecord[],
  runtimeEvents: readonly RuntimeEventRecord[]
): RunId[] {
  const ended = new Set<RunId>();
  for (const event of runtimeEvents) {
    if (event.kind === "run.ended") {
      ended.add(event.runId);
    }
  }
  const seen = new Set<RunId>();
  const unfinished: RunId[] = [];
  for (const record of records) {
    if (
      record.runId !== undefined &&
      !REFERENCE_KINDS.has(record.kind) &&
      !seen.has(record.runId)
    ) {
      seen.add(record.runId);
      if (!ended.has(record.runId)) {
        unfinished.push(record.runId);
      }
    }
  }
  return unfinished;
}

// entry runSeq 断号检测（M4 收口决策 ③）：按 Run（首见顺序）核对序号连续性。
// 中段空洞：相邻 entry 的 runSeq 跳号即缺失（D3：写盘失败不占位重试，序号照常推进）；
// 末尾缺失：run.ended.messageCount（agent_end 新增消息数 = message_end 条数）大于已落盘的
// 最大 runSeq 时，其后的序号全部缺失。无 run.ended 的 Run（崩溃残留）不推末尾——
// 不知道就不猜（D7 同一精神）。纯函数，无 IO
export function detectEntryGaps(
  entries: readonly EntryRecord[],
  runtimeEvents: readonly RuntimeEventRecord[]
): EntryGap[] {
  const runOrder: RunId[] = [];
  const seqsByRun = new Map<RunId, number[]>();
  for (const entry of entries) {
    let seqs = seqsByRun.get(entry.runId);
    if (seqs === undefined) {
      seqs = [];
      seqsByRun.set(entry.runId, seqs);
      runOrder.push(entry.runId);
    }
    seqs.push(entry.runSeq);
  }
  const messageCountByRun = new Map<RunId, number>();
  for (const event of runtimeEvents) {
    if (event.kind === "run.ended") {
      messageCountByRun.set(event.runId, event.payload.messageCount);
      if (!seqsByRun.has(event.runId)) {
        // Run 有 run.ended 却零 entry：全部映射缺失也是缺口，纳入首见顺序
        seqsByRun.set(event.runId, []);
        runOrder.push(event.runId);
      }
    }
  }
  const gaps: EntryGap[] = [];
  for (const runId of runOrder) {
    const seqs = seqsByRun.get(runId) ?? [];
    const missing: number[] = [];
    let expected = 1;
    for (const seq of seqs) {
      for (let missed = expected; missed < seq; missed++) {
        missing.push(missed);
      }
      expected = Math.max(expected, seq + 1);
    }
    const messageCount = messageCountByRun.get(runId);
    if (messageCount !== undefined) {
      for (let missed = expected; missed <= messageCount; missed++) {
        missing.push(missed);
      }
    }
    if (missing.length > 0) {
      gaps.push({ runId, missingSeqs: missing });
    }
  }
  return gaps;
}

// 生效 grant 还原（决策 3b）：created 减去 revoked——revoked 集合内的 grantId 全部失效；
// 其余按 createdAt 排序原样生效（grant 对象自创建后不可变，无部分撤销）
function activeGrants(
  createds: GrantCreatedRecord[],
  revokeds: GrantRevokedRecord[]
): ActiveGrant[] {
  const revokedIds = new Set(revokeds.map((record) => record.grantId));
  return createds
    .filter((record) => !revokedIds.has(record.grantId))
    .map((record) => ({
      grantId: record.grantId,
      tool: record.tool,
      ...(record.pathPrefix !== undefined ? { pathPrefix: record.pathPrefix } : {}),
      ...(record.command !== undefined ? { command: record.command } : {}),
      ...(record.shell === true ? { shell: true } : {}),
      createdAt: record.createdAt,
      firstCall: record.firstCall,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// 冷启动对账（与 M3 账本 reconcile 逐字同语义 + S2 确证配对）：intent 无 receipt →
// OutcomeUnknown（只留证，不重放）；decision（拒绝）即闭环——与 receipt 配对后归 rejected；
// intent 无 receipt 但有 resolution（哈希自动确证）→ resolved（销账，不再滞留 unknown）
export function reconcileRecords(
  intents: IntentRecord[],
  decisions: DecisionRecord[],
  receipts: Receipt[],
  resolutions: ResolutionRecord[]
): ReconcileReport {
  const receiptByExecution = new Map(receipts.map((r) => [r.executionId, r]));
  const resolutionByExecution = new Map(resolutions.map((r) => [r.executionId, r]));
  const rejected: RejectedEntry[] = [];
  for (const decision of decisions) {
    const receipt = receiptByExecution.get(decision.executionId);
    receiptByExecution.delete(decision.executionId);
    rejected.push(receipt === undefined ? { decision } : { decision, receipt });
  }
  const settled: ReconcileEntry[] = [];
  const unknown: ReconcileEntry[] = [];
  const resolved: ResolvedEntry[] = [];
  for (const intent of intents) {
    const receipt = receiptByExecution.get(intent.executionId);
    receiptByExecution.delete(intent.executionId);
    const resolution = resolutionByExecution.get(intent.executionId);
    resolutionByExecution.delete(intent.executionId);
    if (receipt !== undefined) {
      settled.push({ intent, receipt });
    } else if (resolution !== undefined) {
      resolved.push({ intent, resolution });
    } else {
      unknown.push({ intent });
    }
  }
  return {
    settled,
    unknown,
    rejected,
    resolved,
    orphanReceipts: [...receiptByExecution.values()],
    orphanResolutions: [...resolutionByExecution.values()],
  };
}

// 失败四分类装配（M4 S2，D7）：判据纯函数在 classification.ts（活适配器 RunResult 共用），
// 此处只做「事件日志 → 事实」映射。Run 事实按 runId 聚合；同 Run 多次 turn.completed 以末条
// 为准（与活适配器 judgeTerminal 取末条 assistant 消息同口径）
function classifySessionRecords(
  records: EventRecord[],
  runtimeEvents: RuntimeEventRecord[],
  breakers: BreakerRecord[],
  reconcile: ReconcileReport
): SessionClassification {
  const runOrder: RunId[] = [];
  const runFacts = new Map<RunId, RunOutcomeFacts>();
  const runFactsOf = (runId: RunId): RunOutcomeFacts => {
    let facts = runFacts.get(runId);
    if (facts === undefined) {
      facts = {
        syntheticFailure: false,
        breakerTripped: false,
        hasTurnCompleted: false,
        hasRunEnded: false,
      };
      runFacts.set(runId, facts);
      runOrder.push(runId);
    }
    return facts;
  };
  // grant 族 runId 可选（REPL 时段的放权/撤销无活动 Run）——无 runId 的记录不进
  // 任何 Run 的事实表（grant 是 session 级状态，由 /grants 展示，决策 3b）
  for (const record of records) {
    if (record.runId !== undefined && !REFERENCE_KINDS.has(record.kind)) {
      runFactsOf(record.runId);
    }
  }
  const settledByToolCall = new Map<string, ToolSettledPayload>();
  for (const event of runtimeEvents) {
    if (event.kind === "turn.completed") {
      const facts = runFactsOf(event.runId);
      facts.stopReason = event.payload.stopReason;
      facts.syntheticFailure = event.payload.syntheticFailure;
      facts.hasTurnCompleted = true;
    } else if (event.kind === "run.ended") {
      runFactsOf(event.runId).hasRunEnded = true;
    } else if (event.kind === "tool.settled") {
      settledByToolCall.set(event.payload.toolCallId, event.payload);
    }
  }
  for (const breaker of breakers) {
    runFactsOf(breaker.runId).breakerTripped = true;
  }
  const runs: RunClassification[] = runOrder.map((runId) => ({
    runId,
    failure: classifyRunOutcome(runFactsOf(runId)),
  }));

  const toolExecutions: ToolExecutionClassification[] = [];
  const pushTool = (
    executionId: ExecutionId | null,
    toolCallId: string,
    toolName: string,
    runId: RunId,
    outcome: Omit<ToolOutcomeFacts, "runAborted" | "runBreakerTripped">
  ): void => {
    const facts = runFacts.get(runId);
    toolExecutions.push({
      executionId,
      toolCallId,
      toolName,
      failure: classifyToolOutcome({
        ...outcome,
        runAborted: facts?.stopReason === "aborted",
        runBreakerTripped: facts?.breakerTripped ?? false,
      }),
    });
  };
  for (const { intent, receipt } of reconcile.settled) {
    const settled = settledByToolCall.get(intent.toolCallId);
    pushTool(intent.executionId, intent.toolCallId, intent.toolName, intent.runId, {
      rejected: false,
      hasReceipt: true,
      executed: receipt?.executed ?? false,
      isError: receipt?.isError ?? false,
      ...(settled?.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
      intercepted: false,
    });
  }
  for (const { decision } of reconcile.rejected) {
    pushTool(decision.executionId, decision.toolCallId, decision.toolName, decision.runId, {
      rejected: true,
      hasReceipt: false,
      executed: false,
      isError: false,
      intercepted: false,
    });
  }
  for (const { intent, resolution } of reconcile.resolved) {
    pushTool(intent.executionId, intent.toolCallId, intent.toolName, intent.runId, {
      rejected: false,
      hasReceipt: false,
      executed: false,
      isError: false,
      resolved: resolution.outcome,
      intercepted: false,
    });
  }
  for (const { intent } of reconcile.unknown) {
    const settled = settledByToolCall.get(intent.toolCallId);
    pushTool(intent.executionId, intent.toolCallId, intent.toolName, intent.runId, {
      rejected: false,
      hasReceipt: false,
      executed: false,
      isError: settled?.isError ?? false,
      ...(settled?.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
      intercepted: false,
    });
  }
  const ledgeredToolCalls = new Set<string>();
  for (const intent of reconcile.settled.concat(reconcile.unknown, reconcile.resolved)) {
    ledgeredToolCalls.add(intent.intent.toolCallId);
  }
  for (const { decision } of reconcile.rejected) {
    ledgeredToolCalls.add(decision.toolCallId);
  }
  for (const event of runtimeEvents) {
    if (
      event.kind === "tool.settled" &&
      event.payload.isError &&
      !ledgeredToolCalls.has(event.payload.toolCallId)
    ) {
      pushTool(null, event.payload.toolCallId, event.payload.toolName, event.runId, {
        rejected: false,
        hasReceipt: false,
        executed: false,
        isError: true,
        intercepted: true,
      });
    }
  }
  return { runs, toolExecutions };
}
