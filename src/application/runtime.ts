// 装配根（M2 S1，决策 025 从 cli/index.ts 抽到 Controller 层）：注册内置工具 + 构造适配器与
// 会话存储写者 + grant 运行态。审批 handler 由调用方注入（cli 传 REPL 问答版，tui 传面板版）——
// 工厂形态而非成品：装配根先建 grantStore，审批提示的 [a]/[d] 放权键需要它，
// 故调用方给一个"拿到 store 再造 handler"的工厂。
// 会话存储（决策 176 / 210）：<governanceRoot>/.pigeon/state/sessions/<工作目录编码>/ 下的 pi 会话文件（M5.5 S1 治理根缺省
// 同工作区根），交给 Adapter 写消息与 Run 起止，授权经落盘口写入；续跑复用同一 sessionId 打开同一文件续写；
// 释放运行面时关闭
// 上下文压缩（决策 188、218）：运行面一律开启，缺省为产品缺省（1M 窗口减预留，实际几乎不触发），阈值与保留量可配置；
// 摘要请求与主请求同一个模型接入
// 人写的说明（决策 330、363）：读 AGENTS.md（用户级与仓库根到工作目录逐层）作开工状态块的「项目说明」一节，合计上限 32 KiB。
// 推送记忆（决策 191、331、332、363）：开着时读两层学到的记忆作开工状态块的「记忆」一节；
// 只有有人对话的入口另给写入配置，注册 update_memory、推送段带"被纠正时记下"的说明。复盘（收尾、压缩前、补做）随决策 331 删除
// 联网工具（决策 287–291）：webTools 在场即注册 web_search（read 档，免审批）与 web_fetch（network 档，按网站审批）；提炼器用
// 本会话同一个模型接入。各入口按 291 与 265 的先例决定给不给
// 模型信息（决策 362）：接入模块可具名导出 modelInfo，加载时随 StreamFn 登记；装配时按设置 > 声明 > pi-ai 目录 > 未知逐项取值，
// 写进每个 Run 的开始条目并放在运行面上供查询（state/model-info.ts 的 modelProfile）。不改裁剪、压缩或输出上限的行为
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { type AgentsMdInstructions, loadAgentsInstructions } from "../memory/agents-md.ts";
import type { MemoryLayer } from "../memory/learned.ts";
import { loadPushedMemory, type PushedMemory } from "../memory/pushed.ts";
import {
  createListSessionsTool,
  createReadSessionEntryTool,
  createSearchSessionsTool,
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
  sessionToolRegistrations,
} from "../memory/search-tools.ts";
import {
  createUpdateMemoryTool,
  type MemorySource,
  type MemoryWriteNotice,
  UPDATE_MEMORY_TOOL,
  updateMemoryRegistration,
} from "../memory/update-memory-tool.ts";
import { PiRuntimeAdapter, type StatusChannel } from "../pi-runtime/adapter.ts";
import {
  type BeforeCompaction,
  type CompactionConfigInput,
  ContextCompactor,
  resolveCompactionConfig,
} from "../pi-runtime/compaction.ts";
import { ContextPruner, type PruneSeed } from "../pi-runtime/context-prune.ts";
import {
  type AgentMessage,
  declarationComplete,
  loadCatalogLookup,
  modelAccessOf,
  parseModelInfoDeclaration,
  registerModelAccess,
  type StreamFn,
} from "../pi-runtime/index.ts";
import { limitOutputTokens } from "../pi-runtime/output-limit.ts";
import { fixTemperature } from "../pi-runtime/sampling.ts";
import { INJECTION_SNAPSHOT_VERSION, type ToolPolicy } from "../pi-runtime/snapshot.ts";
import {
  type LocalSkillScan,
  loadSkillCatalog,
  NO_LOAD_SKILL_SENTENCE,
  type SkillRoot,
  scanLocalSkills,
  skillTreeFingerprint,
} from "../skills/catalog.ts";
import {
  createLoadSkillTool,
  LOAD_SKILL_TOOL,
  loadSkillRegistration,
} from "../skills/load-skill-tool.ts";
import type { AttemptBudget } from "../state/attempt-config.ts";
import type { ActiveGrant, ConfigGrantRule } from "../state/grants.ts";
import type { HookEventName } from "../state/hooks.ts";
import type { RunId, SessionId } from "../state/ids.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import {
  type ModelInfoDeclaration,
  modelProfile,
  type ResolvedModelInfo,
  resolveModelInfo,
  runModelInfoRecord,
} from "../state/model-info.ts";
import {
  jobsDirOf,
  outputsRootOf,
  sessionSearchCacheDirOf,
  sessionsDirOf,
} from "../state/paths.ts";
import { contextPruneSettings } from "../state/prune-config.ts";
import type {
  RepetitionGuardSettings,
  TruncationContinuationSettings,
} from "../state/runaway-config.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { ToolScope, WorkerRole } from "../state/session-payloads.ts";
import {
  backgroundJobLimitsOf,
  commandsConfigOf,
  configGrantRulesOf,
  contextPruneSectionOf,
  emptySettingsSnapshot,
  memoryLimitsOf,
  modelInfoSectionOf,
  readFileLimitsOf,
  repetitionGuardOf,
  runCommandOutputLimitsOf,
  runCommandTimeoutsOf,
  type SettingsSnapshot,
  searchLimitsOf,
  sessionSearchEnabledOf,
  thinkingSectionOf,
  truncationContinuationOf,
} from "../state/settings.ts";
import { resolveThinkingLevel } from "../state/thinking-config.ts";
import {
  JOB_KILL_TOOL,
  JOB_OUTPUT_TOOL,
  jobPoolFor,
  SessionJobs,
} from "../tools/background-jobs.ts";
import { CommandOutputStore } from "../tools/command-output.ts";
import { createEditFileTool, EditFileParamsSchema } from "../tools/edit-file.ts";
import { DEFAULT_EDIT_MODE, type EditMode } from "../tools/edit-mode.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import {
  createJobKillTool,
  createJobOutputTool,
  JOB_KILL_DESCRIPTION,
  JOB_OUTPUT_DESCRIPTION,
  JobKillParamsSchema,
  JobOutputParamsSchema,
} from "../tools/job-tools.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import type { ToolPolicyLike } from "../tools/policy.ts";
import {
  createReadFileTool,
  type OutsideReadMode,
  ReadFileParamsSchema,
} from "../tools/read-file.ts";
import { FileReadTracker } from "../tools/read-tracker.ts";
import { ToolRegistry, type ToolRiskTier } from "../tools/registry.ts";
import { createReplaceEditTool, ReplaceEditParamsSchema } from "../tools/replace-edit.ts";
import {
  createRunCommandTool,
  RUN_COMMAND_TOOL,
  type RunCommandApproval,
  RunCommandParamsSchema,
  runCommandTexts,
} from "../tools/run-command.ts";
import {
  createSearchTools,
  READ_ONLY_SEARCH_TOOLS,
  searchToolRegistrations,
} from "../tools/search-tools.ts";
import { scopePromptSentence } from "../tools/tool-scope.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import {
  createWriteFileTool,
  WRITE_FILE_TOOL,
  WriteFileParamsSchema,
} from "../tools/write-file.ts";
import {
  createWebFetchTool,
  createWebSearchTool,
  webFetchRegistration,
  webSearchRegistration,
} from "../web/tools.ts";
import {
  backgroundJobEntry,
  cleanupOrphanedJobsOnce,
  JOB_NOTICE_PREFIX,
  JobNotices,
  lostJobsText,
  type PreviousJobs,
} from "./background-jobs.ts";
import { createToolGovernance } from "./governance.ts";
import { SessionHooks } from "./hooks.ts";
import type { McpSession } from "./mcp.ts";
import {
  createOrchestrationTools,
  MESSAGE_WORKER_TOOL,
  orchestrationToolRegistrations,
  STOP_WORKER_TOOL,
  WAIT_WORKERS_TOOL,
  WORKER_STATUS_TOOL,
} from "./orchestration-tools.ts";
import { outputAncestors } from "./output-ancestors.ts";
import { createHostProtectedPathResolver, createProtectedPathResolver } from "./protected-paths.ts";
import {
  createOrchestrateTool,
  ORCHESTRATE_TOOL,
  orchestrateRegistration,
  type ScriptSlot,
} from "./script-tool.ts";
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
  escapeStatusText,
  STATUS_AUTHORITY_SENTENCE,
  type StatusHashes,
  type StatusSectionName,
  type StatusState,
  StatusTracker,
  statusEntry,
} from "./status-block.ts";
import {
  dateText,
  environmentText,
  gitText,
  hostStatusProbe,
  localStatusProbe,
  type StatusFacts,
} from "./status-sources.ts";
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
import {
  type SkippedTools,
  type ToolEnvironment,
  toolEnvironmentProbe,
} from "./tool-environment.ts";
import { toolExecutionModeOf } from "./tool-execution-modes.ts";
import { stderrWarn, type WarnSink } from "./warnings.ts";
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
  // M5.5 S1（决策 040）：治理根——.pigeon/（设置、程序状态、Skill）所在；
  // 缺省同工作区根。worker 的工作区根是自己的 git 工作树，治理根恒为主仓库根
  governanceRoot?: string;
  // M5.5 S2（决策 040）：委派策略（worker）——在场时 allow 与已注册工具取交、deny 与审批模式照搬，
  // yolo 旗标不再参与；缺省按 yolo 旗标给全部内置工具。决策 360：另可带各工具的作用范围（交治理层逐调用判定）
  toolPolicy?: ToolPolicyLike & { readonly scopes?: readonly ToolScope[] };
  sessionId: SessionId;
  yolo: boolean;
  provider: string;
  modelId: string;
  // 审批 handler 由 Actor 注入（决策 025）：工厂收 grantStore——审批提示的 [a]/[d]
  // 放权键需要它；cli 传 REPL 问答版，将来的 tui 传面板版。
  // M6.5 S1（决策 056）：缺省 = 无审批通道，prompt 档一律 fail-closed 拒绝（006）——headless 运行如此
  createApprovalHandler?: (grants: SessionGrantStore) => ApprovalHandler;
  // 决策 325：本会话的设置快照（会话开始时读一次；worker 与沙箱会话用派出它的会话的快照）。放权规则（三层并集）与
  // 命令短名都从它取；缺省为空快照（不读任何设置文件——测试与跑批器如此，日常入口一律显式给出）
  settings?: SettingsSnapshot;
  // M4 S6（D6/F）：固化配置规则——缺省取设置快照里的放权规则（测试可直接注入）
  configGrants?: readonly ConfigGrantRule[];
  // M4 S6（决策 3b）：冷恢复种子——续跑时由会话存储的授权条目还原，
  // 会话 grant 崩溃后静默继续有效
  restoredGrants?: readonly ActiveGrant[];
  // M5 S1（决策 045）：thinking 正文是否持久化进会话存储；缺省 true，Actor 以旗标关闭
  persistThinking?: boolean;
  // 用户级目录（~/.pigeon：AGENTS.md、Skill、学到的记忆的用户级）所在的家目录（缺省 os.homedir()；测试注入临时目录）
  homeDir?: string;
  // M5.5 S5（决策 050）：推理档位——Actor 传启动参数全局值，worker 装配按角色配置覆盖。没给时取设置的 thinking 一节，
  // 设置也没写即按模型信息：支持推理的模型 high，不支持或不知道的 off（决策 390，见 state/thinking-config.ts）
  thinkingLevel?: ThinkingLevel;
  // M5.5 S5（决策 048）：worker 角色——设置的 commands 一节为该角色登记了命令时，run_command 只接受登记的命令
  // （决策 360：作额外限制；没登记的角色与主会话同一规则）；主会话缺省，不受清单限制
  commandRole?: WorkerRole;
  // M5.7 S3（决策 041 / 051 / 052）：已启动的 MCP 会话（Actor 在装配前异步启动，worker 按其工作树各起一份）；
  // 缺省 = 本会话没有外部工具
  mcp?: McpSession;
  // M6.5（决策 059）：显式 Skill 根——在场时只用给定的根（空数组 = 不注入），不扫治理根与用户级目录
  skillRoots?: readonly SkillRoot[];
  // 决策 330：读不读人写的说明（AGENTS.md）；缺省读。跑批器与只测装配的用例关掉（对照实验里说明不是变量，任何一层都不能漏进来）
  agentsMd?: boolean;
  // 决策 061：编辑模式，缺省见 tools/edit-mode.ts 的 DEFAULT_EDIT_MODE（现为 replace）
  editMode?: EditMode;
  // 决策 063、347：单轮输出上限——配置了才在装配层包装 streamFn 传入 maxTokens，并写进注入快照 model 段；未配置不包装、
  // 不写（表示跟模型：按模型定义的上限发，由 provider 按剩余上下文收窄）
  maxOutputTokens?: number;
  // 决策 367：撞上限续跑与流式重复检测的生效设定——缺省取设置快照（不给的项取缺省：都开、omp 档、掐断）；跑批器显式给出
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // M9：任务源给的系统指令（如外部基准的工作方式指令）——原样追加为 system prompt 的一段，随整段 system prompt
  // 冻结进注入快照（Run 开始条目记系统提示全文）。只说工作方式，不含任务内容；缺省不加
  taskDirective?: string;
  // M9：采样温度——装配层包装 streamFn 传入，并写进注入快照 model 段；缺省不设（由 provider 决定）
  temperature?: number;
  // M8（决策 087）：本次尝试的预算——冻结进注入快照并随 Run 开始条目落盘
  budget?: AttemptBudget;
  // M7（决策 077）：分叉续跑的 Agent 初始消息
  initialMessages?: AgentMessage[];
  // 决策 177：worker 与分支会话的来历，新建会话文件时写进文件头
  storeLineage?: StoreLineage;
  // 会话存储故障告警的出口（缺省标准错误输出；测试注入）
  storeWarn?: WarnSink;
  // 决策 324：钩子拦下或出错时的一行提示（终端界面落消息区；缺省静默）
  hooksNotice?: WarnSink;
  // 决策 193：能否检索历史会话。关掉时不注册 search_sessions、read_session_entry 与 list_sessions（339），系统提示去掉提到它们的那一句；
  // 缺省开着（日常使用与 193 之前逐字一致）。决策 382：使用者另有设置项与启动参数两个开关（都在装配之前并入这一项）
  sessionSearch?: boolean;
  // 决策 382：使用者开关关掉时的原因（写进开局记录的 skippedTools）；跑批按条件关掉时不给（照旧不记）
  sessionSearchOffReason?: string;
  // 决策 188、218：上下文压缩的配置（模型窗口、预留、保留量、触发点）；缺省为产品缺省
  compaction?: CompactionConfigInput;
  // 压缩前回调；缺省不挂
  beforeCompaction?: BeforeCompaction;
  // 决策 191、244、331、332：推送记忆。在场即开着——开局推送两层记忆；带写入配置时另注册 update_memory。缺省关着
  // （装配层缺省；日常入口由启动参数缺省打开，跑批器按条件明确指定）
  learnedMemory?: LearnedMemoryConfig;
  // 决策 340：/reload 重建时沿用旧运行面开局读到的人写说明（AGENTS.md）、推送的记忆与本地 Skill 扫描结果（不重读文件）
  // 与系统提示（决策 363：/reload 后系统提示逐字节不变）
  frozenPrompt?: FrozenSessionPrompt;
  // 决策 359：查 PATH 用的环境变量（缺省 process.env；测试注入）
  env?: NodeJS.ProcessEnv;
  // 决策 363：续跑沿用会话记录里最后一个 Run 开始条目记下的系统提示（不重新生成）；缺省按本会话现拼
  systemPrompt?: string;
  // 决策 363：状态变化通道的起点（各节哈希）——/reload 交来旧运行面最后发出的一份，续跑、续做与分叉续跑取会话记录里
  // 最后一条状态条目；缺省没有（首次给完整块）
  statusSent?: StatusHashes;
  // 决策 361：上下文裁剪的起点（已有的裁剪与上一个 Run 的模型、工具集、系统提示）——/reload 交来旧运行面的，续跑、续做与
  // 分叉续跑取自会话记录；缺省没有
  pruneSeed?: PruneSeed;
  // 决策 354：入口给出的确知事实（沙箱档位、网络能否用），写进开工状态块的环境一节
  statusFacts?: StatusFacts;
  // 决策 365：/reload 交来旧运行面的后台作业（连同它的落盘目录），新运行面接着管；续跑时会话记录里上一进程的作业
  reloadJobs?: SessionJobs;
  previousJobs?: PreviousJobs;
  // 无人值守收尾等后台作业的总时限（缺省取设置的 tools.runCommand.backgroundCloseoutSeconds；跑批器显式给出）
  jobCloseoutMs?: number;
  // 决策 264–267：派 worker 的开关。在场即给主 agent 注册 spawn_worker（编排器建好后由装配方绑定到这个槽上）；缺省关着
  // （装配层缺省；终端界面与 pigeon run 由启动参数缺省打开，跑批器各条件明确关掉）。委派策略在场（worker 自己，深度 1）或
  // 注入了执行端（沙箱）时一律不注册
  spawnWorker?: SpawnWorkerSlot;
  // 决策 294 D、309：提交编排脚本的工具。在场即给主 agent 注册 orchestrate（运行器建好后由装配方绑定到这个槽上）；能否执行由槽里的
  // 点名判定管。缺省关着（跑批器各条件不给）；委派策略在场（worker）或注入了执行端（沙箱）时不注册
  scriptOrchestration?: ScriptSlot;
  // 决策 294 B1：任务清单工具（update_tasks、list_tasks）。缺省关着（装配层缺省；终端界面与 pigeon run 按编排配置缺省打开，
  // 跑批器各条件不给）；只给主会话（委派策略在场时不注册）
  taskList?: boolean;
  // 决策 302：worker 用写层文件工具改它自己工作区根（工作树）内的文件默认放行（不开放手模式时）；只由 worker 装配时给
  ownWorkspaceWrites?: boolean;
  // 决策 287–291：联网工具的配置。在场即注册 web_search 与 web_fetch；缺省不注册（装配层缺省；交互入口与 pigeon run 由启动参数
  // 缺省给出，--sandbox-network off 不给，跑批器各条件不给）。worker 与主会话同样拿到（父策略里有才带）
  webTools?: WebToolsConfig;
}

