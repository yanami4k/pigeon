// Pigeon M3 极简 CLI 入口（决策 3：REPL 内联审批，单进程最小闭环，不依赖 M2 TUI）。
// M2 S1（决策 025）：装配根（buildRuntime）在 application/runtime.ts，审批 handler 由本入口
// 注入 REPL 问答版；resume 对账流程在 application/resume.ts，本文件只做参数解析与 IO 接线。
// 用法：node src/cli/index.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   --stream-fn / PIGEON_STREAM_FN：默认导出 StreamFn 的模块
//   （形状 (model, context, options?) => AssistantMessageEventStream，与测试 fixtures 的 fake
//   streamFn 同型；provider 密钥等由该模块自行从环境变量读取）。
//   未配置时清晰报错退出，不静默失败。
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activationStartupWarnings,
  startupEnvironmentOf,
} from "../application/activation-notes.ts";
import { autoVerifyWiring } from "../application/auto-verify.ts";
import { decideCandidate } from "../application/candidate-decision.ts";
import { runCandidateShowCommand, runCandidatesCommand } from "../application/candidates-list.ts";
import { renderDistillReport, runDistillCommand } from "../application/distill-command.ts";
import { runForkCommand } from "../application/fork-command.ts";
import { evalVerdictLabel, failureBadge } from "../application/format.ts";
import type { GrantsCommandContext } from "../application/grants.ts";
import { HEADLESS_EXIT_CODES, runHeadless } from "../application/headless.ts";
import {
  type LaunchFlags,
  parseLaunchFlags,
  resolveRepairRounds,
  resolveStreamFnSpec,
  resolveVerifyConfig,
  reviewConfigOf,
  VALUELESS_FLAGS,
} from "../application/launch-flags.ts";
import { verifierRuntimeFactory } from "../application/rerun.ts";
import { runResumeFlow } from "../application/resume.ts";
import { runManualReview } from "../application/review-command.ts";
import { disposeRuntime, loadStreamFn, type RuntimeBundle } from "../application/runtime.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { runTreeRebuildCommand } from "../application/session-tree.ts";
import { verifyCandidate } from "../application/verify-command.ts";
import { sessionRuntimeScope } from "../application/worker-scope.ts";
import { createWorkerRuntimeFactory } from "../application/workers.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import { renderEditModeComparison } from "../eval/compare.ts";
import { createTaskSourceRerunDispatcher, taskSourcePlanFor } from "../eval/container-rerun.ts";
import { localTaskSource } from "../eval/local-source.ts";
import { DEFAULT_OUTAGE, runEval } from "../eval/runner.ts";
import { swebenchTaskSource, swebenchTemperature } from "../eval/swebench-source.ts";
import { EVAL_CONDITIONS, type EvalCondition, loadEvalTasks } from "../eval/task.ts";
import { describeHead, mainRepoRoot } from "../orchestration/worktree.ts";
import { probeUpstreamVersions } from "../pi-runtime/upstream-version.ts";
import { MIN_RERUN_N } from "../replay/verdict.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import type { SessionListFilters } from "../state/session-summary.ts";
import {
  DEFAULT_EDIT_MODE,
  EDIT_MODES,
  type EditMode,
  isEditMode,
  LEGACY_RESULT_EDIT_MODE,
} from "../tools/edit-mode.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";
import { createAsker, runRepl, sanitizedWriter } from "./repl.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

// 决策 036：cli 唯一 stdout 出口——REPL 问答、审批交互、grant 命令与只读视图
//（trace / replay / session list）全部经同一净化写；半信任内容（模型文本、审批块
// 参数与 diff 预览、错误消息）携带的终端控制序列在边界可见化（M2 审计 P2-1）
const writeOut = sanitizedWriter((text: string): void => {
  process.stdout.write(text);
});

