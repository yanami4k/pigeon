// 候选验证（M8 S3 / S4 / S6 / S8，决策 082 / 084 / 086 / 091）：`pigeon verify` 的执行层。
//
// 一次验证 = 四组各跑固定 N 次的重执行，再按三值口径出结论，最后落一条验证回执。
//   - 失败侧（正回放）：从那次失败尝试的任务开始处重跑，带经验应当变好；
//   - 成功侧（负回放）：从那次成功尝试的任务开始处重跑，带经验不应变差。
// 四组固定 N 全跑不中途停（084）；四组按次序交错跑（第 1 次的四组、第 2 次的四组……），
// 与 Eval 同一考虑：减少模型服务随时间漂移落在某一组身上。
//
// 拒绝出结论的几种前置（都响亮失败，不降级）：
//   - 扫描拒收的候选：永不参与激活，不值得烧四组预算；
//   - 没有对比来源块的候选：单来源候选没有成败两侧，回放无从比较；
//   - 已停止产出的种类（094）：没有激活落点、不进任何装载路径，回放测不出差别，
//     这类旧候选既不可批准也不可激活，不值得烧二十次运行换一个必然的未测出；
//   - 两侧尝试的模型标识或预算不一致：环境摘要只有一份，记谁都会把另一侧说错（091）。
import { describeHead, resolveCommit } from "../orchestration/worktree.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { experienceSetHash } from "../replay/environment.ts";
import { type AttemptPlan, resolveAttemptPlan } from "../replay/plan.ts";
import {
  assertRerunCount,
  DEFAULT_RERUN_N,
  judgeReruns,
  RERUN_ARMS,
  type RerunArm,
} from "../replay/verdict.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import { type AttemptRef, isProducibleCandidateKind } from "../state/candidate.ts";
import type {
  CandidateVerifiedRecord,
  LoadedExperience,
  RerunRun,
  VerificationEnvironment,
} from "../state/event-log.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import {
  buildCandidateIndex,
  candidateLockPath,
  type LocatedCandidate,
  readCandidateBody,
  resolveCandidate,
} from "./candidate-lookup.ts";
import {
  createRerunDispatcher,
  effectiveLimits,
  type RerunDispatcherOptions,
  VerifyPreconditionError,
} from "./rerun.ts";
import { sessionsDirOf } from "./workspace.ts";

// 前置错误定义在 rerun 层（两层互引会成环），此处按原名转出，调用方与测试不受影响
export { VerifyPreconditionError } from "./rerun.ts";

export interface VerifyCandidateOptions {
  governanceRoot: string;
  repoRoot: string;
  // 候选选择器：内容哈希前缀或 种类/名字
  selector: string;
  verify: VerifyConfig;
  runtimeFactoryFor: RerunDispatcherOptions["runtimeFactoryFor"];
  n?: number;
  effectThreshold?: number;
  gate?: RerunDispatcherOptions["gate"];
  keepWorktree?: boolean;
  // 每次回放收尾后回调（CLI 打进度）
  onRerun?: (run: RerunRun) => void;
  now?: () => number;
}

export interface VerifyCandidateResult {
  record: CandidateVerifiedRecord;
  errors: unknown[];
}

export async function verifyCandidate(
  options: VerifyCandidateOptions
): Promise<VerifyCandidateResult> {
  const now = options.now ?? Date.now;
  // 次数校验前置到一切之前（M8 收口补遗）：定位候选、解计划、开工作树都排在它后面
  const n = options.n ?? DEFAULT_RERUN_N;
  assertRerunCount(n);
  const index = buildCandidateIndex(options.governanceRoot);
  const entry = resolveCandidate(index, options.selector);
  const { candidate } = entry;
  assertVerifiable(entry);
  // 同一条候选同一时刻只许一件事：人工触发与无人值守自动验证可能同时跑同一条候选，
  // 四组工作树名只由候选哈希、组别与序号决定，撞车会同时毁掉两次验证的工作树，还会落两条回执。
  // 锁按候选内容哈希取，跨进程有效且不可重入，与四个决定动作共用同一把
  const release = acquireExclusiveLock(
    candidateLockPath(options.governanceRoot, candidate.contentHash),
    `候选 ${candidate.kind}/${candidate.name}（${candidate.contentHash.slice(0, 12)}）正在被另一次验证或审批占用`
  );
  try {
    return await runVerification(options, entry, now, n);
  } finally {
    release();
  }
}