// 推送记忆的配置
export interface LearnedMemoryConfig {
  // 两层上限（字符，按码点计）；缺省取设置快照的 memory 一节（不给的取缺省 4,000）
  limits?: MemoryLimits;
  // 推送哪几层；缺省两层（跑批器只推项目级：不读使用者的用户级记忆）
  layers?: readonly MemoryLayer[];
  // 决策 331：写入。在场即注册 update_memory，推送段带写入说明与交互版的冲突处理；只由有人对话的入口给（终端界面主会话
  // 含沙箱会话、--line）。委派策略在场（worker 与续开的 worker 会话）时不生效
  write?: MemoryWriteConfig;
}

export interface MemoryWriteConfig {
  // 来源（哪个入口）：工具补在每条的〔〕里
  source: MemorySource;
  // 写入后调用：入口在消息区显示一行记下的内容与层级
  onWritten?: (notice: MemoryWriteNotice) => void;
  // 记日期用的时钟（测试注入）
  now?: () => Date;
}

// 决策 353：引导模型把互不依赖的读取放进同一次回复（纯读的一批会同时执行）
export const PARALLEL_READS_SENTENCE = "互不依赖的读取与搜索放在同一次回复里一起发。";

// 截断后拆小引导（决策 063 第 2 件）：两种编辑模式的 system prompt 都追加。静态文本，对 prompt cache 友好
export const TRUNCATION_GUIDANCE =
  "工具调用若因输出上限未执行，把改动拆成几次较小的调用重发，不要原样重发；单次编辑只改需要改的那一段。";

