// worker 运行面工厂（M5.5 S2，决策 040）：装配根每 worker 调一次 buildRuntime——治理根恒为主仓库根、
// 工作区根为 worker 工作树、策略为委派子集、审批经编排器汇聚到父级；worker 会话文件首条写 session.header。
// M5.7 S4（决策 054）：治理根有 MCP 配置时，worker 以其工作树为工作区根启动自己的 MCP server（roots 即工作树）；
// 启动是异步的，运行面在 run 时就绪——订阅先于就绪时暂存、就绪后接上，就绪前取消即按中止收尾。
// 没有 MCP 配置时仍同步装配，行为与 M5.5 相同（会话头写不进在派出时即报错）。

import type { ApprovalHandler } from "../approvals/handler.ts";
import { ROLE_THINKING_LEVELS } from "../orchestration/roles.ts";
import type {
  WorkerRuntimeFactory,
  WorkerRuntimeHandle,
  WorkerRuntimeRequest,
} from "../orchestration/workers.ts";
import { WorkerOrchestrator } from "../orchestration/workers.ts";
import { loadMcpConfig } from "../persistence/mcp-config.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { WorkerRole } from "../state/event-log.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { ReceiptId, SessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type RuntimeBundle, type RuntimeDeps } from "./runtime.ts";

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
  // M5.7 S4（决策 054）：worker 的 MCP 会话启动器——缺省在治理根有 MCP 配置时以 worker 工作树为工作区根启动；
  // 测试注入内存传输
  startMcp?: (request: WorkerRuntimeRequest) => Promise<McpSession>;
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
      ...(deps.startMcp !== undefined ? { startMcp: deps.startMcp } : {}),
    }),
  });
}

export function createWorkerRuntimeFactory(deps: WorkerRuntimeDeps): WorkerRuntimeFactory {
  return (request): WorkerRuntimeHandle => {
    const thinkingLevel =
      (deps.roleThinkingLevels ?? ROLE_THINKING_LEVELS)[request.role] ?? deps.thinkingLevel;
    const runtimeDeps: Omit<RuntimeDeps, "mcp"> = {
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
    };
    // MCP 配置畸形在此响亮失败（派出失败）
    const startMcp =
      deps.startMcp ??
      (loadMcpConfig(request.governanceRoot).servers.length > 0
        ? (target: WorkerRuntimeRequest) =>
            startMcpSession({
              governanceRoot: target.governanceRoot,
              workspaceRoot: target.workspace.path,
            })
        : undefined);
    if (startMcp === undefined) {
      return readyHandle(openWorkerBundle(request, runtimeDeps));
    }
    return pendingHandle(
      startMcp(request).then(async (mcp) => {
        try {
          return openWorkerBundle(request, { ...runtimeDeps, mcp });
        } catch (error) {
          await mcp.close();
          throw error;
        }
      })
    );
  };
}

// 装配运行面并写 worker 会话头；会话头写不进即关会话文件并上抛
function openWorkerBundle(request: WorkerRuntimeRequest, runtimeDeps: RuntimeDeps): RuntimeBundle {
  const bundle = buildRuntime(runtimeDeps);
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
  return bundle;
}

function receiptIdsOf(bundle: RuntimeBundle): ReceiptId[] {
  return bundle.adapter
    .toolExecutions()
    .flatMap((record): ReceiptId[] => (record.receiptId !== undefined ? [record.receiptId] : []));
}

function summaryOf(bundle: RuntimeBundle): string {
  const last = bundle.adapter.transcript().findLast((message) => message.role === "assistant");
  if (last === undefined || last.role !== "assistant") {
    return "";
  }
  return last.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

function readyHandle(bundle: RuntimeBundle): WorkerRuntimeHandle {
  const { adapter } = bundle;
  return {
    run: (task) => adapter.run(task),
    interrupt: () => adapter.interrupt(),
    subscribe: (listener) => adapter.subscribe(listener),
    receiptIds: () => receiptIdsOf(bundle),
    summary: () => summaryOf(bundle),
    dispose: () => disposeRuntime(bundle),
  };
}

// 运行面异步就绪（M5.7 S4）：装配失败经 run 上抛（编排器按失败收尾）；dispose 等就绪后释放
function pendingHandle(ready: Promise<RuntimeBundle>): WorkerRuntimeHandle {
  let bundle: RuntimeBundle | undefined;
  let interruptedEarly = false;
  // 就绪前订阅的监听器 → 就绪后的退订函数
  const early = new Map<(event: EventEnvelope) => void, () => void>();
  const settled = ready.then((value) => {
    bundle = value;
    for (const listener of early.keys()) {
      early.set(listener, value.adapter.subscribe(listener));
    }
    return value;
  });
  // 拒绝由 run / dispose 观察；此处只防未处理拒绝
  settled.catch(() => {});
  return {
    run: async (task) => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      return current.adapter.run(task);
    },
    interrupt: async () => {
      if (bundle === undefined) {
        interruptedEarly = true;
        return;
      }
      await bundle.adapter.interrupt();
    },
    subscribe: (listener) => {
      if (bundle !== undefined) {
        return bundle.adapter.subscribe(listener);
      }
      early.set(listener, () => {});
      return () => {
        const unsubscribe = early.get(listener);
        early.delete(listener);
        unsubscribe?.();
      };
    },
    receiptIds: () => (bundle !== undefined ? receiptIdsOf(bundle) : []),
    summary: () => (bundle !== undefined ? summaryOf(bundle) : ""),
    dispose: async () => {
      const current = await settled.catch(() => undefined);
      if (current !== undefined) {
        await disposeRuntime(current);
      }
    },
  };
}
