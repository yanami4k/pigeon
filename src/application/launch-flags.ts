// 启动参数（决策 067）：cli、tui 与 headless 共用一份模型与运行参数解析，缺省值单一来源。
// 背景：三个入口此前各写一份，模型占位缺省已漂移成三种（进注入快照与 Run 开始条目，会把同一模型
// 按入口分成三组，影响 Eval 按模型分组）；`PIGEON_STREAM_FN` 只有 tui 读取，而 cli 的报错
// 文案称支持该变量。本模块统一占位缺省为 custom/custom，并把环境变量回退放进同一处。
// 真实模型元数据由 streamFn 插件提供，占位只是身份标签；历史会话标签不做映射。

import { SANDBOX_NETWORKS, type SandboxNetwork } from "../execution/sandbox.ts";

import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { OrchestrationSettings } from "../state/orchestration-config.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../state/runtime-events.ts";
import {
  orchestrationSettingsOf as orchestrationSectionOf,
  type SettingsSnapshot,
  webSectionOf,
} from "../state/settings.ts";
import type { WebSection } from "../state/web-config.ts";
import { resolveWebTools, type WebToolsConfig } from "./web-tools.ts";

// 三个入口共用的模型占位缺省（决策 067）
export const DEFAULT_MODEL_PLACEHOLDER = { provider: "custom", modelId: "custom" } as const;

// 无取值的开关型 flag（resume 的参数切分按此判断是否吞下一个参数）
export const VALUELESS_FLAGS = new Set([
  "--yolo",
  "--no-persist-thinking",
  "--no-pushed-memory",
  "--no-session-search",
  "--no-spawn-workers",
  "--no-hooks",
  "--no-web",
  "--sandbox",
  "--sandbox-from-head",
]);

// 日常沙箱的审批档（决策 248）：缺省全部放行（复用 yolo），可改回逐条询问
export const SANDBOX_APPROVALS = ["yolo", "prompt"] as const;
export type SandboxApproval = (typeof SANDBOX_APPROVALS)[number];

// 决策 237、246、248：--sandbox 在一次性容器里工作；--sandbox-network on|off 联网档（缺省 on，以后可加"只放行包管理源"
// 一档而不改用法）；--sandbox-approval yolo|prompt 审批档（缺省 yolo）。
// 决策 278：缺省把工作目录里未提交的改动（含未被忽略的新文件）拍成快照带进容器；--sandbox-from-head 改为只从当前分支的
// 最新提交开工（续跑不受影响：照旧从该会话交回过的分支开工）
export interface SandboxLaunch {
  network: SandboxNetwork;
  approval: SandboxApproval;
  // 给了 --sandbox-from-head 时为 true；缺省带快照
  fromHead?: boolean;
}