// 写操作的审批说法（170 ④），按本会话的审批状态取；决策 363 起在开工状态块的「审批」一节
const WRITE_APPROVAL_SENTENCES: Readonly<Record<RunCommandApproval, string>> = {
  yolo: "写操作自动批准。",
  prompt: "写操作可能需要人工批准。",
  none: "需要批准的写操作会被拒绝（本会话没有人工审批通道）。",
};

// 在 Run 窗口外触发、记录挂刚结束的 Run 的收尾类钩子事件（自动压缩的 PostCompact 另按触发位置判）
const RUN_TAIL_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set([
  "Stop",
  "StopFailure",
  "SubagentStop",
]);

// 系统提示开头一句：介绍读与改两件文件工具。worker 只介绍它有的（决策 360）；两件都在时即原有的整句
function fileToolsSentence(replaceMode: boolean, read: boolean, edit: boolean): string {
  const readPart = replaceMode
    ? "用 read_file 读取文件（每行形如「行号| 内容」）"
    : "用 read_file 读取文件（输出带 N#TAG 行锚点与 [PATH#TAG] 快照）";
  const editPart = replaceMode
    ? "用 edit_file 按原文替换编辑（old_string 须与文件原文逐字一致且在文件里恰好出现一次，不要带行号前缀）"
    : "用 edit_file 按锚点编辑";
  const parts = [...(read ? [readPart] : []), ...(edit ? [editPart] : [])];
  return `你是 Pigeon 编程助手。${parts.length > 0 ? `${parts.join("，")}。` : ""}`;
}

// 决策 360：worker 没给的工具不注册——注册表只留委派策略里有的
function registrySubset(source: ToolRegistry, names: readonly string[]): ToolRegistry {
  const subset = new ToolRegistry();
  for (const registration of source.list()) {
    if (names.includes(registration.name)) {
      subset.register(registration);
    }
  }
  return subset;
}

// 决策 359：没注册 web_search（缺搜索 key）时只说 web_fetch（决策 363 起同在「联网」一节）
export const WEB_FETCH_SENTENCE =
  "需要读取某个网页时，用 web_fetch 读取并说明要从中找什么；web_fetch 只交回按问题提炼的结果，不交回网页原文。";

// 联网工具的说法（决策 287、289）：只在注册了两件工具时给；决策 363 起在开工状态块的「联网」一节
export const WEB_TOOLS_SENTENCE =
  "需要网上的资料时，用 web_search 搜索（返回标题、链接与摘要），用 web_fetch 读取某个网页并说明要从中找什么；" +
  "web_fetch 只交回按问题提炼的结果，不交回网页原文。";

// 本运行面开局定下的部分（决策 340、363）：系统提示，以及开局读到的人写说明（AGENTS.md）、推送的记忆、本地 Skill 扫描结果
// 与按环境注册工具的检查结果。/reload 重建运行面时沿用，不重读文件；开工状态块里的说明、记忆与 Skill 目录照常每个 Run 重读
export interface FrozenSessionPrompt {
  // 决策 363：本运行面的系统提示（续跑与 /reload 后逐字节不变）
  systemPrompt: string;
  instructions: AgentsMdInstructions;
  pushedMemory?: PushedMemory;
  localSkills: LocalSkillScan;
  // 决策 359：按环境注册工具的检查结果（/reload 沿用，一次会话内工具清单固定）
  toolEnvironment?: ToolEnvironment;
}

export interface RuntimeBundle {
  adapter: PiRuntimeAdapter;
  // 本会话的会话存储写者（决策 176）
  sessionStore: SessionStoreWriter;
  // M4 S6：grant 运行态（审批提示 [a]/[d] 与 /grants /revoke /grants save 共用同一存储）
  grantStore: SessionGrantStore;
  configGrants: readonly ConfigGrantRule[];
  // 决策 325：本会话的设置快照（worker 按它继承，/grants 按它列出各层的放权规则）
  settings: SettingsSnapshot;
  // 决策 323 / 324：会话级钩子（冻结的清单、执行、记录与提示；入口层据此跑 SessionStart/Stop 等会话级事件）
  hooks: SessionHooks;
  // M5.7 S3：本运行面持有的 MCP 会话（disposeRuntime 一并关闭）
  mcp?: McpSession;
  // M7（决策 078）：已注册工具的风险档位（快照只在写档与命令档工具之后打）
  toolTiers: ReadonlyMap<string, ToolRiskTier>;
  // 决策 365：本会话的后台作业与结束通知（disposeRuntime 停掉全部作业；/reload 交给新运行面后置空）、无人值守收尾的总时限
  jobs?: SessionJobs | undefined;
  jobNotices?: JobNotices | undefined;
  jobCloseoutMs: number;
  // 后台作业的会话记录改写到本运行面（/reload 交接失败、作业留在旧运行面时用）
  bindJobEvents: () => void;
  // M6：释放运行面前先执行的附加释放动作（快照器、验证与失败重试的退订与收尾）；按登记顺序执行，失败不挡后续
  disposers?: Array<() => Promise<void>>;
  // 决策 350：运行面停下（在途 Run 中止并收尾）之后、会话存储关闭之前执行的收尾动作——快照器在此等未完成的快照拍完
  // （最后一个工具结果同样先写拍摄中标记、开拍），标记与快照条目因此都落在会话存储关闭之前
  closers?: Array<() => Promise<void>>;
  // 推送记忆开着时在场（worker 按它继承）
  learnedMemory?: LearnedMemoryConfig;
  // 决策 330：人写的说明超出 32 KiB 被截断时给终端的一行提示（入口打出）；没截断时缺省
  instructionsNotice?: string;
  // 决策 359：开局没注册 web_search 的原因，或 /reload 时搜索后端改了要重启才生效（入口在终端提示一行）
  toolsNotice?: string;
  // 决策 294 B1：任务清单开着时在场（续聊时从会话还原、/tasks 查看）
  taskList?: TaskList;
  // 决策 340：本运行面装配时用的开局冻结内容（/reload 重建时交给新运行面）
  frozenPrompt: FrozenSessionPrompt;
  // 决策 362：本运行面所用的模型信息（逐项带来源）与缓存规则
  modelInfo: ResolvedModelInfo;
  // 决策 367：本运行面实际生效的撞上限续跑与流式重复检测设定（worker 按它继承）
  truncationContinuation: TruncationContinuationSettings;
  repetitionGuard: RepetitionGuardSettings;
  // 决策 363：状态变化通道（续跑时从会话记录还原，/reload 时把最后发出的一份交给新运行面）
  status: StatusTracker;
  // 决策 361：上下文裁剪（/reload 时把已有的裁剪交给新运行面）
  prune: ContextPruner;
}

// 决策 355：工作区以外的读取按审批状态放行——放手模式自动放行、有审批通道经人批准、无人值守拒绝
const OUTSIDE_READ_MODES: Readonly<Record<RunCommandApproval, OutsideReadMode>> = {
  yolo: "allowed",
  prompt: "approval",
  none: "refused",
};

