// 候选的决定与激活（M8 S6 / S7，决策 089 / 092 / 093）：`pigeon candidates approve|reject|revoke|supersede`
// 的执行层。四个动作合成一族记录，用动作字段区分（089）。
//
// 不可绕过审批（完成证据第一条）：候选正文按哈希不可变地躺在暂存目录里，状态由账本现算，
// 这里是唯一一条把它复制进治理根正常目录的路径；写盘前先落决定记录（治理族 fsync），
// 写不进就不动文件——扩权动作 fail-closed，同 grant.created 的口径。
//
// 批准的四道闸（092）：
//   1. 扫描拒收的候选一律不可批准；
//   2. 结论为回归的候选一律不可批准，翻案只能靠重验；
//   3. 结论为未测出、或从未验证过的候选可由人显式批准，但理由必填、来源记人写，
//      激活记录带"未经回放证实"标记；
//   4. 验证当时装载的那套经验与此刻要激活的那套不是同一套时，旧批准失效，要求重新验证（091）。
//
// 激活（093）：复制到治理根的正常目录，人仍可直接编辑；激活记录存写盘后回读的内容哈希，
// 启动时比对并在不一致时标注"已脱离批准版本"，不阻止使用。撤销为移走文件并留记录，不追溯既往会话。
import {
  activateExperience,
  activationPathFor,
  driftOf,
  revokeExperience,
} from "../activation/activate.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { projectedExperienceSet } from "../replay/materials.ts";
import { isProducibleCandidateKind } from "../state/candidate.ts";
import type {
  CandidateActivatedRecord,
  CandidateDecidedRecord,
  CandidateDecisionAction,
} from "../state/event-log.ts";
import { newSessionId } from "../state/ids.ts";
import {
  buildCandidateIndex,
  candidateLockPath,
  type LocatedCandidate,
  readCandidateBody,
  resolveCandidate,
} from "./candidate-lookup.ts";
import { sessionsDirOf } from "./workspace.ts";

export class CandidateDecisionError extends Error {}

// 未给理由时的默认拒绝文案；来源记系统默认，事后能与人写的理由分开看（决策 066）
export const DEFAULT_REJECT_REASON = "未说明理由";

export interface DecideCandidateInput {
  governanceRoot: string;
  // 候选选择器：内容哈希前缀或 种类/名字
  selector: string;
  action: CandidateDecisionAction;
  // 人写的理由；批准未测出或未验证的候选时必填
  reason?: string;
  // 取代动作：接替它的新候选内容哈希
  supersededBy?: string;
  // 只在测试与"确实要跳过环境比对"时用：跳过第 4 道闸
  skipStalenessCheck?: boolean;
  now?: () => number;
}

export interface DecideCandidateResult {
  decision: CandidateDecidedRecord;
  // 批准时在场
  activation?: CandidateActivatedRecord;
  // 激活落点（批准与撤销时在场）
  path?: string;
}

export function decideCandidate(input: DecideCandidateInput): DecideCandidateResult {
  const now = input.now ?? Date.now;
  // 第一次定位只为把选择器解成内容哈希——锁路径按哈希取，不先解就不知道该锁哪一把
  const located = resolveCandidate(buildCandidateIndex(input.governanceRoot), input.selector);
  const { candidate } = located;
  // 同一条候选同一时刻只许一件事：与验证共用按内容哈希取的那把锁。
  // 两个进程同时批准与撤销同一条候选时，两条决定记录的先后随机，落点文件可能被删除那一方赢在最后，
  // 而状态投影按"最后一条决定"算出已激活——文件没了，状态却说它激活着。
  // 取锁排在任何写入之前（连会话文件都还没开），异常路径由 finally 放锁
  const release = acquireExclusiveLock(
    candidateLockPath(input.governanceRoot, candidate.contentHash),
    `候选 ${candidate.kind}/${candidate.name}（${candidate.contentHash.slice(0, 12)}）正在被另一次验证或审批占用`
  );
  // 决定与激活写进本次命令自己的会话文件（M8 收口修复）：候选的来源会话可能正被另一个
  // 会话进程写着，去抢它的写入锁会让"活会话期间批不了候选"。候选状态本就由账本现算，
  // 三族落在哪个文件不影响投影（buildCandidateIndex 跨会话收集），单写者约束也因此一字未动。
  const log = new JsonlEventLog(sessionsDirOf(input.governanceRoot), newSessionId());
  try {
    // 取锁之后按内容哈希重新算一遍状态：上面那次定位发生在取锁之前，
    // 那段窗口里别人可能刚批准或刚撤销过这条候选，拿旧投影去判闸等于没锁
    const entry = resolveCandidate(
      buildCandidateIndex(input.governanceRoot),
      candidate.contentHash
    );
    switch (input.action) {
      case "approve":
        return approve(input, entry, log, now);
      case "reject":
        return { decision: appendDecision(input, entry, log, now, "reject") };
      case "revoke":
        return revoke(input, entry, log, now);
      case "supersede": {
        if (input.supersededBy === undefined || !/^[0-9a-f]{64}$/.test(input.supersededBy)) {
          throw new CandidateDecisionError(
            `取代需要给出接替它的候选内容哈希（完整 64 位）：${candidate.kind}/${candidate.name}`
          );
        }
        return {
          decision: appendDecision(input, entry, log, now, "supersede", {
            supersededBy: input.supersededBy,
          }),
        };
      }
    }
  } finally {
    log.close();
    release();
  }
}

