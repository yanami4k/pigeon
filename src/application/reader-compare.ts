// 读者对照（决策 180 / 206，账本重构第二段）：同一次运行，旧读法（物化旧账本）与新读法（读新会话存储）的判定输出逐项比较，
// 一致才算改对。覆盖本段迁移的读者：
// - 判定：各 Run 的失败分类、成败标签与其事实（运行结束、悬账数、撞上限、验证结论）、回炉一步、尝试切片（条目范围、轮次、
//   标签、验证记录所在会话）、运行指标（轮次、工具调用、用量、需审批次数、失败分类）、工具级失败分类；
// - 恢复与分叉：生效授权、worker 与分支来历、分叉记录、每个可分叉位置之前最近的快照、续跑还原的消息条数。
// 已知的预期差异（停写后失去来源、判据有意改变）在差异上标出原因，清单见 docs/audits 的本段审计与 spikes/ledger-migration/README.md；
// 未标原因的差异即读法改错。本模块只读，不改任何文件；停写旧账本时连同旧读法一起删除。
import { isDeepStrictEqual } from "node:util";
import { materializeSession } from "../persistence/event-log.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { resolveCheckpointBefore } from "../state/checkpoint-ref.ts";
import { buildTaskAttempt, firstRunOf } from "../state/episode.ts";
import type { RunId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { attemptOutcomeFacts, labelAttempt } from "../state/outcome-label.ts";
import { repairStepOutcome, stepRunsOf } from "../state/repair-step.ts";
import {
  FAIL_CLOSED_APPROVAL_REASON,
  type StoreSessionView,
  storeActiveGrants,
  storeAttemptFacts,
  storeAttemptLabel,
  storeCheckpointBefore,
  storeFirstRun,
  storeRepairStepOutcome,
  storeRunFailure,
  storeRunMetrics,
  storeTaskAttempt,
  storeToolOutcomes,
} from "../state/session-judge.ts";
import { summarizeRunMetrics } from "./headless-core.ts";

export type ReaderArea =
  | "会话"
  | "失败分类"
  | "成败标签"
  | "回炉一步"
  | "尝试切片"
  | "运行指标"
  | "工具分类"
  | "授权"
  | "来历"
  | "分叉"
  | "快照"
  | "续跑";

export interface ReaderDiff {
  area: ReaderArea;
  where: string;
  old: unknown;
  new: unknown;
  // 预期差异的原因；缺省即未预期（读法改错）
  expected?: string;
}

export interface ReaderComparison {
  sessionId: string;
  diffs: ReaderDiff[];
  // 比较过的项数
  checked: number;
}

// 预期差异的原因（与审计、README 的清单一一对应）
export const EXPECTED = {
  evalVerified: "旧 eval.verified 随 184 停写，新读法不计",
  approvalScope: "需审批次数按裁决计入人工批准或拒绝与无审批通道的拒绝，旧读法只计 yolo 批发授权",
  thrownRun: "Run 以异常结束时新存储记出错收尾，旧账本没有运行结束记录",
  interruptedResult: "续跑为悬空调用补的工具结果只写新存储",
  endedAt: "结束时刻取自不同记录（旧 run.ended 与新 Run 收尾条目），相差几毫秒",
  recordId: "验证记录引用的记录号两边各自编号",
} as const;

export interface ReaderCompareOptions {
  // 已注册工具的风险档位（需审批次数按它现算）；缺省按内置工具
  toolTiers?: ReadonlyMap<string, string>;
  // 可能承载验证记录的其他会话（worker 尝试的验证落在父会话里）
  verificationSources?: readonly string[];
}

// 内置工具的风险档位（与 application/runtime.ts 的注册一致；会话检索与技能加载同为读档，需审批次数不计读档，
// 不必列出）；MCP 等其余工具由调用方传入
export const BUILTIN_TOOL_TIERS: ReadonlyMap<string, string> = new Map([
  ["read_file", "read"],
  ["edit_file", "write"],
  ["run_command", "exec"],
]);

export function compareReaders(input: {
  sessionsDir: string;
  sessionId: string;
  options?: ReaderCompareOptions;
}): ReaderComparison {
  const { sessionsDir, sessionId } = input;
  const options = input.options ?? {};
  const diffs: ReaderDiff[] = [];
  let checked = 0;
  const loaded = loadStoreSession(sessionsDir, sessionId);
  if (loaded === undefined) {
    return {
      sessionId,
      checked: 1,
      diffs: [{ area: "会话", where: "新存储", old: "有", new: "没有会话文件" }],
    };
  }
  const old = materializeSession(sessionsDir, sessionId as never);
  const view = loaded.view;
  const sources = (options.verificationSources ?? []).flatMap((id) => {
    const source = loadStoreSession(sessionsDir, id);
    return source !== undefined
      ? [
          {
            old: materializeSession(sessionsDir, id as never, { content: false }),
            view: source.view,
          },
        ]
      : [];
  });
  const oldSources = sources.map((source) => source.old);
  const newSources = sources.map((source) => source.view);
  const same = (area: ReaderArea, where: string, a: unknown, b: unknown, expected?: string) => {
    checked += 1;
    if (!isDeepStrictEqual(a, b)) {
      diffs.push({ area, where, old: a, new: b, ...(expected !== undefined ? { expected } : {}) });
    }
  };

  const oldRuns = old.runStarteds.map((record) => record.runId);
  same(
    "会话",
    "Run 先后",
    oldRuns,
    view.runs.map((run) => run.runId)
  );
  const thrown = new Set(
    view.runs
      .filter(
        (run) =>
          run.end?.ending === "error" &&
          !old.runtimeEvents.some(
            (event) => event.kind === "run.ended" && event.runId === run.runId
          )
      )
      .map((run) => run.runId)
  );
  const evalRuns = new Set(old.evalVerifieds.map((record) => record.runId));

  // ---- 判定 ----
  for (const run of view.runs) {
    const runId = run.runId;
    const where = `Run ${runId}`;
    const runExpected = thrown.has(runId) ? EXPECTED.thrownRun : undefined;
    same(
      "失败分类",
      where,
      old.classification.runs.find((entry) => entry.runId === runId)?.failure ?? null,
      storeRunFailure(run),
      runExpected
    );
    const oldFacts = attemptOutcomeFacts(old, runId, { verificationSources: oldSources });
    const newFacts = storeAttemptFacts(view, runId, { verificationSources: newSources });
    const factsExpected = runExpected ?? (evalRuns.has(runId) ? EXPECTED.evalVerified : undefined);
    same("成败标签", `${where} 的事实`, oldFacts, newFacts, factsExpected);
    same(
      "成败标签",
      where,
      labelAttempt(oldFacts),
      storeAttemptLabel(view, runId, { verificationSources: newSources }),
      factsExpected
    );
  }
  same("回炉一步", "整步结果", repairStepOutcome(old), storeRepairStepOutcome(view));

  if (firstRunOf(old) !== undefined && storeFirstRun(view) !== undefined) {
    const oldAttempt = buildTaskAttempt({
      governanceRoot: "",
      session: old,
      verificationSources: oldSources,
    });
    const newAttempt = storeTaskAttempt({
      governanceRoot: "",
      view,
      verificationSources: newSources,
    });
    const firstExpected =
      (thrown.has(newAttempt.runId) ? EXPECTED.thrownRun : undefined) ??
      (evalRuns.has(newAttempt.runId) ? EXPECTED.evalVerified : undefined);
    same(
      "尝试切片",
      "Run 与条目范围",
      [oldAttempt.runId, oldAttempt.entryRange],
      [newAttempt.runId, newAttempt.entryRange]
    );
    same("尝试切片", "轮次", oldAttempt.turns, newAttempt.turns);
    same("尝试切片", "标签", oldAttempt.label, newAttempt.label, firstExpected);
    same(
      "尝试切片",
      "验证记录所在会话",
      oldAttempt.verification?.sessionId,
      newAttempt.verification?.sessionId,
      firstExpected
    );
    same(
      "尝试切片",
      "有无结束时刻",
      oldAttempt.endedAt !== undefined,
      newAttempt.endedAt !== undefined,
      firstExpected
    );
  }

  const tiers = options.toolTiers ?? BUILTIN_TOOL_TIERS;
  const oldMetrics = summarizeRunMetrics(old);
  const newMetrics = storeRunMetrics(view, { toolTiers: tiers });
  // 旧读法不计、新读法按裁决计入的调用：本步里由人批准或拒绝的、因无审批通道而拒绝的
  const stepRuns = new Set(stepRunsOf(old, oldMetrics.runId ?? ("" as RunId)));
  const widened =
    old.intents.filter(
      (record) => stepRuns.has(record.runId) && record.decision.approvedBy === "human"
    ).length +
    old.decisions.filter(
      (record) =>
        stepRuns.has(record.runId) &&
        (record.decision.approvedBy === "human" ||
          record.decision.reason?.startsWith(FAIL_CLOSED_APPROVAL_REASON) === true)
    ).length;
  same("运行指标", "首个 Run", oldMetrics.runId, newMetrics.runId);
  same("运行指标", "轮次", oldMetrics.turns, newMetrics.turns);
  same("运行指标", "工具调用", oldMetrics.toolCalls, newMetrics.toolCalls);
  same("运行指标", "用量", oldMetrics.usage, newMetrics.usage);
  same(
    "运行指标",
    "需审批次数",
    oldMetrics.approvalsNeeded,
    newMetrics.approvalsNeeded,
    widened > 0 && newMetrics.approvalsNeeded - oldMetrics.approvalsNeeded === widened
      ? EXPECTED.approvalScope
      : undefined
  );
  same(
    "运行指标",
    "失败分类",
    oldMetrics.failure,
    newMetrics.failure,
    newMetrics.runId !== undefined && thrown.has(newMetrics.runId) ? EXPECTED.thrownRun : undefined
  );

  compareToolOutcomes(old, view, same);

  // ---- 恢复与分叉 ----
  const grantShape = (grants: MaterializedSession["grants"]) =>
    grants.map((grant) => ({
      grantId: grant.grantId,
      tool: grant.tool,
      pathPrefix: grant.pathPrefix,
      command: grant.command,
      shell: grant.shell,
      createdAt: grant.createdAt,
    }));
  same("授权", "生效授权", grantShape(old.grants), grantShape(storeActiveGrants(view)));

  const header = old.sessionHeader;
  same(
    "来历",
    "worker 会话",
    header !== undefined
      ? {
          parent: header.parentSessionId,
          name: header.worker.name,
          role: header.worker.role,
          workspace: header.workspace,
        }
      : undefined,
    view.metadata?.worker !== undefined
      ? {
          parent: view.parentSessionId,
          name: view.metadata.worker.name,
          role: view.metadata.worker.role,
          workspace: view.metadata.worker.workspace,
        }
      : undefined
  );
  const branch = old.branchHeader;
  const newBranch = view.metadata?.branch;
  same(
    "来历",
    "分支会话",
    branch !== undefined
      ? [
          branch.sourceSessionId,
          branch.forkPoint,
          branch.checkpoint,
          branch.workspace,
          branch.trigger,
        ]
      : undefined,
    newBranch !== undefined
      ? [
          newBranch.sourceSessionId,
          newBranch.forkPoint,
          newBranch.checkpoint,
          newBranch.workspace,
          newBranch.trigger,
        ]
      : undefined
  );
  same(
    "分叉",
    "分叉记录",
    old.sessionForkeds.map((record) => [
      record.branchSessionId,
      record.forkPoint,
      record.checkpoint,
      record.trigger,
    ]),
    view.forks.map((record) => [
      record.data.branchSessionId,
      record.data.forkPoint,
      record.data.checkpoint,
      record.data.trigger,
    ])
  );
  // 每个可分叉的位置（每个 Run 的每一条消息）之前最近的快照
  for (const run of view.runs) {
    for (let runSeq = 1; runSeq <= run.messages.length; runSeq++) {
      const point = { runId: run.runId, runSeq };
      same(
        "快照",
        `${run.runId} 第 ${runSeq} 条之前`,
        resolveCheckpointBefore(old, point),
        storeCheckpointBefore(view, point)
      );
    }
  }
  // 续跑还原的消息条数：非分支会话即本会话全部消息（分支会话含复制段，不比）
  if (newBranch === undefined) {
    const interrupted = view.runs.some((run) =>
      run.messages.some(
        (ref) =>
          ref.message.role === "toolResult" &&
          typeof ref.message.details === "object" &&
          ref.message.details !== null &&
          "pigeonInterrupted" in ref.message.details
      )
    );
    same(
      "续跑",
      "还原的消息条数",
      old.entries.length,
      sessionContextMessages(loaded.main).length,
      interrupted ? EXPECTED.interruptedResult : undefined
    );
  }
  return { sessionId, diffs, checked };
}

function compareToolOutcomes(
  old: MaterializedSession,
  view: StoreSessionView,
  same: (area: ReaderArea, where: string, a: unknown, b: unknown, expected?: string) => void
): void {
  const oldByCall = new Map(
    old.classification.toolExecutions.map((entry) => [entry.toolCallId, entry.failure])
  );
  for (const outcome of storeToolOutcomes(view)) {
    // 旧读法只给落了治理记录或以出错落定的调用分类；成功的读档调用旧读法不列，新读法记非失败
    const oldFailure = oldByCall.has(outcome.toolCallId) ? oldByCall.get(outcome.toolCallId) : null;
    same(
      "工具分类",
      `${outcome.toolName} ${outcome.toolCallId}`,
      oldFailure ?? null,
      outcome.failure
    );
  }
}
