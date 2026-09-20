// 提炼候选落盘（M7 S4，决策 074 / 075）：候选走 M6 的暂存、扫描与账本链路——模型只产出结论，程序落盘。
// 元数据为 v3，带对比来源块（成败两侧尝试引用、共享前缀、标签与验证记录引用、产物形态、其余同组尝试）。
// 产出规则（§M7 完成证据"失败分支只产生 failure case，不会被写成长期事实"）：
// - 流程（workflow）与步骤集（procedure）必须有成功侧证据；
// - 只有失败侧证据的条目只能是教训（lesson），且不得是 memory（长期事实）；
// 违反规则的条目丢弃，每次提炼有丢弃时留一条不可解析记录列出丢弃项与原因；整体不合格式时只留痕、不落文件。
// 主证据一侧：教训取失败侧（有失败侧证据时），流程与步骤集取成功侧；source 的会话与 Run 即该侧，producerSessionId 为提炼器会话。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type CandidateSink, sourceDigest, stageCandidate } from "../review/candidates.ts";
import {
  type AttemptRef,
  CANDIDATE_VERSION,
  CandidateNameSchema,
  type ContrastSource,
  ProducibleCandidateKindSchema,
  type ReviewerCandidate,
} from "../state/candidate.ts";
import type { DistillAttemptScope, DistillTarget } from "../state/distill.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { sessionsDirOf } from "./snapshot.ts";

const RunSeqsSchema = Type.Array(Type.Integer({ minimum: 1 }));

// 提炼器交回的结构化结果（与 prompt.ts 的输出格式同源）
export const DistillerItemSchema = Type.Object({
  kind: ProducibleCandidateKindSchema,
  name: CandidateNameSchema,
  summary: Type.String({ minLength: 1, maxLength: 300 }),
  strength: Type.Number({ minimum: 0, maximum: 1 }),
  form: Type.Union([Type.Literal("lesson"), Type.Literal("workflow"), Type.Literal("procedure")]),
  content: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  evidence: Type.Object({
    successful: Type.Optional(RunSeqsSchema),
    failed: Type.Optional(RunSeqsSchema),
    prefix: Type.Optional(RunSeqsSchema),
  }),
});

// 外层形状：candidates 数组；逐项按 DistillerItemSchema 校验，单项不合格只丢弃该项
export const DistillerResultSchema = Type.Object({
  candidates: Type.Array(DistillerItemSchema),
});
export type DistillerResult = Static<typeof DistillerResultSchema>;
type DistillerItem = Static<typeof DistillerItemSchema>;

export interface PersistDistillerInput {
  // 暂存目录所在的治理根（当前治理根；被读的尝试可在其他治理根）
  governanceRoot: string;
  // 宿主会话的会话文件：候选两族与不可解析记录写在这里
  sink: CandidateSink;
  // 宿主记录的信封 Run
  hostRunId: RunId;
  target: DistillTarget;
  distillSessionId: SessionId;
  structured: unknown;
  model: { provider: string; id: string };
  usage?: { turns: number; totalTokens: number };
  now?: () => number;
}

export interface PersistDistillerResult {
  written: ReviewerCandidate[];
  duplicates: number;
  rejected: Array<{ name: string; reason: string }>;
  unparsable?: string;
}

function refOf(scope: DistillAttemptScope): AttemptRef {
  return {
    governanceRoot: scope.governanceRoot,
    sessionId: scope.sessionId,
    runId: scope.runId,
    entryRange: { from: scope.from, to: scope.to },
    label: scope.label,
    ...(scope.verification !== undefined ? { verification: scope.verification } : {}),
  };
}

// 产出规则：返回违反原因；合规返回 undefined
function ruleViolation(target: DistillTarget, item: DistillerItem): string | undefined {
  const successEvidence =
    target.successful !== undefined && (item.evidence.successful?.length ?? 0) > 0;
  if (item.form !== "lesson" && !successEvidence) {
    return "流程与步骤集必须有成功侧证据";
  }
  if (!successEvidence && item.kind === "memory") {
    return "只有失败侧证据的条目不得写成长期事实（memory）";
  }
  return undefined;
}