function appendDecision(
  input: DecideCandidateInput,
  entry: LocatedCandidate,
  log: JsonlEventLog,
  now: () => number,
  action: CandidateDecisionAction,
  extra: { supersededBy?: string; verification?: CandidateDecidedRecord["verification"] } = {}
): CandidateDecidedRecord {
  const reason = input.reason?.trim();
  const human = reason !== undefined && reason !== "";
  // 不带信封 Run：本记录落在本次命令自己的会话里，而候选的来源 Run 在别的会话文件中；
  // 来源由候选元数据的 source 四项承载，不靠信封
  return log.appendCandidateDecided({
    candidateKind: entry.candidate.kind,
    name: entry.candidate.name,
    contentHash: entry.candidate.contentHash,
    action,
    reason: human ? reason : DEFAULT_REJECT_REASON,
    reasonSource: human ? "human" : "system-default",
    ...(extra.supersededBy !== undefined ? { supersededBy: extra.supersededBy } : {}),
    ...(extra.verification !== undefined ? { verification: extra.verification } : {}),
    decidedAt: now(),
  });
}

function approve(
  input: DecideCandidateInput,
  entry: LocatedCandidate,
  log: JsonlEventLog,
  now: () => number
): DecideCandidateResult {
  const { candidate, status, verified } = entry;
  // 决策 094：已停止产出的种类没有激活落点。判据放在决定之前——放在激活层意味着
  // 决定记录已经落盘才抛，账本里会留下一条"批过但没生效"，与第一道时序修复同一个道理
  if (!isProducibleCandidateKind(candidate.kind)) {
    throw new CandidateDecisionError(
      `候选种类 ${candidate.kind} 已停止产出、没有激活落点（决策 094）：这条旧候选只能读与拒绝，不可批准`
    );
  }
  if (status === "ScanRejected") {
    throw new CandidateDecisionError(
      `候选 ${candidate.kind}/${candidate.name} 已被确定性扫描拒收，永不参与激活，不可批准`
    );
  }
  if (status === "Superseded") {
    throw new CandidateDecisionError(
      `候选 ${candidate.kind}/${candidate.name} 已被新版本取代，不可批准（请批准接替它的那一个）`
    );
  }
  if (verified?.conclusion === "regressed") {
    throw new CandidateDecisionError(
      `候选 ${candidate.kind}/${candidate.name} 的回放结论是回归（正回放差 ${verified.positiveDelta.toFixed(2)}，` +
        `负回放差 ${verified.negativeDelta.toFixed(2)}）：回归一律不可批准，翻案只能靠重新验证`
    );
  }
  const unverified = verified?.conclusion !== "passed";
  const reason = input.reason?.trim();
  if (unverified && (reason === undefined || reason === "")) {
    throw new CandidateDecisionError(
      `候选 ${candidate.kind}/${candidate.name} ${verified === undefined ? "从未经过回放验证" : "的回放结论是未测出"}：` +
        "可以人工批准，但必须用 --reason 写明理由（理由来源记为人写，激活记录会标注未经回放证实）"
    );
  }
  // 时序（M8 收口修复）：正文的内容哈希核对在读的那一刻完成（readCandidateBody 内），
  // 落决定记录与写落点都排在它之后。核对若留到写盘之后，被篡改的正文已经进了装载目录、
  // 账本里也已经有一条批准记录，而漂移检测因为没有激活记录并不会报。
  const body = readCandidateBody(input.governanceRoot, entry);
  if (input.skipStalenessCheck !== true && verified !== undefined) {
    assertEnvironmentUnchanged(input.governanceRoot, entry, body);
  }
  // 决定先落盘再动文件：写不进就不激活（扩权动作 fail-closed）
  const decision = appendDecision(input, entry, log, now, "approve", {
    ...(verified !== undefined
      ? { verification: { recordId: verified.id, conclusion: verified.conclusion } }
      : {}),
  });
  const activated = activateExperience({
    governanceRoot: input.governanceRoot,
    kind: candidate.kind,
    name: candidate.name,
    content: body,
  });
  if (activated.activatedHash !== candidate.contentHash) {
    throw new CandidateDecisionError(
      `激活内容与批准内容摘要不一致：${activated.path}（批准 ${candidate.contentHash.slice(0, 12)}，` +
        `落点 ${activated.activatedHash.slice(0, 12)}）`
    );
  }
  const activation = log.appendCandidateActivated({
    candidateKind: candidate.kind,
    name: candidate.name,
    contentHash: candidate.contentHash,
    path: activated.path,
    activatedHash: activated.activatedHash,
    unverified,
    decisionId: decision.id,
    activatedAt: now(),
  });
  return { decision, activation, path: activated.path };
}

