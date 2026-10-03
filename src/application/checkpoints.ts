// 快照挂到运行面（M7 S5，决策 078；决策 350 移出关键路径）：写档或命令档工具第一次提议时记基线（会话首次改动之前）；
// 工具结果交回时先看工具自己的证据——编辑类失败、run_command 的文件变化报告为空且完整——显示没有改动就不拍；
// 否则先写"拍摄中"标记（带工具调用号与条目号），再在后台拍快照，与下一次模型请求同时进行。拍完写代码快照条目
// （ref、提交、树、改前基线、工具调用号、条目号），文件没有改变写 unchanged 标记，失败写 failed 标记。
// 从工具结束到下一次工具开始之间 Pigeon 不改工作区文件，后台拍到的与当场拍到的是同一状态；为此下一次工具执行
// （Adapter 的工具执行前等待口）、分叉与退出会话之前先等未完成的快照拍完。等待有上限：超时即中止其 git 进程，
// 该快照记为失败，对应分叉点明确报错，会话不挂住。
// 任何快照故障不影响运行，进内部错误清单，同时向标准错误输出一条说明后果的告警（同一类故障只说一次），不静默。
// 决策 286：告警出口可由调用方给出（终端界面运行期间落消息区）；不给即照旧写标准错误输出。
// 非 git 工作区不挂（不打快照、不报错；在非 git 工作区发起分叉时由分叉入口明确报错）。
import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
} from "../orchestration/checkpoint.ts";
import type { PiRuntimeAdapter, ToolResultNotice } from "../pi-runtime/adapter.ts";
import type { RunId } from "../state/ids.ts";
import type { CheckpointMarkState } from "../state/session-entries.ts";
import type { ToolRiskTier } from "../tools/registry.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { checkpointEntry, checkpointMarkEntry } from "./session-store.ts";
import { dedupedWarner, failureDetail, type WarnSink } from "./warnings.ts";

// 等未完成快照的上限：git 卡住时会话不能永远挂住
export const CHECKPOINT_WAIT_MS = 30_000;

export class CheckpointWaitTimeoutError extends Error {}

export interface CheckpointAttachment {
  checkpointer: Checkpointer;
  // 等未完成的快照拍完；超过上限的记为失败并中止，不抛
  settle(): Promise<void>;
  // 等完未完成的快照再退订、删临时索引（退出会话时）
  close(): Promise<void>;
  // 立即退订，不等
  stop(): void;
  errors(): unknown[];
}

// 运行面里挂快照用到的部分（结构类型）
export interface CheckpointHost {
  adapter: Pick<
    PiRuntimeAdapter,
    "sessionId" | "subscribe" | "subscribeToolResults" | "addToolGate" | "entrySeq"
  >;
  toolTiers: ReadonlyMap<string, ToolRiskTier>;
  sessionStore: Pick<RuntimeBundle["sessionStore"], "append">;
}

// 工具自己的证据显示没有改动（决策 350）：编辑类工具失败；命令带完整的文件变化报告且新增、删除、修改都为空。
// 其余情况（命令出错没有报告、报告不完整、其他命令档工具）都要拍
export function evidenceShowsNoChange(
  tier: ToolRiskTier,
  result: Pick<ToolResultNotice, "isError" | "details">
): boolean {
  if (tier === "write") {
    return result.isError;
  }
  const changes =
    typeof result.details === "object" && result.details !== null
      ? (result.details as { fileChanges?: unknown }).fileChanges
      : undefined;
  if (typeof changes !== "object" || changes === null) {
    return false;
  }
  const { added, removed, modified, truncated } = changes as Record<string, unknown>;
  return (
    truncated === false &&
    [added, removed, modified].every((files) => Array.isArray(files) && files.length === 0)
  );
}

interface Mark {
  runId: RunId;
  toolCallId: string;
  runSeq: number;
}

interface Job {
  promise: Promise<void>;
  controller: AbortController;
  // 快照对应的拍摄标记（基线没有）
  mark?: Mark;
  // 已有下文（拍完、失败或超时记失败）：之后到达的结果一律不再写
  finished: boolean;
}

