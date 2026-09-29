// 装配根（M2 S1，决策 025 从 cli/index.ts 抽到 Controller 层）：注册内置工具 + 构造适配器与
// 会话存储写者 + grant 运行态。审批 handler 由调用方注入（cli 传 REPL 问答版，tui 传面板版）——
// 工厂形态而非成品：装配根先建 grantStore，审批提示的 [a]/[d] 放权键需要它，
// 故调用方给一个"拿到 store 再造 handler"的工厂。
// 会话存储（决策 176 / 210）：<governanceRoot>/.pigeon/sessions/<工作目录编码>/ 下的 pi 会话文件（M5.5 S1 治理根缺省
// 同工作区根），交给 Adapter 写消息与 Run 起止，授权经落盘口写入；续跑复用同一 sessionId 打开同一文件续写；
// 释放运行面时关闭
// 上下文压缩（决策 188、218）：运行面一律开启，缺省为产品缺省（1M 窗口减预留，实际几乎不触发），阈值与保留量可配置；
// 摘要请求与主请求同一个模型接入（跑批时即同一网关、同一计量与花费上限）
// 推送记忆（决策 191、217、227、244）：开着时会话开始读 .pigeon/learned/MEMORY.md 推入系统提示（常驻 Memory 之后、Skill 目录之前）
// 并注册 update_memory；上下文压缩之前先复盘一次（192、207）。复盘运行面也在这里装：系统提示取来源冻结的原文，工具定义不变，
// 执行时只放行 read_file 与 update_memory（240）
// 联网工具（决策 287–291）：webTools 在场即注册 web_search（read 档，免审批）与 web_fetch（network 档，按网站审批）；提炼器用
// 本会话同一个模型接入。各入口按 291 与 265 的先例决定给不给
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { assertMemoryLimit, loadPushedMemory, type MemoryConflictMode } from "../memory/pushed.ts";
import { loadResidentMemory, type MemoryRoot } from "../memory/resident.ts";
import { REVIEW_TEMPLATE_VERSION, type ReviewKind } from "../memory/review-text.ts";
import {
  createReadSessionEntryTool,
  createSearchSessionsTool,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "../memory/search-tools.ts";
import {
  createUpdateMemoryTool,
  UPDATE_MEMORY_TOOL,
  updateMemoryRegistration,
} from "../memory/update-memory-tool.ts";
import { loadCommandsConfig } from "../persistence/commands-config.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import {
  type BeforeCompaction,
  type CompactionConfigInput,
  ContextCompactor,
  resolveCompactionConfig,
} from "../pi-runtime/compaction.ts";
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
import type { ActiveGrant, ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { MemoryReviewTag, ReviewCoverage } from "../state/learned-memory.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { WorkerRole } from "../state/session-payloads.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { DEFAULT_EDIT_MODE, type EditMode } from "../tools/edit-mode.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import { asWorkspaceHost } from "../tools/local-host.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import { createReadFileTool, ReadFileParamsSchema } from "../tools/read-file.ts";
import { ToolRegistry, type ToolRiskTier } from "../tools/registry.ts";
import { createReplaceEditTool, ReplaceEditParamsSchema } from "../tools/replace-edit.ts";
import {
  createRunCommandTool,
  RUN_COMMAND_TOOL,
  type RunCommandApproval,
  RunCommandParamsSchema,
  runCommandTexts,
} from "../tools/run-command.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import {
  createWebFetchTool,
  createWebSearchTool,
  webFetchRegistration,
  webSearchRegistration,
} from "../web/tools.ts";
import { createToolGovernance } from "./governance.ts";
import type { McpSession } from "./mcp.ts";
import {
  assertReviewBudget,
  DEFAULT_REVIEW_BUDGET,
  gateReviewTools,
  type ReviewBudget,
  type ReviewModelChoice,
  type ReviewObserver,
  reviewWarner,
  runMemoryReview,
} from "./memory-review.ts";
import {
  createOrchestrationTools,
  MESSAGE_WORKER_TOOL,
  orchestrationToolRegistrations,
  STOP_WORKER_TOOL,
  WAIT_WORKERS_TOOL,
  WORKER_STATUS_TOOL,
} from "./orchestration-tools.ts";
import {
  grantEventSink,
  openSessionStore,
  type SessionStoreWriter,
  type StoreLineage,
  storeFaultWarner,
} from "./session-store.ts";
import {
  createSpawnWorkerTool,
  SPAWN_WORKER_TOOL,
  type SpawnWorkerSlot,
  spawnWorkerRegistration,
} from "./spawn-worker-tool.ts";
import {
  createTakeWorkerTool,
  TAKE_WORKER_TOOL,
  takeWorkerRegistration,
} from "./take-worker-tool.ts";
import {
  createTaskListTools,
  LIST_TASKS_TOOL,
  TaskList,
  taskListRegistrations,
  UPDATE_TASKS_TOOL,
} from "./task-list-tool.ts";
import type { WarnSink } from "./warnings.ts";
import { createModelDistiller, type WebToolsConfig } from "./web-tools.ts";