// start/resume 共用的运行时装配：注册内置工具 + 构造适配器与会话存储写者
export function buildRuntime(deps: RuntimeDeps): RuntimeBundle {
  // 决策 061：编辑工具按模式装配，工具名都叫 edit_file；hashline 分支与 061 之前逐字一致
  const replaceMode = (deps.editMode ?? DEFAULT_EDIT_MODE) === "replace";
  const maxOutputTokens = deps.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
  ) {
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
  const governanceRoot = deps.governanceRoot ?? deps.workspaceRoot;
  const workspaceHost = deps.workspaceHost ?? createLocalWorkspaceHost(deps.workspaceRoot);
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
  const sessionsDir = sessionsDirOf(governanceRoot);
  // 决策 325：设置快照（会话开始时已读好、校验过）；放权规则取三层并集
  const settings = deps.settings ?? emptySettingsSnapshot(governanceRoot);
  // 决策 362：本次所用的模型信息（身份取接入模块的声明，没有则取启动参数的标签）
  const access = modelAccessOf(deps.streamFn);
  const modelSection = modelInfoSectionOf(settings);
  const modelInfo = resolveModelInfo({
    launch: { provider: deps.provider, id: deps.modelId },
    ...(access?.declared !== undefined ? { declared: access.declared } : {}),
    ...(access?.catalog !== undefined ? { catalog: access.catalog } : {}),
    ...(modelSection !== undefined ? { section: modelSection } : {}),
  });
  // 决策 390：本运行面的推理档位——启动参数 > 设置 > 按模型信息的缺省（支持推理的 high，其余 off）
  const thinkingLevel = resolveThinkingLevel({
    requested: deps.thinkingLevel,
    section: thinkingSectionOf(settings),
    reasoning: modelInfo.reasoning.source === "unknown" ? undefined : modelInfo.reasoning.value,
  });
  // 推理开启时温度不生效：pi-ai 的 anthropic-messages 线路开思考时不发 temperature，DeepSeek 文档也写明思考模式下
  // 温度设了不报错但不生效。请求值如实记成"未生效"，也不再往下传；关思考（off）时温度照常下发
  const appliedTemperature = thinkingLevel !== "off" ? undefined : deps.temperature;
  const continuation = deps.truncationContinuation ?? truncationContinuationOf(settings);
  const repetition = deps.repetitionGuard ?? repetitionGuardOf(settings);
  // 决策 356–358：本会话的命令输出落盘目录与读取记录（read_file、编辑与 write_file 共用），两个工具的上限取设置的 tools 一节
  const outputLimits = runCommandOutputLimitsOf(settings);
  // 虚拟路径带会话号：本会话之外只认分叉来源一路往上（来源取自会话存储，续接的分支会话同样认得；见 output-ancestors.ts）
  const forkSource = deps.storeLineage?.branch?.sourceSessionId;
  const outputStore =
    deps.reloadJobs?.store ??
    new CommandOutputStore({
      base: governanceRoot,
      outputsRoot: outputsRootOf(governanceRoot),
      sessionId: deps.sessionId,
      maxBytes: outputLimits.savedOutputsMaxBytes,
      ancestors: () => outputAncestors(sessionsDir, deps.sessionId, forkSource),
    });
  // 决策 365：单次超时与后台作业（每会话一份作业表，整次运行共用一个作业池；/reload 接着用旧运行面的）
  const commandTimeouts = runCommandTimeoutsOf(settings);
  const jobLimits = backgroundJobLimitsOf(settings);
  const jobs =
    deps.reloadJobs ??
    new SessionJobs({
      sessionId: deps.sessionId,
      host: workspaceHost,
      store: outputStore,
      pool: jobPoolFor(jobsDirOf(governanceRoot), jobLimits.total),
      perSession: jobLimits.perSession,
      outputMaxBytes: jobLimits.outputMaxBytes,
      ...(deps.previousJobs !== undefined ? { firstId: deps.previousJobs.lastId } : {}),
    });
  // 崩溃后下次启动：按记录清理上一进程留下的作业（后台进行，每个进程一次）
  void cleanupOrphanedJobsOnce(governanceRoot, deps.storeWarn, workspaceHost.dockerPrefix);
  const reads = new FileReadTracker();
  const readOptions = { limits: readFileLimitsOf(settings), outputs: outputStore, reads };
  // 决策 361：缓存感知的上下文裁剪——价格比与保留时长取本次的模型信息；裁掉的命令输出补落盘，裁掉的读取不再算读过
  const prune = new ContextPruner(
    contextPruneSettings(contextPruneSectionOf(settings), modelProfile(modelInfo)),
    {
      saveOutput: (text) => outputStore.save(Buffer.from(text, "utf8")),
      forgetRead: (resolvedPath) => reads.forget(resolvedPath),
    },
    deps.pruneSeed
  );
  const configGrants = deps.configGrants ?? configGrantRulesOf(settings);
  if (deps.workspaceHost !== undefined) {
    const scoped = configGrants.filter((rule) => rule.pathPrefix !== undefined);
    if (scoped.length > 0) {
      throw new Error(
        `容器工作区暂不支持按路径限定的放权规则：${scoped.map((rule) => `${rule.tool}（${rule.pathPrefix}）`).join("、")}——` +
          "它们以宿主路径判定，在容器工作区下只会静默失配；请移除这些规则或改用本地工作区"
      );
    }
  }
  // M5.5 S5（决策 048）：可选的命令短名与角色允许清单（取自设置快照的 commands 一节）；
  // 决策 360：为该角色登记了才限定，没登记的不限（tester 缺省即可跑命令，与主会话同一审批规则）
  const commandsConfig = commandsConfigOf(settings);
  const roleAllowlist =
    deps.commandRole !== undefined ? commandsConfig.roles[deps.commandRole] : undefined;
  // 会话存储写者在配置校验之后打开（装配早期抛错时不留下空的会话文件）
  const sessionStore = openSessionStore({
    sessionsDir,
    sessionId: deps.sessionId,
    cwd: deps.workspaceRoot,
    ...(deps.storeLineage !== undefined ? { lineage: deps.storeLineage } : {}),
    onFault: storeFaultWarner(deps.storeWarn),
    persistThinking: deps.persistThinking ?? true,
  });
  // 170 ④：本会话的审批状态——委派策略在场时取其审批模式，否则取 yolo 旗标；非 yolo 时看有没有注入审批通道。
  // run_command 的三处说明与系统提示里的审批说法都按它与执行端的平台生成，不写死本地、人工批准的说法；
  // 钩子 JSON 的 permission_mode 也用它（324）
  const approvalMode = deps.toolPolicy?.approvalMode ?? (deps.yolo ? "yolo" : "prompt");
  // 最近一个已收尾的 Run：收尾类钩子（Stop / StopFailure / SubagentStop、自动压缩的 PostCompact）在 Run 窗口外触发，
  // 记录挂到刚结束的那个 Run；其余 Run 之外的钩子（下一条消息的 UserPromptSubmit、手动压缩、Notification、
  // SessionEnd 等）按会话级记录，不挂上一个 Run
  let lastEndedRunId: RunId | undefined;
  // 决策 323 / 324 / 326 ②：会话级钩子——清单随设置快照冻结；执行位置按执行端（本机/容器，host:true 的在宿主）；
  // 运行记录写进本会话（pigeon.hook 条目）；拦下或出错经 hooksNotice 给一行提示
  const sessionHooks = new SessionHooks({
    sessionId: deps.sessionId,
    governanceRoot,
    workspaceRoot: deps.workspaceRoot,
    platform: workspaceHost.platform,
    hooks: settings.hooks,
    disableAllHooks: settings.merged.disableAllHooks,
    sink: sessionStore,
    // 记录挂活动 Run（adapter 在下方创建；钩子只在运行期触发，届时 adapter 已就位）；
    // Run 窗口外只有收尾类钩子挂刚结束的 Run（run.ended 时记下，见下方订阅）
    activeRunId: (event, matcherTarget): RunId | undefined =>
      adapter.currentRunId() ??
      (RUN_TAIL_HOOK_EVENTS.has(event) || (event === "PostCompact" && matcherTarget === "auto")
        ? lastEndedRunId
        : undefined),
    ...(deps.hooksNotice !== undefined ? { notice: deps.hooksNotice } : {}),
    ...(deps.workspaceHost !== undefined ? { workspaceHost: deps.workspaceHost } : {}),
    permissionMode: approvalMode,
  });
  // PreToolUse 钩子的 additionalContext 随工具结果交给模型：按 toolCallId 暂存，afterToolCall 时一并追加
  const preToolContexts = new Map<string, string[]>();
  // 决策 3b：会话 grant 运行态——续跑时以会话存储里生效的授权为种子（建立减撤销）
  const grantStore = new SessionGrantStore({
    workspaceRoot: deps.workspaceRoot,
    sink: grantEventSink(sessionStore),
    restored: deps.restoredGrants,
    // 执行端另一侧的工作区不建目录限定的放权
    pathScoped: deps.workspaceHost === undefined,
  });
  const approval: RunCommandApproval =
    approvalMode === "yolo" ? "yolo" : deps.createApprovalHandler !== undefined ? "prompt" : "none";
  const commandTexts = runCommandTexts({ platform: workspaceHost.platform, approval });
  // 决策 407：放权时写工具接受工作区以外的路径（与放权下 shell 的能力一致）；未放权时照旧只写工作区
  const writeOptions = { outsideWrites: approval === "yolo" };
  // 决策 368：grep、glob 的上限；本机执行端先用随包附带的 ripgrep，容器里用容器自己的
  const searchLimits = searchLimitsOf(settings);
  const searchOptions = { bundledRipgrep: deps.workspaceHost === undefined };
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
  // 决策 358：新建或整体覆盖文件，与 edit_file 同为写档、工作区围栏（受保护路径与写档审批随之生效）
  registry.register({
    name: WRITE_FILE_TOOL,
    description: "新建或整体覆盖文件",
    parameters: WriteFileParamsSchema,
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
  // 决策 365：后台作业的两件工具——只看、只停本会话的作业，按读档登记（免审批）；job_output 可并行，job_kill 串行
  if (jobs.available) {
    registry.register({
      name: JOB_OUTPUT_TOOL,
      description: JOB_OUTPUT_DESCRIPTION,
      parameters: JobOutputParamsSchema,
      tier: "read",
      pathConfinement: { kind: "none" },
      executionMode: "parallel",
    });
    registry.register({
      name: JOB_KILL_TOOL,
      description: JOB_KILL_DESCRIPTION,
      parameters: JobKillParamsSchema,
      tier: "read",
      pathConfinement: { kind: "none" },
      executionMode: "sequential",
    });
  }
  // 决策 368：grep、glob——只读工具（读档审批、可并行），登记点见 tools/search-tools.ts
  for (const registration of searchToolRegistrations()) {
    registry.register(registration);
  }
  // 决策 339：检索与目录排除当前会话所在的整棵会话树（父会话取本会话的来历：worker 的派出方、分支的来源）
  const lineageParent =
    deps.storeLineage?.worker?.parentSessionId ?? deps.storeLineage?.branch?.sourceSessionId;
  const current = {
    sessionId: deps.sessionId,
    ...(lineageParent !== undefined ? { parentSessionId: lineageParent } : {}),
  };
  // 决策 359：按环境只注册用得上的工具——会话开始时查一次（/reload 沿用开局的结果），没注册的连同原因记进 Run 开始条目
  const environment = toolEnvironmentProbe({
    ...(deps.frozenPrompt?.toolEnvironment !== undefined
      ? { frozen: deps.frozenPrompt.toolEnvironment }
      : {}),
    workspaceRoot: deps.workspaceRoot,
    governanceRoot,
    sessionsDir,
    current,
    searchBackend: deps.webTools?.search.backend !== undefined,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });
  const skippedTools: SkippedTools[] = [];
  const skip = (tools: string[], reason: string): false => {
    skippedTools.push({ tools, reason });
    return false;
  };
  // M5 S2（决策 038）：Session Search 的 read 档工具（决策 339 加会话目录，共三件），范围只限本项目会话目录；
  // 决策 193 的开关关掉时一件都不注册；决策 382：使用者开关（设置 sessionSearch.enabled 或 --no-session-search，
  // 由入口并入 deps.sessionSearch 并给原因）关掉时同样不注册，原因写进开局记录；
  // 决策 359：本会话所在的会话树以外没有会话（搜不到东西）时也不注册
  const sessionSearchTools = [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, LIST_SESSIONS_TOOL];
  const sessionSearchOffReason =
    deps.sessionSearch === false
      ? deps.sessionSearchOffReason
      : sessionSearchEnabledOf(settings) === false
        ? "设置 sessionSearch.enabled 为 false（使用者关掉了会话检索）"
        : undefined;
  const sessionSearch =
    sessionSearchOffReason !== undefined
      ? skip(sessionSearchTools, sessionSearchOffReason)
      : deps.sessionSearch !== false &&
        (environment.check("sessionHistory") || skip(sessionSearchTools, "本项目没有历史会话"));
  // 可搜文本缓存在 .pigeon/state/search-cache/
  const sessionToolOptions = {
    sessionsDir,
    cacheDir: sessionSearchCacheDirOf(governanceRoot),
    current: {
      sessionId: deps.sessionId,
      ...(lineageParent !== undefined ? { parentSessionId: lineageParent } : {}),
    },
  };
  if (sessionSearch) {
    for (const registration of sessionToolRegistrations(sessionsDir)) {
      registry.register(registration);
    }
  }
  // 决策 331：只有带写入配置的主会话注册记忆工具（写档、只写两层记忆文件、免审批）；worker 只推送
  const memoryLimits = learned?.limits ?? memoryLimitsOf(settings);
  const memoryWrite =
    learned?.write !== undefined && deps.toolPolicy === undefined ? learned.write : undefined;
  if (memoryWrite !== undefined) {
    registry.register(
      updateMemoryRegistration({
        governanceRoot,
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      })
    );
  }
  // 决策 264–267：派 worker 的工具——只给主会话；沙箱（执行端在场）不注册。worker 自己（委派策略在场）只在层数放开、
  // 它还没到最底层时由装配方给一个本层的槽（299：槽的派出方所在层大于 0），此时不给 take_worker（叠加只往主工作目录）
  const nestedSlot =
    deps.spawnWorker !== undefined && deps.spawnWorker.settings.depth > 0
      ? deps.spawnWorker
      : undefined;
  const spawnCandidate =
    deps.workspaceHost === undefined
      ? deps.toolPolicy === undefined
        ? deps.spawnWorker
        : nestedSlot
      : undefined;
  // 决策 359：工作区不是 git 仓库时整组不注册
  const spawnSlot =
    spawnCandidate !== undefined &&
    (environment.check("gitWorkspace") ||
      skip(
        [
          SPAWN_WORKER_TOOL,
          WAIT_WORKERS_TOOL,
          WORKER_STATUS_TOOL,
          MESSAGE_WORKER_TOOL,
          STOP_WORKER_TOOL,
          ...(nestedSlot === undefined ? [TAKE_WORKER_TOOL] : []),
        ],
        "工作区不是 git 仓库"
      ))
      ? spawnCandidate
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
  // 决策 309：提交编排脚本的工具——只给主会话；worker 与沙箱不注册。决策 359：脚本派的 worker 要 git 工作区、脚本跑在
  // docker 里，两样缺一即不注册
  const scriptCandidate =
    deps.workspaceHost === undefined && deps.toolPolicy === undefined
      ? deps.scriptOrchestration
      : undefined;
  const scriptSlot =
    scriptCandidate !== undefined &&
    (environment.check("gitWorkspace") || skip([ORCHESTRATE_TOOL], "工作区不是 git 仓库")) &&
    (environment.check("dockerOnPath") ||
      skip([ORCHESTRATE_TOOL], "PATH 里找不到 docker 可执行文件"))
      ? scriptCandidate
      : undefined;
  if (scriptSlot !== undefined) {
    registry.register(orchestrateRegistration());
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
  // 决策 359：没有可用的搜索后端（缺 key）不注册 web_search，web_fetch 照常；/reload 沿用开局的决定
  const searchReason = webTools?.search.unavailable ?? "没有可用的搜索后端";
  const webSearch =
    webTools !== undefined &&
    (environment.check("webSearch") || skip([WEB_SEARCH_TOOL], searchReason));
  // 开局没注册 web_search 时在终端提示一行；/reload 时搜索后端变了只提示重启后生效（本会话的工具清单不变）
  const toolsNotice =
    webTools === undefined
      ? undefined
      : deps.frozenPrompt === undefined
        ? webSearch
          ? undefined
          : `web_search 没有注册：${searchReason}（改好后重启 Pigeon 生效）`
        : webSearch !== (webTools.search.backend !== undefined)
          ? "搜索后端的改动在重启 Pigeon 后生效，本会话的工具清单不变"
          : undefined;
  if (webTools !== undefined) {
    if (webSearch) {
      registry.register(webSearchRegistration());
    }
    registry.register(webFetchRegistration());
  }
  // 决策 330：会话开始读人写的说明（AGENTS.md），清单进注入快照（开局的身份）。本地工作区从工作区根往上读（worker 即它自己的
  // 工作树）；沙箱读宿主上的工作区（治理根），与本机会话内容一致。决策 363 起说明本身进开工状态块，会话中改动时整段追加
  // （见下方状态变化通道）；这里开局读的一份只用于清单与超长提示。/reload 重建运行面时沿用开局读的这份
  const frozen = deps.frozenPrompt;
  const instructions =
    deps.agentsMd === false
      ? { section: "", manifest: [] }
      : (frozen?.instructions ??
        loadAgentsInstructions({
          workspaceRoot: deps.workspaceHost === undefined ? deps.workspaceRoot : governanceRoot,
          ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
        }));
  // 决策 191、332：会话开始读两层学到的记忆，清单进 Run 开始条目；决策 363 起推送段进开工状态块，会话中被改动时整段追加
  const pushedMemory =
    learned !== undefined
      ? (frozen?.pushedMemory ??
        loadPushedMemory({
          governanceRoot,
          ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
          limits: memoryLimits,
          writable: memoryWrite !== undefined,
          ...(learned.layers !== undefined ? { layers: learned.layers } : {}),
        }))
      : undefined;
  // 决策 360：worker（委派策略在场）的提示只介绍它有的工具，并交代作用范围；主会话的工具一律在场，提示不变
  const delegatedAllow = deps.toolPolicy?.allow;
  const offered = (...names: string[]): boolean =>
    delegatedAllow === undefined || names.every((name) => delegatedAllow.includes(name));
  // 决策 363：系统提示只留固定底座（工具的介绍）——审批与联网的说法随 /reload 会变，搬进开工状态块（见下方「审批」「联网」两节）
  const basePrompt =
    fileToolsSentence(replaceMode, offered("read_file"), offered("edit_file")) +
    PARALLEL_READS_SENTENCE +
    (offered("edit_file") ? TRUNCATION_GUIDANCE : "") +
    (offered(RUN_COMMAND_TOOL) ? commandTexts.prompt : "") +
    (sessionSearch && offered(SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, LIST_SESSIONS_TOOL)
      ? "需要以前会话里的信息时，可用 list_sessions 浏览本项目以前的会话，用 search_sessions 按关键词检索以前会话里的对话，" +
        "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。"
      : "") +
    scopePromptSentence(deps.toolPolicy?.scopes ?? []);
  // M5 S4（决策 043）：会话开始登记 Skill Catalog——决策 363 起目录段进开工状态块（会话中增删改时重新登记、整段追加），
  // 哈希清单进快照；有 Skill 才注册并广告 load_skill（无 Skill 时不占工具广告）
  // 本地 Skill 开局扫描一次（/reload 沿用）；MCP server 的 prompts 随本运行面的 MCP 会话
  const localSkills =
    frozen?.localSkills ??
    scanLocalSkills({
      workspaceRoot: governanceRoot,
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.skillRoots !== undefined ? { roots: deps.skillRoots } : {}),
    });
  const skillCatalog = loadSkillCatalog({
    workspaceRoot: governanceRoot,
    local: localSkills,
    // M5.7 S4（043 口径）：MCP server 的 prompts 以 server 为来源进同一目录
    ...(deps.mcp !== undefined && deps.mcp.prompts.length > 0 ? { prompts: deps.mcp.prompts } : {}),
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
    WRITE_FILE_TOOL,
    RUN_COMMAND_TOOL,
    ...(jobs.available ? [JOB_OUTPUT_TOOL, JOB_KILL_TOOL] : []),
    ...READ_ONLY_SEARCH_TOOLS,
    ...(sessionSearch ? [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, LIST_SESSIONS_TOOL] : []),
    ...(memoryWrite !== undefined ? [UPDATE_MEMORY_TOOL] : []),
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
    ...(scriptSlot !== undefined ? [ORCHESTRATE_TOOL] : []),
    ...(taskList !== undefined ? [UPDATE_TASKS_TOOL, LIST_TASKS_TOOL] : []),
    ...(webTools !== undefined ? [...(webSearch ? [WEB_SEARCH_TOOL] : []), WEB_FETCH_TOOL] : []),
  ];
  // 决策 360：worker 只在给了某件外部工具时才说外部工具
  const mcpSection = mcpTools.some((bridged) => offered(bridged.name))
    ? "## 外部工具\n以 mcp__<server>__ 开头的工具来自外部 MCP server，与内置工具同样受审批与留证；" +
      "server 不可用时这些工具会报错，改用内置工具继续。"
    : "";
  // 决策 363：系统提示 = 固定底座 + 任务指令 + 权威层级说明；续跑沿用会话记录里的、/reload 沿用旧运行面的，逐字节不变。
  // 人写的说明、推送的记忆、Skill 目录与外部工具的说明进开工状态块（见下方状态变化通道）
  const systemPrompt =
    deps.systemPrompt ??
    frozen?.systemPrompt ??
    [basePrompt, deps.taskDirective ?? "", STATUS_AUTHORITY_SENTENCE]
      .filter((section) => section !== "")
      .join("\n\n");
  // 决策 363、354：开工状态块的各节。文件类各节（项目说明、Skill 目录、记忆）、环境与 git 状态在 Run 开始与写档、命令档工具之后
  // 重取，其余（外部工具、审批、联网在本运行面内不变；日期）每次都看
  const statusProbe =
    deps.workspaceHost !== undefined
      ? hostStatusProbe(deps.workspaceHost)
      : localStatusProbe(deps.workspaceRoot);
  // 「审批」一节：写操作与 run_command 的审批说法（随审批模式变）；决策 360：worker 只说它有的工具
  const approvalSection = [
    ...(offered("edit_file") || offered(WRITE_FILE_TOOL)
      ? [WRITE_APPROVAL_SENTENCES[approval]]
      : []),
    ...(offered(RUN_COMMAND_TOOL) ? [commandTexts.approval] : []),
  ].join("\n");
  // 「联网」一节：决策 359 没注册 web_search 时只说 web_fetch；决策 360 worker 只说它有的
  const webSection =
    webTools !== undefined && offered(WEB_FETCH_TOOL)
      ? webSearch && offered(WEB_SEARCH_TOOL)
        ? WEB_TOOLS_SENTENCE
        : WEB_FETCH_SENTENCE
      : "";
  const memorySection = (): string =>
    learned !== undefined
      ? loadPushedMemory({
          governanceRoot,
          ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
          limits: memoryLimits,
          writable: memoryWrite !== undefined,
          ...(learned.layers !== undefined ? { layers: learned.layers } : {}),
        }).section
      : "";
  // Skill 根的变动指纹：每次请求之前比一次（只 stat），变了才重取文件类各节、重新登记（load_skill 拒绝时说的"下一次请求之前
  // 会重新登记"即靠它）
  let skillPrint: string | undefined;
  const readSlowSections = async (): Promise<Map<StatusSectionName, string>> => {
    skillPrint = skillTreeFingerprint(localSkills.roots);
    const [git, entries] = await Promise.all([statusProbe.gitState(), statusProbe.rootEntries()]);
    const agents =
      deps.agentsMd === false
        ? ""
        : loadAgentsInstructions({
            workspaceRoot: deps.workspaceHost === undefined ? deps.workspaceRoot : governanceRoot,
            ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
          }).section;
    // Skill 增删改：重新登记；开局注册了 load_skill 时它随即按新目录读取（解除改动前的哈希拒绝）
    const rescanned = loadSkillCatalog({
      workspaceRoot: governanceRoot,
      local: scanLocalSkills({
        workspaceRoot: governanceRoot,
        ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
        ...(deps.skillRoots !== undefined ? { roots: deps.skillRoots } : {}),
      }),
      ...(deps.mcp !== undefined && deps.mcp.prompts.length > 0
        ? { prompts: deps.mcp.prompts }
        : {}),
    });
    if (hasSkills) {
      skillCatalog.skills = rescanned.skills;
    }
    // 决策 360：worker 没给 load_skill 时不说 Skill 目录
    const skills = offered(LOAD_SKILL_TOOL)
      ? rescanned.section === "" || hasSkills
        ? rescanned.section
        : `${rescanned.section}\n${NO_LOAD_SKILL_SENTENCE}`
      : "";
    const memory = memorySection();
    return new Map<StatusSectionName, string>([
      ["项目说明", agents],
      ["Skill 目录", skills],
      [
        "环境",
        environmentText({
          root: deps.workspaceHost?.root ?? deps.workspaceRoot,
          platform: workspaceHost.platform,
          remote: deps.workspaceHost !== undefined,
          entries,
          ...(deps.statusFacts !== undefined ? { facts: deps.statusFacts } : {}),
        }),
      ],
      ["记忆", memory],
      ["git 状态", gitText(git)],
    ]);
  };
  let slowSections: Map<StatusSectionName, string> | undefined;
  const currentStatus = async (refresh: boolean): Promise<StatusState> => {
    if (refresh || slowSections === undefined) {
      slowSections = await readSlowSections();
    }
    const state = new Map<StatusSectionName, string>([
      ...slowSections,
      ["外部工具", mcpSection],
      ["审批", approvalSection],
      ["联网", webSection],
      ["日期", dateText(new Date())],
    ]);
    for (const [name, text] of state) {
      if (text === "") {
        state.delete(name);
      }
    }
    return state;
  };
  // 状态变化通道：首次与压缩之后给完整块，其余只给变了的节；起点见 statusSent。沿用的是旧会话的系统提示（没有权威层级
  // 说明，还带"开局冻结"的旧说法）时，首次的完整块开头另加一句以本状态块为准
  const statusTracker = new StatusTracker(deps.statusSent, {
    legacyNote: !systemPrompt.includes(STATUS_AUTHORITY_SENTENCE),
  });
  // 每次发出（状态消息进了会话记录）与记成已发都把当时的各节哈希记进会话记录，续跑与分叉从记录取
  const recordStatus = (hashes: StatusHashes | undefined) => {
    if (hashes !== undefined) {
      sessionStore.append(statusEntry(hashes));
    }
  };
  let statusTouched = false;
  const statusChannel: StatusChannel = {
    beforeRun: async ({ compacted }) => {
      statusTouched = false;
      return statusTracker.next(await currentStatus(true), compacted);
    },
    betweenTurns: async ({ compacted }) => {
      const refresh = statusTouched || skillTreeFingerprint(localSkills.roots) !== skillPrint;
      statusTouched = false;
      return statusTracker.next(await currentStatus(refresh), compacted);
    },
    delivered: () => recordStatus(statusTracker.delivered()),
  };
  const delegated = deps.toolPolicy;
  const policy: ToolPolicy =
    delegated !== undefined
      ? {
          allow: toolNames.filter((name) => delegated.allow.includes(name)),
          deny: [...delegated.deny],
          approvalMode: delegated.approvalMode,
        }
      : { allow: toolNames, deny: [], approvalMode: deps.yolo ? "yolo" : "prompt" };
  const governedRegistry =
    delegated !== undefined ? registrySubset(registry, policy.allow) : registry;
  // Run 开始条目的附加摘要：MCP 工具集与 server 状态（有 server 时）
  const mcpSummary = mcp !== undefined && mcp.connections.length > 0 ? mcp : undefined;
  // 决策 359：按环境没注册的工具与原因（有才带）
  const runStartedExtras =
    mcpSummary !== undefined || skippedTools.length > 0
      ? () => ({
          ...(mcpSummary !== undefined ? mcpSummary.summary() : {}),
          ...(skippedTools.length > 0 ? { skippedTools: structuredClone(skippedTools) } : {}),
        })
      : undefined;
  // 决策 188：压缩服务。摘要请求与主请求同一个模型接入，只套温度（摘要从不请求推理，温度总能生效）；
  // 不套单轮输出上限包装——它会盖掉上游给摘要定的输出上限（0.8 倍预留与模型输出上限的较小者）。
  // 模型对象只是占位身份（真实模型元数据在模型接入插件里），带上输出上限与窗口供上游定摘要请求的选项
  // 决策 323 / 324：PreCompact 钩子——压缩之前通知（只通知、不能拦：拦下压缩会使下一次请求超长出错）。
  // matcher 匹配触发位置：turn / run-start 记 auto，手动压缩记 manual（331：压缩前复盘已删除，回调只剩调用方的）
  const hooksBeforeCompaction: BeforeCompaction | undefined = sessionHooks
    .list()
    .some((hook) => hook.event === "PreCompact")
    ? async (info) => {
        const trigger = info.trigger === "manual" ? "manual" : "auto";
        await sessionHooks.runEvent("PreCompact", trigger, {
          trigger,
          custom_instructions: info.customInstructions ?? null,
        });
        await deps.beforeCompaction?.(info);
      }
    : deps.beforeCompaction;
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
    // 未配置输出上限时为 0（占位不知道真实模型的上限；压缩摘要的输出上限此时只按预留量取）
    maxTokens: maxOutputTokens ?? 0,
  };
  const compactor = new ContextCompactor({
    config: compactionConfig,
    streamFn:
      deps.temperature !== undefined
        ? fixTemperature(deps.streamFn, deps.temperature)
        : deps.streamFn,
    model: placeholderModel,
    ...(hooksBeforeCompaction !== undefined ? { beforeCompaction: hooksBeforeCompaction } : {}),
  });
  // 决策 289：提炼器——本会话同一个模型接入，温度 0，不带工具，有输出上限；不套单轮输出上限与温度的包装，选项直接给
  const webToolset =
    webTools !== undefined
      ? [
          ...(webSearch ? [createWebSearchTool(webTools.search)] : []),
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
        thinkingLevel,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
      memory: instructions.manifest,
      skills: skillCatalog.manifest,
      createdAt: Date.now(),
      ...(pushedMemory !== undefined
        ? { pushedMemory: structuredClone(pushedMemory.manifest) }
        : {}),
      ...(deps.budget !== undefined ? { budget: { ...deps.budget } } : {}),
    },
    // 决策 063、347：配置了单轮输出上限才在装配层包装 streamFn 传入，上游与 provider 插件不改
    streamFn: withOutputLimit(
      appliedTemperature !== undefined
        ? fixTemperature(deps.streamFn, appliedTemperature)
        : deps.streamFn,
      maxOutputTokens
    ),
    tools: [
      createReadFileTool(workspaceHost, {
        ...(replaceMode ? { editMode: "replace" as const } : {}),
        outsideReads: OUTSIDE_READ_MODES[approval],
        ...readOptions,
      }),
      replaceMode
        ? createReplaceEditTool(workspaceHost, reads, writeOptions)
        : createEditFileTool(workspaceHost, reads, writeOptions),
      createWriteFileTool(workspaceHost, reads, writeOptions),
      createRunCommandTool({
        workspaceRoot: deps.workspaceRoot,
        host: workspaceHost,
        approval,
        output: {
          headBytes: outputLimits.headBytes,
          tailBytes: outputLimits.tailBytes,
          store: outputStore,
        },
        commands: commandsConfig.commands,
        ...(roleAllowlist !== undefined ? { allowlist: roleAllowlist } : {}),
        // 决策 360：带命令前缀范围时程序只按 PATH 解析
        ...(delegated?.scopes?.some((scope) => scope.tool === RUN_COMMAND_TOOL) === true
          ? { pathOnly: true }
          : {}),
        // 决策 365：单次超时的缺省与上限、后台作业
        timeoutMs: commandTimeouts.defaultSeconds * 1000,
        maxTimeoutMs: commandTimeouts.maxSeconds * 1000,
        jobs,
      }),
      ...(jobs.available ? [createJobOutputTool(jobs), createJobKillTool(jobs)] : []),
      ...createSearchTools(workspaceHost, {
        // 决策 408：超过字数预算的 grep 全文存进本会话的落盘目录（与 run_command 同一处）
        grep: { ...searchOptions, maxResults: searchLimits.grepMaxResults, outputs: outputStore },
        glob: { ...searchOptions, maxResults: searchLimits.globMaxResults },
      }),
      ...(sessionSearch
        ? [
            createSearchSessionsTool(sessionToolOptions),
            createReadSessionEntryTool(sessionToolOptions),
            createListSessionsTool(sessionToolOptions),
          ]
        : []),
      ...(memoryWrite !== undefined
        ? [
            createUpdateMemoryTool({
              governanceRoot,
              ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
              sessionId: deps.sessionId,
              source: memoryWrite.source,
              limits: memoryLimits,
              ...(memoryWrite.onWritten !== undefined ? { onWritten: memoryWrite.onWritten } : {}),
              ...(memoryWrite.now !== undefined ? { now: memoryWrite.now } : {}),
            }),
          ]
        : []),
      ...(hasSkills ? [createLoadSkillTool({ catalog: skillCatalog })] : []),
      ...mcpTools.map((bridged) => bridged.tool),
      ...(spawnSlot !== undefined
        ? [createSpawnWorkerTool(spawnSlot, policy.allow), ...createOrchestrationTools(spawnSlot)]
        : []),
      ...(takeSlot !== undefined ? [createTakeWorkerTool(takeSlot)] : []),
      ...(scriptSlot !== undefined ? [createOrchestrateTool(scriptSlot)] : []),
      ...(taskList !== undefined ? createTaskListTools(taskList) : []),
      ...webToolset,
    ],
    // M5.5 S0（决策 049）：装配根组装工具调用治理后注入 Adapter
    governance: createToolGovernance({
      registry: governedRegistry,
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
      // 决策 360：worker 各工具的作用范围
      ...(delegated?.scopes !== undefined ? { scopes: delegated.scopes } : {}),
      // 决策 324：PreToolUse 钩子——在审批之前执行；拒绝 > 要人确认 > 放行；放行只免人工审批这一步，
      // 改过的参数重新经过全部检查（交付给执行侧替换）
      preToolUseHooks: async (input) => {
        const report = await sessionHooks.runEvent("PreToolUse", input.toolName, {
          tool_name: input.toolName,
          tool_input: input.args,
          tool_use_id: input.toolCallId,
        });
        if (report.additionalContext.length > 0) {
          preToolContexts.set(input.toolCallId, [...report.additionalContext]);
        }
        // 决策 324：continue:false 压过 decision——停止本轮处理：阻断本调用并在这批工具后停下
        if (report.continueFalse !== undefined) {
          return {
            decision: "deny",
            terminate: true,
            reason:
              report.blocked?.reason ?? report.continueFalse.stopReason ?? "钩子要求停止本轮处理",
          };
        }
        if (report.blocked !== undefined) {
          return { decision: "deny", reason: report.blocked.reason };
        }
        // updatedInput 不带放行含义：只换参数；结论只看 blocked / ask / allow
        const updated =
          report.updatedInput !== undefined ? { updatedInput: report.updatedInput } : {};
        if (report.ask !== undefined) {
          return {
            decision: "ask",
            ...(report.ask.reason !== undefined ? { reason: report.ask.reason } : {}),
            ...updated,
          };
        }
        if (report.allow === true) {
          return { decision: "allow", ...updated };
        }
        if (report.updatedInput !== undefined) {
          return { ...updated };
        }
        return undefined;
      },
      // 决策 326 ①：项目的 .pigeon 为受保护路径（本地工作区按宿主上的真实路径判定，容器工作区经执行端在容器里判定）
      protectedPath:
        deps.workspaceHost !== undefined
          ? createHostProtectedPathResolver(deps.workspaceHost)
          : createProtectedPathResolver({
              workspaceRoot: deps.workspaceRoot,
              governanceRoot,
              realPaths: true,
            }),
    }),
    sessionId: deps.sessionId,
    sessionStore,
    compaction: compactor,
    // 决策 363：开工状态块与状态变化通道
    status: statusChannel,
    prune,
    // M5.7 S3（决策 052）：每个 Run 开始时把 MCP 工具集摘要与 server 当前状态写进 Run 开始条目；无 server 时不带字段
    ...(runStartedExtras !== undefined ? { runStartedExtras } : {}),
    modelInfo: runModelInfoRecord(modelInfo),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    // 决策 353：读类工具并行、其余串行（登记在 tool-execution-modes.ts），各环境同一规则
    executionModeOf: toolExecutionModeOf,
    // 决策 367：撞上限续跑与流式重复检测（关掉的不传）
    ...(continuation.enabled ? { truncationContinuation: continuation } : {}),
    ...(repetition.enabled ? { repetitionGuard: repetition } : {}),
    // 决策 324：工具结束后的钩子（PostToolUse / PostToolUseFailure）——替换结果文本或把理由与上下文补进结果
    toolHooks: {
      toolFinished: async (input) => {
        const event = input.isError ? "PostToolUseFailure" : "PostToolUse";
        const report = await sessionHooks.runEvent(event, input.toolName, {
          tool_name: input.toolName,
          tool_input: input.args,
          tool_use_id: input.toolCallId,
          ...(input.isError ? { error: input.text } : { tool_response: input.text }),
        });
        const contexts = [
          ...(preToolContexts.get(input.toolCallId) ?? []),
          ...report.additionalContext,
        ];
        preToolContexts.delete(input.toolCallId);
        // PostToolUse 的 decision:"block" 把理由交给模型（追加在工具结果之后）
        const reasons = report.runs
          .filter((run) => run.decisionBlock === true && run.reason !== undefined)
          .map((run) => run.reason as string);
        const appended = [...contexts, ...reasons];
        const replaceText =
          typeof report.updatedToolOutput === "string" ? report.updatedToolOutput : undefined;
        if (
          replaceText === undefined &&
          appended.length === 0 &&
          report.continueFalse === undefined
        )
          return undefined;
        return {
          ...(replaceText !== undefined ? { replaceText } : {}),
          ...(appended.length > 0 ? { contextText: appended.join("\n\n") } : {}),
          // continue:false（决策 324 复审）：整轮结束，理由显示给人
          ...(report.continueFalse !== undefined
            ? { stopReason: report.continueFalse.stopReason ?? "钩子要求停止本轮处理" }
            : {}),
        };
      },
    },
  });
  // 收尾类钩子的归属：Run 收尾事件到达后记下这个 Run（adapter.currentRunId 在窗口外已清空）
  adapter.subscribe((event) => {
    if (event.kind === "run.ended") lastEndedRunId = event.runId;
  });
  // 决策 365：后台作业的会话记录与结束通知挂到本运行面；续跑时告诉模型上一进程的作业已丢失
  const bindJobEvents = (): void =>
    jobs.setEventSink((event) =>
      sessionStore.append(backgroundJobEntry(event, adapter.currentRunId()))
    );
  bindJobEvents();
  const jobNotices = new JobNotices(jobs, adapter);
  const lostJobs = deps.previousJobs?.lost ?? [];
  if (lostJobs.length > 0) {
    adapter.notify(`${JOB_NOTICE_PREFIX}${escapeStatusText(lostJobsText(lostJobs))}`);
    deps.storeWarn?.(lostJobsText(lostJobs));
  }
  // 写工具改过的文件记作前台改动（作业结束时从期间变化里扣除）；job_output 以外的工具调用清零不带等待的连续查询。
  // 决策 407：放权时写到工作区以外的文件不进工作区的改动统计
  const relativeToRoot = (resolved: string): string | undefined => {
    const relative =
      deps.workspaceHost !== undefined
        ? path.posix.relative(workspaceHost.root, resolved)
        : path.relative(deps.workspaceRoot, resolved);
    const unified = relative.replaceAll("\\", "/");
    return unified === ".." || unified.startsWith("../") || path.isAbsolute(relative)
      ? undefined
      : unified;
  };
  adapter.subscribeToolResults((notice) => {
    if (notice.toolName !== JOB_OUTPUT_TOOL) jobs.resetQueries();
    const resolved = (notice.details as { resolvedPath?: unknown } | undefined)?.resolvedPath;
    const relative =
      !notice.isError &&
      typeof resolved === "string" &&
      registry.get(notice.toolName)?.tier === "write"
        ? relativeToRoot(resolved)
        : undefined;
    if (relative !== undefined) {
      jobs.noteForegroundChanges([relative]);
    }
  });
  // 决策 323：PostCompact 钩子——压缩完成后通知（无决策能力；触发位置 turn / run-start 记 auto、manual 记 manual）
  if (sessionHooks.list().some((hook) => hook.event === "PostCompact")) {
    adapter.subscribeCompaction((notice) => {
      if (notice.kind === "compacted") {
        const trigger = notice.trigger === "manual" ? "manual" : "auto";
        // compact_summary 给真实摘要（复审 P2：不再给空串）：压缩后的上下文里 role 为
        // compactionSummary 的消息带 summary 字符串（上游 harness/compaction 的形状）
        const summaryMessage = notice.messages.find(
          (message) => (message as { role?: unknown }).role === "compactionSummary"
        ) as { summary?: unknown } | undefined;
        const compactSummary =
          typeof summaryMessage?.summary === "string" ? summaryMessage.summary : "";
        void sessionHooks.runEvent("PostCompact", trigger, {
          trigger,
          compact_summary: compactSummary,
        });
      }
    });
  }
  // 决策 363：写档与命令档工具之后重取文件类各节与 git 状态；模型自己用 update_memory 写成的记忆不回显
  adapter.subscribeToolResults((notice) => {
    const tier = registry.get(notice.toolName)?.tier;
    if (tier === "write" || tier === "exec") {
      statusTouched = true;
    }
    // 模型自己写的记忆当即记成已发（连同会话记录），/reload 与续跑之后也不回显
    if (notice.toolName === UPDATE_MEMORY_TOOL && !notice.isError) {
      const memory = memorySection();
      recordStatus(statusTracker.absorb("记忆", memory === "" ? undefined : memory));
    }
  });
  const toolTiers = new Map(
    governedRegistry.list().map((registration) => [registration.name, registration.tier])
  );
  return {
    adapter,
    sessionStore,
    grantStore,
    configGrants,
    settings,
    hooks: sessionHooks,
    toolTiers,
    jobs,
    jobNotices,
    jobCloseoutMs: deps.jobCloseoutMs ?? jobLimits.closeoutSeconds * 1000,
    bindJobEvents,
    modelInfo,
    truncationContinuation: continuation,
    repetitionGuard: repetition,
    status: statusTracker,
    prune,
    frozenPrompt: {
      systemPrompt,
      instructions,
      ...(pushedMemory !== undefined ? { pushedMemory } : {}),
      localSkills,
      toolEnvironment: environment.result(),
    },
    ...(mcp !== undefined ? { mcp } : {}),
    ...(learned !== undefined ? { learnedMemory: learned } : {}),
    ...("notice" in instructions && instructions.notice !== undefined
      ? { instructionsNotice: instructions.notice }
      : {}),
    ...(taskList !== undefined ? { taskList } : {}),
    ...(toolsNotice !== undefined ? { toolsNotice } : {}),
  };
}

