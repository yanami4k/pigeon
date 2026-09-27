// 快照挂到运行面（M7 S5，决策 078）：订阅 Adapter 的归一化事件——写档或命令档工具提议时记基线（会话首次改动之前），
// 落定后文件确实改变才生成快照，并落一条 workspace.checkpoint 观察记录（ref、提交、树、改前基线、工具调用号、条目号）。
// 条目号取"当前条目号 + 1"：Adapter 写死顺序执行，上游在 tool_execution_end 之后紧接着发该工具结果消息的 message_end，
// 所以落定时刻的下一条就是结果消息；记录同时带工具调用号，冷侧可与内容文件交叉核对。
// 快照在事件分派内同步执行（必须先于下一次工具调用改文件）；任何快照故障不影响运行，进内部错误清单，
// 同时向标准错误输出一条说明后果的告警（同一类故障只说一次），不静默。
// 非 git 工作区不挂（不打快照、不报错；在非 git 工作区发起分叉时由分叉入口明确报错）。
import {
  type Checkpointer,
  createCheckpointer,
  isGitWorkspace,
} from "../orchestration/checkpoint.ts";
import type { RuntimeBundle } from "./runtime.ts";
import { checkpointEntry } from "./session-store.ts";
import { dedupedWarner, failureDetail } from "./warnings.ts";

export interface CheckpointAttachment {
  checkpointer: Checkpointer;
  stop(): void;
  errors(): unknown[];
}

export function attachCheckpoints(options: {
  bundle: RuntimeBundle;
  workspaceRoot: string;
}): CheckpointAttachment | undefined {
  const { bundle, workspaceRoot } = options;
  if (!isGitWorkspace(workspaceRoot)) {
    return undefined;
  }
  const checkpointer = createCheckpointer({ workspaceRoot, sessionId: bundle.adapter.sessionId });
  const errors: unknown[] = [];
  const warn = dedupedWarner();
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
          bundle.adapter.recordObservation("workspace.checkpoint", {
            ...checkpoint,
            afterRunSeq: bundle.adapter.entrySeq() + 1,
          });
          // 决策 206 双写：代码快照条目紧跟在发起调用的助手消息之后、工具结果消息之前（位置取代 afterRunSeq）
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