export interface RuntimeDeps {
  streamFn: StreamFn;
  workspaceRoot: string;
  // 决策 098：执行端——三个工作区工具（read_file / edit_file / run_command）经它读写与执行；缺省为 workspaceRoot 上的
  // 本地实现。容器工作区注入容器实现，此时 workspaceRoot 只是宿主侧的占位目录。按路径限定的放权以宿主路径判定，
  // 在这类工作区下暂不支持：带审批通道或装了 pathPrefix 固化规则时装配即报错，不让规则静默失配
  workspaceHost?: WorkspaceHost;
  // 决策 248：日常沙箱改回逐条询问时置 false——注入执行端时仍接交互审批，但会话放权不建目录限定（[d] 按批准一次处理）；
  // 缺省不放开，注入执行端时带审批通道即报错
  pathScopedGrants?: boolean;
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
  // M6.5 S1（决策 056）：缺省 = 无审批通道，prompt 档一律 fail-closed 拒绝（006）——headless 运行如此
  createApprovalHandler?: (grants: SessionGrantStore) => ApprovalHandler;
  // M4 S6（D6/F）：固化配置规则——缺省时 buildRuntime 自行 loadGrantConfig；
  // 畸形文件在此响亮失败（治理配置 fail-closed，启动中止）
  configGrants?: readonly ConfigGrantRule[];
  // M4 S6（决策 3b）：冷恢复种子——续跑时由会话存储的授权条目还原，
  // 会话 grant 崩溃后静默继续有效
  restoredGrants?: readonly ActiveGrant[];
  // M5 S1（决策 045）：thinking 正文是否持久化进会话存储；缺省 true，Actor 以旗标关闭
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
  // 冻结进注入快照（Run 开始条目记系统提示全文）。只说工作方式，不含任务内容；缺省不加
  taskDirective?: string;
  // M9：采样温度——装配层包装 streamFn 传入，并写进注入快照 model 段；缺省不设（由 provider 决定）
  temperature?: number;
  // M7（决策 071 / 079）：会话级验证命令与失败自动分叉重试次数——冻结进注入快照并随 Run 开始条目落盘
  verify?: VerifyConfig;
  retryOnFail?: number;
  // M8（决策 087）：本次尝试的预算——冻结进注入快照并随 Run 开始条目落盘
  budget?: AttemptBudget;
  // 决策 142 / 143：回炉轮数（只在开启时给）——冻结进注入快照并随 Run 开始条目落盘
  repairRounds?: number;
  // M7（决策 077）：分叉续跑的 Agent 初始消息
  initialMessages?: AgentMessage[];
  // 决策 177：worker 与分支会话的来历，新建会话文件时写进文件头
  storeLineage?: StoreLineage;
  // 会话存储故障告警的出口（缺省标准错误输出；测试注入）
  storeWarn?: WarnSink;
  // 决策 193：能否检索历史会话。关掉时不注册 search_sessions 与 read_session_entry，系统提示去掉提到它们的那一句；
  // 缺省开着（日常使用与 193 之前逐字一致）
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（模型窗口、预留、保留量、触发点）；缺省为产品缺省
  compaction?: CompactionConfigInput;
  // 决策 192、207：压缩前回调（压缩前复盘的挂点）；缺省不挂
  beforeCompaction?: BeforeCompaction;
  // 决策 191、217、244：推送记忆。在场即开着——开局推送 MEMORY.md、注册 update_memory、压缩前复盘；缺省关着
  // （装配层缺省；日常入口由启动参数缺省打开，跑批器按条件明确指定）
  learnedMemory?: LearnedMemoryConfig;
  // 决策 191、192：本运行面是一次复盘——系统提示取来源会话冻结的原文（工具定义照常装配，与来源相同），执行时只放行
  // read_file 与 update_memory，Run 开始条目记复盘种类与模板版本。只由复盘装配时给
  reviewSession?: ReviewSessionConfig;
  // 决策 264–267：派 worker 的开关。在场即给主 agent 注册 spawn_worker（编排器建好后由装配方绑定到这个槽上）；缺省关着
  // （装配层缺省；终端界面与 pigeon run 由启动参数缺省打开，跑批器各条件明确关掉）。委派策略在场（worker 自己，深度 1）或
  // 注入了执行端（沙箱）时一律不注册
  spawnWorker?: SpawnWorkerSlot;
  // 决策 294 B1：任务清单工具（update_tasks、list_tasks）。缺省关着（装配层缺省；终端界面与 pigeon run 按编排配置缺省打开，
  // 跑批器各条件不给）；只给主会话（委派策略在场时不注册）
  taskList?: boolean;
  // 决策 302：worker 用写层文件工具改它自己工作区根（工作树）内的文件默认放行（不开放手模式时）；只由 worker 装配时给
  ownWorkspaceWrites?: boolean;
  // 决策 287–291：联网工具的配置。在场即注册 web_search 与 web_fetch；缺省不注册（装配层缺省；交互入口与 pigeon run 由启动参数
  // 缺省给出，--sandbox-network off 不给，跑批器各条件不给）。worker 与主会话同样拿到（父策略里有才带）
  webTools?: WebToolsConfig;
}

