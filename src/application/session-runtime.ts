// 会话运行面装配（决策 067）：新建与 resume 走同一条路——作用域解析（worker 会话回到它自己的
// 工作树与委派策略）、固化 grant 种子物化、MCP 会话启动与启动提示、运行面构建。
// 续跑（决策 183）：运行面打开会话文件之后，用 pi 的 buildSessionContext 还原对话上下文交给 Agent；末条助手消息里
// 悬空的工具调用各补一条"进程中断、结果未知、请自行核实"的工具结果并写进会话，由 agent 自行核对。
// cli 与 tui 此前各写一份 buildWithMcp 与 resume 配方，缺省与提示口径不一；此处收成一份。
// 先建后换语义不变：装配失败（如 grants.json 畸形）时先关掉已启动的 MCP server 再上抛，
// 调用方的旧运行面不受影响。

import { materializeSession } from "../persistence/session-read.ts";
import { loadStoreSession, loadStoreSessionFile } from "../persistence/session-view.ts";
import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { attemptOutcomeFacts, labelAttempt, type OutcomeLabel } from "../state/outcome-label.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { storeAttemptLabel } from "../state/session-judge.ts";
import { type AttemptVerification, attachAttemptVerification } from "./attempt-verify.ts";
import { attachCheckpoints, type CheckpointAttachment } from "./checkpoints.ts";
import { runRetryOnFail } from "./fork.ts";
import { describeMcpStartup, type McpSession, startMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type RuntimeBundle, type RuntimeDeps } from "./runtime.ts";
import { type SessionRuntimeScope, sessionRuntimeScope } from "./worker-scope.ts";
import { restoreGrantSeed, sessionsDirOf } from "./workspace.ts";

// 装配需要的运行参数（launch-flags.ts 的子集：解析出来直接传进来）
export interface SessionRuntimeFlags {
  yolo: boolean;
  provider: string;
  modelId: string;
  persistThinking: boolean;
  thinkingLevel?: ThinkingLevel;
  memoryBudgetChars?: number;
  maxOutputTokens?: number;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）
  compaction?: CompactionConfigInput;
}

export interface OpenSessionRuntimeRequest {
  // 治理根：.pigeon/（会话文件、固化 grant 配置、常驻 Memory、Skill）所在
  governanceRoot: string;
  sessionId: SessionId;
  streamFn: StreamFn;
  flags: SessionRuntimeFlags;
  // 审批 handler 由 Actor 注入（决策 025）；缺省 = 无审批通道，prompt 档 fail-closed
  createApprovalHandler?: RuntimeDeps["createApprovalHandler"];
  // 续跑既有会话：以会话里的生效 grant 为种子（决策 3b，静默继续有效），并还原对话上下文（决策 183）
  resume?: boolean;
  // MCP 启动提示（启动问题与注解配置冲突）：cli 打 stdout、tui 打 stderr，由调用方决定
  onMcpNote?: (note: string) => void;
  // 缺省按治理根与作用域工作区根启动真实 MCP 会话；测试注入替身
  startMcp?: (scope: { governanceRoot: string; workspaceRoot: string }) => Promise<McpSession>;
  // M5 S3（决策 042）：用户级偏好所在的家目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  // M7（决策 071）：会话级验证命令——冻结进注入快照；配置时挂 Run 结束后的独立验证
  verify?: VerifyConfig;
  // M7（决策 079）：失败自动分叉重试次数（冻结进注入快照；主会话在尝试标为失败后后台分叉重试）
  retryOnFail?: number;
}

export interface OpenedSessionRuntime {
  bundle: RuntimeBundle;
  scope: SessionRuntimeScope;
  // 配置了验证命令时在场（运行面释放前等在跑的验证收尾）
  verification?: AttemptVerification;
  // M7（决策 078）：git 工作区的主会话在场（分叉入口据此取快照器）
  checkpoints?: CheckpointAttachment;
  // M7（决策 079）：后台失败自动分叉重试（开启时在场）
  retry?: { idle(): Promise<void>; errors(): unknown[] };
  // 续跑时在场：还原了几条消息、为几个悬空的工具调用补了结果
  restored?: { messages: number; interrupted: number };
}

