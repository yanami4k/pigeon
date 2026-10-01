// 启动参数（决策 067）：cli、tui 与 headless 共用一份模型与运行参数解析，缺省值单一来源。
// 背景：三个入口此前各写一份，模型占位缺省已漂移成三种（进注入快照与 Run 开始条目，会把同一模型
// 按入口分成三组，影响 Eval 按模型分组）；`PIGEON_STREAM_FN` 只有 tui 读取，而 cli 的报错
// 文案称支持该变量。本模块统一占位缺省为 custom/custom，并把环境变量回退放进同一处。
// 真实模型元数据由 streamFn 插件提供，占位只是身份标签；历史会话标签不做映射。

import { SANDBOX_NETWORKS, type SandboxNetwork } from "../execution/sandbox.ts";
import { loadProjectRepairRounds, loadVerifyConfig } from "../persistence/verify-config.ts";
import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { OrchestrationSettings } from "../state/orchestration-config.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../state/runtime-events.ts";
import {
  orchestrationSettingsOf as orchestrationSectionOf,
  type SettingsSnapshot,
} from "../state/settings.ts";

// 三个入口共用的模型占位缺省（决策 067）
export const DEFAULT_MODEL_PLACEHOLDER = { provider: "custom", modelId: "custom" } as const;

// M7（决策 071）：验证命令缺省超时（5 分钟）
export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60_000;

// 无取值的开关型 flag（resume 的参数切分按此判断是否吞下一个参数）
export const VALUELESS_FLAGS = new Set([
  "--yolo",
  "--no-persist-thinking",
  "--no-pushed-memory",
  "--no-spawn-workers",
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
  provider: string;
  modelId: string;
  // M5 S1（决策 045）：--no-persist-thinking 关闭 thinking 正文持久化（缺省开）
  persistThinking: boolean;
  // M5 S3（决策 042）：--memory-budget <字符数> 常驻 Memory 预算（缺省 8000）
  memoryBudgetChars?: number;
  // M5.5 S5（决策 050）：--thinking <档位> 推理档位全局值（缺省不请求推理）
  thinkingLevel?: ThinkingLevel;
  // 决策 063：--max-output-tokens <n> 单轮输出上限（缺省 16,384）
  maxOutputTokens?: number;
  // M9：--temperature <n> 采样温度（0 到 2；缺省不设，由 provider 决定）
  temperature?: number;
  // M5 S2（决策 045）：--history-limit <n> /resume 历史渲染安全上限（仅 TUI 接受）
  historyLimit?: number;
  // M7（决策 071）：--verify-command <命令> 与 --verify-timeout <毫秒>——尝试收尾后由程序独立执行的验证命令；
  // cli REPL / resume、tui 与 pigeon run 接受
  verifyCommand?: string;
  verifyTimeoutMs?: number;
  // M7（决策 079）：--retry-on-fail <K> 失败自动分叉重试次数（缺省 0 关闭）；cli REPL / resume、tui 与 pigeon run 接受
  retryOnFail?: number;
  // 决策 142 / 143：--repair-rounds <N> 回炉轮数（0 为关闭）；只有 pigeon run 接受（REPL / TUI 与 worker 路径不做回炉）
  repairRounds?: number;
  // 决策 191、244：推送记忆——日常入口缺省开着（与会话检索开关的缺省一致），--no-pushed-memory 关掉（关掉即不推送、
  // 不注册记忆工具）；--memory-limit <字符数> 学到的记忆的总量上限（缺省 12,000）。cli REPL / resume、tui 与
  // pigeon run 接受
  pushedMemory: boolean;
  memoryLimitChars?: number;
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
  // 是否接受验证命令参数（cli / tui 主会话与 pigeon run；eval 沿用 task.json 的验证器，不接受）
  verify?: boolean;
  // 是否接受 --retry-on-fail（cli / tui 主会话与 pigeon run）
  retry?: boolean;
  // 是否接受 --repair-rounds（只有 pigeon run）
  repair?: boolean;
  // 是否接受 --no-pushed-memory 与 --memory-limit（日常入口：cli / tui 主会话与 pigeon run；跑批器按条件指定，不接受）
  pushedMemory?: boolean;
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
    provider: DEFAULT_MODEL_PLACEHOLDER.provider,
    modelId: DEFAULT_MODEL_PLACEHOLDER.modelId,
    persistThinking: true,
    pushedMemory: true,
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
    } else if (flag === "--memory-limit" && options.pushedMemory === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--memory-limit 需要正整数（字符数）（${usage}）`);
      }
      flags.memoryLimitChars = value;
    } else if (flag === "--memory-budget") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--memory-budget 需要非负整数（字符数）（${usage}）`);
      }
      flags.memoryBudgetChars = value;
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
    } else if (flag === "--verify-command" && options.verify === true) {
      const value = argv[++i];
      if (value === undefined || value.trim() === "") {
        throw new Error(`--verify-command 缺少取值（一行命令）（${usage}）`);
      }
      flags.verifyCommand = value;
    } else if (flag === "--verify-timeout" && options.verify === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--verify-timeout 需要正整数（毫秒）（${usage}）`);
      }
      flags.verifyTimeoutMs = value;
    } else if (flag === "--retry-on-fail" && options.retry === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--retry-on-fail 需要非负整数（0 表示关闭）（${usage}）`);
      }
      flags.retryOnFail = value;
    } else if (flag === "--repair-rounds" && options.repair === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--repair-rounds 需要非负整数（0 表示关闭）（${usage}）`);
      }
      flags.repairRounds = value;
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

// 联网工具给不给（决策 291）：沙箱开断网档时不给——两件工具由宿主代为联网，不受容器断网约束，选断网就一并关掉；
// 其余情形（不开沙箱、沙箱联网）都给
export function webToolsEnabled(flags: Pick<LaunchFlags, "sandbox">): boolean {
  return flags.sandbox?.network !== "off";
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

// 验证命令配置（决策 071）：由启动参数得出，会话开始时冻结进注入快照；未给命令即未配置
export function verifyConfigOf(flags: LaunchFlags): VerifyConfig | undefined {
  if (flags.verifyCommand === undefined) {
    return undefined;
  }
  return {
    command: flags.verifyCommand,
    timeoutMs: flags.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    source: "flag",
  };
}

// 验证命令的三级来源（M8 S1，决策 081）：启动参数 > 项目配置（.pigeon/verify.json）> 未配置。
// 启动参数在场时整条配置取启动参数——两级逐字段混合会让"这次尝试用的是哪条命令、多长超时"
// 取决于两份来源的组合，事后不可读。项目配置畸形一律响亮失败，不静默降级为未配置。
export function resolveVerifyConfig(
  flags: LaunchFlags,
  governanceRoot: string
): VerifyConfig | undefined {
  return verifyConfigOf(flags) ?? loadVerifyConfig(governanceRoot, DEFAULT_VERIFY_TIMEOUT_MS);
}

// 回炉轮数的来源（决策 142 / 143）：启动参数 > 项目验证配置（.pigeon/verify.json 的 repairRounds）> 0（关闭）。
// 参数给 0 即关闭，压过项目配置；轮数与验证命令分别取来源，缺验证命令时由运行入口启动报错
export function resolveRepairRounds(flags: LaunchFlags, governanceRoot: string): number {
  return flags.repairRounds ?? loadProjectRepairRounds(governanceRoot) ?? 0;
}
