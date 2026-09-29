// 快照挂到运行面（M7 S5，决策 078）：订阅 Adapter 的归一化事件——写档或命令档工具提议时记基线（会话首次改动之前），
// 落定后文件确实改变才生成快照，并写一条代码快照条目（ref、提交、树、改前基线、工具调用号）。
// Adapter 写死顺序执行，上游在 tool_execution_end 之后紧接着发该工具结果消息的 message_end，所以条目落在发起调用的
// 助手消息之后、工具结果消息之前，位置即它对应的分叉点。
// 快照在事件分派内同步执行（必须先于下一次工具调用改文件）；任何快照故障不影响运行，进内部错误清单，
// 同时向标准错误输出一条说明后果的告警（同一类故障只说一次），不静默。决策 286：告警出口可由调用方给出
// （终端界面运行期间落消息区）；不给即照旧写标准错误输出，pigeon run 与 eval stream 不给，实验路径不受影响。
// 非 git 工作区不挂（不打快照、不报错；在非 git 工作区发起分叉时由分叉入口明确报错）。
import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
} from "../orchestration/checkpoint.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { checkpointEntry } from "./session-store.ts";
import { dedupedWarner, failureDetail, type WarnSink } from "./warnings.ts";

export interface CheckpointAttachment {
  checkpointer: Checkpointer;
  stop(): void;
  errors(): unknown[];
}

export function attachCheckpoints(options: {
  bundle: RuntimeBundle;
  workspaceRoot: string;
  // 决策 286：告警出口（缺省标准错误输出）
  warn?: WarnSink;
}): CheckpointAttachment | undefined {
  const { bundle, workspaceRoot } = options;
  if (!isGitWorkspace(workspaceRoot)) {
    return undefined;
  }
  const checkpointer = createCheckpointer({ workspaceRoot, sessionId: bundle.adapter.sessionId });
  const errors: unknown[] = [];
  const warn = dedupedWarner(options.warn);
  const changesFiles = (toolName: string) => {
    const tier = bundle.toolTiers.get(toolName);
    return tier === "write" || tier === "exec";
  };
  const unsubscribe = bundle.adapter.subscribe((event) => {
    try {
      if (event.kind === "tool.proposed") {
        const payload = event.payload as { toolName: string };
        if (changesFiles(payload.toolName)) {
          checkpointer.beforeChange();
        }
      } else if (event.kind === "tool.settled") {
        const payload = event.payload as { toolName: string; toolCallId: string };
        if (!changesFiles(payload.toolName)) {
          return;
        }
        const snapshot = checkpointer.afterChange();
        if (snapshot !== undefined) {
          const checkpoint = {
            ref: snapshot.ref,
            commit: snapshot.commit,
            tree: snapshot.tree,
            ...(snapshot.baseCommit !== undefined ? { baseCommit: snapshot.baseCommit } : {}),
            toolCallId: payload.toolCallId,
          };
          bundle.sessionStore.append(checkpointEntry(event.runId, checkpoint));
        }
      }
    } catch (error) {
      errors.push(error);
      warn(
        error,
        `工作区快照告警：${failureDetail(error)}（该时点没有快照，从这里分叉会回退到更早的快照）`
      );
    }
  });
  return { checkpointer, stop: unsubscribe, errors: () => [...errors] };
}
