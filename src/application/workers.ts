// worker 运行面工厂（M5.5 S2，决策 040）：装配根每 worker 调一次 buildRuntime——治理根恒为主仓库根、
// 工作区根为 worker 工作树、策略为委派子集、审批经编排器汇聚到父级；worker 会话文件首条写 session.header。

import type { ApprovalHandler } from "../approvals/handler.ts";
import { ROLE_THINKING_LEVELS } from "../orchestration/roles.ts";
import type {
  WorkerRuntimeFactory,
  WorkerRuntimeHandle,
  WorkerRuntimeRequest,
} from "../orchestration/workers.ts";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { WorkerRole } from "../state/event-log.ts";
import type { ReceiptId, SessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { buildRuntime, type RuntimeBundle } from "./runtime.ts";

export interface WorkerRuntimeDeps {
  // 每个 worker 的模型接入：生产传同一个无状态 streamFn，测试按 worker 给独立剧本
  streamFnFor: (request: WorkerRuntimeRequest) => StreamFn;
  provider: string;
  modelId: string;
  homeDir?: string;
  persistThinking?: boolean;
  // M5.5 S5（决策 050）：推理档位两级来源——全局值（启动参数），角色配置覆盖（缺省取 roles.ts 角色表）
  thinkingLevel?: ThinkingLevel;
  roleThinkingLevels?: Readonly<Partial<Record<WorkerRole, ThinkingLevel>>>;
}

export interface SessionWorkersDeps extends Omit<WorkerRuntimeDeps, "streamFnFor"> {
  streamFn: StreamFn;
  // 治理根（主仓库根）
  governanceRoot: string;
  // 派出 worker 的父运行面：父策略取其冻结快照，父子两族写其会话文件
  bundle: RuntimeBundle;
  // 父运行面本身是 worker 会话时在场（深度 1：拒绝再派）
  parentSessionId?: SessionId;
  // 汇聚审批入口（Actor 注入，经审批队列）
  approvals: ApprovalHandler;
}

// 按会话装配编排器（M5.5 S4）：Actor 只拿四动作面，不触达 orchestration 的构造细节
export function createSessionWorkers(deps: SessionWorkersDeps): WorkerOrchestrator {
  return new WorkerOrchestrator({
    governanceRoot: deps.governanceRoot,
    session: {
      sessionId: deps.bundle.adapter.sessionId,
      ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
    },
    parentPolicy: deps.bundle.adapter.snapshot().tools.policy,
    parentLog: deps.bundle.eventLog,
    approvals: deps.approvals,
    createRuntime: createWorkerRuntimeFactory({
      streamFnFor: () => deps.streamFn,
      provider: deps.provider,
      modelId: deps.modelId,
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.persistThinking !== undefined ? { persistThinking: deps.persistThinking } : {}),
      ...(deps.thinkingLevel !== undefined ? { thinkingLevel: deps.thinkingLevel } : {}),
      ...(deps.roleThinkingLevels !== undefined
        ? { roleThinkingLevels: deps.roleThinkingLevels }
        : {}),
    }),
  });
}

export function createWorkerRuntimeFactory(deps: WorkerRuntimeDeps): WorkerRuntimeFactory {
  return (request): WorkerRuntimeHandle => {
    const thinkingLevel =
      (deps.roleThinkingLevels ?? ROLE_THINKING_LEVELS)[request.role] ?? deps.thinkingLevel;
    const bundle = buildRuntime({
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      streamFn: deps.streamFnFor(request),
      workspaceRoot: request.workspace.path,
      governanceRoot: request.governanceRoot,
      toolPolicy: request.policy,
      // M5.5 S5（决策 048）：run_command 按角色套 .pigeon/commands.json 的允许清单
      commandRole: request.role,
      sessionId: request.sessionId,
      yolo: request.policy.approvalMode === "yolo",
      provider: deps.provider,
      modelId: deps.modelId,
      // M5.5 S3（决策 040）：审批经编排器汇聚到父级；放权落点挂 worker 自己的 grant 存储——
      // [a]/[d] 创建的会话 grant 写进 worker 会话文件，只在该 worker 内生效，随其结束作废
      createApprovalHandler: (workerGrants) => (approval) =>
        request.approvalHandler({ ...approval, grants: workerGrants }),
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.persistThinking !== undefined ? { persistThinking: deps.persistThinking } : {}),
    });
    try {
      bundle.eventLog.appendSessionHeader({
        parentSessionId: request.lineage.parentSessionId,
        ...(request.lineage.parentRunId !== undefined
          ? { parentRunId: request.lineage.parentRunId }
          : {}),
        worker: { name: request.name, role: request.role },
        workspace: request.workspace,
        startedAt: Date.now(),
      });
    } catch (error) {
      bundle.eventLog.close();
      throw error;
    }
    const { adapter, eventLog } = bundle;
    return {
      run: (task) => adapter.run(task),
      interrupt: () => adapter.interrupt(),
      subscribe: (listener) => adapter.subscribe(listener),
      receiptIds: () =>
        adapter
          .toolExecutions()
          .flatMap((record): ReceiptId[] =>
            record.receiptId !== undefined ? [record.receiptId] : []
          ),
      summary: () => {
        const last = adapter.transcript().findLast((message) => message.role === "assistant");
        if (last === undefined || last.role !== "assistant") {
          return "";
        }
        return last.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("")
          .trim();
      },
      dispose: async () => {
        await adapter.dispose();
        eventLog.close();
      },
    };
  };
}
