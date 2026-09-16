// 会话运行面装配（决策 067）：新建与 resume 走同一条路——作用域解析（worker 会话回到它自己的
// 工作树与委派策略）、固化 grant 种子物化、MCP 会话启动与启动提示、运行面构建。
// cli 与 tui 此前各写一份 buildWithMcp 与 resume 配方，缺省与提示口径不一；此处收成一份，
// 并作为 M6 挂后台 Reviewer 调度的落点。
// 先建后换语义不变：装配失败（如 grants.json 畸形）时先关掉已启动的 MCP server 再上抛，
// 调用方的旧运行面不受影响。
import type { StreamFn } from "../pi-runtime/index.ts";
import type { SessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { describeMcpStartup, type McpSession, startMcpSession } from "./mcp.ts";
import { buildRuntime, type RuntimeBundle, type RuntimeDeps } from "./runtime.ts";
import { type SessionRuntimeScope, sessionRuntimeScope } from "./worker-scope.ts";
import { restoreGrantSeed } from "./workspace.ts";

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
}

export interface OpenedSessionRuntime {
  bundle: RuntimeBundle;
  scope: SessionRuntimeScope;
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
      mcp,
    });
    return { bundle, scope };
  } catch (error) {
    // 装配失败：已启动的 server 必须关掉，否则留下孤儿进程（先建后换的收口约束）
    await mcp.close();
    throw error;
  }
}