export interface LaunchFlags {
  root: string;
  // 模型接入模块说明符：--stream-fn 优先，其次环境变量 PIGEON_STREAM_FN
  streamFnSpec?: string;
  yolo: boolean;
  // 决策 324：--no-hooks 只对本次运行停用全部钩子（清空清单并置 disableAllHooks）；各入口一律接受
  noHooks: boolean;
  // 决策 346：--no-web 只对本次运行不给联网工具（web_search、web_fetch 不注册，系统提示不带联网那句）；各入口一律接受
  noWeb: boolean;
  provider: string;
  modelId: string;
  // M5 S1（决策 045）：--no-persist-thinking 关闭 thinking 正文持久化（缺省开）
  persistThinking: boolean;
  // M5.5 S5（决策 050）：--thinking <档位> 推理档位全局值（不给即取设置，设置也没写按模型信息：支持推理的 high，决策 390）
  thinkingLevel?: ThinkingLevel;
  // 决策 063、347：--max-output-tokens <n> 单轮输出上限（缺省不设：跟模型，按模型定义的上限发、由 provider 按剩余上下文收窄）
  maxOutputTokens?: number;
  // M9：--temperature <n> 采样温度（0 到 2；缺省不设，由 provider 决定）
  temperature?: number;
  // M5 S2（决策 045）：--history-limit <n> /resume 历史渲染安全上限（仅 TUI 接受）
  historyLimit?: number;
  // 决策 191、244：推送记忆——日常入口缺省开着，--no-pushed-memory 关掉（关掉即不推送、不注册记忆工具）。
  // 对称的会话检索开关是 --no-session-search（决策 382，见下）。两层上限在设置的 memory 一节（决策 332），不设启动参数
  pushedMemory: boolean;
  // 决策 382：会话检索——日常入口缺省开着，--no-session-search 关掉（关掉即不注册检索三件，开局记录写明原因）；
  // 接受入口同 --no-pushed-memory。设置里另有 sessionSearch.enabled 一项（缺省开）；跑批按条件开关，不接受这个参数
  sessionSearch: boolean;
  // 决策 188、218：--context-window <n>、--compact-threshold <n>、--compact-keep <n>——上下文压缩的模型窗口、
  // 触发点与保留量（缺省为产品缺省：1M 窗口减预留、保留 20000）；各入口都接受，给了哪项带哪项
  compaction?: CompactionConfigInput;
  // 决策 237：--sandbox 及其参数；不开沙箱时缺省
  sandbox?: SandboxLaunch;
  // 决策 265–267：主 agent 派 worker——终端界面与 pigeon run 缺省开着，--no-spawn-workers 关掉（关掉即不注册 spawn_worker）；
  // 沙箱会话与命令行对话不注册，不看这一项
  spawnWorkers: boolean;
  // 决策 268、300：--worker-concurrency <n> 同时在跑的 worker 上限（缺省取编排配置，配置缺省 8；人派的与 agent 派的一并计算）；
  // --worker-limit <n> 一次运行里 agent 最多派出的 worker 数（可选的上限，缺省不设）。与 --no-spawn-workers 同在能派 worker 的入口接受
  workerConcurrency?: number;
  workerLimit?: number;
}

// 上下文压缩参数名 → 配置字段
const COMPACTION_FLAGS: Readonly<Record<string, keyof CompactionConfigInput>> = {
  "--context-window": "contextWindow",
  "--compact-threshold": "thresholdTokens",
  "--compact-keep": "keepRecentTokens",
};

export interface ParseLaunchFlagsOptions {
  // 参数错误时附在报错里的用法说明（各入口自己的用法行）
  usage: string;
  // 环境变量来源（缺省 process.env；测试注入）
  env?: Record<string, string | undefined>;
  // 工作区根缺省（缺省 process.cwd()）
  cwd?: string;
  // 是否接受 --history-limit（只有 TUI 有历史渲染）
  historyLimit?: boolean;
  // 是否接受 --temperature（只有把它交给运行面的 Eval 入口；其余入口当作未知参数，不静默忽略）
  temperature?: boolean;
  // 是否接受 --no-pushed-memory（日常入口：cli / tui 主会话与 pigeon run；跑批器按条件指定，不接受）
  pushedMemory?: boolean;
  // 是否接受 --no-session-search（决策 382；接受入口同 --no-pushed-memory）
  sessionSearch?: boolean;
  // 是否接受 --sandbox 及其参数（终端界面、命令行对话与续跑、pigeon run）
  sandbox?: boolean;
  // 是否接受 --no-spawn-workers（能派 worker 的入口：终端界面与 pigeon run）
  spawnWorkers?: boolean;
}