// 复盘运行面的设定：种类、来源会话冻结的系统提示原文与来源会话号（refs 里的 user 补来源会话的编号——用户的话说在来源会话里）
export interface ReviewSessionConfig {
  kind: ReviewKind;
  systemPrompt: string;
  sourceSessionId: SessionId;
  // 覆盖到来源会话的哪一条记录（283 补充）：分叉点，Run 开始条目的复盘标记记下它
  covers?: ReviewCoverage;
  // 终端界面启动时后台补做的复盘（283、295）：读代码的来处与此前的覆盖位置
  backfill?: NonNullable<MemoryReviewTag["backfill"]>;
}

// 推送记忆的配置
export interface LearnedMemoryConfig {
  // {冲突处理} 的填法：交互使用（命令行对话、终端界面）/ 无人值守（pigeon run、跑批）
  conflict: MemoryConflictMode;
  // 总量上限（字符，按码点计）；缺省 12,000
  limitChars?: number;
  // 压缩前复盘：缺省开着、上限取缺省；false 即不做（worker 与复盘运行面自己）
  review?: MemoryReviewSettings | false;
  // 复盘模型（决策 296）：在场即本会话的复盘（压缩前、收尾）改用它；缺省用会话本身的模型
  reviewModel?: ReviewModelChoice;
}

export interface MemoryReviewSettings {
  // 复盘上限（缺省 40 轮、15 分钟）
  budget?: ReviewBudget;
  // 每次复盘开始与结束时调用
  observer?: ReviewObserver;
  // 复盘失败与撞上限的告警出口（缺省标准错误输出，同一类只说一次）
  warn?: WarnSink;
  // 外部中止（跑批器作废这一步等）：在途的复盘随之中止
  abortSignal?: AbortSignal;
  // 决策 307、308：打转检测设定（压缩前复盘挂上；叫停这次复盘，已写入的记忆保留）；缺省不挂
  loopGuard?: LoopGuardSettings;
}

// 截断后拆小引导（决策 063 第 2 件）：两种编辑模式的 system prompt 都追加。静态文本，对 prompt cache 友好
export const TRUNCATION_GUIDANCE =
  "工具调用若因输出上限未执行，把改动拆成几次较小的调用重发，不要原样重发；单次编辑只改需要改的那一段。";

// 系统提示里写操作的审批说法（170 ④），按本会话的审批状态取
const WRITE_APPROVAL_SENTENCES: Readonly<Record<RunCommandApproval, string>> = {
  yolo: "写操作自动批准。",
  prompt: "写操作可能需要人工批准。",
  none: "需要批准的写操作会被拒绝（本会话没有人工审批通道）。",
};

