// 会话运行面装配（决策 067）：新建与 resume 走同一条路——作用域解析（worker 会话回到它自己的
// 工作树与委派策略）、固化 grant 种子物化、MCP 会话启动与启动提示、运行面构建。
// cli 与 tui 此前各写一份 buildWithMcp 与 resume 配方，缺省与提示口径不一；此处收成一份。
// 先建后换语义不变：装配失败（如 grants.json 畸形）时先关掉已启动的 MCP server 再上抛，
// 调用方的旧运行面不受影响。

import { materializeSession } from "../persistence/session-read.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import { attemptOutcomeFacts, labelAttempt } from "../state/outcome-label.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { type AttemptVerification, attachAttemptVerification } from "./attempt-verify.ts";
import { attachCheckpoints, type CheckpointAttachment } from "./checkpoints.ts";
import { runRetryOnFail } from "./fork.ts";
import { describeMcpStartup, type McpSession, startMcpSession } from "./mcp.ts";
import { buildRuntime, type RuntimeBundle, type RuntimeDeps } from "./runtime.ts";
import { bindSessionTree, type SessionTreeBinding } from "./session-tree.ts";
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
}

export interface OpenSessionRuntimeRequest {
  // 治理根：.pigeon/（会话文件、固化 grant 配置、常驻 Memory、Skill）所在
  governanceRoot: string;
  sessionId: SessionId;
  streamFn: StreamFn;
  flags: SessionRuntimeFlags;
  // 审批 handler 由 Actor 注入（决策 025）；缺省 = 无审批通道，prompt 档 fail-closed
  createApprovalHandler?: RuntimeDeps["createApprovalHandler"];
  // 恢复既有会话：以事件日志物化的生效 grant 为种子（决策 3b，静默继续有效）
  restoreGrants?: boolean;
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
  // M7（决策 077）：会话树绑定（已在树里的会话实时写穿；分叉入口在分叉后调 ensureAttached）
  tree?: SessionTreeBinding;
  // M7（决策 079）：后台失败自动分叉重试（开启时在场）
  retry?: { idle(): Promise<void>; errors(): unknown[] };
}

export async function openSessionRuntime(
  request: OpenSessionRuntimeRequest
): Promise<OpenedSessionRuntime> {
  // M5.5 S4（决策 040）：worker 会话回到它自己的工作树与委派策略；新建会话与主会话即治理根
  const scope = sessionRuntimeScope(request.governanceRoot, request.sessionId);
  const restoredGrants =
    request.restoreGrants === true
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
      ...(request.createApprovalHandler !== undefined
        ? { createApprovalHandler: request.createApprovalHandler }
        : {}),
      ...(restoredGrants !== undefined ? { restoredGrants } : {}),
      ...(request.homeDir !== undefined ? { homeDir: request.homeDir } : {}),
      ...(request.verify !== undefined ? { verify: { ...request.verify } } : {}),
      ...(request.retryOnFail !== undefined ? { retryOnFail: request.retryOnFail } : {}),
      mcp,
    });
    // M7（决策 078）：主会话在 git 工作区里打快照（写或命令确实改变文件后）；worker 会话不挂
    const checkpoints =
      scope.parentSessionId === undefined
        ? attachCheckpoints({ bundle, workspaceRoot: scope.workspaceRoot })
        : undefined;
    if (checkpoints !== undefined) {
      bundle.disposers = [...(bundle.disposers ?? []), async () => checkpoints.stop()];
    }
    // M7（决策 077）：已在树里的会话（恢复的分支或来源会话）接上实时写穿；worker 会话不进树
    const tree =
      scope.parentSessionId === undefined
        ? bindSessionTree({ bundle, governanceRoot: request.governanceRoot })
        : undefined;
    if (tree !== undefined) {
      await tree.ensureAttached();
      bundle.disposers = [
        ...(bundle.disposers ?? []),
        async () => {
          await tree.idle();
          tree.stop();
        },
      ];
    }
    // M7（决策 079）：主会话一次尝试标为失败后，后台从任务开始处分叉重试（最多 K 次）
    const retryErrors: unknown[] = [];
    const retryPending = new Set<Promise<void>>();
    const retries = request.retryOnFail ?? 0;
    const startRetry = (runId: RunId): void => {
      if (retries <= 0 || scope.parentSessionId !== undefined) {
        return;
      }
      const dir = sessionsDirOf(request.governanceRoot);
      const session = materializeSession(dir, request.sessionId, { content: false });
      if (labelAttempt(attemptOutcomeFacts(session, runId)) !== "Failed") {
        return;
      }
      const startMcp = request.startMcp;
      const task = runRetryOnFail({
        governanceRoot: request.governanceRoot,
        sourceSessionId: request.sessionId,
        sourceLog: bundle.eventLog,
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
      })
        .then(async () => {
          await tree?.ensureAttached();
        })
        .catch((error: unknown) => {
          retryErrors.push(error);
        });
      retryPending.add(task);
      task.finally(() => retryPending.delete(task)).catch(() => {});
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
      ...(tree !== undefined ? { tree } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
  } catch (error) {
    // 装配失败：已启动的 server 必须关掉，否则留下孤儿进程（先建后换的收口约束）
    await mcp.close();
    throw error;
  }
}