export function persistDistillerCandidates(input: PersistDistillerInput): PersistDistillerResult {
  const now = input.now ?? Date.now;
  const { target } = input;
  const envelope = input.structured as { candidates?: unknown } | undefined;
  if (typeof envelope !== "object" || envelope === null || !Array.isArray(envelope.candidates)) {
    const reason =
      input.structured === undefined
        ? "提炼器没有交回结构化结果"
        : `结构化结果不符合格式：${[
            ...Value.Errors(DistillerResultSchema, input.structured ?? null),
          ]
            .slice(0, 3)
            .map((error) => `${error.instancePath || "/"} ${error.message}`)
            .join("；")}`;
    input.sink.appendObservation({
      kind: "review.unparsable",
      runId: input.hostRunId,
      payload: { producerSessionId: input.distillSessionId, reason },
    });
    return { written: [], duplicates: 0, rejected: [], unparsable: reason };
  }
  const written: ReviewerCandidate[] = [];
  const rejected: PersistDistillerResult["rejected"] = [];
  let duplicates = 0;
  for (const raw of envelope.candidates) {
    if (!Value.Check(DistillerItemSchema, raw)) {
      const name = (raw as { name?: unknown } | null)?.name;
      const reason = [...Value.Errors(DistillerItemSchema, raw)]
        .slice(0, 2)
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("；");
      rejected.push({
        name: typeof name === "string" ? name : "（无名）",
        reason: `不符合格式：${reason}`,
      });
      continue;
    }
    const item = raw;
    const violation = ruleViolation(target, item);
    if (violation !== undefined) {
      rejected.push({ name: item.name, reason: violation });
      continue;
    }
    // 主证据一侧
    const failedFirst =
      item.form === "lesson" &&
      target.failed !== undefined &&
      (item.evidence.failed?.length ?? 0) > 0;
    const primary = failedFirst ? target.failed : (target.successful ?? target.failed);
    const primarySeqs = (failedFirst ? item.evidence.failed : item.evidence.successful) ?? [];
    if (primary === undefined) {
      rejected.push({ name: item.name, reason: "这组尝试没有可作为主证据的一侧" });
      continue;
    }
    const contrast: ContrastSource = {
      form: item.form,
      successful: target.successful !== undefined ? [refOf(target.successful)] : [],
      failed: target.failed !== undefined ? [refOf(target.failed)] : [],
      ...(target.sharedPrefix !== undefined
        ? {
            sharedPrefix: {
              sessionId: target.sharedPrefix.sessionId,
              runId: target.sharedPrefix.runId,
              from: target.sharedPrefix.from,
              to: target.sharedPrefix.to,
            },
          }
        : {}),
      ...(target.others.length > 0 ? { others: target.others.map((other) => ({ ...other })) } : {}),
    };
    const candidate = stageCandidate({
      governanceRoot: input.governanceRoot,
      kind: item.kind,
      name: item.name,
      content: item.content,
      build: (facts) => ({
        version: CANDIDATE_VERSION,
        origin: "distiller",
        kind: item.kind,
        name: item.name,
        contentHash: facts.contentHash,
        bytes: facts.bytes,
        source: {
          sessionId: primary.sessionId,
          runId: primary.runId,
          producerSessionId: input.distillSessionId,
          entryRunSeqs: primarySeqs,
          contentDigest: sourceDigest(
            sessionsDirOf(primary.governanceRoot),
            primary.sessionId,
            primary.runId,
            primarySeqs
          ),
        },
        summary: item.summary,
        strength: item.strength,
        scan: facts.scan,
        ...(facts.supersedes !== undefined ? { supersedes: facts.supersedes } : {}),
        createdAt: now(),
        contrast,
      }),
    });
    if (candidate === undefined) {
      duplicates += 1;
      continue;
    }
    input.sink.appendCandidateProposed({
      runId: input.hostRunId,
      candidate,
      model: { ...input.model },
      ...(input.usage !== undefined ? { usage: { ...input.usage } } : {}),
    });
    input.sink.appendCandidateScreened({
      runId: input.hostRunId,
      candidateKind: item.kind,
      name: item.name,
      contentHash: candidate.contentHash,
      scannerVersion: candidate.scan.scannerVersion,
      hits: candidate.scan.hits,
    });
    written.push(candidate);
  }
  if (rejected.length > 0) {
    input.sink.appendObservation({
      kind: "review.unparsable",
      runId: input.hostRunId,
      payload: {
        producerSessionId: input.distillSessionId,
        reason: `提炼结果丢弃 ${rejected.length} 项：${rejected
          .map((entry) => `${entry.name}（${entry.reason}）`)
          .join("；")}`,
      },
    });
  }
  return {
    written,
    duplicates,
    rejected,
  };
}
