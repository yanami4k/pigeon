// Pigeon M3 极简 CLI 入口（决策 3：REPL 内联审批，单进程最小闭环，不依赖 M2 TUI）。
// M2 S1（决策 025）：装配根（buildRuntime）在 application/runtime.ts，审批 handler 由本入口
// 注入 REPL 问答版；resume 对账流程在 application/resume.ts，本文件只做参数解析与 IO 接线。
// 用法：node src/cli/index.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   --stream-fn / PIGEON_STREAM_FN：默认导出 StreamFn 的模块
//   （形状 (model, context, options?) => AssistantMessageEventStream，与测试 fixtures 的 fake
//   streamFn 同型；provider 密钥等由该模块自行从环境变量读取）。
//   未配置时清晰报错退出，不静默失败。
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runForkCommand } from "../application/fork-command.ts";
import { evalVerdictLabel, failureBadge } from "../application/format.ts";
import type { GrantsCommandContext } from "../application/grants.ts";
import { HEADLESS_EXIT_CODES, runHeadless } from "../application/headless.ts";
import {
  type LaunchFlags,
  parseLaunchFlags,
  resolveRepairRounds,
  resolveStreamFnSpec,
  resolveStructuredMemoryEnabled,
  resolveVerifyConfig,
  VALUELESS_FLAGS,
} from "../application/launch-flags.ts";
import { runResumeFlow } from "../application/resume.ts";
import { disposeRuntime, loadStreamFn, type RuntimeBundle } from "../application/runtime.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { runTreeRebuildCommand } from "../application/session-tree.ts";
import {
  listStructuredMemory,
  renderStructuredMemoryList,
} from "../application/structured-memory.ts";
import { sessionRuntimeScope } from "../application/worker-scope.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import { renderEditModeComparison } from "../eval/compare.ts";
import { localTaskSource } from "../eval/local-source.ts";
import { DEFAULT_OUTAGE, runEval } from "../eval/runner.ts";
import { runStreamBaselines, runStreamExperiment } from "../eval/stream-experiment.ts";
import {
  assembleImageContext,
  generateStreamManifest,
  STREAM_RUNTIMES,
  summarizeManifest,
} from "../eval/stream-generate.ts";
import { markHumanGateFailures, type StreamManifest } from "../eval/stream-manifest.ts";
import { STREAM_CONDITIONS, type StreamCondition } from "../eval/stream-results.ts";
import { DEFAULT_STEP_BUDGET } from "../eval/stream-runner.ts";
import { swebenchTaskSource, swebenchTemperature } from "../eval/swebench-source.ts";
import { EVAL_CONDITIONS, type EvalCondition, loadEvalTasks } from "../eval/task.ts";
import { DEFAULT_GATEWAY_MODEL_ID } from "../pi-runtime/index.ts";
import { probeUpstreamVersions } from "../pi-runtime/upstream-version.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import type { SessionListFilters } from "../state/session-summary.ts";
import {
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
    "支持 --yolo / --no-persist-thinking / --memory-budget / --thinking / --max-output-tokens / --verify-command / --verify-timeout / --retry-on-fail / --root / --stream-fn / --provider / --model";
  const flags = parseLaunchFlags(modelArgv, {
    usage: modelUsage,
    verify: true,
    retry: true,
  });
  const streamFnSpec = resolveStreamFnSpec(flags, modelUsage);
  // 工作区准备（决策 034）：realpath 规范化，与 tui 入口同一份
  const workspaceRoot = prepareWorkspace(flags.root);
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
          ...verifyOption(flags, workspaceRoot),
          ...retryOption(flags),
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
    "[--max-turns <N>] [--wall-clock <毫秒>] [--max-output-tokens <n>] [--verify-command <命令>] [--verify-timeout <毫秒>] [--retry-on-fail <K>] [--repair-rounds <N>] [--no-structured-memory] [--json]（任务描述缺省从 stdin 读）";
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
  // 决策 134：结构化记忆开关——启动参数 > 项目配置 > 开启
  const structuredMemoryEnabled = resolveStructuredMemoryEnabled(flags, workspaceRoot);
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
    // M7（决策 079）：失败自动分叉重试
    ...retryOption(flags),
    ...(repairRounds > 0 ? { repairRounds } : {}),
    structuredMemory: { enabled: structuredMemoryEnabled },
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
        `${result.structuredMemory !== undefined ? ` ｜ ${structuredMemorySummaryText(result.structuredMemory, structuredMemoryEnabled)}` : ""}` +
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

// pigeon eval stream-manifest --repo-profile pigeon|strands --repo <人的仓库> --range <起点>..<终点> --image <镜像> --out <清单文件>
//   [--test-timeout-sec N]：延续式实验出题（决策 127、141、153）——在断网的参考容器里逐提交测判题探针与格式化比对，
// 按写死的规则出流清单；清单与探针原始记录各存一个文件
// pigeon eval stream-baseline --manifest <清单> --repo <人的仓库> --image <镜像> --out <基准目录>
//   [--concurrency N（缺省 1）] [--container-memory <上限>（缺省 2g）] [--streams s1,s2] [--check cases|gate|both]：
// 提前单独算全量测量的人的基准——每路一个独立的参考容器，按提交落盘，同一目录重跑即续算；eval stream 以 --baseline 读取。
// 同时做开跑前置检查：人的代码逐个提交跑验证门，列出没过的提交与步（--check 缺省两者都做）
async function evalStreamBaselineMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval stream-baseline --manifest <清单> --repo <人的仓库> --image <镜像> --out <基准目录> " +
    "[--concurrency N] [--container-memory <上限>] [--streams s1,s2] [--check cases|gate|both] " +
    "[--mark-manifest <写出的清单>]";
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === undefined || !arg.startsWith("--") || value === undefined) {
      throw new Error(`参数不对：${arg ?? ""}（${usage}）`);
    }
    values.set(arg, value);
    i++;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") throw new Error(`缺 ${name}（${usage}）`);
    return value;
  };
  const concurrency = Number(values.get("--concurrency") ?? "1");
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(`--concurrency 需要正整数（${usage}）`);
  const streams = values
    .get("--streams")
    ?.split(",")
    .filter((x) => x !== "");
  const check = values.get("--check") ?? "both";
  if (check !== "cases" && check !== "gate" && check !== "both")
    throw new Error(`--check 只能是 cases、gate 或 both（${usage}）`);
  const summary = await runStreamBaselines({
    manifestFile: required("--manifest"),
    repoDir: required("--repo"),
    image: required("--image"),
    outDir: required("--out"),
    concurrency,
    check,
    containerRunArgs: ["--memory", values.get("--container-memory") ?? STREAM_CONTAINER_MEMORY],
    ...(streams !== undefined ? { streams } : {}),
    log: (line) => process.stderr.write(`[baseline] ${new Date().toISOString()} ${line}\n`),
  });
  process.stdout.write(
    `人的基准（${check}）：共 ${summary.total} 个提交，本次算 ${summary.computed} 个，` +
      `此前已落盘 ${summary.cached} 个，出错 ${summary.failed.length} 个\n`
  );
  for (const f of summary.failed) process.stdout.write(`  ${f.commit}：${f.error.slice(0, 300)}\n`);
  if (check !== "cases") {
    process.stdout.write(
      `开跑前置检查：人的代码上验证门没过的提交 ${summary.gateFailures.length} 个\n`
    );
    for (const g of summary.gateFailures) {
      process.stdout.write(
        `  ${g.commit}（步 ${g.seqs.join(",")}）：${g.failedSteps.join("、") || "无法判定"}\n`
      );
    }
  }
  // 给清单打标记：人的代码没过验证门的步记 humanFailsGate（这些步照常跑，只作标记）
  const markTo = values.get("--mark-manifest");
  if (markTo !== undefined && check !== "cases" && summary.failed.length === 0) {
    const manifest = JSON.parse(readFileSync(required("--manifest"), "utf8")) as StreamManifest;
    const marked = markHumanGateFailures(
      manifest,
      summary.gateFailures.map((g) => g.commit)
    );
    writeFileSync(markTo, `${JSON.stringify(marked, null, 2)}\n`);
    process.stdout.write(
      `清单已打标记：${marked.steps.filter((s) => s.humanFailsGate === true).length} 步记为人的代码没过验证门，写到 ${markTo}\n`
    );
  }
  if (summary.failed.length > 0 || summary.gateFailures.length > 0) process.exitCode = 1;
}