// 续跑：等写者打开会话文件，读主分支还原上下文；悬空调用补的工具结果先写进会话，再连同还原的消息交给 Agent。
// 会话文件打不开（新存储故障）时报错：没有上下文的续跑不是续跑
async function restoreContext(bundle: RuntimeBundle): Promise<{
  messages: number;
  interrupted: number;
}> {
  const path = await bundle.sessionStore.filePath();
  const loaded = path !== undefined ? loadStoreSessionFile(path) : undefined;
  if (loaded === undefined) {
    throw new Error("会话文件没有打开（新会话存储告警已给出原因），无法还原对话上下文，续跑中止");
  }
  const { messages, interrupted } = restoreSessionContext(loaded.main);
  for (const message of interrupted) {
    bundle.sessionStore.appendMessage(message);
  }
  await bundle.sessionStore.flush();
  bundle.adapter.restoreMessages([...messages, ...interrupted]);
  return { messages: messages.length, interrupted: interrupted.length };
}

export async function openSessionRuntime(
  request: OpenSessionRuntimeRequest
): Promise<OpenedSessionRuntime> {
  // M5.5 S4（决策 040）：worker 会话回到它自己的工作树与委派策略；新建会话与主会话即治理根
  const scope = sessionRuntimeScope(request.governanceRoot, request.sessionId);
  const restoredGrants =
    request.resume === true
      ? restoreGrantSeed(request.governanceRoot, request.sessionId)
      : undefined;
  const startMcp =
    request.startMcp ??
    ((target) => startMcpSession({ ...target, workspaceRoot: target.workspaceRoot }));
  const mcp = await startMcp({
    governanceRoot: request.governanceRoot,
    workspaceRoot: scope.workspaceRoot,
  });
  for (const note of describeMcpStartup(mcp)) {
    request.onMcpNote?.(note);
  }
  try {
    const bundle = buildRuntime({
      streamFn: request.streamFn,
      workspaceRoot: scope.workspaceRoot,
      governanceRoot: request.governanceRoot,
      ...(scope.toolPolicy !== undefined ? { toolPolicy: scope.toolPolicy } : {}),
      sessionId: request.sessionId,
      yolo: request.flags.yolo,
      provider: request.flags.provider,
      modelId: request.flags.modelId,
      persistThinking: request.flags.persistThinking,
      ...(request.flags.thinkingLevel !== undefined
        ? { thinkingLevel: request.flags.thinkingLevel }
        : {}),
      ...(request.flags.memoryBudgetChars !== undefined
        ? { memoryBudgetChars: request.flags.memoryBudgetChars }
        : {}),
      ...(request.flags.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.flags.maxOutputTokens }
        : {}),
      ...(request.flags.compaction !== undefined ? { compaction: request.flags.compaction } : {}),
      ...(request.createApprovalHandler !== undefined
        ? { createApprovalHandler: request.createApprovalHandler }
        : {}),
      ...(restoredGrants !== undefined ? { restoredGrants } : {}),
      ...(request.homeDir !== undefined ? { homeDir: request.homeDir } : {}),
      ...(request.verify !== undefined ? { verify: { ...request.verify } } : {}),
      ...(request.retryOnFail !== undefined ? { retryOnFail: request.retryOnFail } : {}),
      mcp,
    });
    let restored: OpenedSessionRuntime["restored"];
    if (request.resume === true) {
      try {
        restored = await restoreContext(bundle);
      } catch (error) {
        // 运行面已建好：释放它再上抛（MCP 会话由下方的装配失败出口关闭），调用方的旧运行面不受影响
        const { mcp: _mcp, ...withoutMcp } = bundle;
        await disposeRuntime(withoutMcp);
        throw error;
      }
    }
    // M7（决策 078）：主会话在 git 工作区里打快照（写或命令确实改变文件后）；worker 会话不挂
    const checkpoints =
      scope.parentSessionId === undefined
        ? attachCheckpoints({ bundle, workspaceRoot: scope.workspaceRoot })
        : undefined;
    if (checkpoints !== undefined) {
      bundle.disposers = [...(bundle.disposers ?? []), async () => checkpoints.stop()];
    }
    // M7（决策 079）：主会话一次尝试标为失败后，后台从任务开始处分叉重试（最多 K 次）
    const retryErrors: unknown[] = [];
    const retryPending = new Set<Promise<void>>();
    const retries = request.retryOnFail ?? 0;
    // 这次尝试的标签（账本重构第二段）：等本 Run 的收尾条目交给写者并落盘，再从新存储现算；
    // 新存储里没有本会话的文件（双写之前的旧会话、或新存储打不开）时过渡期回退旧账本
    const labelOf = async (runId: RunId): Promise<OutcomeLabel> => {
      await bundle.adapter.settled();
      await bundle.sessionStore.flush();
      const dir = sessionsDirOf(request.governanceRoot);
      const loaded = loadStoreSession(dir, request.sessionId);
      if (loaded !== undefined) {
        return storeAttemptLabel(loaded.view, runId);
      }
      return labelAttempt(
        attemptOutcomeFacts(materializeSession(dir, request.sessionId, { content: false }), runId)
      );
    };
    const startRetry = (runId: RunId): void => {
      if (retries <= 0 || scope.parentSessionId !== undefined) {
        return;
      }
      const task = labelOf(runId)
        .then((label) => (label === "Failed" ? retryFrom(runId) : undefined))
        .catch((error: unknown) => {
          retryErrors.push(error);
        });
      retryPending.add(task);
      task.finally(() => retryPending.delete(task)).catch(() => {});
    };
    const retryFrom = (runId: RunId): Promise<void> => {
      const startMcp = request.startMcp;
      const task = runRetryOnFail({
        governanceRoot: request.governanceRoot,
        sourceSessionId: request.sessionId,
        sourceLog: bundle.eventLog,
        sourceStore: bundle.sessionStore,
        runId,
        retries,
        // 复用本会话运行面已挂的快照器实例（同一会话只能有一个实例，否则序号会撞车）
        ...(checkpoints !== undefined ? { checkpointer: checkpoints.checkpointer } : {}),
        run: {
          streamFn: request.streamFn,
          provider: request.flags.provider,
          modelId: request.flags.modelId,
          yolo: request.flags.yolo,
          persistThinking: request.flags.persistThinking,
          ...(request.flags.thinkingLevel !== undefined
            ? { thinking: request.flags.thinkingLevel }
            : {}),
          ...(request.homeDir !== undefined ? { homeDir: request.homeDir } : {}),
          ...(request.verify !== undefined ? { verify: request.verify } : {}),
          ...(startMcp !== undefined
            ? {
                startMcp: () =>
                  startMcp({
                    governanceRoot: request.governanceRoot,
                    workspaceRoot: scope.workspaceRoot,
                  }),
              }
            : {}),
        },
      });
      return task.then(() => undefined);
    };
    // M7（决策 071）：Run 结束后在工作区根独立执行验证命令，结果落本会话的通用验证记录
    const verification =
      request.verify !== undefined
        ? attachAttemptVerification({
            bundle,
            config: request.verify,
            workspaceRoot: scope.workspaceRoot,
            onVerified: (record) => startRetry(record.target.runId),
          })
        : undefined;
    // 未配置验证命令时，在 Run 结束后按账本现算的标签判断（撞上限、熔断、业务失败）
    const unsubscribeRetry =
      request.verify === undefined && retries > 0
        ? bundle.adapter.subscribe((event) => {
            if (event.kind === "run.ended") {
              startRetry(event.runId);
            }
          })
        : undefined;
    const retry =
      retries > 0
        ? {
            idle: async () => {
              await verification?.idle();
              while (retryPending.size > 0) {
                await Promise.allSettled([...retryPending]);
              }
            },
            errors: () => [...retryErrors],
          }
        : undefined;
    if (retry !== undefined) {
      bundle.disposers = [
        ...(bundle.disposers ?? []),
        async () => {
          unsubscribeRetry?.();
          await retry.idle();
        },
      ];
    }
    if (verification !== undefined) {
      bundle.disposers = [...(bundle.disposers ?? []), () => verification.stop()];
    }
    return {
      bundle,
      scope,
      ...(verification !== undefined ? { verification } : {}),
      ...(checkpoints !== undefined ? { checkpoints } : {}),
      ...(retry !== undefined ? { retry } : {}),
      ...(restored !== undefined ? { restored } : {}),
    };
  } catch (error) {
    // 装配失败：已启动的 server 必须关掉，否则留下孤儿进程（先建后换的收口约束）
    await mcp.close();
    throw error;
  }
}
