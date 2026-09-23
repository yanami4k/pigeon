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
import { loadResidentMemory, type MemoryRoot } from "../memory/resident.ts";
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
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, limitOutputTokens } from "../pi-runtime/output-limit.ts";
import { fixTemperature } from "../pi-runtime/sampling.ts";
import { INJECTION_SNAPSHOT_VERSION, type ToolPolicy } from "../pi-runtime/snapshot.ts";
import { loadSkillCatalog, type SkillRoot } from "../skills/catalog.ts";
import {
  createLoadSkillTool,
  LOAD_SKILL_TOOL,
  loadSkillRegistration,
} from "../skills/load-skill-tool.ts";
import type { AttemptBudget, VerifyConfig } from "../state/attempt-config.ts";
import type { WorkerRole } from "../state/event-log.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { ActiveGrant } from "../state/materialize.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { DEFAULT_EDIT_MODE, type EditMode } from "../tools/edit-mode.ts";
import { asWorkspaceHost } from "../tools/local-host.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { createReadFileTool, ReadFileParamsSchema } from "../tools/read-file.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createReplaceEditTool, ReplaceEditParamsSchema } from "../tools/replace-edit.ts";
import {
  createRunCommandTool,
  RUN_COMMAND_TOOL,
  RunCommandParamsSchema,
} from "../tools/run-command.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { createToolGovernance } from "./governance.ts";
import type { McpSession } from "./mcp.ts";

export interface RuntimeDeps {
  streamFn: StreamFn;
  workspaceRoot: string;
  // 决策 098：执行端——三个工作区工具（read_file / edit_file / run_command）经它读写与执行；缺省为 workspaceRoot 上的
  // 本地实现。容器工作区注入容器实现，此时 workspaceRoot 只是宿主侧的占位目录。按路径限定的放权以宿主路径判定，
  // 在这类工作区下暂不支持：带审批通道或装了 pathPrefix 固化规则时装配即报错，不让规则静默失配
  workspaceHost?: WorkspaceHost;
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
  // 放权键需要它；cli 传 REPL 问答版，将来的 tui 传面板版。
  // M6.5 S1（决策 056）：缺省 = 无审批通道，prompt 档一律 fail-closed 拒绝并落 decision（006）——headless 运行如此
  createApprovalHandler?: (grants: SessionGrantStore) => ApprovalHandler;
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
  // M5.7 S3（决策 041 / 051 / 052）：已启动的 MCP 会话（Actor 在装配前异步启动，worker 按其工作树各起一份）；
  // 缺省 = 本会话没有外部工具
  mcp?: McpSession;
  // M6.5（决策 059）：显式 Skill 根与 Memory 根——在场时只用给定的根（空数组 = 不注入），不扫治理根与用户级目录；
  // Eval 三条件由 skillRoots 切换，memoryRoots 一律为空
  skillRoots?: readonly SkillRoot[];
  memoryRoots?: readonly MemoryRoot[];
  // 决策 061：编辑模式，缺省 hashline（缺省时装配出的工具与 system prompt 逐字不变）
  editMode?: EditMode;
  // 决策 063：单轮输出上限（缺省 16,384）——装配层包装 streamFn 传入 maxTokens，并写进注入快照 model 段
  maxOutputTokens?: number;
  // M9：任务源给的系统指令（如外部基准的工作方式指令）——原样追加为 system prompt 的一段，随整段 system prompt
  // 冻结进注入快照（run.started 记其哈希，全文在内容文件的 system 记录里）。只说工作方式，不含任务内容；缺省不加
  taskDirective?: string;
  // M9：采样温度——装配层包装 streamFn 传入，并写进注入快照 model 段；缺省不设（由 provider 决定）
  temperature?: number;
  // M7（决策 071 / 079）：会话级验证命令与失败自动分叉重试次数——冻结进注入快照并随 run.started 落盘
  verify?: VerifyConfig;
  retryOnFail?: number;
  // M8（决策 087）：本次尝试的预算——冻结进注入快照并随 run.started 落盘，回放据此沿用同一预算
  budget?: AttemptBudget;
  // 决策 142 / 143：回炉轮数（只在开启时给）——冻结进注入快照并随 run.started 落盘
  repairRounds?: number;
  // M7（决策 077）：分叉续跑的 Agent 初始消息
  initialMessages?: AgentMessage[];
}

// 截断后拆小引导（决策 063 第 2 件）：两种编辑模式的 system prompt 都追加。静态文本，对 prompt cache 友好
export const TRUNCATION_GUIDANCE =
  "工具调用若因输出上限未执行，把改动拆成几次较小的调用重发，不要原样重发；单次编辑只改需要改的那一段。";

export interface RuntimeBundle {
  adapter: PiRuntimeAdapter;
  eventLog: JsonlEventLog;
  // M4 S6：grant 运行态（审批提示 [a]/[d] 与 /grants /revoke /grants save 共用同一存储）
  grantStore: SessionGrantStore;
  configGrants: readonly ConfigGrantRule[];
  // M5.7 S3：本运行面持有的 MCP 会话（disposeRuntime 一并关闭）
  mcp?: McpSession;
  // M7（决策 078）：已注册工具的风险档位（快照只在写档与命令档工具之后打）
  toolTiers: ReadonlyMap<string, "read" | "write" | "exec">;
  // M6：释放运行面前先执行的附加释放动作（后台审阅调度的退订与收尾）；按登记顺序执行，失败不挡后续
  disposers?: Array<() => Promise<void>>;
}

