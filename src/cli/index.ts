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
import { pathToFileURL } from "node:url";
import { evalVerdictLabel, failureBadge } from "../application/format.ts";
import type { GrantsCommandContext } from "../application/grants.ts";
import { HEADLESS_EXIT_CODES, runHeadless } from "../application/headless.ts";
import {
  parseLaunchFlags,
  resolveStreamFnSpec,
  VALUELESS_FLAGS,
} from "../application/launch-flags.ts";
import { runResumeFlow } from "../application/resume.ts";
import { disposeRuntime, loadStreamFn, type RuntimeBundle } from "../application/runtime.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { sessionRuntimeScope } from "../application/worker-scope.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import { renderEditModeComparison } from "../eval/compare.ts";
import { runEval } from "../eval/runner.ts";
import { EVAL_CONDITIONS, type EvalCondition, loadEvalTasks } from "../eval/task.ts";
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
    // M4 收口决策 ①：升格/移除留痕写入本会话事件日志
    eventLog: bundle.eventLog,
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
    "支持 --yolo / --no-persist-thinking / --memory-budget / --thinking / --max-output-tokens / --root / --stream-fn / --provider / --model";
  const flags = parseLaunchFlags(modelArgv, { usage: modelUsage });
  const streamFnSpec = resolveStreamFnSpec(flags, modelUsage);
  // 工作区准备（决策 034）：realpath 规范化 + D8 旧账本一次性迁移，与 tui 入口同一份
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
        const { bundle } = await openSessionRuntime({
          governanceRoot: workspaceRoot,
          sessionId,
          streamFn,
          flags,
          restoreGrants: true,
          // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
          createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
          onMcpNote: (note) => {
            write(`[mcp] ${note}\n`);
          },
        });
        try {
          await runRepl({
            adapter: bundle.adapter,
            ask,
            write,
            grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
            // M5 S2（决策 038）：/search 内容级检索
            search: { root: workspaceRoot },
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
    "[--max-turns <N>] [--wall-clock <毫秒>] [--max-output-tokens <n>] [--json]（任务描述缺省从 stdin 读）";
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
  const flags = parseLaunchFlags(modelArgv, { usage });
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
  });
  if (json) {
    // JSON.stringify 转义全部 C0 控制字符，一行输出不携带终端控制序列
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    writeOut(
      `会话 ${result.sessionId} ｜ 终态 ${result.status} ｜ 分类：${failureBadge(result.failure)} ｜ ` +
        `${result.turns} 轮 ｜ 工具调用 ${result.toolCalls} 次 ｜ 需审批 ${result.approvalsNeeded} 次 ｜ ` +
        `token ${result.usage.totalTokens}${result.errorMessage !== undefined ? ` ｜ ${result.errorMessage}` : ""}\n`
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
  const flags = parseLaunchFlags(modelArgv, { usage });
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
    tasks,
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
  if (argv[0] === "eval" && argv[1] === "compare") {
    evalCompareMain(argv.slice(2));
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
  const startUsage =
    "支持 --yolo / --no-persist-thinking / --memory-budget / --thinking / --max-output-tokens / --root / --stream-fn / --provider / --model";
  const flags = parseLaunchFlags(argv, { usage: startUsage });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, startUsage));
  // 工作区准备（决策 034）：realpath 规范化（工具路径围栏以它为准）+ D8 旧账本一次性迁移
  const workspaceRoot = prepareWorkspace(flags.root);
  const write = writeOut;
  const { ask, close } = createAsker(process.stdin, write);
  const sessionId = newSessionId();
  // 会话运行面装配（决策 067）：MCP 启动、作用域与装配失败收口都在 application/session-runtime.ts
  const { bundle } = await openSessionRuntime({
    governanceRoot: workspaceRoot,
    sessionId,
    streamFn,
    flags,
    // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
    createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
    onMcpNote: (note) => {
      write(`[mcp] ${note}\n`);
    },
  });
  try {
    await runRepl({
      adapter: bundle.adapter,
      ask,
      write,
      grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
      // M5 S2（决策 038）：/search 内容级检索
      search: { root: workspaceRoot },
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