// 系统提示里联网工具的说法（决策 287、289）：只在注册了两件工具时追加
export const WEB_TOOLS_SENTENCE =
  "需要网上的资料时，用 web_search 搜索（返回标题、链接与摘要），用 web_fetch 读取某个网页并说明要从中找什么；" +
  "web_fetch 只交回按问题提炼的结果，不交回网页原文。";

export interface RuntimeBundle {
  adapter: PiRuntimeAdapter;
  // 本会话的会话存储写者（决策 176）
  sessionStore: SessionStoreWriter;
  // M4 S6：grant 运行态（审批提示 [a]/[d] 与 /grants /revoke /grants save 共用同一存储）
  grantStore: SessionGrantStore;
  configGrants: readonly ConfigGrantRule[];
  // M5.7 S3：本运行面持有的 MCP 会话（disposeRuntime 一并关闭）
  mcp?: McpSession;
  // M7（决策 078）：已注册工具的风险档位（快照只在写档与命令档工具之后打）
  toolTiers: ReadonlyMap<string, ToolRiskTier>;
  // M6：释放运行面前先执行的附加释放动作（快照器、验证与失败重试的退订与收尾）；按登记顺序执行，失败不挡后续
  disposers?: Array<() => Promise<void>>;
  // 推送记忆开着时在场（worker 按它继承）
  learnedMemory?: LearnedMemoryConfig;
  // 决策 294 B1：任务清单开着时在场（续聊时从会话还原、/tasks 查看）
  taskList?: TaskList;
}