// start/resume 共用的运行时装配：注册内置工具 + 构造适配器与事件日志
export function buildRuntime(deps: RuntimeDeps): RuntimeBundle {
  // 决策 061：编辑工具按模式装配，工具名都叫 edit_file；hashline 分支与 061 之前逐字一致
  const replaceMode = (deps.editMode ?? DEFAULT_EDIT_MODE) === "replace";
  const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error(`单轮输出上限需要正整数：${maxOutputTokens}`);
  }
  if (
    deps.temperature !== undefined &&
    !(Number.isFinite(deps.temperature) && deps.temperature >= 0 && deps.temperature <= 2)
  ) {
    throw new Error(`采样温度需要 0 到 2 之间的数：${deps.temperature}`);
  }
  // 推理开启时上游不把温度交给 provider（二者在该线路上互斥）：请求值如实记成"未生效"，也不再往下传
  const reasoningEnabled = deps.thinkingLevel !== undefined && deps.thinkingLevel !== "off";
  const appliedTemperature = reasoningEnabled ? undefined : deps.temperature;
  const governanceRoot = deps.governanceRoot ?? deps.workspaceRoot;
  const workspaceHost = deps.workspaceHost ?? asWorkspaceHost(deps.workspaceRoot);
  // 护栏（M9）：按路径限定的放权（会话 grant 的目录限定、固化规则的 pathPrefix）以宿主路径判定，对非本地的工作区
  // 只会静默失配。路径放权在这类工作区下暂不支持：带审批通道的交互场景直接拒绝装配（审批面板的 [d] 就是目录放权）
  if (deps.workspaceHost !== undefined && deps.createApprovalHandler !== undefined) {
    throw new Error(
      "容器工作区暂不支持交互审批：按路径限定的放权以宿主路径判定，在容器工作区下会静默失配；" +
        "目前只支持无审批通道的无人值守运行"
    );
  }
  const sessionsDir = path.join(governanceRoot, ".pigeon", "sessions");
  const eventLog = new JsonlEventLog(sessionsDir, deps.sessionId, {
    content: { persistThinking: deps.persistThinking ?? true },
  });
  // F：固化配置启动时装载（畸形 → 抛错，启动中止——授权语义不明绝不静默运行）
  const configGrants = deps.configGrants ?? loadGrantConfig(governanceRoot);
  if (deps.workspaceHost !== undefined) {
    const scoped = configGrants.filter((rule) => rule.pathPrefix !== undefined);
    if (scoped.length > 0) {
      throw new Error(
        `容器工作区暂不支持按路径限定的放权规则：${scoped.map((rule) => `${rule.tool}（${rule.pathPrefix}）`).join("、")}——` +
          "它们以宿主路径判定，在容器工作区下只会静默失配；请移除这些规则或改用本地工作区"
      );
    }
  }
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
    description: replaceMode ? "原文替换编辑" : "hashline 锚定稀疏编辑",
    parameters: replaceMode ? ReplaceEditParamsSchema : EditFileParamsSchema,
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
    ...(deps.memoryRoots !== undefined ? { roots: deps.memoryRoots } : {}),
  });
  const editSentence = replaceMode
    ? "你是 Pigeon 编程助手。用 read_file 读取文件（每行形如「行号| 内容」），" +
      "用 edit_file 按原文替换编辑（old_string 须与文件原文逐字一致且在文件里恰好出现一次，不要带行号前缀）。"
    : "你是 Pigeon 编程助手。用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照），" +
      "用 edit_file 按锚点编辑。";
  const basePrompt =
    editSentence +
    TRUNCATION_GUIDANCE +
    "写操作可能需要人工批准。" +
    "用 run_command 运行命令（不经 shell，不支持管道与 && 串联；每条命令都要人工批准）。" +
    "需要以前会话里的信息时，用 search_sessions 按关键词检索本项目历史消息，" +
    "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。";
  // M5 S4（决策 043）：会话开始登记 Skill Catalog——目录段与 Memory 同段冻结进 system prompt，
  // 哈希清单进快照；有 Skill 才注册并广告 load_skill（无 Skill 时不占工具广告）
  const skillCatalog = loadSkillCatalog({
    workspaceRoot: governanceRoot,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    // M5.7 S4（043 口径）：MCP server 的 prompts 以 server 为来源进同一目录
    ...(deps.mcp !== undefined && deps.mcp.prompts.length > 0 ? { prompts: deps.mcp.prompts } : {}),
    ...(deps.skillRoots !== undefined ? { roots: deps.skillRoots } : {}),
  });
  const hasSkills = skillCatalog.skills.length > 0;
  if (hasSkills) {
    registry.register(loadSkillRegistration(skillCatalog));
  }
  // M5.7 S3（决策 041 / 051 / 052）：MCP 工具按实际风险档注册，与内置工具同受六档排律、审批与留证
  const mcp = deps.mcp;
  const mcpTools = mcp?.tools ?? [];
  for (const bridged of mcpTools) {
    registry.register(bridged.registration);
  }
  const toolNames = [
    "read_file",
    "edit_file",
    RUN_COMMAND_TOOL,
    SEARCH_SESSIONS_TOOL,
    READ_SESSION_ENTRY_TOOL,
    ...(hasSkills ? [LOAD_SKILL_TOOL] : []),
    ...mcpTools.map((bridged) => bridged.name),
  ];
  const mcpSection =
    mcpTools.length > 0
      ? "## 外部工具\n以 mcp__<server>__ 开头的工具来自外部 MCP server，与内置工具同样受审批与留证；" +
        "server 不可用时这些工具会报错，改用内置工具继续。"
      : "";
  const systemPrompt = [
    basePrompt,
    residentMemory.section,
    skillCatalog.section,
    mcpSection,
    deps.taskDirective ?? "",
  ]
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
        maxOutputTokens,
        ...(appliedTemperature !== undefined ? { temperature: appliedTemperature } : {}),
        ...(deps.temperature !== undefined && appliedTemperature === undefined
          ? {
              temperatureIgnored: {
                requested: deps.temperature,
                reason: "reasoning-enabled" as const,
              },
            }
          : {}),
      },
      tools: { policy, advertised: policy.allow },
      context: {
        systemPrompt,
        ...(deps.taskDirective !== undefined ? { taskDirective: deps.taskDirective } : {}),
      },
      memory: residentMemory.manifest,
      skills: skillCatalog.manifest,
      createdAt: Date.now(),
      ...(deps.verify !== undefined ? { verify: { ...deps.verify } } : {}),
      ...(deps.retryOnFail !== undefined ? { retryOnFail: deps.retryOnFail } : {}),
      ...(deps.budget !== undefined ? { budget: { ...deps.budget } } : {}),
      ...(deps.repairRounds !== undefined ? { repairRounds: deps.repairRounds } : {}),
    },
    // 决策 063：单轮输出上限在装配层包装 streamFn 传入，上游与 provider 插件不改
    streamFn: limitOutputTokens(
      appliedTemperature !== undefined
        ? fixTemperature(deps.streamFn, appliedTemperature)
        : deps.streamFn,
      maxOutputTokens
    ),
    tools: [
      replaceMode
        ? createReadFileTool(workspaceHost, { editMode: "replace" })
        : createReadFileTool(workspaceHost),
      replaceMode ? createReplaceEditTool(workspaceHost) : createEditFileTool(workspaceHost),
      createRunCommandTool({
        workspaceRoot: deps.workspaceRoot,
        host: workspaceHost,
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
      ...mcpTools.map((bridged) => bridged.tool),
    ],
    // M5.5 S0（决策 049）：装配根组装工具调用治理后注入 Adapter
    governance: createToolGovernance({
      registry,
      // M4 S6（决策 3）：审批提示四键 [y]/[n]/[a]/[d]——[a]/[d] 经 store 创建会话 grant；
      // 交互实现由 Actor 注入（决策 025）；无审批通道时不传，prompt 档 fail-closed
      ...(deps.createApprovalHandler !== undefined
        ? { approvalHandler: deps.createApprovalHandler(grantStore) }
        : {}),
      // M4 S6（决策 3 + D6）：grant 求值件——排律 deny → 会话 grant → 配置 grant → yolo → read → prompt
      sessionGrants: grantStore,
      configGrants,
      workspaceRoot: deps.workspaceRoot,
    }),
    sessionId: deps.sessionId,
    eventLog,
    // M5 S5（决策 044）：llm.request 指纹与内容文件同一抽取选项
    messageContent: { persistThinking: deps.persistThinking ?? true },
    // M5.7 S3（决策 052）：每个 Run 开始时把 MCP 工具集摘要与 server 当前状态写进 run.started；无 server 时不带字段
    ...(mcp !== undefined && mcp.connections.length > 0
      ? { runStartedExtras: () => mcp.summary() }
      : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
  });
  adapterRef.current = adapter;
  const toolTiers = new Map(
    registry.list().map((registration) => [registration.name, registration.tier])
  );
  return {
    adapter,
    eventLog,
    grantStore,
    configGrants,
    toolTiers,
    ...(mcp !== undefined ? { mcp } : {}),
  };
}

// 释放运行面（M5.7 S3）：先停 Adapter，再关 MCP 连接（server 进程随之退出），最后关会话文件；前一步失败不跳过后续
export async function disposeRuntime(bundle: RuntimeBundle): Promise<void> {
  for (const dispose of bundle.disposers?.splice(0) ?? []) {
    try {
      await dispose();
    } catch {
      // 附加释放失败不挡运行面释放（审阅是后台附属，不得拖住主会话收尾）
    }
  }
  try {
    await bundle.adapter.dispose();
  } finally {
    try {
      await bundle.mcp?.close();
    } finally {
      bundle.eventLog.close();
    }
  }
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
