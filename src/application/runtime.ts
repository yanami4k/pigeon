// 装配根（M2 S1，决策 025 从 cli/index.ts 抽到 Controller 层）：注册内置工具 + 构造适配器与
// 事件日志 + grant 运行态。审批 handler 由调用方注入（cli 传 REPL 问答版，tui 传面板版）——
// 工厂形态而非成品：装配根先建 grantStore，审批提示的 [a]/[d] 放权键需要它，
// 故调用方给一个"拿到 store 再造 handler"的工厂。
// 事件日志 = <governanceRoot>/.pigeon/sessions/sess_<ulid>.jsonl（M4 D1 布局；M5.5 S1 治理根缺省同工作区根；
// ROADMAP §3.2 调用前意图 + 调用后 Receipt 作为治理族归并入同一日志，不双写）。
// resume 复用同一 sessionId 续写（append 模式），会话文件跨进程延续
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { loadResidentMemory } from "../memory/resident.ts";
import {
  createReadSessionEntryTool,
  createSearchSessionsTool,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "../memory/search-tools.ts";
import { loadCommandsConfig } from "../persistence/commands-config.ts";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { INJECTION_SNAPSHOT_VERSION, type ToolPolicy } from "../pi-runtime/snapshot.ts";
import { loadSkillCatalog } from "../skills/catalog.ts";
import {
  createLoadSkillTool,
  LOAD_SKILL_TOOL,
  loadSkillRegistration,
} from "../skills/load-skill-tool.ts";
import type { WorkerRole } from "../state/event-log.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { ActiveGrant } from "../state/materialize.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { createReadFileTool, ReadFileParamsSchema } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import {
  createRunCommandTool,
  RUN_COMMAND_TOOL,
  RunCommandParamsSchema,
} from "../tools/run-command.ts";
import { createToolGovernance } from "./governance.ts";

export interface RuntimeDeps {
  streamFn: StreamFn;
  workspaceRoot: string;
  // M5.5 S1（决策 040）：治理根——.pigeon/（会话文件、固化 grant 配置、常驻 Memory、Skill）所在；
  // 缺省同工作区根。worker 的工作区根是自己的 git 工作树，治理根恒为主仓库根
  governanceRoot?: string;
  // M5.5 S2（决策 040）：委派策略（worker）——在场时 allow 与已注册工具取交、deny 与审批模式照搬，
  // yolo 旗标不再参与；缺省按 yolo 旗标给全部内置工具
  toolPolicy?: ToolPolicyLike;
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
  // M5 S1（决策 045）：thinking 正文是否持久化进内容文件；缺省 true，Actor 以旗标关闭
  persistThinking?: boolean;
  // M5 S3（决策 042）：用户级偏好所在的家目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  // M5 S3（决策 042）：常驻 Memory 字符预算（缺省 8000，约 2000 token）
  memoryBudgetChars?: number;
  // M5.5 S5（决策 050）：推理档位——Actor 传启动参数全局值，worker 装配按角色配置覆盖；缺省 off
  thinkingLevel?: ThinkingLevel;
  // M5.5 S5（决策 048）：worker 角色——在场时 run_command 只接受 .pigeon/commands.json 为该角色登记的
  // 命令（未登记即一条都不许）；主会话缺省，不受清单限制
  commandRole?: WorkerRole;
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
  const governanceRoot = deps.governanceRoot ?? deps.workspaceRoot;
  const sessionsDir = path.join(governanceRoot, ".pigeon", "sessions");
  const eventLog = new JsonlEventLog(sessionsDir, deps.sessionId, {
    content: { persistThinking: deps.persistThinking ?? true },
  });
  // F：固化配置启动时装载（畸形 → 抛错，启动中止——授权语义不明绝不静默运行）
  const configGrants = deps.configGrants ?? loadGrantConfig(governanceRoot);
  // M5.5 S5（决策 048）：可选的命令短名与角色允许清单（畸形 → 抛错，启动中止）
  const commandsConfig = loadCommandsConfig(governanceRoot);
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
  // M5.5 S5（决策 048）：exec 档——永不自动放行，[a] 收窄为精确命令串
  registry.register({
    name: RUN_COMMAND_TOOL,
    description: "在工作区根运行一条命令（不经 shell）",
    parameters: RunCommandParamsSchema,
    tier: "exec",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  // M5 S2（决策 038）：Session Search 的两个 read 档工具，范围只限本项目会话目录
  for (const registration of sessionToolRegistrations(sessionsDir)) {
    registry.register(registration);
  }
  // M5 S3（决策 042）：会话开始读常驻 Memory，拼进 system prompt 一次即冻结（不走 transformContext）；
  // 清单进 InjectionSnapshot v3，会话中途改文件下个会话才生效
  const residentMemory = loadResidentMemory({
    workspaceRoot: governanceRoot,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.memoryBudgetChars !== undefined ? { budgetChars: deps.memoryBudgetChars } : {}),
  });
  const basePrompt =
    "你是 Pigeon 编程助手。用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照），" +
    "用 edit_file 按锚点编辑。写操作可能需要人工批准。" +
    "用 run_command 运行命令（不经 shell，不支持管道与 && 串联；每条命令都要人工批准）。" +
    "需要以前会话里的信息时，用 search_sessions 按关键词检索本项目历史消息，" +
    "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。";
  // M5 S4（决策 043）：会话开始登记 Skill Catalog——目录段与 Memory 同段冻结进 system prompt，
  // 哈希清单进快照；有 Skill 才注册并广告 load_skill（无 Skill 时不占工具广告）
  const skillCatalog = loadSkillCatalog({
    workspaceRoot: governanceRoot,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
  });
  const hasSkills = skillCatalog.skills.length > 0;
  if (hasSkills) {
    registry.register(loadSkillRegistration(skillCatalog));
  }
  const toolNames = [
    "read_file",
    "edit_file",
    RUN_COMMAND_TOOL,
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
    ...(hasSkills ? [LOAD_SKILL_TOOL] : []),
  ];
  const systemPrompt = [basePrompt, residentMemory.section, skillCatalog.section]
    .filter((section) => section !== "")
    .join("\n\n");
  const delegated = deps.toolPolicy;
  const policy: ToolPolicy =
    delegated !== undefined
      ? {
          allow: toolNames.filter((name) => delegated.allow.includes(name)),
          deny: [...delegated.deny],
          approvalMode: delegated.approvalMode,
        }
      : { allow: toolNames, deny: [], approvalMode: deps.yolo ? "yolo" : "prompt" };
  // load_skill 的读取留痕经 Adapter 盖 runId 落 skill.loaded；工具先于 Adapter 构造，故晚绑定
  const adapterRef: { current: PiRuntimeAdapter | undefined } = { current: undefined };
  const adapter = new PiRuntimeAdapter({
    snapshot: {
      version: INJECTION_SNAPSHOT_VERSION,
      model: {
        provider: deps.provider,
        id: deps.modelId,
        ...(deps.thinkingLevel !== undefined ? { thinkingLevel: deps.thinkingLevel } : {}),
      },
      tools: { policy, advertised: policy.allow },
      context: { systemPrompt },
      memory: residentMemory.manifest,
      skills: skillCatalog.manifest,
      createdAt: Date.now(),
    },
    streamFn: deps.streamFn,
    tools: [
      createReadFileTool(deps.workspaceRoot),
      createEditFileTool(deps.workspaceRoot),
      createRunCommandTool({
        workspaceRoot: deps.workspaceRoot,
        commands: commandsConfig.commands,
        ...(deps.commandRole !== undefined
          ? { allowlist: commandsConfig.roles[deps.commandRole] ?? [] }
          : {}),
      }),
      createSearchSessionsTool({ sessionsDir }),
      createReadSessionEntryTool({ sessionsDir }),
      ...(hasSkills
        ? [
            createLoadSkillTool({
              catalog: skillCatalog,
              onLoaded: (payload) => adapterRef.current?.recordObservation("skill.loaded", payload),
            }),
          ]
        : []),
    ],
    // M5.5 S0（决策 049）：装配根组装工具调用治理后注入 Adapter
    governance: createToolGovernance({
      registry,
      // M4 S6（决策 3）：审批提示四键 [y]/[n]/[a]/[d]——[a]/[d] 经 store 创建会话 grant；
      // 交互实现由 Actor 注入（决策 025）
      approvalHandler: deps.createApprovalHandler(grantStore),
      // M4 S6（决策 3 + D6）：grant 求值件——排律 deny → 会话 grant → 配置 grant → yolo → read → prompt
      sessionGrants: grantStore,
      configGrants,
      workspaceRoot: deps.workspaceRoot,
    }),
    sessionId: deps.sessionId,
    eventLog,
    // M5 S5（决策 044）：llm.request 指纹与内容文件同一抽取选项
    messageContent: { persistThinking: deps.persistThinking ?? true },
  });
  adapterRef.current = adapter;
  return { adapter, eventLog, grantStore, configGrants };
}

// 加载用户提供的 StreamFn 模块（默认导出必须是函数）。归位装配根（M2 S2）：它是模型接入的
// 装载件，与 buildRuntime 同属"装配"职责；cli 与 tui 两个 Actor 都从本层取，避免 Actor 互依
export async function loadStreamFn(specifier: string): Promise<StreamFn> {
  // 说明符判定：磁盘上存在的相对/绝对路径一律按文件加载（tmp/x.mjs 这类含分隔符的
  // 相对路径也是文件，不能交给裸说明符解析）；否则按裸包名 import
  const asFile = path.resolve(specifier);
  const url = existsSync(asFile) ? pathToFileURL(asFile).href : specifier;
  let module: Record<string, unknown>;
  try {
    // 动态 import 的合理例外：模块说明符来自运行期旗标/环境变量（插件加载），静态 import 无法覆盖
    module = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `无法加载 streamFn 模块 ${specifier}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof module.default !== "function") {
    throw new Error(`streamFn 模块 ${specifier} 没有默认导出函数`);
  }
  return module.default as StreamFn;
}