async function evalStreamManifestMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval stream-manifest --repo-profile pigeon|strands --repo <人的仓库> --range <起点>..<终点> " +
    "--image <镜像> --out <清单文件> [--test-timeout-sec N] [--container-memory <上限>] [--concurrency N]";
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === undefined || !arg.startsWith("--") || value === undefined) {
      throw new Error(`参数不对：${arg ?? ""}（${usage}）`);
    }
    values.set(arg, value);
    i++;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") throw new Error(`缺 ${name}（${usage}）`);
    return value;
  };
  const runtime = STREAM_RUNTIMES[required("--repo-profile")];
  if (runtime === undefined) throw new Error(`--repo-profile 只能是 pigeon 或 strands（${usage}）`);
  const [rangeStart, rangeEnd] = required("--range").split("..");
  if (rangeStart === undefined || rangeStart === "" || rangeEnd === undefined || rangeEnd === "") {
    throw new Error(`--range 形如 <起点>..<终点>（${usage}）`);
  }
  const timeoutSec = Number(values.get("--test-timeout-sec") ?? "600");
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1)
    throw new Error(`--test-timeout-sec 需要正整数（${usage}）`);
  const manifest = await generateStreamManifest({
    repoDir: required("--repo"),
    runtime,
    rangeStart,
    rangeEnd,
    image: required("--image"),
    outFile: required("--out"),
    testTimeoutMs: timeoutSec * 1000,
    ...(values.has("--container-memory")
      ? { containerRunArgs: ["--memory", required("--container-memory")] }
      : {}),
    ...(values.has("--concurrency") ? { concurrency: Number(required("--concurrency")) } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${summarizeManifest(manifest)}\n`);
}

// pigeon eval stream --manifest <清单> --repo <人的仓库> --image <镜像> --out <输出目录> --conditions a,b
//   [--streams s1,s2] [--attempts N] [--concurrency N（缺省 4）] [--max-steps K（试跑）] [--max-turns N（缺省 150）]
//   [--wall-clock-min N（缺省 46）] [--model-id <模型>（缺省 kimi-for-coding）] [--mini-python <解释器>]
//   [--container-memory <上限>（缺省 2g）] [--baseline <人的基准目录>]：
// 延续式实验（第三至六节）——每条流乘以每个条件为一个作业，逐步在断网容器里做、判、落地或撤回、全量测量、写结果行；
// 无人值守：Pigeon 各条件一律放权（yolo），不看 --yolo；
// 四个条件的模型请求都经跑批进程内置的网关（决策 155），真 key 取自 KIMI_API_KEY 与可选的 KIMI_API_KEY_2；
// 同一输出目录重跑即从断点续跑
const STREAM_CONTAINER_MEMORY = "2g";

async function evalStreamMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval stream --manifest <清单> --repo <人的仓库> --image <镜像> --out <输出目录> " +
    "--conditions full,no-memory,no-gate,minimal [--streams s1] [--attempts N] [--concurrency N] [--max-steps K] " +
    "[--max-turns N] [--wall-clock-min N] [--model-id <模型>] [--mini-python <装有 mini-swe-agent 的解释器>] " +
    "[--container-memory <上限，缺省 2g>] [--baseline <人的基准目录>]";
  const own = new Set([
    "--manifest",
    "--repo",
    "--image",
    "--out",
    "--conditions",
    "--streams",
    "--attempts",
    "--concurrency",
    "--max-steps",
    "--max-turns",
    "--wall-clock-min",
    "--model-id",
    "--mini-python",
    "--container-memory",
    "--baseline",
  ]);
  const values = new Map<string, string>();
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (own.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要取值（${usage}）`);
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
    if (value === undefined || value === "") throw new Error(`缺 ${name}（${usage}）`);
    return value;
  };
  const positive = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 需要正整数（${usage}）`);
    return value;
  };
  const list = (name: string) =>
    values.has(name)
      ? required(name)
          .split(",")
          .filter((x) => x !== "")
      : undefined;
  const conditions = list("--conditions") ?? [];
  for (const c of conditions) {
    if (!(STREAM_CONDITIONS as readonly string[]).includes(c)) {
      throw new Error(`未知条件 ${c}（可选 ${STREAM_CONDITIONS.join("、")}）`);
    }
  }
  if (conditions.length === 0) throw new Error(`缺 --conditions（${usage}）`);
  const needsPigeon = conditions.some((c) => c !== "minimal");
  const flags = parseLaunchFlags(modelArgv, { usage, temperature: true });
  const keys = [process.env.KIMI_API_KEY, process.env.KIMI_API_KEY_2].filter(
    (k): k is string => k !== undefined && k !== ""
  );
  if (keys.length === 0) throw new Error("缺少 KIMI_API_KEY 环境变量：网关的真 key 从这里取");
  const modelId = values.get("--model-id") ?? DEFAULT_GATEWAY_MODEL_ID;
  const pigeon = needsPigeon
    ? {
        provider: "kimi-coding",
        modelId,
        // 与外部基准同一口径：缺省固定温度 0
        temperature: swebenchTemperature(flags.temperature),
        ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
        ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
      }
    : undefined;
  const streams = list("--streams");
  const attempts = positive("--attempts");
  const concurrency = positive("--concurrency");
  const maxSteps = positive("--max-steps");
  // 作业容器与参考容器缺省 2g：人的基准逐遍记录内存峰值，超过上限的 75% 即告警
  const memory = values.get("--container-memory") ?? STREAM_CONTAINER_MEMORY;
  const miniPython = values.get("--mini-python");
  const baselineDir = values.get("--baseline");
  const summary = await runStreamExperiment({
    gateway: { keys, modelId },
    manifestFile: required("--manifest"),
    repoDir: required("--repo"),
    image: required("--image"),
    outDir: required("--out"),
    conditions: conditions as StreamCondition[],
    budget: {
      maxTurns: positive("--max-turns") ?? DEFAULT_STEP_BUDGET.maxTurns,
      wallClockMs:
        (positive("--wall-clock-min") ?? DEFAULT_STEP_BUDGET.wallClockMs / 60_000) * 60_000,
    },
    ...(pigeon !== undefined ? { pigeon } : {}),
    ...(miniPython !== undefined
      ? {
          minimalCommand: [
            miniPython,
            fileURLToPath(new URL("../../eval/stream/mini/run_mini.py", import.meta.url)),
          ],
        }
      : {}),
    ...(streams !== undefined ? { streams } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    containerRunArgs: ["--memory", memory],
    ...(baselineDir !== undefined ? { baselineDir } : {}),
    // 带时间戳：试跑时据此把每步的耗时与内存采样对上
    log: (line) => writeOut(`[stream] ${new Date().toISOString()} ${line}\n`),
  });
  for (const job of summary.jobs) {
    writeOut(
      `[stream] ${job.key}：完成到第 ${job.completedTo ?? "—"} 步${job.stopped !== undefined ? `；停止：${job.stopped}` : ""}\n`
    );
  }
  writeOut(`[stream] 结果 ${summary.resultsFile}；报告 ${summary.reportFile}\n`);
  if (summary.jobs.some((j) => j.stopped !== undefined)) process.exitCode = 3;
}

// pigeon eval stream-image-context --repo-profile pigeon|strands|strands-lint --repo <人的仓库> --out <目录>
//   [--lock-rev <提交>] [--manifest <清单>（strands-lint 必给）]：
// 组装延续式跑批工作区镜像的构建上下文（决策 148），之后 docker build <目录>；strands-lint 为 strands 基础镜像之上的
// lint 层（按清单里要测的每个提交解析），docker build -f Dockerfile.lint <目录>
function evalStreamImageContextMain(argv: string[]): void {
  const usage =
    "用法：pigeon eval stream-image-context --repo-profile pigeon|strands|strands-lint --repo <人的仓库> --out <目录> " +
    "[--lock-rev <提交>] [--manifest <清单>]";
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === undefined || !arg.startsWith("--") || value === undefined) {
      throw new Error(`参数不对：${arg ?? ""}（${usage}）`);
    }
    values.set(arg, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") throw new Error(`缺 ${name}（${usage}）`);
    return value;
  };
  const lockRev = values.get("--lock-rev");
  const manifestFile = values.get("--manifest");
  const written = assembleImageContext({
    profileName: required("--repo-profile"),
    repoDir: required("--repo"),
    outDir: required("--out"),
    ...(lockRev !== undefined ? { lockRev } : {}),
    ...(manifestFile !== undefined
      ? { manifest: JSON.parse(readFileSync(manifestFile, "utf8")) as StreamManifest }
      : {}),
  });
  process.stdout.write(`${written.join("\n")}\n`);
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
  if (argv[0] === "eval" && argv[1] === "stream") {
    await evalStreamMain(argv.slice(2));
    return;
  }
  if (argv[0] === "eval" && argv[1] === "stream-image-context") {
    evalStreamImageContextMain(argv.slice(2));
    return;
  }
  if (argv[0] === "eval" && argv[1] === "stream-baseline") {
    await evalStreamBaselineMain(argv.slice(2));
    return;
  }
  if (argv[0] === "eval" && argv[1] === "stream-manifest") {
    await evalStreamManifestMain(argv.slice(2));
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
  // 决策 132 / 136：只读列出结构化记忆条目
  if (argv[0] === "memory" && argv[1] === "list") {
    memoryListMain(argv.slice(2));
    return;
  }
  if (argv[0] === "resume") {
    await resumeMain(argv.slice(1));
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
  const startUsage =
    "支持 --yolo / --no-persist-thinking / --memory-budget / --thinking / --max-output-tokens / --verify-command / --verify-timeout / --retry-on-fail / --root / --stream-fn / --provider / --model";
  const flags = parseLaunchFlags(argv, {
    usage: startUsage,
    verify: true,
    retry: true,
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, startUsage));
  // 工作区准备（决策 034）：realpath 规范化（工具路径围栏以它为准）
  const workspaceRoot = prepareWorkspace(flags.root);
  const write = writeOut;
  const { ask, close } = createAsker(process.stdin, write);
  const sessionId = newSessionId();
  // 会话运行面装配（决策 067）：MCP 启动、作用域与装配失败收口都在 application/session-runtime.ts
  const opened = await openSessionRuntime({
    governanceRoot: workspaceRoot,
    sessionId,
    streamFn,
    flags,
    ...verifyOption(flags, workspaceRoot),
    ...retryOption(flags),
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

// 决策 134：结构化记忆给了哪几条（开局一组、回炉每轮一组）
function structuredMemorySummaryText(
  summary: NonNullable<Awaited<ReturnType<typeof runHeadless>>["structuredMemory"]>,
  enabled: boolean
): string {
  if (!enabled) {
    return "结构化记忆 关闭";
  }
  const list = (ids: readonly string[]) => (ids.length > 0 ? ids.join("、") : "无");
  return (
    `结构化记忆 开局 ${list(summary.opening)}` +
    (summary.repair.length > 0
      ? `，回炉 ${summary.repair.map((round, index) => `第 ${index + 1} 轮 ${list(round)}`).join("；")}`
      : "")
  );
}

// pigeon memory list [--root <dir>] [--json]：只读列出当前项目的结构化记忆条目（决策 132 / 136）——
// 从账本现算、不回写缓存，不需要模型接入
function memoryListMain(argv: string[]): void {
  let root = process.cwd();
  let json = false;
  const usage = "用法：pigeon memory list [--root <dir>] [--json]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root") {
      root = argv[++i] ?? root;
    } else if (flag === "--json") {
      json = true;
    } else {
      throw new Error(`未知参数：${flag}（${usage}）`);
    }
  }
  const listing = listStructuredMemory(realpathSync(root));
  writeOut(json ? `${JSON.stringify(listing)}\n` : renderStructuredMemoryList(listing));
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

// M7（决策 079）：失败自动分叉重试次数
function retryOption(flags: LaunchFlags): { retryOnFail?: number } {
  return flags.retryOnFail !== undefined ? { retryOnFail: flags.retryOnFail } : {};
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