// pigeon trace <sessionId> [--run <runId>] [--root <dir>]：只读关联视图（M4 S3）——
// 不需要模型接入，永不写事件日志/工作区（只走 materializeSession 读路径，见 trace.ts）
function traceMain(argv: string[]): void {
  let sessionId: string | undefined;
  let runId: string | undefined;
  let root = process.cwd();
  // M5 S2（决策 045）：--with-content 带正文（默认关）
  let withContent = false;
  const usage = "用法：pigeon trace <sessionId> [--run <runId>] [--with-content] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--run") {
      runId = argv[++i];
    } else if (flag === "--with-content") {
      withContent = true;
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else if (sessionId === undefined && flag !== undefined && !flag.startsWith("--")) {
      sessionId = flag;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  if (sessionId === undefined || runId === "") {
    throw new Error(usage);
  }
  writeOut(
    runTraceCommand({
      root: realpathSync(root),
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
      withContent,
    })
  );
}

// pigeon replay <runId> [--session <sessionId>] [--root <dir>]：只读黑匣子时间线（M4 S4，
// D4 一次性渲染）——不需要模型接入，永不写事件日志/工作区，绝不重新执行真实副作用
// （只走 materializeSession 读路径，见 replay.ts）；与 trace 的链式分组治理视图相区别
function replayMain(argv: string[]): void {
  let runId: string | undefined;
  let sessionId: string | undefined;
  let root = process.cwd();
  // M5 S2（决策 045）：--with-content 带正文（默认关）
  let withContent = false;
  const usage =
    "用法：pigeon replay <runId> [--session <sessionId>] [--with-content] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--session") {
      sessionId = argv[++i];
    } else if (flag === "--with-content") {
      withContent = true;
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else if (runId === undefined && flag !== undefined && !flag.startsWith("--")) {
      runId = flag;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  if (runId === undefined || sessionId === "") {
    throw new Error(usage);
  }
  writeOut(
    runReplayCommand({
      root: realpathSync(root),
      runId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      withContent,
    })
  );
}

// pigeon session list [--tool <name>] [--class <cancelled|business|infrastructure|unknown>]
//   [--since <ISO 日期|epoch 毫秒>] [--until <...>] [--root <dir>]：会话投影列表（M4 S5，D5）——
// 只读渲染（派生不落库），不需要模型接入，永不写事件日志/工作区
const FAILURE_CLASSES = ["cancelled", "business", "infrastructure", "unknown"] as const;

// 时间边界解析：全数字 = epoch 毫秒；否则按 ISO 日期 Date.parse，解析不出响亮报错
function parseTimeBound(flag: string, value: string | undefined): number {
  if (value === undefined) {
    throw new Error(`${flag} 缺少取值（ISO 日期或 epoch 毫秒）`);
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} 需要 ISO 日期或 epoch 毫秒：${value}`);
  }
  return parsed;
}

function sessionListMain(argv: string[]): void {
  const filters: SessionListFilters = {};
  let root = process.cwd();
  const usage =
    "用法：pigeon session list [--tool <name>] [--class <cancelled|business|infrastructure|unknown>] " +
    "[--since <ISO 日期或 epoch 毫秒>] [--until <ISO 日期或 epoch 毫秒>] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--tool") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--tool 缺少取值（工具名）");
      }
      filters.tool = value;
    } else if (flag === "--class") {
      const value = argv[++i];
      if (value === undefined || !(FAILURE_CLASSES as readonly string[]).includes(value)) {
        throw new Error(
          `未知失败分类：${value ?? "（缺取值）"}（可选：${FAILURE_CLASSES.join("/")}）`
        );
      }
      // 成员校验已在上面完成，此处收窄到联合类型
      filters.class = value as (typeof FAILURE_CLASSES)[number];
    } else if (flag === "--since") {
      filters.since = parseTimeBound(flag, argv[++i]);
    } else if (flag === "--until") {
      filters.until = parseTimeBound(flag, argv[++i]);
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  writeOut(runSessionListCommand({ root: realpathSync(root), filters }));
}

// 模型接入 flags：解析在 application/launch-flags.ts（决策 067，与 tui、headless 同一份、
// 同一批缺省；含 PIGEON_STREAM_FN 回退）。resume 的参数切分用其导出的 VALUELESS_FLAGS

// REPL 的 grant 命令上下文（/grants 唯一展示入口 + /revoke + /grants save）
function grantCommandsOf(
  bundle: RuntimeBundle,
  workspaceRoot: string,
  sessionId: SessionId,
  write: (text: string) => void
): GrantsCommandContext {
  return {
    root: workspaceRoot,
    store: bundle.grantStore,
    configRules: bundle.configGrants,
    sessionId,
    write,
  };
}

// pigeon resume <sessionId> [--yolo] [--root <dir>] --stream-fn <模块路径> [--provider <p>]
//   [--model <m>]：冷恢复对账（哈希自动确证 + 剩余悬账人工确认菜单）后在同一会话下续跑
// REPL（M4 S5，D5）——Pi transcript 不恢复，模型对话上下文重新建立；后续 Run 继续写入
// 本会话事件日志；系统永不自动重新执行（§3.2）
// pigeon review <sessionId> [--run <runId>] [--root <dir>] --stream-fn <模块路径> [--provider <p>] [--model <m>]：
// 手动补审（M6 S4，决策 064）——对冷会话补一次后台审阅，完成后落盘候选；worker、headless 与 Eval 会话
// 不自动审，需要时用它补。与自动审阅同一派发器，派出与收尾记进被审会话
async function reviewMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon review <sessionId> [--run <runId>] [--root <dir>] --stream-fn <模块路径> [--provider <p>] [--model <m>]";
  let sessionIdArg: string | undefined;
  let runIdArg: string | undefined;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--run") {
      runIdArg = argv[++i];
      if (runIdArg === undefined) {
        throw new Error(`--run 缺少取值（${usage}）`);
      }
      continue;
    }
    if (!arg.startsWith("--") && sessionIdArg === undefined) {
      sessionIdArg = arg;
      continue;
    }
    modelArgv.push(arg);
    const next = argv[i + 1];
    if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
      modelArgv.push(next);
      i++;
    }
  }
  if (sessionIdArg === undefined) {
    throw new Error(usage);
  }
  const flags = parseLaunchFlags(modelArgv, { usage });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const governanceRoot = prepareWorkspace(flags.root);
  const summary = await runManualReview({
    governanceRoot,
    sessionId: sessionIdArg,
    ...(runIdArg !== undefined ? { runId: runIdArg } : {}),
    streamFn,
    provider: flags.provider,
    modelId: flags.modelId,
    persistThinking: flags.persistThinking,
  });
  writeOut(
    `补审 会话 ${summary.sessionId} ｜ ${summary.runId} ｜ 审阅会话 ${summary.reviewSessionId} ｜ ` +
      `收尾 ${summary.status} ｜ 新候选 ${summary.candidatesWritten} 个` +
      (summary.duplicates > 0 ? ` ｜ 重复跳过 ${summary.duplicates} 个` : "") +
      (summary.unparsable !== undefined ? ` ｜ 结果不可解析：${summary.unparsable}` : "") +
      (summary.error !== undefined ? ` ｜ 原因：${summary.error}` : "") +
      `\n查看：pigeon trace ${summary.sessionId}；候选：pigeon candidates\n`
  );
}

// pigeon candidates [--all] [--root <dir>]：只读列出候选（M6 S4，决策 065 子裁决 ⑤），缺省隐藏扫描拒收项
// pigeon distill (--task <任务标识> | --eval-results <目录>) [--force] --stream-fn <模块路径> [--provider <p>] [--model <m>]：
// 手动提炼（M7 S4，决策 074）——与自动触发同一派发器与选对规则；Eval 结果目录只读读取
async function distillMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon distill (--task <任务标识> | --eval-results <目录>) [--force] [--root <dir>] --stream-fn <模块路径> [--provider <p>] [--model <m>]";
  let taskKey: string | undefined;
  let evalResults: string | undefined;
  let force = false;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task") {
      taskKey = argv[++i];
    } else if (arg === "--eval-results") {
      evalResults = argv[++i];
    } else if (arg === "--force") {
      force = true;
    } else if (arg !== undefined) {
      modelArgv.push(arg);
    }
  }
  const flags = parseLaunchFlags(modelArgv, { usage });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const root = prepareWorkspace(flags.root);
  const result = await runDistillCommand({
    root,
    ...(taskKey !== undefined ? { taskKey } : {}),
    ...(evalResults !== undefined ? { evalResults } : {}),
    force,
    createRuntime: createWorkerRuntimeFactory({
      streamFnFor: () => streamFn,
      provider: flags.provider,
      modelId: flags.modelId,
      persistThinking: flags.persistThinking,
    }),
  });
  writeOut(`${renderDistillReport(result)}\n`);
}

// M6（决策 065）列表 + M8 S6（决策 088）详情与四个审批动作。
// 审批走 CLI 子命令而非 TUI 面板：候选审批是离线决策、内容为长文，与在线短决策的工具审批形态不同，
// 混进同一界面会把该慢的决定塞进快节奏上下文
const CANDIDATE_ACTIONS = ["approve", "reject", "revoke", "supersede"] as const;

function candidatesMain(argv: string[]): void {
  const usage =
    "用法：pigeon candidates [--all] [--root <dir>]\n" +
    "      pigeon candidates show <哈希前缀|种类/名字> [--root <dir>]\n" +
    "      pigeon candidates approve|reject|revoke <哈希前缀|种类/名字> [--reason <理由>] [--root <dir>]\n" +
    "      pigeon candidates supersede <哈希前缀|种类/名字> --by <新候选完整哈希> [--reason <理由>] [--root <dir>]";
  const sub = argv[0];
  if (sub === "show") {
    const { selector, root } = parseCandidateArgs(argv.slice(1), usage);
    writeOut(runCandidateShowCommand({ root: realpathSync(root), selector }));
    return;
  }
  if (sub !== undefined && (CANDIDATE_ACTIONS as readonly string[]).includes(sub)) {
    const action = sub as (typeof CANDIDATE_ACTIONS)[number];
    const parsed = parseCandidateArgs(argv.slice(1), usage, { reason: true, by: true });
    const result = decideCandidate({
      governanceRoot: realpathSync(parsed.root),
      selector: parsed.selector,
      action,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      ...(parsed.by !== undefined ? { supersededBy: parsed.by } : {}),
    });
    const lines = [
      `${action} ｜ ${result.decision.candidateKind}/${result.decision.name} ｜ ${result.decision.contentHash.slice(0, 12)}`,
      `理由（${result.decision.reasonSource === "human" ? "人写" : "系统默认"}）：${result.decision.reason}`,
    ];
    if (result.activation !== undefined) {
      lines.push(
        `已激活：${result.activation.path}` +
          (result.activation.unverified ? "（未经回放证实）" : "") +
          " ｜ 下一个会话开始装载（本会话的注入快照已冻结）"
      );
    }
    if (action === "revoke" && result.path !== undefined) {
      lines.push(`已移走落点：${result.path}（不追溯既往会话）`);
    }
    writeOut(`${lines.join("\n")}\n`);
    return;
  }
  let root = process.cwd();
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--all") {
      all = true;
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  writeOut(runCandidatesCommand({ root: realpathSync(root), all }));
}

interface CandidateArgs {
  selector: string;
  root: string;
  reason?: string;
  by?: string;
}

function parseCandidateArgs(
  argv: string[],
  usage: string,
  accepts: { reason?: boolean; by?: boolean } = {}
): CandidateArgs {
  const parsed: CandidateArgs = { selector: "", root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root") {
      parsed.root = argv[++i] ?? parsed.root;
    } else if (flag === "--reason" && accepts.reason === true) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`--reason 缺少取值（${usage}）`);
      }
      parsed.reason = value;
    } else if (flag === "--by" && accepts.by === true) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`--by 缺少取值（新候选的完整内容哈希）（${usage}）`);
      }
      parsed.by = value;
    } else if (parsed.selector === "" && flag !== undefined && !flag.startsWith("--")) {
      parsed.selector = flag;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  if (parsed.selector === "") {
    throw new Error(`缺少候选选择器（内容哈希前缀或 种类/名字）（${usage}）`);
  }
  return parsed;
}

// pigeon verify <选择器>（M8 S6，决策 086）：人工触发一次回放验证——四组各跑 N 次真执行，
// 出三值结论并落一条验证回执。需要模型接入（回放是真跑），验证命令按 081 的三级来源解出。
// 无人值守的自动验证是另一个开关（决策 086），不在这里。
// pigeon verify 的参数解析（M8 收口补遗：抽出来单测，次数下限在这一层就判）
export interface VerifyArgs {
  selector: string;
  n?: number;
  effectThreshold?: number;
  keepWorktree: boolean;
  // 余下交给通用启动参数解析的部分（模型接入、验证命令等）
  modelArgv: string[];
}

export function parseVerifyArgs(argv: string[], usage: string): VerifyArgs {
  let selector: string | undefined;
  let n: number | undefined;
  let effectThreshold: number | undefined;
  let keepWorktree = false;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--n") {
      const value = Number(argv[++i]);
      // 下限在这里就判（M8 收口补遗）：低于下限的次数不该先跑掉四组回放再报错
      if (!Number.isInteger(value) || value < MIN_RERUN_N) {
        throw new Error(`--n 需要不小于 ${MIN_RERUN_N} 的整数（${usage}）`);
      }
      n = value;
    } else if (flag === "--effect") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0 || value > 1) {
        throw new Error(`--effect 需要 (0, 1] 之间的小数（${usage}）`);
      }
      effectThreshold = value;
    } else if (flag === "--keep-worktree") {
      keepWorktree = true;
    } else if (flag?.startsWith("--") === true) {
      modelArgv.push(flag);
      const next = argv[i + 1];
      if (!VALUELESS_FLAGS.has(flag) && next !== undefined && !next.startsWith("--")) {
        modelArgv.push(next);
        i++;
      }
    } else if (selector === undefined && flag !== undefined) {
      selector = flag;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  if (selector === undefined) {
    throw new Error(`缺少候选选择器（内容哈希前缀或 种类/名字）（${usage}）`);
  }
  return {
    selector,
    ...(n !== undefined ? { n } : {}),
    ...(effectThreshold !== undefined ? { effectThreshold } : {}),
    keepWorktree,
    modelArgv,
  };
}

async function verifyMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon verify <哈希前缀|种类/名字> [--n <每组次数>] [--effect <大效应门槛>] " +
    "[--keep-worktree] [--root <dir>] [--stream-fn <模块路径>] [--provider <p>] [--model <m>] " +
    "[--verify-command <命令>] [--verify-timeout <毫秒>]";
  const { selector, n, effectThreshold, keepWorktree, modelArgv } = parseVerifyArgs(argv, usage);
  const flags = parseLaunchFlags(modelArgv, { usage, verify: true });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const governanceRoot = prepareWorkspace(flags.root);
  const verify = resolveVerifyConfig(flags, governanceRoot);
  if (verify === undefined) {
    throw new Error(
      "未配置验证命令：回放靠它判成败，没有它跑多少次都只能标未知。" +
        "请在 .pigeon/verify.json 里配置，或用 --verify-command 指定"
    );
  }
  const result = await verifyCandidate({
    governanceRoot,
    repoRoot: mainRepoRoot(governanceRoot),
    selector,
    verify,
    ...(n !== undefined ? { n } : {}),
    ...(effectThreshold !== undefined ? { effectThreshold } : {}),
    keepWorktree,
    // 模型标识、推理档位与单轮输出上限都沿用被验证那次尝试（M8 收口补遗：收口成同一份依赖构造）
    runtimeFactoryFor: (sampling) =>
      verifierRuntimeFactory({ ...sampling, streamFn, persistThinking: flags.persistThinking }),
    onRerun: (run) => {
      writeOut(
        `[verify] ${run.arm} #${run.index} ｜ ${evalVerdictLabel(run.verdict)} ｜ ${run.status} ｜ ` +
          `${run.turns} 轮 ｜ 会话 ${run.sessionId}\n`
      );
    },
  });
  const record = result.record;
  writeOut(
    [
      `结论：${record.conclusion} ｜ 每组 ${record.n} 次 ｜ 大效应门槛 ${record.effectThreshold}`,
      `正回放差 ${record.positiveDelta.toFixed(2)} ｜ 负回放差 ${record.negativeDelta.toFixed(2)}`,
      ...record.arms.map((arm) => `  ${arm.arm}：${arm.passes}/${arm.runs}`),
      `回执已落账本：${record.id}（pigeon candidates show ${record.contentHash.slice(0, 12)} 看全文）`,
    ].join("\n")
  );
  writeOut("\n");
  for (const error of result.errors) {
    process.stderr.write(
      `验证告警：${error instanceof Error ? error.message : String(error)}（不改变结论）\n`
    );
  }
}