export function parseLaunchFlags(argv: string[], options: ParseLaunchFlagsOptions): LaunchFlags {
  const env = options.env ?? process.env;
  const { usage } = options;
  const flags: LaunchFlags = {
    root: options.cwd ?? process.cwd(),
    yolo: false,
    noHooks: false,
    noWeb: false,
    provider: DEFAULT_MODEL_PLACEHOLDER.provider,
    modelId: DEFAULT_MODEL_PLACEHOLDER.modelId,
    persistThinking: true,
    pushedMemory: true,
    sessionSearch: true,
    spawnWorkers: true,
  };
  // 环境变量回退：--stream-fn 未给时用 PIGEON_STREAM_FN（决策 067：cli 补齐，与既有报错文案一致）
  // 沙箱参数：先收下，循环后与 --sandbox 对齐
  let sandbox = false;
  let sandboxNetwork: SandboxNetwork | undefined;
  let sandboxApproval: SandboxApproval | undefined;
  let sandboxFromHead = false;
  const fromEnv = env.PIGEON_STREAM_FN;
  if (fromEnv !== undefined && fromEnv !== "") {
    flags.streamFnSpec = fromEnv;
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      flags.yolo = true;
    } else if (flag === "--no-hooks") {
      flags.noHooks = true;
    } else if (flag === "--no-web") {
      flags.noWeb = true;
    } else if (flag === "--sandbox" && options.sandbox === true) {
      sandbox = true;
    } else if (flag === "--sandbox-from-head" && options.sandbox === true) {
      sandboxFromHead = true;
    } else if (flag === "--sandbox-network" && options.sandbox === true) {
      const value = argv[++i];
      if (value === undefined || !(SANDBOX_NETWORKS as readonly string[]).includes(value)) {
        throw new Error(`--sandbox-network 只接受 ${SANDBOX_NETWORKS.join("/")}（${usage}）`);
      }
      sandboxNetwork = value as SandboxNetwork;
    } else if (flag === "--sandbox-approval" && options.sandbox === true) {
      const value = argv[++i];
      if (value === undefined || !(SANDBOX_APPROVALS as readonly string[]).includes(value)) {
        throw new Error(`--sandbox-approval 只接受 ${SANDBOX_APPROVALS.join("/")}（${usage}）`);
      }
      sandboxApproval = value as SandboxApproval;
    } else if (flag === "--no-persist-thinking") {
      flags.persistThinking = false;
    } else if (flag === "--no-spawn-workers" && options.spawnWorkers === true) {
      flags.spawnWorkers = false;
    } else if (
      (flag === "--worker-concurrency" || flag === "--worker-limit") &&
      options.spawnWorkers === true
    ) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} 需要正整数（${usage}）`);
      }
      if (flag === "--worker-concurrency") {
        flags.workerConcurrency = value;
      } else {
        flags.workerLimit = value;
      }
    } else if (flag === "--no-pushed-memory" && options.pushedMemory === true) {
      flags.pushedMemory = false;
    } else if (flag === "--no-session-search" && options.sessionSearch === true) {
      flags.sessionSearch = false;
    } else if (flag === "--thinking") {
      const value = argv[++i];
      if (value === undefined || !isThinkingLevel(value)) {
        throw new Error(`--thinking 需要推理档位（${THINKING_LEVELS.join("/")}）（${usage}）`);
      }
      flags.thinkingLevel = value;
    } else if (flag === "--max-output-tokens") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--max-output-tokens 需要正整数（${usage}）`);
      }
      flags.maxOutputTokens = value;
    } else if (flag === "--temperature" && options.temperature === true) {
      const raw = argv[++i];
      const value = Number(raw);
      if (
        raw === undefined ||
        raw.trim() === "" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 2
      ) {
        throw new Error(`--temperature 需要 0 到 2 之间的数（${usage}）`);
      }
      flags.temperature = value;
    } else if (flag === "--history-limit" && options.historyLimit === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--history-limit 需要正整数（${usage}）`);
      }
      flags.historyLimit = value;
    } else if (flag !== undefined && COMPACTION_FLAGS[flag] !== undefined) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} 需要正整数（token 数）（${usage}）`);
      }
      flags.compaction = { ...flags.compaction, [COMPACTION_FLAGS[flag]]: value };
    } else if (flag === "--root") {
      flags.root = argv[++i] ?? flags.root;
    } else if (flag === "--stream-fn") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`--stream-fn 缺少取值（模块路径）（${usage}）`);
      }
      flags.streamFnSpec = value;
    } else if (flag === "--provider") {
      flags.provider = argv[++i] ?? flags.provider;
    } else if (flag === "--model") {
      flags.modelId = argv[++i] ?? flags.modelId;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  if (sandbox) {
    flags.sandbox = {
      network: sandboxNetwork ?? "on",
      approval: sandboxApproval ?? "yolo",
      ...(sandboxFromHead ? { fromHead: true } : {}),
    };
    // 沙箱里的审批（决策 248）：缺省全部放行，复用 yolo；--sandbox-approval prompt 改回逐条询问（另给 --yolo 仍放行）
    flags.yolo = flags.yolo || flags.sandbox.approval === "yolo";
  } else if (sandboxNetwork !== undefined || sandboxApproval !== undefined || sandboxFromHead) {
    throw new Error(
      `--sandbox-network、--sandbox-approval 与 --sandbox-from-head 只配合 --sandbox 用（${usage}）`
    );
  }
  return flags;
}