async function runVerification(
  options: VerifyCandidateOptions,
  entry: LocatedCandidate,
  now: () => number,
  n: number
): Promise<VerifyCandidateResult> {
  const { candidate } = entry;
  const contrast = candidate.contrast;
  if (contrast === undefined) {
    throw new VerifyPreconditionError(
      `候选 ${candidate.kind}/${candidate.name} 没有对比来源块：单来源候选没有成败两侧，回放无从比较`
    );
  }
  const failedRef = contrast.failed[0];
  const successfulRef = contrast.successful[0];
  if (failedRef === undefined || successfulRef === undefined) {
    throw new VerifyPreconditionError(
      `候选 ${candidate.kind}/${candidate.name} 的对比来源块缺一侧：正回放与负回放都要有对应的尝试`
    );
  }
  const body = readCandidateBody(options.governanceRoot, entry);
  const planFor = (ref: AttemptRef): AttemptPlan =>
    resolveAttemptPlan({
      sessionsDir: sessionsDirOf(ref.governanceRoot),
      sessionId: ref.sessionId,
      runId: ref.runId,
      resolveBranchTip: (branch) => resolveCommit(options.repoRoot, branch),
    });
  const failedPlan = planFor(failedRef);
  const successfulPlan = planFor(successfulRef);
  assertComparable(failedPlan, successfulPlan);

  // 本次验证自己的会话（M8 收口修复）：派出与收尾两族、验证回执都落在它里面。
  // 候选的来源会话可能正被另一个会话进程写着，去抢它的写入锁会让活会话期间验不了候选；
  // 候选状态本就由账本现算，三族落在哪个文件不影响投影
  const verifySessionId = newSessionId();
  const dispatcher = createRerunDispatcher({
    governanceRoot: options.governanceRoot,
    repoRoot: options.repoRoot,
    hostSessionId: verifySessionId,
    hostLog: hostLogProxy(options.governanceRoot, verifySessionId),
    nameSeed: candidate.contentHash,
    runtimeFactoryFor: options.runtimeFactoryFor,
    verify: options.verify,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    ...(options.keepWorktree !== undefined ? { keepWorktree: options.keepWorktree } : {}),
  });
  const candidateBody = {
    kind: candidate.kind,
    name: candidate.name,
    content: body,
    contentHash: candidate.contentHash,
  };
  const runs: RerunRun[] = [];
  let withExperiences: LoadedExperience[] | undefined;
  let withSetHash: string | undefined;
  // 交错跑：第 1 次的四组、第 2 次的四组……
  for (let index2 = 1; index2 <= n; index2++) {
    for (const arm of RERUN_ARMS) {
      const outcome = await dispatcher.rerun({
        arm,
        index: index2,
        plan: arm.startsWith("failed") ? failedPlan : successfulPlan,
        ...(arm.endsWith("-with") ? { candidate: candidateBody } : {}),
      });
      runs.push(outcome.run);
      options.onRerun?.(outcome.run);
      if (arm.endsWith("-with")) {
        withExperiences ??= outcome.experiences;
        withSetHash ??= outcome.experienceSetHash;
      }
    }
  }
  const judgement = judgeReruns({
    runs: runs.map((run) => ({ arm: run.arm as RerunArm, index: run.index, verdict: run.verdict })),
    n,
    ...(options.effectThreshold !== undefined ? { effectThreshold: options.effectThreshold } : {}),
  });
  const experiences = withExperiences ?? [];
  const environment: VerificationEnvironment = {
    model: failedPlan.model,
    harness: describeHead(options.repoRoot),
    runtime: { node: process.version, platform: process.platform },
    budget: effectiveLimits(failedPlan.budget),
    verify: options.verify,
    experienceSetHash: withSetHash ?? experienceSetHash(experiences),
    experiences,
  };
  const log = new JsonlEventLog(sessionsDirOf(options.governanceRoot), verifySessionId);
  try {
    const record = log.appendCandidateVerified({
      candidateKind: candidate.kind,
      name: candidate.name,
      contentHash: candidate.contentHash,
      conclusion: judgement.conclusion,
      n: judgement.n,
      effectThreshold: judgement.effectThreshold,
      positiveDelta: judgement.positiveDelta,
      negativeDelta: judgement.negativeDelta,
      arms: judgement.arms,
      runs,
      environment,
      verifiedAt: now(),
    });
    return { record, errors: dispatcher.errors() };
  } finally {
    log.close();
  }
}

function assertVerifiable(entry: LocatedCandidate): void {
  const { candidate, status } = entry;
  if (status === "ScanRejected") {
    throw new VerifyPreconditionError(
      `候选 ${candidate.kind}/${candidate.name} 已被确定性扫描拒收，永不参与激活，不做回放验证`
    );
  }
  if (!isProducibleCandidateKind(candidate.kind)) {
    throw new VerifyPreconditionError(
      `候选种类 ${candidate.kind} 已停止产出、没有激活落点（决策 094）：这条旧候选不可批准也不可激活，回放没有意义`
    );
  }
}

function assertComparable(failed: AttemptPlan, successful: AttemptPlan): void {
  const modelOf = (plan: AttemptPlan): string => `${plan.model.provider}/${plan.model.id}`;
  if (modelOf(failed) !== modelOf(successful)) {
    throw new VerifyPreconditionError(
      `两侧尝试的模型标识不同（失败侧 ${modelOf(failed)}，成功侧 ${modelOf(successful)}）：` +
        "环境摘要只有一份，记谁都会把另一侧说错，故拒绝验证"
    );
  }
  const budgetOf = (plan: AttemptPlan): string => JSON.stringify(effectiveLimits(plan.budget));
  if (budgetOf(failed) !== budgetOf(successful)) {
    throw new VerifyPreconditionError(
      `两侧尝试的预算不同（失败侧 ${budgetOf(failed)}，成功侧 ${budgetOf(successful)}）：` +
        "两侧预算不同的对比本身就不公平，且环境摘要只有一份，故拒绝验证"
    );
  }
}

// 宿主会话文件的派出与收尾写入点：每次回放各开一次（整轮验证期间长开会把会话锁占到底，
// 期间任何别的进程都读不了这个会话）
function hostLogProxy(
  governanceRoot: string,
  hostSessionId: SessionId
): RerunDispatcherOptions["hostLog"] {
  const dir = sessionsDirOf(governanceRoot);
  const withLog = <T>(body: (log: JsonlEventLog) => T): T => {
    const log = new JsonlEventLog(dir, hostSessionId);
    try {
      return body(log);
    } finally {
      log.close();
    }
  };
  return {
    appendChildSpawned: (input) => withLog((log) => log.appendChildSpawned(input)),
    appendChildSettled: (input) => withLog((log) => log.appendChildSettled(input)),
  };
}
