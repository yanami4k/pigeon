// 装配根（M2 S1，决策 025 从 cli/index.ts 抽到 Controller 层）：注册内置工具 + 构造适配器与
// 事件日志 + grant 运行态。审批 handler 由调用方注入（cli 传 REPL 问答版，tui 传面板版）——
// 工厂形态而非成品：装配根先建 grantStore，审批提示的 [a]/[d] 放权键需要它，
// 故调用方给一个"拿到 store 再造 handler"的工厂。
// 事件日志 = <workspaceRoot>/.pigeon/sessions/sess_<ulid>.jsonl（M4 D1 布局；
// ROADMAP §3.2 调用前意图 + 调用后 Receipt 作为治理族归并入同一日志，不双写）。
// resume 复用同一 sessionId 续写（append 模式），会话文件跨进程延续
import path from "node:path";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { INJECTION_SNAPSHOT_VERSION } from "../pi-runtime/snapshot.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { ActiveGrant } from "../state/materialize.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { createReadFileTool, ReadFileParamsSchema } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";

export interface RuntimeDeps {
  streamFn: StreamFn;
  workspaceRoot: string;
  sessionId: SessionId;
  yolo: boolean;
  provider: string;
  modelId: string;
  // 审批 handler 由 Actor 注入（决策 025）：工厂收 grantStore——审批提示的 [a]/[d]
  // 放权键需要它；cli 传 REPL 问答版，将来的 tui 传面板版
  createApprovalHandler: (grants: SessionGrantStore) => ApprovalHandler;
  // M4 S6（D6/F）：固化配置规则——缺省时 buildRuntime 自行 loadGrantConfig；
  // 畸形文件在此响亮失败（治理配置 fail-closed，启动中止）
  configGrants?: readonly ConfigGrantRule[];
  // M4 S6（决策 3b）：冷恢复种子——resume 时由 materializeSession(...).grants 还原，
  // 会话 grant 崩溃后静默继续有效
  restoredGrants?: readonly ActiveGrant[];
}

export interface RuntimeBundle {
  adapter: PiRuntimeAdapter;
  eventLog: JsonlEventLog;
  // M4 S6：grant 运行态（审批提示 [a]/[d] 与 /grants /revoke /grants save 共用同一存储）
  grantStore: SessionGrantStore;
  configGrants: readonly ConfigGrantRule[];
}

// start/resume 共用的运行时装配：注册内置工具 + 构造适配器与事件日志
export function buildRuntime(deps: RuntimeDeps): RuntimeBundle {
  const sessionsDir = path.join(deps.workspaceRoot, ".pigeon", "sessions");
  const eventLog = new JsonlEventLog(sessionsDir, deps.sessionId);
  // F：固化配置启动时装载（畸形 → 抛错，启动中止——授权语义不明绝不静默运行）
  const configGrants = deps.configGrants ?? loadGrantConfig(deps.workspaceRoot);
  // 决策 3b：会话 grant 运行态——resume 时以事件日志物化结果为种子（created − revoked）
  const grantStore = new SessionGrantStore({
    workspaceRoot: deps.workspaceRoot,
    eventLog,
    restored: deps.restoredGrants,
  });
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "读取工作区内文件内容",
    parameters: ReadFileParamsSchema,
    tier: "read",
    pathConfinement: { kind: "workspace" },
    executionMode: "parallel",
  });
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: EditFileParamsSchema,
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: deps.provider, id: deps.modelId },
      tools: {
        policy: {
          allow: ["read_file", "edit_file"],
          deny: [],
          approvalMode: deps.yolo ? "yolo" : "prompt",
        },
        advertised: ["read_file", "edit_file"],
      },
      context: {
        systemPrompt:
          "你是 Pigeon 编程助手。用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照），" +
          "用 edit_file 按锚点编辑。写操作可能需要人工批准。",
      },
      memory: [],
      skills: [],
      createdAt: Date.now(),
    },
    streamFn: deps.streamFn,
    registry,
    tools: [createReadFileTool(deps.workspaceRoot), createEditFileTool(deps.workspaceRoot)],
    // M4 S6（决策 3）：审批提示四键 [y]/[n]/[a]/[d]——[a]/[d] 经 store 创建会话 grant；
    // 交互实现由 Actor 注入（决策 025）
    approvalHandler: deps.createApprovalHandler(grantStore),
    sessionId: deps.sessionId,
    eventLog,
    // M4 S6（决策 3 + D6）：grant 求值件——排律 deny → 会话 grant → 配置 grant → yolo → read → prompt
    sessionGrants: grantStore,
    configGrants,
    workspaceRoot: deps.workspaceRoot,
  });
  return { adapter, eventLog, grantStore, configGrants };
}