// 联网工具给不给（决策 291、346）：判定只在这一处。三者任一成立就不给——
// 本次运行带 --no-web；设置的 web.enabled 为 false（三层按标量覆盖，缺省 true）；沙箱开断网档（两件工具由宿主代为联网，
// 不受容器断网约束，选断网就一并关掉）。其余情形都给
export function webToolsEnabled(
  flags: Pick<LaunchFlags, "sandbox" | "noWeb">,
  web: WebSection | undefined
): boolean {
  if (flags.noWeb) return false;
  if (web?.enabled === false) return false;
  return flags.sandbox?.network !== "off";
}

// 决策 379：本机（不在容器沙箱里）放手且联网工具开着时，启动提示一行风险（定稿原文）。终端界面落消息区，pigeon run 写标准错误输出
export const LOCAL_RISK_NOTICE =
  "提示：本机放手模式下命令以你的账户执行、不经审批，能读家目录里的凭据；联网工具开着，网页或外部内容里夹带的指令可能借此把数据发出去。要隔离请用 --sandbox。";

export function localRiskNotice(
  flags: Pick<LaunchFlags, "sandbox" | "yolo">,
  webTools: boolean
): string | undefined {
  return flags.sandbox === undefined && flags.yolo && webTools ? LOCAL_RISK_NOTICE : undefined;
}

// 交给装配根的联网工具选项：给就按快照的 web 一节建出配置（配置畸形在此响亮失败），不给就不带 webTools。
// 各入口启动与终端界面 /reload 后都经这里，按当时的设置快照重算；worker 照父运行面拿同一份
export function webToolsOptionOf(
  flags: Pick<LaunchFlags, "sandbox" | "noWeb">,
  snapshot: SettingsSnapshot,
  env?: Record<string, string | undefined>
): { webTools?: WebToolsConfig } {
  const web = webSectionOf(snapshot);
  return webToolsEnabled(flags, web)
    ? { webTools: resolveWebTools({ config: web, ...(env !== undefined ? { env } : {}) }) }
    : {};
}

// 编排设定（决策 297–303）：设置快照的 orchestration 一节（缺失取缺省），启动参数给了的两项以参数为准
export function orchestrationSettingsOf(
  flags: Pick<LaunchFlags, "workerConcurrency" | "workerLimit">,
  snapshot: SettingsSnapshot
): OrchestrationSettings {
  const settings = orchestrationSectionOf(snapshot);
  return {
    ...settings,
    ...(flags.workerConcurrency !== undefined ? { maxConcurrent: flags.workerConcurrency } : {}),
    ...(flags.workerLimit !== undefined ? { maxWorkersPerRun: flags.workerLimit } : {}),
  };
}

// 模型接入必须显式配置：缺失时响亮失败（措辞与两个入口此前一致）
export function resolveStreamFnSpec(flags: LaunchFlags, usage: string): string {
  if (flags.streamFnSpec === undefined || flags.streamFnSpec === "") {
    throw new Error(
      "未配置模型接入：请用 --stream-fn <模块路径> 或环境变量 PIGEON_STREAM_FN 指定一个默认导出 " +
        `StreamFn 的模块（provider 密钥由该模块自行从环境变量读取）（${usage}）`
    );
  }
  return flags.streamFnSpec;
}
