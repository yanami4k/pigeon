// 复盘（决策 186、191、192、207、221、240、241、243；施工默认 Q9、Q11、Q13）：从本会话分叉出一个复盘会话，沿用原会话的
// 系统提示与工具定义（命中缓存），在末尾追加一条复盘指令，让同一模型用 update_memory 更新学到的记忆。
// - 分叉：目标为来源会话主分支上最后一条消息条目，位置写 at（上游给条目号时位置缺省为 before）；上游读盘上的内容，
//   调用方须先让来源的写者落盘。复盘会话是普通的新会话，Run 开始条目记复盘种类与模板版本（175）。
// - 指令：{当前记忆全文} 在复盘时现读 MEMORY.md（干活的 agent 中途可能已改过）；收尾复盘另填验证结论。
// - 工具：请求里的工具定义与原会话相同，执行时只放行 read_file 与 update_memory，其余调用不执行、回一句固定的话（240）。
// - 预算：另设轮数与墙钟上限（缺省 40 轮、15 分钟，243），不占这一步的宽上限（171）。
// - 失败：复盘失败或撞上限都不改变这一步的结果；由调用方经去重告警写标准错误输出，并记进结果。

import { MEMORY_FILE_HEADER } from "../memory/learned.ts";
import { readMemoryFile } from "../memory/learned-store.ts";
import {
  REVIEW_ALLOWED_TOOLS,
  REVIEW_TOOL_REFUSAL,
  type ReviewKind,
  reviewInstruction,
  withReviewedUpTo,
} from "../memory/review-text.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
} from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import type { ToolGovernanceFactory } from "../pi-runtime/governance.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import { forkSessionFile, sessionContextMessages } from "../pi-runtime/session-store.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import type { ReviewCoverage } from "../state/learned-memory.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import { dedupedWarner, failureDetail, type WarnSink } from "./warnings.ts";
import { sessionsDirOf } from "./workspace.ts";

// 复盘模型（决策 296）：日常使用中在配置里指定后，压缩前、收尾、补做三种复盘都用它（provider 与模型号，经本会话同一个模型接入发出）；
// 不指定时压缩前与收尾复盘用会话本身的模型，补做用本次启动的模型。跑批器不给，行为不变
export interface ReviewModelChoice {
  provider: string;
  modelId: string;
}

// 配置文件里的写法（provider、model）→ 装配用的写法
export function reviewModelChoice(
  configured: { provider: string; model: string } | undefined
): ReviewModelChoice | undefined {
  return configured !== undefined
    ? { provider: configured.provider, modelId: configured.model }
    : undefined;
}

// 复盘上限（243）：校准时临时取 40 轮、15 分钟；可配置
export interface ReviewBudget {
  maxTurns: number;
  wallClockMs: number;
}

export const DEFAULT_REVIEW_BUDGET: Readonly<ReviewBudget> = {
  maxTurns: 40,
  wallClockMs: 15 * 60_000,
};

export function assertReviewBudget(budget: ReviewBudget): void {
  if (!Number.isInteger(budget.maxTurns) || budget.maxTurns < 1) {
    throw new Error(`复盘轮数上限需要正整数：${budget.maxTurns}`);
  }
  if (!Number.isInteger(budget.wallClockMs) || budget.wallClockMs < 1) {
    throw new Error(`复盘墙钟上限需要正整数（毫秒）：${budget.wallClockMs}`);
  }
}

// 一次复盘的结果（进 headless 结果与跑批器结果行）
export interface ReviewOutcome {
  kind: ReviewKind;
  // 复盘会话；分叉没成时缺省
  sessionId?: SessionId;
  // completed 为正常收尾；turn-limit / wall-clock-limit 为撞复盘上限；其余为失败（failed、aborted、empty-reply）
  status: string;
  turns: number;
  tokens: number;
  wallMs: number;
  hitLimit: boolean;
  // 失败原因（撞上限不算失败，不带）
  error?: string;
}

// 复盘开始与结束的观察口：headless 据此在压缩前复盘期间暂停这一步的墙钟，跑批器据此在复盘前后读网关计量
export interface ReviewObserver {
  started?(kind: ReviewKind): void;
  ended?(outcome: ReviewOutcome): void;
}

