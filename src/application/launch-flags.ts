// 启动参数（决策 067）：cli、tui 与 headless 共用一份模型与运行参数解析，缺省值单一来源。
// 背景：三个入口此前各写一份，模型占位缺省已漂移成三种（进注入快照与 run.started，会把同一模型
// 按入口分成三组，影响 Eval 与学习侧按模型分组）；`PIGEON_STREAM_FN` 只有 tui 读取，而 cli 的报错
// 文案称支持该变量。本模块统一占位缺省为 custom/custom，并把环境变量回退放进同一处。
// 真实模型元数据由 streamFn 插件提供，占位只是身份标签；历史会话标签不做映射。
import { DEFAULT_REVIEW_EVERY_TURNS } from "../review/scheduler.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import type { ReviewConfig } from "../state/review.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../state/runtime-events.ts";

// 三个入口共用的模型占位缺省（决策 067）
export const DEFAULT_MODEL_PLACEHOLDER = { provider: "custom", modelId: "custom" } as const;

// M7（决策 071）：验证命令缺省超时（5 分钟）
export const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60_000;

// 无取值的开关型 flag（resume 的参数切分按此判断是否吞下一个参数）
export const VALUELESS_FLAGS = new Set(["--yolo", "--no-persist-thinking", "--no-review"]);

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
  // M5 S2（决策 045）：--history-limit <n> /resume 历史渲染安全上限（仅 TUI 接受）
  historyLimit?: number;
  // M6（决策 064 子裁决 ①）：后台审阅开关（--no-review 关闭，缺省开）与轮次间隔（--review-every <N>，
  // 0 = 只在 Run 结束审；缺省取调度器常量）。只有 cli REPL / resume 与 tui 接受
  review: boolean;
  reviewEvery?: number;
  // M7（决策 071）：--verify-command <命令> 与 --verify-timeout <毫秒>——尝试收尾后由程序独立执行的验证命令；
  // cli REPL / resume、tui 与 pigeon run 接受
  verifyCommand?: string;
  verifyTimeoutMs?: number;
  // M7（决策 079）：--retry-on-fail <K> 失败自动分叉重试次数（缺省 0 关闭）；cli REPL / resume、tui 与 pigeon run 接受
  retryOnFail?: number;
}

export interface ParseLaunchFlagsOptions {
  // 参数错误时附在报错里的用法说明（各入口自己的用法行）
  usage: string;
  // 环境变量来源（缺省 process.env；测试注入）
  env?: Record<string, string | undefined>;
  // 工作区根缺省（缺省 process.cwd()）
  cwd?: string;
  // 是否接受 --history-limit（只有 TUI 有历史渲染）
  historyLimit?: boolean;
  // 是否接受后台审阅参数（只有 cli / tui 的主会话挂审阅；run 与 eval 不接受）
  review?: boolean;
  // 是否接受验证命令参数（cli / tui 主会话与 pigeon run；eval 沿用 task.json 的验证器，不接受）
  verify?: boolean;
  // 是否接受 --retry-on-fail（cli / tui 主会话与 pigeon run）
  retry?: boolean;
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
    review: true,
  };
  // 环境变量回退：--stream-fn 未给时用 PIGEON_STREAM_FN（决策 067：cli 补齐，与既有报错文案一致）
  const fromEnv = env.PIGEON_STREAM_FN;
  if (fromEnv !== undefined && fromEnv !== "") {
    flags.streamFnSpec = fromEnv;
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      flags.yolo = true;
    } else if (flag === "--no-persist-thinking") {
      flags.persistThinking = false;
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
    } else if (flag === "--history-limit" && options.historyLimit === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--history-limit 需要正整数（${usage}）`);
      }
      flags.historyLimit = value;
    } else if (flag === "--no-review" && options.review === true) {
      flags.review = false;
    } else if (flag === "--review-every" && options.review === true) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--review-every 需要非负整数（0 表示只在 Run 结束审）（${usage}）`);
      }
      flags.reviewEvery = value;
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
  return flags;
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

// 后台审阅配置（决策 064 子裁决 ①）：由启动参数得出，会话开始时冻结进注入快照
export function reviewConfigOf(flags: LaunchFlags): ReviewConfig {
  return { enabled: flags.review, everyTurns: flags.reviewEvery ?? DEFAULT_REVIEW_EVERY_TURNS };
}

// 验证命令配置（决策 071）：由启动参数得出，会话开始时冻结进注入快照；未给命令即未配置
export function verifyConfigOf(flags: LaunchFlags): VerifyConfig | undefined {
  if (flags.verifyCommand === undefined) {
    return undefined;
  }
  return {
    command: flags.verifyCommand,
    timeoutMs: flags.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
  };
}