export function attachCheckpoints(options: {
  bundle: CheckpointHost;
  workspaceRoot: string;
  // 决策 286：告警出口（缺省标准错误输出）
  warn?: WarnSink;
  // 等待上限（缺省 CHECKPOINT_WAIT_MS）
  waitMs?: number;
  // 缺省按工作区新建
  checkpointer?: Checkpointer;
}): CheckpointAttachment | undefined {
  const { bundle, workspaceRoot } = options;
  if (options.checkpointer === undefined && !isGitWorkspace(workspaceRoot)) {
    return undefined;
  }
  const checkpointer =
    options.checkpointer ??
    createCheckpointer({ workspaceRoot, sessionId: bundle.adapter.sessionId });
  const waitMs = options.waitMs ?? CHECKPOINT_WAIT_MS;
  const errors: unknown[] = [];
  const warn = dedupedWarner(options.warn);
  const report = (error: unknown) => {
    errors.push(error);
    warn(
      error,
      `工作区快照告警：${failureDetail(error)}（该时点的快照没有拍成，从这里分叉会明确报错，不退回更早的快照）`
    );
  };
  const tierOf = (toolName: string) => bundle.toolTiers.get(toolName);
  const writeMark = (mark: Mark, state: CheckpointMarkState, reason?: string) =>
    bundle.sessionStore.append(
      checkpointMarkEntry(mark.runId, {
        toolCallId: mark.toolCallId,
        runSeq: mark.runSeq,
        state,
        ...(reason !== undefined ? { reason } : {}),
      })
    );

  const pending = new Set<Job>();
  const start = <T>(
    work: (signal: AbortSignal) => Promise<T>,
    done: (result: T) => void,
    mark?: Mark
  ): void => {
    const job: Job = {
      promise: Promise.resolve(),
      controller: new AbortController(),
      finished: false,
      ...(mark !== undefined ? { mark } : {}),
    };
    pending.add(job);
    job.promise = (async () => {
      try {
        // 让出这一轮事件循环：工具结果交回之后，下一次模型请求先发出
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (job.finished) {
          return;
        }
        const result = await work(job.controller.signal);
        if (!job.finished) {
          job.finished = true;
          done(result);
        }
      } catch (error) {
        if (!job.finished) {
          job.finished = true;
          if (mark !== undefined) {
            writeMark(mark, "failed", failureDetail(error));
          }
          report(error);
        }
      } finally {
        pending.delete(job);
      }
    })();
  };

  const settle = async (): Promise<void> => {
    const deadline = Date.now() + waitMs;
    while (pending.size > 0) {
      const jobs = [...pending];
      let timer: NodeJS.Timeout | undefined;
      const inTime = await Promise.race([
        Promise.all(jobs.map((job) => job.promise)).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      if (inTime) {
        continue;
      }
      for (const job of [...pending]) {
        pending.delete(job);
        if (job.finished) {
          continue;
        }
        job.finished = true;
        job.controller.abort();
        const error = new CheckpointWaitTimeoutError(
          `快照等待超时：超过 ${waitMs} 毫秒没有拍完，已中止`
        );
        if (job.mark !== undefined) {
          writeMark(job.mark, "failed", error.message);
        }
        report(error);
      }
    }
  };

  let baselineRequested = false;
  const unsubscribe = bundle.adapter.subscribe((event) => {
    if (event.kind !== "tool.proposed" || baselineRequested) {
      return;
    }
    const tier = tierOf((event.payload as { toolName: string }).toolName);
    if (tier === "write" || tier === "exec") {
      // 只有第一次需要：之后快照器自己知道基线已记下（或已丢失）
      baselineRequested = true;
      start(
        (signal) => checkpointer.beforeChange(signal),
        () => {}
      );
    }
  });
  const unsubscribeResults = bundle.adapter.subscribeToolResults((notice) => {
    const tier = tierOf(notice.toolName);
    if ((tier !== "write" && tier !== "exec") || evidenceShowsNoChange(tier, notice)) {
      return;
    }
    // 观察口在工具结果消息写进会话存储之后、同一次分派里调用：这时的条目号就是该工具结果消息的序号
    const mark: Mark = {
      runId: notice.runId,
      toolCallId: notice.toolCallId,
      runSeq: bundle.adapter.entrySeq(),
    };
    writeMark(mark, "shooting");
    start(
      (signal) => checkpointer.afterChange(signal),
      (snapshot) => {
        if (snapshot === undefined) {
          writeMark(mark, "unchanged");
          return;
        }
        bundle.sessionStore.append(
          checkpointEntry(mark.runId, {
            ref: snapshot.ref,
            commit: snapshot.commit,
            tree: snapshot.tree,
            ...(snapshot.baseCommit !== undefined ? { baseCommit: snapshot.baseCommit } : {}),
            toolCallId: mark.toolCallId,
            runSeq: mark.runSeq,
          })
        );
      },
      mark
    );
  });
  const removeGate = bundle.adapter.addToolGate(settle);
  const stop = () => {
    unsubscribe();
    unsubscribeResults();
    removeGate();
  };
  return {
    checkpointer,
    settle,
    close: async () => {
      await settle();
      stop();
      await checkpointer.close();
    },
    stop,
    errors: () => [...errors],
  };
}