// 复盘运行面：与 worker 同一形状的最小子集
export interface ReviewRuntime {
  run(task: string): Promise<{ status: string; emptyReply?: boolean; errorMessage?: string }>;
  interrupt(cause?: RunStopCause): Promise<void>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  dispose(): Promise<void>;
}

export interface MemoryReviewInput {
  kind: ReviewKind;
  governanceRoot: string;
  sourceSessionId: SessionId;
  // 收尾复盘的验证结论（按 review-text.ts 的填法）；压缩前复盘不给
  verdict?: string;
  // 补做（295）：此前的复盘已覆盖到上下文里的第几条消息；在场即在指令第一段之后写明，仍给完整上下文
  reviewedUpTo?: number;
  budget: ReviewBudget;
  // 用分叉出的会话号与还原的消息装配复盘运行面（系统提示取来源冻结的原文、只放行两件工具，由调用方装配）；
  // covers 为这次复盘覆盖到来源会话的哪一条记录（283 补充），调用方写进复盘会话的 Run 开始条目
  open(review: ForkedReview): ReviewRuntime;
  // 外部中止（跑批器作废这一步等）：在途的复盘立即中止
  abortSignal?: AbortSignal;
}

// {当前记忆全文}：现读的 MEMORY.md 原文；文件还不在时给新建文件的文件头（空记忆）
export function currentMemoryText(governanceRoot: string): string {
  const read = readMemoryFile(governanceRoot);
  return (read.exists ? read.text : MEMORY_FILE_HEADER).trimEnd();
}

// 分叉出的复盘会话：会话号、还原的消息与覆盖到的来源条目
export interface ForkedReview {
  sessionId: SessionId;
  initialMessages: AgentMessage[];
  covers: ReviewCoverage;
}

// 分叉：来源主分支上最后一条消息条目，位置 at；返回复盘会话号、还原的消息与分叉点（即覆盖到的记录）
async function forkForReview(
  sessionsDir: string,
  sourceSessionId: SessionId
): Promise<ForkedReview> {
  const located = locateSessionFile(sessionsDir, sourceSessionId);
  if (located === undefined) {
    throw new Error("来源会话在会话存储里没有会话文件");
  }
  const view = readSessionFile(located.path);
  const main = view !== undefined ? branchEntries(view, view.lanes.get("main") ?? null) : [];
  const last = main.findLast((entry) => entry.type === "message");
  if (last === undefined) {
    throw new Error("来源会话里还没有消息，没有可复盘的内容");
  }
  const sessionId = newSessionId();
  const branchPath = await forkSessionFile({
    sessionsRoot: sessionsDir,
    source: { sessionId: sourceSessionId, path: located.path },
    entryId: last.id,
    branchSessionId: sessionId,
    cwd: view?.header.cwd ?? "",
  });
  const loaded = loadStoreSessionFile(branchPath);
  if (loaded === undefined) {
    throw new Error("复盘会话的文件读不出来");
  }
  return {
    sessionId,
    initialMessages: sessionContextMessages(loaded.main),
    covers: { entryId: last.id, seq: last.seq },
  };
}