// 释放运行面（M5.7 S3）：先停 Adapter，再关 MCP 连接（server 进程随之退出），最后关会话存储写者；
// 前一步失败不跳过后续
export async function disposeRuntime(bundle: RuntimeBundle): Promise<void> {
  // 决策 365：会话或运行结束时停掉本会话全部在跑的后台作业（结束记录落在会话存储关闭之前）；/reload 交出去的不在这里。
  // 决策 409：标了会话结束后保留的不等、不停，记一条"保留"、交出跟踪
  bundle.jobNotices?.dispose();
  try {
    await bundle.jobs?.killAll("aborted");
  } catch {
    // 停不掉的由崩溃清理兜底
  }
  bundle.jobs?.detachKept();
  bundle.jobs?.dispose();
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
    for (const close of bundle.closers?.splice(0) ?? []) {
      try {
        await close();
      } catch {
        // 同附加释放：失败不挡会话存储关闭
      }
    }
    try {
      await bundle.mcp?.close();
    } finally {
      await bundle.sessionStore.close();
    }
  }
}

// 加载用户提供的 StreamFn 模块（默认导出必须是函数）。归位装配根（M2 S2）：它是模型接入的
// 装载件，与 buildRuntime 同属"装配"职责；cli 与 tui 两个 Actor 都从本层取，避免 Actor 互依
export async function loadStreamFn(
  specifier: string,
  warn: WarnSink = stderrWarn
): Promise<StreamFn> {
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
  const streamFn = module.default as StreamFn;
  // 决策 362：可选的具名导出 modelInfo（不合规即报错，不认识的顶层键告警）；声明没给全价格、窗口与输出上限时另加载
  // pi-ai 自带目录备查（加载失败告警，按未知处理）
  let declared: ModelInfoDeclaration | undefined;
  if (module.modelInfo !== undefined) {
    const parsed = parseModelInfoDeclaration(module.modelInfo, `streamFn 模块 ${specifier}`);
    declared = parsed.declared;
    if (parsed.unknownKeys.length > 0) {
      warn(
        `streamFn 模块 ${specifier} 导出的 modelInfo 有不认识的字段 ${parsed.unknownKeys.join("、")}（不是 pi-ai 模型字段，也不是 modelInfo 的字段），已忽略`
      );
    }
  }
  const catalog = declarationComplete(declared) ? undefined : await loadCatalogLookup(warn);
  registerModelAccess(streamFn, {
    ...(declared !== undefined ? { declared } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
  });
  return streamFn;
}

// 配置了单轮输出上限才包装；未配置原样返回（跟模型）
function withOutputLimit(streamFn: StreamFn, maxOutputTokens: number | undefined): StreamFn {
  return maxOutputTokens !== undefined ? limitOutputTokens(streamFn, maxOutputTokens) : streamFn;
}