// start/resume 共用的运行时装配：注册内置工具 + 构造适配器与会话存储写者
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
  // 压缩配置畸形在打开会话文件之前响亮失败
  const compactionConfig = resolveCompactionConfig(deps.compaction);
  const learned = deps.learnedMemory;
  assertMemoryLimit(learned?.limitChars);
  // 压缩前复盘（192、207）：推送开着、不是复盘运行面自己、没有明说不做时开着
  const reviewSettings =
    learned !== undefined && learned.review !== false && deps.reviewSession === undefined
      ? (learned.review ?? {})
      : undefined;
  if (reviewSettings?.budget !== undefined) {
    assertReviewBudget(reviewSettings.budget);
  }
  // 推理开启时温度不生效：pi-ai 的 anthropic-messages 线路开思考时不发 temperature，DeepSeek 文档也写明思考模式下
  // 温度设了不报错但不生效。请求值如实记成"未生效"，也不再往下传；关思考（缺省 off）时温度照常下发
  const reasoningEnabled = deps.thinkingLevel !== undefined && deps.thinkingLevel !== "off";
  const appliedTemperature = reasoningEnabled ? undefined : deps.temperature;
  const governanceRoot = deps.governanceRoot ?? deps.workspaceRoot;
  const workspaceHost = deps.workspaceHost ?? asWorkspaceHost(deps.workspaceRoot);
  // 护栏（M9）：按路径限定的放权（会话 grant 的目录限定、固化规则的 pathPrefix）以宿主路径判定，对非本地的工作区
  // 只会静默失配。路径放权在这类工作区下暂不支持：带审批通道的交互场景直接拒绝装配（审批面板的 [d] 就是目录放权）
  if (
    deps.workspaceHost !== undefined &&
    deps.createApprovalHandler !== undefined &&
    deps.pathScopedGrants !== false
  ) {
    throw new Error(
      "容器工作区暂不支持交互审批：按路径限定的放权以宿主路径判定，在容器工作区下会静默失配；" +
        "目前只支持无审批通道的无人值守运行"
    );
  }
  const sessionsDir = path.join(governanceRoot, ".pigeon", "sessions");
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
  // 会话存储写者在配置校验之后打开（装配早期抛错时不留下空的会话文件）
  const sessionStore = openSessionStore({
    sessionsDir,
    sessionId: deps.sessionId,
    cwd: deps.workspaceRoot,
    ...(deps.storeLineage !== undefined ? { lineage: deps.storeLineage } : {}),
    onFault: storeFaultWarner(deps.storeWarn),
    persistThinking: deps.persistThinking ?? true,
  });
  // 决策 3b：会话 grant 运行态——续跑时以会话存储里生效的授权为种子（建立减撤销）
  const grantStore = new SessionGrantStore({
    workspaceRoot: deps.workspaceRoot,
    sink: grantEventSink(sessionStore),
    restored: deps.restoredGrants,
    // 执行端另一侧的工作区不建目录限定的放权
    pathScoped: deps.workspaceHost === undefined,
  });
  // 170 ④：本会话的审批状态——委派策略在场时取其审批模式，否则取 yolo 旗标；非 yolo 时看有没有注入审批通道。
  // run_command 的三处说明与系统提示里的审批说法都按它与执行端的平台生成，不写死本地、人工批准的说法
  const approvalMode = deps.toolPolicy?.approvalMode ?? (deps.yolo ? "yolo" : "prompt");
  const approval: RunCommandApproval =
    approvalMode === "yolo" ? "yolo" : deps.createApprovalHandler !== undefined ? "prompt" : "none";
  const commandTexts = runCommandTexts({ platform: workspaceHost.platform, approval });
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
    description: commandTexts.registry,
    parameters: RunCommandParamsSchema,
    tier: "exec",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  // M5 S2（决策 038）：Session Search 的两个 read 档工具，范围只限本项目会话目录；决策 193 的开关关掉时不注册
  const sessionSearch = deps.sessionSearch ?? true;
  if (sessionSearch) {
    for (const registration of sessionToolRegistrations(sessionsDir)) {
      registry.register(registration);
    }
  }
  // 决策 217：推送开着时注册记忆工具（写档、只写 learned/、免审批）
  if (learned !== undefined) {
    registry.register(updateMemoryRegistration(governanceRoot));
  }
  // 决策 264–267：派 worker 的工具——只给主会话；沙箱（执行端在场）不注册。worker 自己（委派策略在场）只在层数放开、
  // 它还没到最底层时由装配方给一个本层的槽（299：槽的派出方所在层大于 0），此时不给 take_worker（叠加只往主工作目录）
  const nestedSlot =
    deps.spawnWorker !== undefined && deps.spawnWorker.settings.depth > 0
      ? deps.spawnWorker
      : undefined;
  const spawnSlot =
    deps.workspaceHost === undefined
      ? deps.toolPolicy === undefined
        ? deps.spawnWorker
        : nestedSlot
      : undefined;
  const takeSlot = spawnSlot !== undefined && nestedSlot === undefined ? spawnSlot : undefined;
  if (spawnSlot !== undefined) {
    registry.register(spawnWorkerRegistration());
    // 决策 297：等待、状态、发消息、停止四件积木与派 worker 同槽同范围
    for (const registration of orchestrationToolRegistrations(spawnSlot.settings)) {
      registry.register(registration);
    }
  }
  if (takeSlot !== undefined) {
    // 决策 279：取用 worker 自身改动的工具与派 worker 同槽同范围（写档，按写操作审批）
    registry.register(takeWorkerRegistration());
  }
  // 决策 294 B1：任务清单——只给主会话
  const taskList =
    deps.taskList === true && deps.toolPolicy === undefined ? new TaskList() : undefined;
  if (taskList !== undefined) {
    for (const registration of taskListRegistrations()) {
      registry.register(registration);
    }
  }
  // 决策 287–291：联网工具——web_search 读档免审批，web_fetch 网络档按网站审批
  const webTools = deps.webTools;
  if (webTools !== undefined) {
    registry.register(webSearchRegistration());
    registry.register(webFetchRegistration());
  }
  // M5 S3（决策 042）：会话开始读常驻 Memory，拼进 system prompt 一次即冻结（不走 transformContext）；
  // 清单进 InjectionSnapshot v3，会话中途改文件下个会话才生效
  const residentMemory = loadResidentMemory({
    workspaceRoot: governanceRoot,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.memoryBudgetChars !== undefined ? { budgetChars: deps.memoryBudgetChars } : {}),
    ...(deps.memoryRoots !== undefined ? { roots: deps.memoryRoots } : {}),
  });
  // 决策 191：会话开始读学到的记忆，整份推入、即冻结；清单进 Run 开始条目。复盘运行面也读一次（记下复盘开始时的记忆），
  // 但系统提示用来源的原文
  const pushedMemory =
    learned !== undefined
      ? loadPushedMemory({
          governanceRoot,
          conflict: learned.conflict,
          ...(learned.limitChars !== undefined ? { limitChars: learned.limitChars } : {}),
        })
      : undefined;
  const editSentence = replaceMode
    ? "你是 Pigeon 编程助手。用 read_file 读取文件（每行形如「行号| 内容」），" +
      "用 edit_file 按原文替换编辑（old_string 须与文件原文逐字一致且在文件里恰好出现一次，不要带行号前缀）。"
    : "你是 Pigeon 编程助手。用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照），" +
      "用 edit_file 按锚点编辑。";
  const basePrompt =
    editSentence +
    TRUNCATION_GUIDANCE +
    WRITE_APPROVAL_SENTENCES[approval] +
    commandTexts.prompt +
    (sessionSearch
      ? "需要以前会话里的信息时，用 search_sessions 按关键词检索本项目历史消息，" +
        "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。"
      : "") +
    (webTools !== undefined ? WEB_TOOLS_SENTENCE : "");
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
    ...(sessionSearch ? [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL] : []),
    ...(learned !== undefined ? [UPDATE_MEMORY_TOOL] : []),
    ...(hasSkills ? [LOAD_SKILL_TOOL] : []),
    ...mcpTools.map((bridged) => bridged.name),
    ...(spawnSlot !== undefined
      ? [
          SPAWN_WORKER_TOOL,
          WAIT_WORKERS_TOOL,
          WORKER_STATUS_TOOL,
          MESSAGE_WORKER_TOOL,
          STOP_WORKER_TOOL,
        ]
      : []),
    ...(takeSlot !== undefined ? [TAKE_WORKER_TOOL] : []),
    ...(taskList !== undefined ? [UPDATE_TASKS_TOOL, LIST_TASKS_TOOL] : []),
    ...(webTools !== undefined ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] : []),
  ];
  const mcpSection =
    mcpTools.length > 0
      ? "## 外部工具\n以 mcp__<server>__ 开头的工具来自外部 MCP server，与内置工具同样受审批与留证；" +
        "server 不可用时这些工具会报错，改用内置工具继续。"
      : "";
  // 复盘运行面沿用来源会话冻结的系统提示原文（命中缓存，也不让复盘看到开局之后改过的记忆段）
  const systemPrompt =
    deps.reviewSession?.systemPrompt ??
    [
      basePrompt,
      residentMemory.section,
      pushedMemory?.section ?? "",
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
  // Run 开始条目的附加摘要：MCP 工具集与 server 状态（有 server 时）
  const mcpSummary = mcp !== undefined && mcp.connections.length > 0 ? mcp : undefined;
  const runStartedExtras = mcpSummary !== undefined ? () => mcpSummary.summary() : undefined;
  // 决策 188：压缩服务。摘要请求与主请求同一个模型接入，只套温度（摘要从不请求推理，温度总能生效）；
  // 不套单轮输出上限包装——它会盖掉上游给摘要定的输出上限（0.8 倍预留与模型输出上限的较小者）。
  // 模型对象只是占位身份（真实模型元数据在模型接入插件里），带上输出上限与窗口供上游定摘要请求的选项
  // 决策 192、207：压缩前复盘——推送开着时，压缩真正执行之前从本会话分叉复盘一次（三个触发位置都经这个回调），
  // 再调用调用方给的压缩前回调。复盘改动的记忆不影响本会话（开工时已推入）；复盘失败不挡压缩
  const warnReview = reviewWarner(reviewSettings?.warn);
  const preCompactionReview: BeforeCompaction | undefined =
    reviewSettings !== undefined && learned !== undefined
      ? async (info) => {
          const observer = reviewSettings.observer;
          observer?.started?.("pre-compaction");
          await sessionStore.flush();
          const signals = [info.signal, reviewSettings.abortSignal].filter(
            (signal): signal is AbortSignal => signal !== undefined
          );
          const outcome = await runMemoryReview({
            kind: "pre-compaction",
            governanceRoot,
            sourceSessionId: deps.sessionId,
            budget: reviewSettings.budget ?? DEFAULT_REVIEW_BUDGET,
            abortSignal: AbortSignal.any(signals),
            ...(reviewSettings.loopGuard !== undefined
              ? { loopGuard: reviewSettings.loopGuard }
              : {}),
            open: (review) =>
              reviewHandle(
                buildRuntime(
                  reviewRuntimeDeps(deps, review, {
                    kind: "pre-compaction",
                    systemPrompt,
                    sourceSessionId: deps.sessionId,
                    covers: review.covers,
                  })
                )
              ),
          });
          warnReview(outcome);
          observer?.ended?.(outcome);
        }
      : undefined;
  const beforeCompaction: BeforeCompaction | undefined =
    preCompactionReview === undefined
      ? deps.beforeCompaction
      : async (info) => {
          await preCompactionReview(info);
          await deps.beforeCompaction?.(info);
        };
  // 占位模型对象（真实模型元数据在模型接入插件里）：压缩摘要请求与网页提炼请求共用
  const placeholderModel = {
    id: deps.modelId,
    name: deps.modelId,
    api: "unknown" as const,
    provider: deps.provider,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: compactionConfig.contextWindow,
    maxTokens: maxOutputTokens,
  };
  const compactor = new ContextCompactor({
    config: compactionConfig,
    streamFn:
      deps.temperature !== undefined
        ? fixTemperature(deps.streamFn, deps.temperature)
        : deps.streamFn,
    model: placeholderModel,
    ...(beforeCompaction !== undefined ? { beforeCompaction } : {}),
  });
  // 决策 289：提炼器——本会话同一个模型接入，温度 0，不带工具，有输出上限；不套单轮输出上限与温度的包装，选项直接给
  const webToolset =
    webTools !== undefined
      ? [
          createWebSearchTool(webTools.search),
          createWebFetchTool({
            limits: webTools.fetch,
            distill: createModelDistiller({
              streamFn: deps.streamFn,
              model: placeholderModel,
              maxTokens: webTools.distillMaxTokens,
            }),
            ...(webTools.lookup !== undefined ? { lookup: webTools.lookup } : {}),
            ...(webTools.transport !== undefined ? { transport: webTools.transport } : {}),
          }),
        ]
      : [];
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
      ...(pushedMemory !== undefined ? { learnedMemory: pushedMemory.manifest } : {}),
      ...(deps.reviewSession !== undefined
        ? {
            memoryReview: {
              kind: deps.reviewSession.kind,
              template: REVIEW_TEMPLATE_VERSION,
              ...(deps.reviewSession.covers !== undefined
                ? { covers: { ...deps.reviewSession.covers } }
                : {}),
              ...(deps.reviewSession.backfill !== undefined
                ? { backfill: structuredClone(deps.reviewSession.backfill) }
                : {}),
            },
          }
        : {}),
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
        approval,
        commands: commandsConfig.commands,
        ...(deps.commandRole !== undefined
          ? { allowlist: commandsConfig.roles[deps.commandRole] ?? [] }
          : {}),
      }),
      ...(sessionSearch
        ? [createSearchSessionsTool({ sessionsDir }), createReadSessionEntryTool({ sessionsDir })]
        : []),
      ...(learned !== undefined
        ? [
            createUpdateMemoryTool({
              governanceRoot,
              sessionId: deps.reviewSession?.sourceSessionId ?? deps.sessionId,
              ...(learned.limitChars !== undefined ? { limitChars: learned.limitChars } : {}),
            }),
          ]
        : []),
      ...(hasSkills ? [createLoadSkillTool({ catalog: skillCatalog })] : []),
      ...mcpTools.map((bridged) => bridged.tool),
      ...(spawnSlot !== undefined
        ? [createSpawnWorkerTool(spawnSlot), ...createOrchestrationTools(spawnSlot)]
        : []),
      ...(takeSlot !== undefined ? [createTakeWorkerTool(takeSlot)] : []),
      ...(taskList !== undefined ? createTaskListTools(taskList) : []),
      ...webToolset,
    ],
    // M5.5 S0（决策 049）：装配根组装工具调用治理后注入 Adapter；复盘运行面在前面加一道闸，只放行两件工具（240）
    governance: gateReviewTools(
      deps.reviewSession !== undefined,
      createToolGovernance({
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
        // 决策 302：worker 改自己工作树内的文件默认放行
        ...(deps.ownWorkspaceWrites === true ? { ownWorkspaceWrites: true } : {}),
      })
    ),
    sessionId: deps.sessionId,
    sessionStore,
    compaction: compactor,
    // M5.7 S3（决策 052）：每个 Run 开始时把 MCP 工具集摘要与 server 当前状态写进 Run 开始条目；无 server 时不带字段
    ...(runStartedExtras !== undefined ? { runStartedExtras } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    // 决策 264：注册了派 worker 工具时，同一次回复里的多个派出并行执行
    ...(spawnSlot !== undefined ? { parallelTools: true } : {}),
  });
  const toolTiers = new Map(
    registry.list().map((registration) => [registration.name, registration.tier])
  );
  return {
    adapter,
    sessionStore,
    grantStore,
    configGrants,
    toolTiers,
    ...(mcp !== undefined ? { mcp } : {}),
    ...(learned !== undefined ? { learnedMemory: learned } : {}),
    ...(taskList !== undefined ? { taskList } : {}),
  };
}