export async function runMemoryReview(input: MemoryReviewInput): Promise<ReviewOutcome> {
  const startedAt = Date.now();
  let sessionId: SessionId | undefined;
  let turns = 0;
  let tokens = 0;
  let limitHit: RunStopCause | undefined;
  const outcome = (status: string, error?: string): ReviewOutcome => ({
    kind: input.kind,
    ...(sessionId !== undefined ? { sessionId } : {}),
    status,
    turns,
    tokens,
    wallMs: Date.now() - startedAt,
    hitLimit: status === "turn-limit" || status === "wall-clock-limit",
    ...(error !== undefined ? { error } : {}),
  });
  let runtime: ReviewRuntime | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe = (): void => {};
  const onAbort = () => {
    runtime?.interrupt().catch(() => {});
  };
  try {
    if (input.abortSignal?.aborted === true) {
      return outcome("aborted", "复盘开始之前已被中止");
    }
    const forked = await forkForReview(sessionsDirOf(input.governanceRoot), input.sourceSessionId);
    sessionId = forked.sessionId;
    // 当前记忆全文在复盘开始时现读
    const memory = currentMemoryText(input.governanceRoot);
    const instruction =
      input.kind === "closing"
        ? reviewInstruction({ kind: "closing", verdict: input.verdict ?? "", memory })
        : reviewInstruction({ kind: "pre-compaction", memory });
    const text =
      input.reviewedUpTo !== undefined
        ? withReviewedUpTo(instruction, input.reviewedUpTo)
        : instruction;
    const current = input.open(forked);
    runtime = current;
    const stop = (cause: RunStopCause) => {
      if (limitHit !== undefined) {
        return;
      }
      limitHit = cause;
      current.interrupt(cause).catch(() => {});
    };
    unsubscribe = current.subscribe((event) => {
      if (event.kind !== "turn.completed") {
        return;
      }
      turns += 1;
      tokens += (event.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0;
      if (turns >= input.budget.maxTurns) {
        stop("turn-limit");
      }
    });
    timer = setTimeout(() => stop("wall-clock-limit"), input.budget.wallClockMs);
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const result = await current.run(text);
    if (result.status === "aborted") {
      return limitHit !== undefined
        ? outcome(limitHit)
        : outcome("aborted", result.errorMessage ?? "复盘被中止");
    }
    if (result.emptyReply === true) {
      return outcome("empty-reply", "复盘的模型回复为空");
    }
    if (result.status !== "completed") {
      return outcome(result.status, result.errorMessage ?? `复盘以 ${result.status} 收尾`);
    }
    return outcome("completed");
  } catch (error) {
    return outcome("failed", failureDetail(error));
  } finally {
    clearTimeout(timer);
    unsubscribe();
    input.abortSignal?.removeEventListener("abort", onAbort);
    try {
      await runtime?.dispose();
    } catch {
      // 释放失败不改变复盘结果
    }
  }
}

// 复盘失败与撞上限的告警：写标准错误输出，同一类只说一次（warnings.ts 口径）；文案说明后果
export function reviewWarner(sink?: WarnSink): (outcome: ReviewOutcome) => void {
  const warn = dedupedWarner(sink);
  return (outcome) => {
    const label = outcome.kind === "closing" ? "收尾复盘" : "压缩前复盘";
    if (outcome.hitLimit) {
      warn(
        new Error(`${label}撞上限：${outcome.status}`),
        `${label}撞上复盘上限（${outcome.status === "turn-limit" ? "轮数" : "墙钟"}）而中止：已写入的记忆照常保留，这一步的结果不受影响`
      );
    } else if (outcome.status !== "completed") {
      warn(
        new Error(`${label}失败：${outcome.error ?? outcome.status}`),
        `${label}失败：${outcome.error ?? outcome.status}；这一步的结果不受影响，记忆可能没有更新`
      );
    }
  };
}

// 复盘运行面的工具闸（240）：请求里的工具定义不变，执行时只放行 read_file 与 update_memory，其余调用在治理判定之前拦下、
// 回固定的一句话，不执行。拦下的调用不进治理的账本与熔断计数（它们不是上游拦截，也不该触发熔断）；on 为假时原样返回
export function gateReviewTools(
  on: boolean,
  factory: ToolGovernanceFactory
): ToolGovernanceFactory {
  if (!on) {
    return factory;
  }
  return (host) => {
    const inner = factory(host);
    const gated = new Set<string>();
    return {
      beginRun: () => inner.beginRun(),
      decide: async (call) => {
        if (!REVIEW_ALLOWED_TOOLS.includes(call.toolName)) {
          gated.add(call.toolCallId);
          return { kind: "block", reason: REVIEW_TOOL_REFUSAL };
        }
        return inner.decide(call);
      },
      governs: (toolCallId) => gated.has(toolCallId) || inner.governs(toolCallId),
      decisionOf: (toolCallId) => inner.decisionOf(toolCallId),
      settle: (settlement) => {
        if (!gated.has(settlement.toolCallId)) {
          inner.settle(settlement);
        }
      },
      runOutcome: () => inner.runOutcome(),
      toolExecutions: () => inner.toolExecutions(),
    };
  };
}