async function resumeMain(argv: string[]): Promise<void> {
  let sessionIdArg: string | undefined;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--") && sessionIdArg === undefined) {
      sessionIdArg = arg;
      continue;
    }
    modelArgv.push(arg);
    // 取值型 flag 的值也不以 -- 开头，一并带走（开关型 flag 无值）
    const next = argv[i + 1];
    if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
      modelArgv.push(next);
      i++;
    }
  }
  const usage =
    "用法：pigeon resume <sessionId> [--yolo] [--root <dir>] --stream-fn <模块路径> [--provider <p>] [--model <m>]";
  if (sessionIdArg === undefined) {
    throw new Error(usage);
  }
  const sessionId = asSessionId(sessionIdArg);
  const modelUsage =
    "支持 --yolo / --no-persist-thinking / --memory-budget / --thinking / --max-output-tokens / --review-every / --no-review / --verify-command / --verify-timeout / --auto-verify / --retry-on-fail / --root / --stream-fn / --provider / --model";
  const flags = parseLaunchFlags(modelArgv, {
    usage: modelUsage,
    review: true,
    verify: true,
    retry: true,
  });
  const streamFnSpec = resolveStreamFnSpec(flags, modelUsage);
  // 工作区准备（决策 034）：realpath 规范化，与 tui 入口同一份
  const workspaceRoot = prepareWorkspace(flags.root);
  // M8（决策 091 / 093）：恢复会话同样要先说一次已激活经验的漂移与批准失效
  emitActivationNotes(workspaceRoot, flags);
  const write = writeOut;
  // M5.5 S4（决策 040）：worker 会话回到它自己的工作树与委派策略（父会话或工作树缺失时响亮失败）
  const scope = sessionRuntimeScope(workspaceRoot, sessionId);
  const { ask, close } = createAsker(process.stdin, write);
  try {
    await runResumeFlow({
      root: workspaceRoot,
      workspaceRoot: scope.workspaceRoot,
      sessionId: sessionIdArg,
      ask,
      write,
      // 对账收口后进入 REPL：同一 sessionId 续写事件日志；EOF/退出走正常 finally
      enterRepl: async () => {
        const streamFn = await loadStreamFn(streamFnSpec);
        // 作用域、grant 冷恢复种子（决策 3b）、MCP 启动与装配都在 application/session-runtime.ts
        //（决策 067，与 tui 的 /resume 换绑同一份）
        const opened = await openSessionRuntime({
          governanceRoot: workspaceRoot,
          sessionId,
          streamFn,
          flags,
          restoreGrants: true,
          // M6（决策 064）：主会话挂后台审阅（worker 会话作用域在装配内部排除）
          review: reviewConfigOf(flags),
          ...verifyOption(flags, workspaceRoot),
          ...attemptOptions(flags, streamFn, workspaceRoot),
          // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
          createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
          onMcpNote: (note) => {
            write(`[mcp] ${note}\n`);
          },
        });
        const { bundle } = opened;
        try {
          await runRepl({
            adapter: bundle.adapter,
            ask,
            write,
            grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
            // M5 S2（决策 038）：/search 内容级检索
            search: { root: workspaceRoot },
            // M7（决策 079）：/fork 手动分叉
            fork: forkHandlerOf(opened, workspaceRoot, flags, streamFn),
          });
        } finally {
          await disposeRuntime(bundle);
        }
      },
    });
  } finally {
    close();
  }
}