// 复盘运行面的装配参数：与来源同一份（工具定义因此相同），换会话号与初始消息，系统提示取来源原文；不带验证、回炉、
// 失败重试、压缩前回调与会话来历；预算取复盘上限；推送照开（注册 update_memory）但不再嵌套压缩前复盘
export function reviewRuntimeDeps(
  deps: RuntimeDeps,
  review: { sessionId: SessionId; initialMessages: AgentMessage[] },
  session: ReviewSessionConfig
): RuntimeDeps {
  const {
    verify: _verify,
    retryOnFail: _retryOnFail,
    repairRounds: _repairRounds,
    beforeCompaction: _beforeCompaction,
    storeLineage: _storeLineage,
    restoredGrants: _restoredGrants,
    budget: _budget,
    initialMessages: _initialMessages,
    learnedMemory,
    ...base
  } = deps;
  const settings = learnedMemory?.review;
  const budget = (settings !== false ? settings?.budget : undefined) ?? DEFAULT_REVIEW_BUDGET;
  const reviewModel = learnedMemory?.reviewModel;
  return {
    ...base,
    ...(reviewModel !== undefined
      ? { provider: reviewModel.provider, modelId: reviewModel.modelId }
      : {}),
    sessionId: review.sessionId,
    initialMessages: review.initialMessages,
    reviewSession: session,
    budget: { maxTurns: budget.maxTurns, wallClockMs: budget.wallClockMs },
    ...(learnedMemory !== undefined ? { learnedMemory: { ...learnedMemory, review: false } } : {}),
  };
}