function revoke(
  input: DecideCandidateInput,
  entry: LocatedCandidate,
  log: JsonlEventLog,
  now: () => number
): DecideCandidateResult {
  const { candidate, activated } = entry;
  if (activated === undefined) {
    throw new CandidateDecisionError(
      `候选 ${candidate.kind}/${candidate.name} 没有激活记录，无从撤销`
    );
  }
  // 落点按种类与名字重算（M8 收口补遗）：撤销是不可逆的递归删除，不能拿记录里的自由字符串直接删。
  // 与记录不一致即拒绝——不猜哪一个才是对的，也不替人删一个说不清来历的路径
  if (!isProducibleCandidateKind(candidate.kind)) {
    throw new CandidateDecisionError(
      `候选种类 ${candidate.kind} 没有激活落点（决策 094），无从撤销`
    );
  }
  const expected = activationPathFor(candidate.kind, candidate.name);
  if (activated.path !== expected) {
    throw new CandidateDecisionError(
      `激活记录里的落点与按种类和名字重算的不一致，拒绝撤销：记录 ${activated.path}，重算 ${expected}`
    );
  }
  // 先落记录再移文件：记录写不进就不撤——反过来会让审计看到"还在生效"而文件已不在
  const decision = appendDecision(input, entry, log, now, "revoke");
  revokeExperience({ governanceRoot: input.governanceRoot, path: expected });
  return { decision, path: expected };
}

// 第 4 道闸（091）：验证当时装载的那套经验，与此刻批准后会装载的那套，必须是同一套
function assertEnvironmentUnchanged(
  governanceRoot: string,
  entry: LocatedCandidate,
  body: string
): void {
  const { candidate, verified } = entry;
  if (verified === undefined) {
    return;
  }
  const projected = projectedExperienceSet(governanceRoot, {
    kind: candidate.kind,
    name: candidate.name,
    content: body,
  });
  if (projected.experienceSetHash !== verified.environment.experienceSetHash) {
    throw new CandidateDecisionError(
      `验证当时的经验集合与此刻要激活的不是同一套（验证时 ${verified.environment.experienceSetHash.slice(0, 12)}，` +
        `现在 ${projected.experienceSetHash.slice(0, 12)}）：旧批准依据的证据不再描述将要激活的那一套，` +
        "请先 pigeon verify 重新验证"
    );
  }
}

// 激活落点的漂移（093）：给启动检查与详情视图共用
export function activationDrift(
  governanceRoot: string,
  entry: LocatedCandidate
): { path: string; state: "same" | "drifted" | "missing" } | undefined {
  const { activated } = entry;
  if (activated === undefined) {
    return undefined;
  }
  const path = activated.path;
  return {
    path,
    state: driftOf({ governanceRoot, path, activatedHash: activated.activatedHash }).state,
  };
}