// pigeon run [任务描述] [--root <dir>] --stream-fn <模块路径> [--yolo] [--thinking <档位>] [--provider <p>]
//   [--model <m>] [--max-turns <N>] [--wall-clock <毫秒>] [--json]：headless 运行（M6.5 S1，决策 056）——
// 进程内 API runHeadless 的薄壳；任务描述缺省从 stdin 读；无审批通道，prompt 档 fail-closed；
// --json 退出时打印一行结构化结果；退出码按终态映射（HEADLESS_EXIT_CODES，1 为参数与装配错误）
async function runMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon run [任务描述] [--root <dir>] --stream-fn <模块路径> [--yolo] [--thinking <档位>] " +
    "[--max-turns <N>] [--wall-clock <毫秒>] [--max-output-tokens <n>] [--verify-command <命令>] [--verify-timeout <毫秒>] [--retry-on-fail <K>] [--repair-rounds <N>] [--json]（任务描述缺省从 stdin 读）";
  let task: string | undefined;
  let json = false;
  let maxTurns: number | undefined;
  let wallClockMs: number | undefined;
  let editMode: EditMode | undefined;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--json") {
      json = true;
    } else if (arg === "--edit-mode") {
      editMode = parseEditMode(argv[++i], usage);
    } else if (arg === "--max-turns" || arg === "--wall-clock") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${arg} 需要正整数（${usage}）`);
      }
      if (arg === "--max-turns") {
        maxTurns = value;
      } else {
        wallClockMs = value;
      }
    } else if (!arg.startsWith("--") && task === undefined) {
      task = arg;
    } else {
      modelArgv.push(arg);
      const next = argv[i + 1];
      if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
        modelArgv.push(next);
        i++;
      }
    }
  }
  const flags = parseLaunchFlags(modelArgv, { usage, verify: true, retry: true, repair: true });
  if (task === undefined) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    task = Buffer.concat(chunks).toString("utf8");
  }
  task = task.trim();
  if (task === "") {
    throw new Error(`任务描述为空（${usage}）`);
  }
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const workspaceRoot = prepareWorkspace(flags.root);
  // 决策 142 / 143：回炉轮数——启动参数 > 项目验证配置 > 关闭；设定不成立由 runHeadless 启动报错
  const repairRounds = resolveRepairRounds(flags, workspaceRoot);
  const result = await runHeadless({
    task,
    governanceRoot: workspaceRoot,
    workspaceRoot,
    streamFn,
    yolo: flags.yolo,
    ...(editMode !== undefined ? { editMode } : {}),
    provider: flags.provider,
    modelId: flags.modelId,
    persistThinking: flags.persistThinking,
    ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
    ...(flags.memoryBudgetChars !== undefined
      ? { memoryBudgetChars: flags.memoryBudgetChars }
      : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    ...verifyOption(flags, workspaceRoot),
    // M7（决策 079）：失败自动分叉重试；叶子验证后自动提炼
    ...attemptOptions(flags, streamFn, workspaceRoot),
    ...(repairRounds > 0 ? { repairRounds } : {}),
  });
  if (json) {
    // JSON.stringify 转义全部 C0 控制字符，一行输出不携带终端控制序列
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    writeOut(
      `会话 ${result.sessionId} ｜ 终态 ${result.status} ｜ 分类：${failureBadge(result.failure)} ｜ ` +
        `${result.turns} 轮 ｜ 工具调用 ${result.toolCalls} 次 ｜ 需审批 ${result.approvalsNeeded} 次 ｜ ` +
        `token ${result.usage.totalTokens}${result.retries !== undefined ? ` ｜ 重试 ${result.retries.map((retry) => retry.label).join("、")}` : ""} ｜ 标签 ${result.label}${result.verification !== undefined ? `（验证 ${result.verification.verdict}）` : ""}` +
        `${result.repair !== undefined ? ` ｜ ${repairSummary(result.repair)}` : ""}` +
        `${result.errorMessage !== undefined ? ` ｜ ${result.errorMessage}` : ""}\n`
    );
  }
  process.exitCode = HEADLESS_EXIT_CODES[result.status];
}

// pigeon eval <任务目录> --out <输出目录> [--runs N] --stream-fn <模块路径> [--yolo] [--thinking <档位>]
//   [--provider <p>] [--model <m>] [--skill <eval/skills/<name> 目录>] [--conditions none,candidate,approved]：
// Eval 冒烟（M6.5 S4，决策 059 / 060）——任务目录可以是任务集或单个任务；Skill 目录缺省取任务集同级 skills/ 下
// 唯一的那个；三个条件的 skillRoots 分别为空、<skill>/candidate、<skill>/approved；results.jsonl 与 report.md
// 写在输出目录，实验会话在输出目录的 .pigeon/ 下；重跑同一输出目录跳过已有的行
async function evalMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval <任务目录> --out <输出目录> [--runs N] --stream-fn <模块路径> [--yolo] " +
    "[--thinking <档位>] [--skill <Skill 目录>] [--conditions none,candidate,approved] [--edit-mode hashline|replace] " +
    "[--max-output-tokens <n>]";
  let tasksDir: string | undefined;
  let outDir: string | undefined;
  let runs = 3;
  let skillDir: string | undefined;
  let conditions: EvalCondition[] | undefined;
  let editMode: EditMode | undefined;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--out") {
      outDir = argv[++i];
    } else if (arg === "--skill") {
      skillDir = argv[++i];
    } else if (arg === "--runs") {
      runs = Number(argv[++i]);
      if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`--runs 需要正整数（${usage}）`);
      }
    } else if (arg === "--edit-mode") {
      editMode = parseEditMode(argv[++i], usage);
    } else if (arg === "--conditions") {
      const values = (argv[++i] ?? "").split(",").filter((value) => value !== "");
      const unknown = values.filter(
        (value) => !(EVAL_CONDITIONS as readonly string[]).includes(value)
      );
      if (values.length === 0 || unknown.length > 0) {
        throw new Error(`--conditions 只接受 ${EVAL_CONDITIONS.join("/")}（${usage}）`);
      }
      conditions = values as EvalCondition[];
    } else if (!arg.startsWith("--") && tasksDir === undefined) {
      tasksDir = arg;
    } else {
      modelArgv.push(arg);
      const next = argv[i + 1];
      if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
        modelArgv.push(next);
        i++;
      }
    }
  }
  if (tasksDir === undefined || outDir === undefined || outDir === "") {
    throw new Error(usage);
  }
  const flags = parseLaunchFlags(modelArgv, { usage, temperature: true });
  const tasks = loadEvalTasks(tasksDir);
  if (tasks.length === 0) {
    throw new Error(`任务目录下没有任务：${tasksDir}`);
  }
  const resolvedSkill = path.resolve(skillDir ?? defaultSkillDir(tasksDir));
  // 展示路径取 eval/ 所在目录的相对路径（如 eval/skills/<name>/candidate），随 run.started 的 Skill 清单落盘
  const labelBase = path.dirname(path.dirname(path.dirname(resolvedSkill)));
  const rootOf = (stage: "candidate" | "approved") => {
    const dir = path.join(resolvedSkill, stage);
    return { path: dir, label: path.relative(labelBase, dir).split(path.sep).join("/") };
  };
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const summary = await runEval({
    source: localTaskSource(tasks),
    skill: { candidate: rootOf("candidate"), approved: rootOf("approved") },
    outDir,
    runs,
    streamFn,
    yolo: flags.yolo,
    provider: flags.provider,
    modelId: flags.modelId,
    ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
    ...(conditions !== undefined ? { conditions } : {}),
    ...(editMode !== undefined ? { editMode } : {}),
    ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    ...(flags.temperature !== undefined ? { temperature: flags.temperature } : {}),
    onResult: (line) => {
      writeOut(
        `[eval] ${line.taskId} ｜ ${line.condition} ｜ ${line.editMode ?? LEGACY_RESULT_EDIT_MODE} ｜ 第 ${line.attempt} 次 ｜ ${line.status} ｜ ` +
          `${evalVerdictLabel(line.verdict)}${line.falsePositive ? "（误报）" : ""} ｜ ${line.turns} 轮 ｜ ` +
          `token ${line.usage.totalTokens} ｜ 会话 ${line.sessionId}${line.error !== undefined ? ` ｜ ${line.error}` : ""}\n`
      );
    },
  });
  writeOut(
    `[eval] 完成：本次运行 ${summary.ran} 次，跳过已有 ${summary.skipped} 次；` +
      `结果 ${summary.resultsFile}；报告 ${summary.reportFile}\n`
  );
}

// pigeon eval swebench --dataset <JSONL> --out <输出目录> --work-dir <判分工作目录> --python <解释器> --stream-fn <模块路径>
//   [--instances a,b,c] [--concurrency N] [--max-turns N] [--wall-clock-min N] [--container-memory <如 3g>] [--yolo] …：
// 外部基准跑批（M9，决策 097 / 102）——任务源换成 SWE-bench Verified，其余与 pigeon eval 同一个 runner：只跑无经验条件，
// 每题一次；agent 在该实例的评测容器里干活，收工取 diff 交官方判分器；重跑同一输出目录只补跑没有结果的题
async function evalSwebenchMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval swebench --dataset <JSONL> --out <输出目录> --work-dir <判分工作目录> --python <解释器> " +
    "--stream-fn <模块路径> [--instances a,b,c] [--concurrency N] [--temperature <0-2，缺省 0>] [--max-turns N] [--wall-clock-min N] " +
    "[--container-memory <上限>] [--judge-script <路径>] [--judge-proxy <地址|gateway:端口>] [--edit-mode hashline|replace] [--yolo]";
  const values = new Map<string, string>();
  const own = new Set([
    "--dataset",
    "--out",
    "--work-dir",
    "--python",
    "--instances",
    "--concurrency",
    "--max-turns",
    "--wall-clock-min",
    "--container-memory",
    "--judge-script",
    "--judge-proxy",
    "--edit-mode",
  ]);
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (own.has(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} 需要取值（${usage}）`);
      }
      values.set(arg, value);
    } else {
      modelArgv.push(arg);
      const next = argv[i + 1];
      if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
        modelArgv.push(next);
        i++;
      }
    }
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") {
      throw new Error(`缺 ${name}（${usage}）`);
    }
    return value;
  };
  const positive = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} 需要正整数（${usage}）`);
    }
    return value;
  };
  const flags = parseLaunchFlags(modelArgv, { usage, temperature: true });
  const editModeValue = values.get("--edit-mode");
  const memory = values.get("--container-memory");
  const source = swebenchTaskSource({
    datasetFile: required("--dataset"),
    workDir: required("--work-dir"),
    python: required("--python"),
    judgeScript:
      values.get("--judge-script") ??
      fileURLToPath(new URL("../../eval/swebench/judge.py", import.meta.url)),
    budget: {
      maxTurns: positive("--max-turns", 80),
      wallClockMs: positive("--wall-clock-min", 20) * 60_000,
    },
    ...(values.has("--instances")
      ? {
          instanceIds: required("--instances")
            .split(",")
            .filter((id) => id !== ""),
        }
      : {}),
    ...(memory !== undefined ? { containerRunArgs: ["--memory", memory] } : {}),
    // 只作用于判分阶段的评测容器；agent 的工作区容器不受影响
    ...(values.has("--judge-proxy") ? { judgeProxy: required("--judge-proxy") } : {}),
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const summary = await runEval({
    source,
    outDir: required("--out"),
    runs: 1,
    conditions: ["none"],
    concurrency: positive("--concurrency", 1),
    streamFn,
    yolo: flags.yolo,
    provider: flags.provider,
    modelId: flags.modelId,
    ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
    ...(editModeValue !== undefined ? { editMode: parseEditMode(editModeValue, usage) } : {}),
    ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    // 110：外部基准缺省固定温度 0，要改必须显式传 --temperature
    temperature: swebenchTemperature(flags.temperature),
    // 各路共用一个工作队列；模型服务持续不可用时暂停再取题，用满暂停次数就停止（退出码 3，之后同目录续跑）
    outage: { ...DEFAULT_OUTAGE },
    onResult: (line) => {
      writeOut(
        `[eval] ${line.taskId} ｜ ${line.status} ｜ ${evalVerdictLabel(line.verdict)} ｜ ${line.turns} 轮 ｜ ` +
          `token ${line.usage.totalTokens} ｜ ${Math.round((line.wallMs ?? 0) / 1000)} 秒 ｜ 会话 ${line.sessionId}` +
          `${line.error !== undefined ? ` ｜ ${line.error}` : ""}\n`
      );
    },
  });
  writeOut(
    `[eval] 完成：本次运行 ${summary.ran} 次，跳过已有 ${summary.skipped} 次；` +
      `结果 ${summary.resultsFile}；报告 ${summary.reportFile}\n`
  );
  if (summary.stopped !== undefined) {
    writeOut(`[eval] 已停止取新题：${summary.stopped}\n`);
    process.exitCode = 3;
  }
}

// pigeon eval swebench-verify（M9）：对外部基准跑批里提炼出的候选做回放验证。被验证的尝试在容器工作区里跑的，
// 没有宿主 git 工作树可开：回放由任务源对同一实例重新准备环境、照原尝试的尺子重跑、用任务源的判据命令判分；
// 四组、固定 N、三值结论与回执同 pigeon verify（084、089）。候选所在的治理根即 --root
async function evalSwebenchVerifyMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval swebench-verify --root <候选所在的治理根> --candidate <哈希前缀|种类/名字> --dataset <JSONL> " +
    "--work-dir <判分工作目录> --python <解释器> --stream-fn <模块路径> [--n N（缺省 5）] [--effect 0-1（缺省 0.4）] " +
    "[--concurrency N] [--edit-mode hashline|replace] [--container-memory <上限>] [--judge-script <路径>] " +
    "[--judge-proxy <地址|gateway:端口>]";
  const own = new Set([
    "--root",
    "--candidate",
    "--dataset",
    "--work-dir",
    "--python",
    "--n",
    "--effect",
    "--concurrency",
    "--edit-mode",
    "--container-memory",
    "--judge-script",
    "--judge-proxy",
  ]);
  const values = new Map<string, string>();
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (own.has(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} 需要取值（${usage}）`);
      }
      values.set(arg, value);
    } else {
      modelArgv.push(arg);
      const next = argv[i + 1];
      if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
        modelArgv.push(next);
        i++;
      }
    }
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") {
      throw new Error(`缺 ${name}（${usage}）`);
    }
    return value;
  };
  const numberOf = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) {
      return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`${name} 需要数值（${usage}）`);
    }
    return value;
  };
  const flags = parseLaunchFlags(modelArgv, { usage });
  const memory = values.get("--container-memory");
  const source = swebenchTaskSource({
    datasetFile: required("--dataset"),
    workDir: required("--work-dir"),
    python: required("--python"),
    judgeScript:
      values.get("--judge-script") ??
      fileURLToPath(new URL("../../eval/swebench/judge.py", import.meta.url)),
    // 实例自带的预算在回放里不用：回放沿用原尝试冻结的预算
    budget: { maxTurns: 100, wallClockMs: 20 * 60_000 },
    ...(memory !== undefined ? { containerRunArgs: ["--memory", memory] } : {}),
    ...(values.has("--judge-proxy") ? { judgeProxy: required("--judge-proxy") } : {}),
  });
  const governanceRoot = prepareWorkspace(required("--root"));
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, usage));
  const editModeValue = values.get("--edit-mode");
  const editMode =
    editModeValue !== undefined ? parseEditMode(editModeValue, usage) : DEFAULT_EDIT_MODE;
  let harness: { commit: string; dirty: boolean };
  try {
    harness = describeHead(fileURLToPath(new URL(".", import.meta.url)));
  } catch {
    harness = { commit: "unknown", dirty: false };
  }
  const n = numberOf("--n");
  const effect = numberOf("--effect");
  const concurrency = numberOf("--concurrency");
  const { record, errors } = await verifyCandidate({
    governanceRoot,
    selector: required("--candidate"),
    // 回执环境里的判据：任务源的判分命令（数据集与判分脚本），超时取判分的缺省上限
    verify: {
      command: `任务源 ${source.name} 的判分命令（数据集 ${required("--dataset")}）`,
      timeoutMs: 40 * 60_000,
    },
    harness,
    planFor: taskSourcePlanFor(source.name),
    dispatcherFor: ({ nameSeed }) =>
      createTaskSourceRerunDispatcher({
        hostGovernanceRoot: governanceRoot,
        source,
        streamFn,
        editMode,
        nameSeed,
      }),
    ...(n !== undefined ? { n } : {}),
    ...(effect !== undefined ? { effectThreshold: effect } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    onRerun: (run) => {
      writeOut(
        `[verify] ${run.arm} #${run.index} ｜ ${evalVerdictLabel(run.verdict)} ｜ ${run.status} ｜ ${run.turns} 轮 ｜ ` +
          `token ${run.totalTokens} ｜ ${Math.round(run.durationMs / 1000)} 秒 ｜ 会话 ${run.sessionId}` +
          `${run.error !== undefined ? ` ｜ ${run.error}` : ""}\n`
      );
    },
  });
  writeOut(
    `[verify] 结论：${record.conclusion}（正回放差 ${record.positiveDelta.toFixed(2)}，负回放差 ${record.negativeDelta.toFixed(2)}，` +
      `每组 ${record.n} 次，门槛 ${record.effectThreshold}）；回执 ${record.id}\n`
  );
  for (const arm of record.arms) {
    writeOut(`[verify] ${JSON.stringify(arm)}\n`);
  }
  for (const error of errors) {
    process.stderr.write(
      `[verify] 内部故障：${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

// --edit-mode 取值（决策 061）：单值 hashline 或 replace
function parseEditMode(value: string | undefined, usage: string): EditMode {
  if (value === undefined || !isEditMode(value)) {
    throw new Error(`--edit-mode 只接受 ${EDIT_MODES.join("/")}（${usage}）`);
  }
  return value;
}

// pigeon eval compare --baseline <目录> --candidate <目录> [--condition none] [--out <文件>]：编辑模式对照报告
// （决策 061）——两个 Eval 输出目录按编辑模式汇总与逐任务对比，缺省写到候选目录下的 compare.md
function evalCompareMain(argv: string[]): void {
  const usage =
    "用法：pigeon eval compare --baseline <目录> --candidate <目录> [--condition none] [--out <文件>]";
  let baselineDir: string | undefined;
  let candidateDir: string | undefined;
  let condition: EvalCondition = "none";
  let outFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--baseline") {
      baselineDir = argv[++i];
    } else if (arg === "--candidate") {
      candidateDir = argv[++i];
    } else if (arg === "--condition") {
      const value = argv[++i];
      if (value === undefined || !(EVAL_CONDITIONS as readonly string[]).includes(value)) {
        throw new Error(`--condition 只接受 ${EVAL_CONDITIONS.join("/")}（${usage}）`);
      }
      condition = value as EvalCondition;
    } else if (arg === "--out") {
      outFile = argv[++i];
    } else {
      throw new Error(`未知参数：${arg}（${usage}）`);
    }
  }
  if (baselineDir === undefined || candidateDir === undefined) {
    throw new Error(usage);
  }
  const report = renderEditModeComparison({ baselineDir, candidateDir, condition });
  const target = outFile ?? path.join(candidateDir, "compare.md");
  writeFileSync(target, report);
  writeOut(`[eval compare] 报告 ${target}\n`);
}

// 缺省 Skill 目录：任务集同级 skills/ 下唯一的子目录
function defaultSkillDir(tasksDir: string): string {
  const resolved = path.resolve(tasksDir);
  const tasksRoot = existsSync(path.join(resolved, "task.json"))
    ? path.dirname(resolved)
    : resolved;
  const skillsRoot = path.join(path.dirname(tasksRoot), "skills");
  const names = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  if (names.length !== 1) {
    throw new Error(`无法确定 Skill 目录：${skillsRoot} 下应恰有一个子目录，请用 --skill 指定`);
  }
  return path.join(skillsRoot, names[0] ?? "");
}

async function main(argv: string[]): Promise<void> {
  // M7（ROADMAP §M7）：启动时探测上游版本，与已验证版本不一致时明确告警
  for (const warning of probeUpstreamVersions().warnings) {
    process.stderr.write(`${warning}\n`);
  }
  if (argv[0] === "eval" && argv[1] === "compare") {
    evalCompareMain(argv.slice(2));
    return;
  }
  if (argv[0] === "eval" && argv[1] === "swebench-verify") {
    await evalSwebenchVerifyMain(argv.slice(2));
    return;
  }
  if (argv[0] === "eval" && argv[1] === "swebench") {
    await evalSwebenchMain(argv.slice(2));
    return;
  }
  if (argv[0] === "eval") {
    await evalMain(argv.slice(1));
    return;
  }
  if (argv[0] === "run") {
    await runMain(argv.slice(1));
    return;
  }
  if (argv[0] === "trace") {
    traceMain(argv.slice(1));
    return;
  }
  if (argv[0] === "replay") {
    replayMain(argv.slice(1));
    return;
  }
  if (argv[0] === "session" && argv[1] === "list") {
    sessionListMain(argv.slice(2));
    return;
  }
  if (argv[0] === "resume") {
    await resumeMain(argv.slice(1));
    return;
  }
  // M6（决策 064 / 065）：手动补审与候选列表
  if (argv[0] === "review") {
    await reviewMain(argv.slice(1));
    return;
  }
  // M7（决策 077）：由账本重建会话树
  if (argv[0] === "tree" && argv[1] === "rebuild") {
    const sessionArg = argv[2];
    if (sessionArg === undefined) {
      throw new Error("用法：pigeon tree rebuild <sessionId> [--root <dir>]");
    }
    const rootIndex = argv.indexOf("--root");
    const root = prepareWorkspace(
      rootIndex >= 0 ? (argv[rootIndex + 1] ?? process.cwd()) : process.cwd()
    );
    writeOut(
      `${await runTreeRebuildCommand({ governanceRoot: root, sessionId: asSessionId(sessionArg) })}\n`
    );
    return;
  }
  // M7（决策 074）：手动提炼
  if (argv[0] === "distill") {
    await distillMain(argv.slice(1));
    return;
  }
  if (argv[0] === "candidates") {
    candidatesMain(argv.slice(1));
    return;
  }
  // M8（决策 086）：人工触发回放验证
  if (argv[0] === "verify") {
    await verifyMain(argv.slice(1));
    return;
  }
  const startUsage =
    "支持 --yolo / --no-persist-thinking / --memory-budget / --thinking / --max-output-tokens / --review-every / --no-review / --verify-command / --verify-timeout / --auto-verify / --retry-on-fail / --root / --stream-fn / --provider / --model";
  const flags = parseLaunchFlags(argv, {
    usage: startUsage,
    review: true,
    verify: true,
    retry: true,
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, startUsage));
  // 工作区准备（决策 034）：realpath 规范化（工具路径围栏以它为准）
  const workspaceRoot = prepareWorkspace(flags.root);
  // M8（决策 091 / 093）：已激活经验的漂移与批准失效，会话开始前如实说一次（不阻止使用）
  emitActivationNotes(workspaceRoot, flags);
  const write = writeOut;
  const { ask, close } = createAsker(process.stdin, write);
  const sessionId = newSessionId();
  // 会话运行面装配（决策 067）：MCP 启动、作用域与装配失败收口都在 application/session-runtime.ts
  const opened = await openSessionRuntime({
    governanceRoot: workspaceRoot,
    sessionId,
    streamFn,
    flags,
    // M6（决策 064）：主会话挂后台审阅
    review: reviewConfigOf(flags),
    ...verifyOption(flags, workspaceRoot),
    ...attemptOptions(flags, streamFn, workspaceRoot),
    // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
    createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
    onMcpNote: (note) => {
      write(`[mcp] ${note}\n`);
    },
  });
  const { bundle } = opened;
  try {
    await runRepl({
      adapter: bundle.adapter,
      ask,
      write,
      grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
      // M5 S2（决策 038）：/search 内容级检索
      search: { root: workspaceRoot },
      // M7（决策 079）：/fork 手动分叉
      fork: forkHandlerOf(opened, workspaceRoot, flags, streamFn),
    });
  } finally {
    close();
    await disposeRuntime(bundle);
  }
}

// 仅作为入口直接运行时执行；被 import 时不启动 REPL
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// M8（决策 091 / 093）：启动告警打到 stderr——与上游版本探测同一口径，不进账本、不阻止启动。
// 环境由 application 层的 startupEnvironmentOf 统一构造（M8 收口修复：两个入口此前各自硬传空预算）
function emitActivationNotes(governanceRoot: string, flags: LaunchFlags): void {
  for (const note of activationStartupWarnings(
    governanceRoot,
    startupEnvironmentOf(flags, governanceRoot)
  )) {
    process.stderr.write(`${note}
`);
  }
}

// 决策 142 / 143：回炉摘要——用了几轮、最终验证结论、是否撤回（预算耗尽而提前撤回另行标注）
function repairSummary(
  repair: NonNullable<Awaited<ReturnType<typeof runHeadless>>["repair"]>
): string {
  return (
    `回炉 ${repair.rounds} 轮 ｜ 最终验证 ${repair.verdict ?? "未验证"}` +
    (repair.closed ? "" : " ｜ 这一步未收尾") +
    (repair.reverted
      ? ` ｜ 已撤回${repair.budgetExhausted ? "（预算耗尽提前撤回）" : ""}` +
        (repair.restored
          ? ""
          : `（工作区未恢复${repair.restoreError !== undefined ? "" : "：没有改动"}）`)
      : "")
  );
}

// M7（决策 071）/ M8（决策 081）：会话级验证命令——启动参数 > 项目配置 > 未配置（未配置时不传）
function verifyOption(
  flags: LaunchFlags,
  governanceRoot: string
): {
  verify?: NonNullable<ReturnType<typeof resolveVerifyConfig>>;
} {
  const verify = resolveVerifyConfig(flags, governanceRoot);
  return verify !== undefined ? { verify } : {};
}

// M7（决策 079 / 074）：失败自动分叉重试次数与叶子验证后的提炼器运行面（与主会话同一模型接入）；
// M8（决策 086）：--auto-verify 开着且验证命令可得时，提炼落库后自动把新候选验一遍
function attemptOptions(
  flags: LaunchFlags,
  streamFn: Awaited<ReturnType<typeof loadStreamFn>>,
  governanceRoot: string
): {
  retryOnFail?: number;
  distill: {
    createRuntime: ReturnType<typeof createWorkerRuntimeFactory>;
    autoVerify?: ReturnType<typeof autoVerifyWiring>;
  };
} {
  const verify = resolveVerifyConfig(flags, governanceRoot);
  return {
    ...(flags.retryOnFail !== undefined ? { retryOnFail: flags.retryOnFail } : {}),
    distill: {
      createRuntime: createWorkerRuntimeFactory({
        streamFnFor: () => streamFn,
        provider: flags.provider,
        modelId: flags.modelId,
        persistThinking: flags.persistThinking,
      }),
      ...(flags.autoVerify && verify !== undefined
        ? {
            autoVerify: autoVerifyWiring(governanceRoot, verify, streamFn, flags.persistThinking),
          }
        : {}),
    },
  };
}

// M7（决策 079）：/fork 手动分叉——分支沿用本会话的模型接入、审批模式与验证命令
function forkHandlerOf(
  opened: Awaited<ReturnType<typeof openSessionRuntime>>,
  governanceRoot: string,
  flags: LaunchFlags,
  streamFn: Awaited<ReturnType<typeof loadStreamFn>>
): (args: string) => Promise<string> {
  return (args) =>
    runForkCommand({
      governanceRoot,
      opened,
      args,
      run: {
        streamFn,
        provider: flags.provider,
        modelId: flags.modelId,
        yolo: flags.yolo,
        persistThinking: flags.persistThinking,
        ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
        ...verifyOption(flags, governanceRoot),
      },
    });
}