// 复盘运行面的句柄：释放时只停运行面、关会话文件，不关 MCP 会话（与来源共用，来源还在用）
export function reviewHandle(bundle: RuntimeBundle): {
  run: RuntimeBundle["adapter"]["run"];
  interrupt: RuntimeBundle["adapter"]["interrupt"];
  subscribe: RuntimeBundle["adapter"]["subscribe"];
  subscribeRounds: RuntimeBundle["adapter"]["subscribeRounds"];
  notify: RuntimeBundle["adapter"]["notify"];
  dispose(): Promise<void>;
} {
  const { adapter, sessionStore } = bundle;
  return {
    run: (task) => adapter.run(task),
    interrupt: (cause) => adapter.interrupt(cause),
    subscribe: (listener) => adapter.subscribe(listener),
    subscribeRounds: (listener) => adapter.subscribeRounds(listener),
    notify: (text) => adapter.notify(text),
    dispose: async () => {
      try {
        await adapter.dispose();
      } finally {
        await sessionStore.close();
      }
    },
  };
}

// 释放运行面（M5.7 S3）：先停 Adapter，再关 MCP 连接（server 进程随之退出），最后关会话存储写者；
// 前一步失败不跳过后续
export async function disposeRuntime(bundle: RuntimeBundle): Promise<void> {
  for (const dispose of bundle.disposers?.splice(0) ?? []) {
    try {
      await dispose();
    } catch {
      // 附加释放失败不挡运行面释放（附加动作都是后台附属，不得拖住主会话收尾）
    }
  }
  try {
    await bundle.adapter.dispose();
  } finally {
    try {
      await bundle.mcp?.close();
    } finally {
      await bundle.sessionStore.close();
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
