// Pigeon M3 极简 CLI 入口（决策 3：REPL 内联审批，单进程最小闭环，不依赖 M2 TUI）。
// 决策 267：pigeon 不带子命令即启动终端界面（以子进程运行 tui 入口，Actor 之间不互相 import）；命令行对话留作后备，
// 由 --line 进入，只保证不坏、不再加新功能（不注册 spawn_worker）。决策 286：顶层帮助补上终端界面的 --continue 与
// --resume（参数由 tui 入口解析）；只改帮助文字，eval stream 与 pigeon run 的行为不变。
// M2 S1（决策 025）：装配根（buildRuntime）在 application/runtime.ts，审批 handler 由本入口
// 注入 REPL 问答版；resume 对账流程在 application/resume.ts，本文件只做参数解析与 IO 接线。
// 用法：node src/cli/index.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   --stream-fn / PIGEON_STREAM_FN：默认导出 StreamFn 的模块
//   （形状 (model, context, options?) => AssistantMessageEventStream，与测试 fixtures 的 fake
//   streamFn 同型；provider 密钥等由该模块自行从环境变量读取）。
//   未配置时清晰报错退出，不静默失败。

import { spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handbackJobsNotice } from "../application/background-jobs.ts";
import { runForkCommand } from "../application/fork-command.ts";
import { failureBadge } from "../application/format.ts";
import type { GrantsCommandContext } from "../application/grants.ts";
import { HEADLESS_EXIT_CODES, runHeadless } from "../application/headless-core.ts";
import {
  type LaunchFlags,
  orchestrationSettingsOf,
  parseLaunchFlags,
  resolveStreamFnSpec,
  VALUELESS_FLAGS,
  webToolsOptionOf,
} from "../application/launch-flags.ts";
import { LOOP_GUARD_TEXTS } from "../application/loop-guard.ts";
import { MIGRATE_CONFIG_USAGE, runMigrateConfig } from "../application/migrate-config.ts";
import { runResumeFlow } from "../application/resume.ts";
import {
  disposeRuntime,
  loadStreamFn,
  type MemoryWriteConfig,
  type RuntimeBundle,
} from "../application/runtime.ts";
import {
  closeSandbox,
  exportSandbox,
  runHeadlessInSandbox,
  runSandboxCommand,
  SANDBOX_FORK_UNSUPPORTED,
  type Sandbox,
  sandboxStatusFacts,
  startSandbox,
} from "../application/sandbox-session.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import { openSessionRuntime, pushedMemoryRunOptions } from "../application/session-runtime.ts";
import {
  openSessionSettings,
  parseTrustAnswer,
  TRUST_CONFIG_FLAG,
  type TrustChoice,
  trustPromptText,
} from "../application/session-settings.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import { gatewayAccountsFromEnv } from "../eval/model-gateway.ts";
import { streamTemperature } from "../eval/stream-agents.ts";
import {
  CLASSES_SUMMARY_FILE,
  installTerminationHandler,
  runStreamBaselines,
  runStreamClasses,
  runStreamExperiment,
} from "../eval/stream-experiment.ts";
import { loadExternalAgentConfig } from "../eval/stream-external.ts";
import {
  assembleImageContext,
  generateStreamManifest,
  STREAM_RUNTIMES,
  summarizeManifest,
} from "../eval/stream-generate.ts";
import { currentHarnessRef, describeHarness } from "../eval/stream-harness.ts";
import {
  markHumanGateFailures,
  type StreamManifest,
  TASK_PROMPT_FORMATS,
  type TaskPromptFormat,
} from "../eval/stream-manifest.ts";
import { runStreamRejudge } from "../eval/stream-rejudge.ts";
import {
  isExternalCondition,
  STREAM_CONDITIONS,
  type StreamCondition,
} from "../eval/stream-results.ts";
import { DEFAULT_STEP_BUDGET } from "../eval/stream-runner.ts";
import { memoryWriteNoticeLine } from "../memory/update-memory-tool.ts";
import { DEFAULT_GATEWAY_MODEL_ID, GATEWAY_PROVIDER } from "../pi-runtime/index.ts";
import { probeUpstreamVersions } from "../pi-runtime/upstream-version.ts";
import type { TrustEntry } from "../state/config-trust.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import { BUNDLE_ROLE_ENV, FROM_BUNDLE, packageFileUrl } from "../state/package-paths.ts";
import { pigeonRel } from "../state/paths.ts";
import {
  repetitionGuardSettings,
  truncationContinuationSettings,
} from "../state/runaway-config.ts";
import type { SessionListFilters } from "../state/session-summary.ts";
import { loopGuardSettingsOf, withHooksDisabled } from "../state/settings.ts";
import { EDIT_MODES, type EditMode, isEditMode } from "../tools/edit-mode.ts";
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
// 不需要模型接入，永不写会话文件/工作区（只经只读读取器读，见 trace.ts）
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
// D4 一次性渲染）——不需要模型接入，永不写会话文件/工作区，绝不重新执行真实副作用
// （只经只读读取器读，见 replay.ts）；与 trace 的按轮分组视图相区别
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
// 只读渲染（派生不落库），不需要模型接入，永不写会话文件/工作区
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
    layeredRules: bundle.settings.grants,
    sessionId,
    write,
  };
}

// pigeon resume <sessionId> [--yolo] [--root <dir>] --stream-fn <模块路径> [--provider <p>]
//   [--model <m>]：在同一会话下续跑 REPL（M4 S5；决策 183）——对话上下文由会话文件还原，悬空的工具调用
// 补"结果未知、请自行核实"的工具结果由 agent 核对；后续 Run 接着写入本会话；系统永不自动重新执行（§3.2）
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
    "用法：pigeon resume <sessionId> [--yolo] [--root <dir>] --stream-fn <模块路径> [--provider <p>] [--model <m>] [--no-hooks] [--no-web]";
  if (sessionIdArg === undefined) {
    throw new Error(usage);
  }
  const sessionId = asSessionId(sessionIdArg);
  const modelUsage = `支持 ${SESSION_FLAGS_HINT}`;
  const flags = parseLaunchFlags(modelArgv, {
    usage: modelUsage,
    pushedMemory: true,
    sandbox: true,
  });
  const streamFnSpec = resolveStreamFnSpec(flags, modelUsage);
  // 工作区准备（决策 034）：realpath 规范化，与 tui 入口同一份
  const workspaceRoot = prepareWorkspace(flags.root);
  const write = writeOut;
  const { ask, close } = createAsker(process.stdin, write);
  try {
    // 决策 325、326：旧布局检查、设置快照与会执行命令的条目的确认（行内问答）
    let settings = await openSessionSettings(workspaceRoot, {
      confirmation: { kind: "interactive", ask: lineTrustAsker(ask, write) },
      notice: (line) => write(`${line}\n`),
    });
    // 决策 324：命令行对话（resume 进的 REPL 与 --line）不接钩子——无论旗标与否一律停用全部钩子
    settings = withHooksDisabled(settings);
    await runResumeFlow({
      root: workspaceRoot,
      sessionId: sessionIdArg,
      write,
      // 进入 REPL：同一 sessionId 续写会话；EOF/退出走正常 finally
      enterRepl: async () => {
        const streamFn = await loadStreamFn(streamFnSpec);
        // 决策 237：沙箱会话从它交回过的分支新开容器接着干
        const sandbox = await startSandbox({
          flags,
          governanceRoot: workspaceRoot,
          settings,
          sessionId,
          resume: true,
          log: sandboxLog(write),
        });
        // 作用域（worker 会话回到它自己的工作树与委派策略）、grant 冷恢复种子（决策 3b）、对话上下文还原（决策 183）、
        // MCP 启动与装配都在 application/session-runtime.ts（决策 067，与 tui 的 /resume 换绑同一份）
        const opened = await openSessionRuntime({
          governanceRoot: workspaceRoot,
          settings,
          sessionId,
          streamFn,
          flags,
          resume: true,
          ...(sandbox !== undefined
            ? { workspaceHost: sandbox.host, statusFacts: sandboxStatusFacts(sandbox) }
            : {}),
          ...webToolsOptionOf(flags, settings),
          // 决策 331：有人对话，带记忆工具；写入后打印一行记下的内容与层级
          memoryWrite: lineMemoryWrite(write),
          // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
          createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
          onMcpNote: (note) => {
            write(`[mcp] ${note}\n`);
          },
        }).catch(async (error: unknown) => {
          await sandbox?.discard().catch(() => {});
          throw error;
        });
        const { bundle } = opened;
        // 决策 330：人写的说明超出上限被截断时提示一行
        if (bundle.instructionsNotice !== undefined) write(`${bundle.instructionsNotice}\n`);
        if (bundle.toolsNotice !== undefined) write(`${bundle.toolsNotice}\n`);
        try {
          await runRepl({
            adapter: bundle.adapter,
            ask,
            write,
            grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
            // M5 S2（决策 038）：/search 内容级检索
            search: { root: workspaceRoot },
            // M7（决策 079）：/fork 手动分叉（沙箱里不支持，说明原因）
            fork:
              sandbox !== undefined
                ? async () => SANDBOX_FORK_UNSUPPORTED
                : forkHandlerOf(opened, workspaceRoot, flags, streamFn),
            ...sandboxReplOptions(sandbox, bundle),
          });
        } finally {
          warnSandboxJobs(sandbox, bundle, write);
          await disposeRuntime(bundle);
          await finishSandbox(sandbox, write);
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
    "[--max-turns <N>] [--wall-clock <毫秒>] [--no-hooks] [--no-web] [--no-pushed-memory] [--no-spawn-workers] [--worker-concurrency <n>] [--worker-limit <n>] [--max-output-tokens <n>] [--context-window <n>] [--compact-threshold <n>] [--compact-keep <n>] " +
    "[--sandbox [--sandbox-network on|off] [--sandbox-approval yolo|prompt] [--sandbox-from-head]] [--trust-config] [--json]（任务描述缺省从 stdin 读；--trust-config 只对本次放行未确认的会执行命令或放权的配置）";
  let task: string | undefined;
  let json = false;
  let maxTurns: number | undefined;
  let wallClockMs: number | undefined;
  let editMode: EditMode | undefined;
  // 决策 326 ③、341：只对本次运行放行未确认的会执行命令或放权的配置（不记下）
  let trustConfig = false;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--json") {
      json = true;
    } else if (arg === TRUST_CONFIG_FLAG) {
      trustConfig = true;
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
  const flags = parseLaunchFlags(modelArgv, {
    usage,
    pushedMemory: true,
    sandbox: true,
    spawnWorkers: true,
  });
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
  // 决策 325、326：旧布局检查与设置快照；未确认的会执行命令的配置在开跑前报错退出（--trust-config 只对本次放行）
  let settings = await openSessionSettings(workspaceRoot, {
    confirmation: { kind: "unattended", trustConfig },
  });
  // 决策 324：--no-hooks 只对本次运行停用全部钩子
  if (flags.noHooks) settings = withHooksDisabled(settings);
  // 决策 297–303：编排设定——设置的 orchestration 一节（缺失取缺省），--worker-concurrency 与 --worker-limit 优先
  const orchestration = orchestrationSettingsOf(flags, settings);
  // 决策 308：打转检测——设置的 loopGuard 一节（缺失取缺省即开着）
  const loopGuard = loopGuardSettingsOf(settings);
  const runOptions = {
    task,
    governanceRoot: workspaceRoot,
    settings,
    workspaceRoot,
    streamFn,
    yolo: flags.yolo,
    ...(editMode !== undefined ? { editMode } : {}),
    provider: flags.provider,
    modelId: flags.modelId,
    persistThinking: flags.persistThinking,
    ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    ...(flags.compaction !== undefined ? { compaction: flags.compaction } : {}),
    // 决策 191、244：推送记忆缺省开着（--no-pushed-memory 关掉）；无人值守
    pushedMemory: flags.pushedMemory,
    // 决策 264–267：主 agent 派 worker 缺省开着（--no-spawn-workers 关掉）；--sandbox 时由 headless 略过（沙箱里不派 worker）
    spawnWorkers: flags.spawnWorkers,
    // 决策 309：脚本编排随派 worker 打开，任务描述算作点名
    scriptOrchestration: flags.spawnWorkers,
    orchestration,
    // 决策 294 B1：任务清单按编排配置（缺省开）
    taskList: orchestration.taskList,
    // 决策 287–291：联网工具缺省给出，--sandbox-network off 不给
    ...webToolsOptionOf(flags, settings),
    loopGuard,
  };
  // 决策 237：--sandbox 在一次性容器里跑，返回前交回成分支并删除容器；提示行写标准错误，不混进 --json 的一行结果
  const result =
    flags.sandbox !== undefined
      ? await runHeadlessInSandbox(
          { ...runOptions, sessionId: newSessionId() },
          { flags, log: (line) => process.stderr.write(`[沙箱] ${line}\n`) }
        )
      : await runHeadless(runOptions);
  if (json) {
    // JSON.stringify 转义全部 C0 控制字符，一行输出不携带终端控制序列
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    writeOut(
      `会话 ${result.sessionId} ｜ 终态 ${result.status} ｜ 分类：${failureBadge(result.failure)} ｜ ` +
        `${result.turns} 轮 ｜ 工具调用 ${result.toolCalls} 次 ｜ 需审批 ${result.approvalsNeeded} 次 ｜ ` +
        `token ${result.usage.totalTokens} ｜ 标签 ${result.label}` +
        `${result.errorMessage !== undefined ? ` ｜ ${result.errorMessage}` : ""}\n`
    );
  }
  // 决策 307：打转叫停的收尾说明（终态一行之后；--json 时已在结果里）
  if (!json && result.looping !== undefined) {
    writeOut(`${LOOP_GUARD_TEXTS.runStopped(result.looping)}\n`);
  }
  if ("sandboxNotice" in result && result.sandboxNotice !== undefined) {
    process.stderr.write(`[沙箱] ${result.sandboxNotice}\n`);
  }
  process.exitCode = HEADLESS_EXIT_CODES[result.status];
}

// pigeon eval stream-manifest --repo-profile pigeon|strands --repo <人的仓库> --range <起点>..<终点> --image <镜像> --out <清单文件>
//   [--test-timeout-sec N]：延续式实验出题（决策 127、141、153）——在断网的参考容器里逐提交测判题探针与格式化比对，
// 按写死的规则出流清单；清单与探针原始记录各存一个文件
// pigeon eval stream-baseline --manifest <清单> --repo <人的仓库> --image <镜像> --out <基准目录>
//   [--concurrency N（缺省 1）] [--container-memory <上限>（缺省 2g）] [--streams s1,s2] [--check cases|gate|both|classes]：
// 提前单独算人的基准——每路一个独立的参考容器，按提交落盘，同一目录重跑即续算；eval stream 以 --baseline 读取。
// 同时做开跑前置检查：人的代码逐个提交跑验证门，列出没过的提交与步（--check 缺省两者都做）。--check classes 为全部题
// 预计算两类用例（214，正式跑与校准之前须算好），写汇总文件 classes-summary.json
async function evalStreamBaselineMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval stream-baseline --manifest <清单> --repo <人的仓库> --image <镜像> --out <基准目录> " +
    "[--concurrency N] [--container-memory <上限>] [--streams s1,s2] [--check cases|gate|both|classes] " +
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
  if (check !== "cases" && check !== "gate" && check !== "both" && check !== "classes")
    throw new Error(`--check 只能是 cases、gate、both 或 classes（${usage}）`);
  const common = {
    manifestFile: required("--manifest"),
    repoDir: required("--repo"),
    image: required("--image"),
    outDir: required("--out"),
    concurrency,
    containerRunArgs: ["--memory", values.get("--container-memory") ?? STREAM_CONTAINER_MEMORY],
    ...(streams !== undefined ? { streams } : {}),
    log: (line: string) => process.stderr.write(`[baseline] ${new Date().toISOString()} ${line}\n`),
  };
  // 两类用例（214）：全部题逐题在 commit 与叠放到 parent 上各跑两遍，按提交落盘，同一目录重跑即续算
  if (check === "classes") {
    const classes = await runStreamClasses(common);
    const zero = classes.steps.filter((s) => s.failToPass === 0);
    process.stdout.write(
      `两类用例：共 ${classes.total} 道题，本次算 ${classes.computed} 道，此前已落盘 ${classes.cached} 道，` +
        `出错 ${classes.failed.length} 道；要做到的为零的题 ${zero.length} 道` +
        `${zero.length > 0 ? `（题号 ${zero.map((s) => s.task).join(",")}）` : ""}；汇总写到 ${CLASSES_SUMMARY_FILE}\n`
    );
    process.stdout.write(
      `无法建立基线的题 ${classes.unbuildable.length} 道${
        classes.unbuildable.length > 0
          ? `（题号 ${classes.unbuildable.map((u) => u.task).join(",")}，跑批时不判分、不进主判据）`
          : ""
      }\n`
    );
    for (const f of classes.failed) {
      process.stdout.write(`  题 ${f.task}（${f.commit}）：${f.error.slice(0, 300)}\n`);
    }
    if (classes.failed.length > 0) process.exitCode = 1;
    return;
  }
  const summary = await runStreamBaselines({ ...common, check });
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

// pigeon eval stream-rejudge --manifest <清单> --repo <人的仓库> --image <镜像> --baseline <基准目录> --out <正式跑输出目录>
//   [--classes-image <镜像>] [--tasks 步序,步序] [--limit N] [--concurrency N（缺省 1）] [--container-memory <上限>（缺省 2g）]：
// 按保存的改动重判（270 ①、316）：不重跑 agent，照正式跑同一判题路径重判各行，取完整的逐用例结果，与原结果行逐项核对；
// 结果写到 <输出目录>/rejudge/cases.jsonl，原结果行不改，已有的行跳过
async function evalStreamRejudgeMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval stream-rejudge --manifest <清单> --repo <人的仓库> --image <镜像> --baseline <基准目录> " +
    "--out <正式跑输出目录> [--classes-image <镜像>] [--tasks 步序,步序] [--limit N] [--concurrency N] " +
    "[--container-memory <上限>]";
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
  const positive = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} 需要正整数（${usage}）`);
    return n;
  };
  const tasks = values.get("--tasks");
  const seqs = tasks
    ?.split(",")
    .filter((x) => x !== "")
    .map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--tasks 需要步序列表（${usage}）`);
      return n;
    });
  const limit = positive("--limit");
  const concurrency = positive("--concurrency");
  const classesImage = values.get("--classes-image");
  const summary = await runStreamRejudge({
    manifestFile: required("--manifest"),
    repoDir: required("--repo"),
    image: required("--image"),
    baselineDir: required("--baseline"),
    outDir: required("--out"),
    containerRunArgs: ["--memory", values.get("--container-memory") ?? STREAM_CONTAINER_MEMORY],
    ...(classesImage !== undefined ? { classesImage } : {}),
    ...(seqs !== undefined ? { seqs } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    log: (line) =>
      process.stderr.write(`[rejudge] ${new Date().toISOString()} ${line}
`),
  });
  process.stdout.write(
    `重判：选中 ${summary.selected} 行，此前已做 ${summary.skipped} 行；本次一致 ${summary.consistent} 行，` +
      `不一致 ${summary.inconsistent.length} 行，出错 ${summary.errors.length} 行；结果写到 ${summary.file}
`
  );
  for (const x of summary.inconsistent)
    process.stdout.write(`  不一致 ${x.key}：${x.mismatches.join("；")}
`);
  for (const x of summary.errors)
    process.stdout.write(`  出错 ${x.key}：${x.error.slice(0, 300)}
`);
  if (summary.errors.length > 0) process.exitCode = 1;
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
//   [--attempts N] [--concurrency N（缺省 4）] [--max-steps K（试跑：只跑前 K 道题）] [--max-turns N（缺省 150）]
//   [--wall-clock-min N（缺省 30）] [--model-id <模型>（缺省 deepseek-flash）] [--mini-python <解释器>]
//   [--container-memory <上限>（缺省 2g）] [--baseline <人的基准目录>] [--prompt-format test-files|test-cases]
//   [--spend-limit-cny <元>] [--compact-threshold <n>] [--compact-keep <n>]（上下文压缩的触发点与保留量，缺省为产品缺省；
//   集成冒烟调低触发点验证压缩，决策 218）
//   [--tasks 题号,…（按题号选题）| --sample K [--seed N]（从要做到的不为零的题中按种子抽 K 道，缺省种子 20260927）]
//   [--accept-harness-change "<原因>"（续跑时代码版本不符的显式放行，记进身份头与报告）]
//   [--allow-dirty-harness（首次开跑时放行未提交改动或读不到的提交号，开发自测用，记进身份头与报告）]：
// 提交流实验（第三至六节；193 固定起点）——清单里的题按时间接成一条流，每个条件为一个作业，每一步新开容器（内置条件
// 断网，外部 agent 条件接只通模型网关的网络）从人在该步之前的代码做、判、全量测量、写结果行；无人值守：Pigeon 各条件一律放权（yolo），不看 --yolo；
// 各条件的模型请求都经跑批进程内置的网关（决策 155、234），上游为 DeepSeek；一个 key 一个账号：DEEPSEEK_API_KEY 为
// 账号 1，DEEPSEEK_API_KEY_2、_3… 依次为后续账号，各账号并发上限取 DEEPSEEK_API_KEY_<编号>_CONCURRENCY（缺省 2500）；
// 花费上限 --spend-limit-cny（人民币元，决策 235）：经网关的全部请求累计到上限即停批，缺省不设；
// 外部 agent 条件（实验设施）：--external-agent <配置文件> 可重复给，每份配置定义一个条件 ext-<名字>，可与现有条件混写在
// --conditions 里；其作业容器接只通模型网关的跑批内部网络（宿主上的配置文件见 src/eval/stream-external.ts）。
// 外部条件的请求体逐字转发，网关不做兼容改写；有的客户端库会给工具定义加 "type": "custom"（例如 litellm 的
// Anthropic 线路），DeepSeek 的 Anthropic 兼容端点见到它会回 400（unknown variant `custom`），这类 agent 须自己去掉该字段；
// 撞上限续跑与流式重复检测（决策 367）：--continuation、--continuation-max-consecutive、--continuation-max-per-run、
// --repetition-guard、--repetition-mode、--repetition-preset，只对 Pigeon 条件生效，缺省同产品缺省，生效值记进身份头；
// 同一输出目录重跑即从断点续跑
const STREAM_CONTAINER_MEMORY = "2g";

async function evalStreamMain(argv: string[]): Promise<void> {
  const usage =
    "用法：pigeon eval stream --manifest <清单> --repo <人的仓库> --image <镜像> --out <输出目录> " +
    `--conditions ${STREAM_CONDITIONS.join(",")}[,ext-<名字>…] [--external-agent <配置文件>]… [--attempts N] [--concurrency N] [--max-steps K] ` +
    "[--max-turns N] [--wall-clock-min N] [--model-id <模型>] [--mini-python <装有 mini-swe-agent 的解释器>] " +
    "[--container-memory <上限，缺省 2g>] [--baseline <人的基准目录>] [--prompt-format test-files|test-cases] " +
    "[--spend-limit-cny <元>] [--compact-threshold <n>] [--compact-keep <n>] " +
    "[--memory-limit <项目级记忆的字符数上限，缺省 4000>] " +
    "[--continuation on|off] [--continuation-max-consecutive <n，缺省 2>] [--continuation-max-per-run <n，缺省 5>] " +
    "[--repetition-guard on|off] [--repetition-mode abort|log] [--repetition-preset omp|wide] " +
    "[--background-closeout-seconds <n，缺省 600；0 为收尾不等、直接停掉作业>] " +
    "[--tasks 题号,题号… | --sample K [--seed N（缺省 20260927）]] " +
    '[--accept-harness-change "<原因>"] [--allow-dirty-harness]';
  const own = new Set([
    "--accept-harness-change",
    "--manifest",
    "--repo",
    "--image",
    "--out",
    "--conditions",
    "--prompt-format",
    "--attempts",
    "--concurrency",
    "--max-steps",
    "--tasks",
    "--sample",
    "--seed",
    "--max-turns",
    "--wall-clock-min",
    "--model-id",
    "--mini-python",
    "--container-memory",
    "--baseline",
    "--spend-limit-cny",
    "--memory-limit",
    "--continuation",
    "--continuation-max-consecutive",
    "--continuation-max-per-run",
    "--repetition-guard",
    "--repetition-mode",
    "--repetition-preset",
    "--background-closeout-seconds",
  ]);
  const values = new Map<string, string>();
  const modelArgv: string[] = [];
  // 外部 agent 的配置文件：可重复给
  const externalAgentFiles: string[] = [];
  // 不带取值的开关：不交给模型参数的解析
  let allowDirtyHarness = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--allow-dirty-harness") {
      allowDirtyHarness = true;
    } else if (arg === "--external-agent") {
      const value = argv[++i];
      if (value === undefined || value === "")
        throw new Error(`--external-agent 需要配置文件（${usage}）`);
      externalAgentFiles.push(value);
    } else if (own.has(arg)) {
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
    if (!(STREAM_CONDITIONS as readonly string[]).includes(c) && !isExternalCondition(c)) {
      throw new Error(
        `未知条件 ${c}（可选 ${STREAM_CONDITIONS.join("、")}，或 ext-<外部 agent 的名字>）`
      );
    }
  }
  if (conditions.length === 0) throw new Error(`缺 --conditions（${usage}）`);
  const needsPigeon = conditions.some((c) => c !== "minimal" && !isExternalCondition(c));
  // 外部 agent 的配置在开跑前解析、校验（与所跑条件的对应在 runStreamExperiment 里查）
  const externalAgents = externalAgentFiles.map((file) => loadExternalAgentConfig(file));
  const memoryLimitChars = positive("--memory-limit");
  const oneOf = <T extends string>(name: string, choices: readonly T[]): T | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    if (!(choices as readonly string[]).includes(raw)) {
      throw new Error(`${name} 可选 ${choices.join("、")}（${usage}）`);
    }
    return raw as T;
  };
  // 决策 365：无人值守收尾等后台作业的总时限（只对 Pigeon 条件生效；缺省同产品缺省，生效值记进身份头）
  const closeoutRaw = values.get("--background-closeout-seconds");
  const backgroundCloseoutSeconds = closeoutRaw === undefined ? undefined : Number(closeoutRaw);
  if (
    backgroundCloseoutSeconds !== undefined &&
    (!Number.isInteger(backgroundCloseoutSeconds) || backgroundCloseoutSeconds < 0)
  ) {
    throw new Error(`--background-closeout-seconds 需要非负整数（${usage}）`);
  }
  // 决策 367：撞上限续跑与流式重复检测（只对 Pigeon 条件生效；没给的项取产品缺省）
  const continuationSwitch = oneOf("--continuation", ["on", "off"] as const);
  const maxConsecutive = positive("--continuation-max-consecutive");
  const maxPerRun = positive("--continuation-max-per-run");
  const truncationContinuation = truncationContinuationSettings({
    ...(continuationSwitch !== undefined ? { enabled: continuationSwitch === "on" } : {}),
    ...(maxConsecutive !== undefined ? { maxConsecutive } : {}),
    ...(maxPerRun !== undefined ? { maxPerRun } : {}),
  });
  const repetitionSwitch = oneOf("--repetition-guard", ["on", "off"] as const);
  const repetitionMode = oneOf("--repetition-mode", ["abort", "log"] as const);
  const repetitionPreset = oneOf("--repetition-preset", ["omp", "wide"] as const);
  const repetition = repetitionGuardSettings({
    ...(repetitionSwitch !== undefined ? { enabled: repetitionSwitch === "on" } : {}),
    ...(repetitionMode !== undefined ? { mode: repetitionMode } : {}),
    ...(repetitionPreset !== undefined ? { preset: repetitionPreset } : {}),
  });
  if ("problem" in repetition) throw new Error(`流式重复检测参数不对：${repetition.problem}`);
  const flags = parseLaunchFlags(modelArgv, { usage, temperature: true });
  const accounts = gatewayAccountsFromEnv(process.env);
  const modelId = values.get("--model-id") ?? DEFAULT_GATEWAY_MODEL_ID;
  const pigeon = needsPigeon
    ? {
        provider: GATEWAY_PROVIDER,
        modelId,
        // 缺省固定温度 0（110）
        temperature: streamTemperature(flags.temperature),
        ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
        ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
        // 决策 218：压缩阈值用产品缺省；集成冒烟可经参数调低
        ...(flags.compaction !== undefined ? { compaction: flags.compaction } : {}),
        // 推送格（191、332）：项目级记忆的上限，没给即缺省
        ...(memoryLimitChars !== undefined ? { memoryLimitChars } : {}),
        truncationContinuation,
        repetitionGuard: repetition.settings,
        ...(backgroundCloseoutSeconds !== undefined ? { backgroundCloseoutSeconds } : {}),
      }
    : undefined;
  const promptFormat = values.get("--prompt-format");
  if (
    promptFormat !== undefined &&
    !(TASK_PROMPT_FORMATS as readonly string[]).includes(promptFormat)
  ) {
    throw new Error(`未知题面格式 ${promptFormat}（可选 ${TASK_PROMPT_FORMATS.join("、")}）`);
  }
  const attempts = positive("--attempts");
  const concurrency = positive("--concurrency");
  const maxSteps = positive("--max-steps");
  // 选题（202、219）：题号为清单里的题按时间接成的流中的序号（从 1 起）；抽样只在要做到的用例不为零的题中抽
  const tasks = list("--tasks")?.map((t) => {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--tasks 需要正整数题号（${usage}）`);
    return n;
  });
  const sampleK = positive("--sample");
  const seed = positive("--seed");
  if (seed !== undefined && sampleK === undefined)
    throw new Error(`--seed 只配合 --sample 用（${usage}）`);
  // 作业容器与参考容器缺省 2g：人的基准逐遍记录内存峰值，超过上限的 75% 即告警
  const memory = values.get("--container-memory") ?? STREAM_CONTAINER_MEMORY;
  const miniPython = values.get("--mini-python");
  const baselineDir = values.get("--baseline");
  const spendLimitRaw = values.get("--spend-limit-cny");
  const spendLimitCny = spendLimitRaw === undefined ? undefined : Number(spendLimitRaw);
  if (spendLimitCny !== undefined && !(Number.isFinite(spendLimitCny) && spendLimitCny > 0)) {
    throw new Error(`--spend-limit-cny 需要正数（${usage}）`);
  }
  // 代码版本的显式放行（269）：原因为空即报错
  const acceptHarnessChange = values.get("--accept-harness-change");
  if (acceptHarnessChange !== undefined && acceptHarnessChange.trim() === "") {
    throw new Error(`--accept-harness-change 的原因不能为空（${usage}）`);
  }
  const minimalCommand =
    miniPython !== undefined
      ? [miniPython, fileURLToPath(packageFileUrl("eval/stream/mini/run_mini.py"))]
      : undefined;
  // SIGTERM（systemd 停服、整机关机）：在途的步作废、不再取新步，硬时限内自行退出
  const shutdown = new AbortController();
  const removeTermHandler = installTerminationHandler(
    process,
    (reason) => {
      writeOut(`[stream] ${reason}\n`);
      shutdown.abort(reason);
    },
    (code) => process.exit(code)
  );
  const summary = await runStreamExperiment({
    shutdownSignal: shutdown.signal,
    gateway: { accounts, modelId, ...(spendLimitCny !== undefined ? { spendLimitCny } : {}) },
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
    ...(minimalCommand !== undefined ? { minimalCommand } : {}),
    ...(externalAgents.length > 0 ? { externalAgents } : {}),
    ...(promptFormat !== undefined ? { promptFormat: promptFormat as TaskPromptFormat } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(sampleK !== undefined
      ? { sample: { k: sampleK, ...(seed !== undefined ? { seed } : {}) } }
      : {}),
    containerRunArgs: ["--memory", memory],
    ...(baselineDir !== undefined ? { baselineDir } : {}),
    harnessAllowance: {
      ...(acceptHarnessChange !== undefined ? { acceptHarnessChange } : {}),
      ...(allowDirtyHarness ? { allowDirtyHarness } : {}),
    },
    // 带时间戳：试跑时据此把每步的耗时与内存采样对上
    log: (line) => writeOut(`[stream] ${new Date().toISOString()} ${line}\n`),
  }).finally(removeTermHandler);
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

function parseEditMode(value: string | undefined, usage: string): EditMode {
  if (value === undefined || !isEditMode(value)) {
    throw new Error(`--edit-mode 只接受 ${EDIT_MODES.join("/")}（${usage}）`);
  }
  return value;
}

export async function main(argv: string[]): Promise<void> {
  // M7（ROADMAP §M7）：启动时探测上游版本，与已验证版本不一致时明确告警
  for (const warning of probeUpstreamVersions().warnings) {
    process.stderr.write(`${warning}\n`);
  }
  const route = routeTopLevel(argv);
  if (route.kind === "help") {
    writeOut(`${TOP_LEVEL_HELP}\n`);
    return;
  }
  if (route.kind === "version") {
    writeOut(`pigeon ${pigeonVersion()}（${describeHarness(currentHarnessRef())}）\n`);
    return;
  }
  if (route.kind === "tui") {
    await launchTui(route.argv);
    return;
  }
  if (route.kind === "line") {
    await lineMain(route.argv);
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
  if (argv[0] === "eval" && argv[1] === "stream-rejudge") {
    await evalStreamRejudgeMain(argv.slice(2));
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
  // pigeon sandbox list | clean：残留的沙箱容器
  if (argv[0] === "sandbox") {
    writeOut(await runSandboxCommand(argv.slice(1)));
    return;
  }
  if (argv[0] === "migrate-config") {
    migrateConfigMain(argv.slice(1));
    return;
  }
  throw new Error(`未知子命令：${argv[0]}（${TOP_LEVEL_HELP}）`);
}

// 顶层子命令：不带子命令即终端界面，--line 为命令行对话
const SUBCOMMANDS = new Set([
  "eval",
  "run",
  "trace",
  "replay",
  "session",
  "resume",
  "sandbox",
  "migrate-config",
]);

// pigeon migrate-config [--root <dir>]（决策 325）：旧配置并入三层设置、旧位置的程序状态移入 .pigeon/state/；可重复执行
function migrateConfigMain(argv: string[]): void {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root" && argv[i + 1] !== undefined) {
      root = argv[++i] ?? root;
    } else {
      throw new Error(`未知参数：${flag}（${MIGRATE_CONFIG_USAGE}）`);
    }
  }
  const result = runMigrateConfig(realpathSync(root));
  writeOut(`${result.lines.join("\n")}\n`);
}

export type TopLevelRoute =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "tui"; argv: string[] }
  | { kind: "line"; argv: string[] }
  | { kind: "subcommand" };

// 决策 267：pigeon 不带子命令即启动终端界面；带 --line 进命令行对话（--line 本身不交给参数解析）
export function routeTopLevel(argv: readonly string[]): TopLevelRoute {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") {
    return { kind: "help" };
  }
  if (first === "--version") {
    return { kind: "version" };
  }
  if (first !== undefined && SUBCOMMANDS.has(first)) {
    return { kind: "subcommand" };
  }
  if (argv.includes("--line")) {
    return { kind: "line", argv: argv.filter((arg) => arg !== "--line") };
  }
  return { kind: "tui", argv: [...argv] };
}

// 终端界面入口（tui/main.ts）：与本文件同在 src 下
export const TUI_ENTRY = fileURLToPath(new URL("../tui/main.ts", import.meta.url));

// 终端界面子进程的参数（node 之后的部分）与附加环境变量（决策 351）：由入口决定。从源码启动的，子进程跑源码的 tui 入口；
// 从打包产物启动的，子进程跑同一个产物（moduleUrl 即产物地址），开 source map，经环境变量由产物入口分派到终端界面
export function tuiChildCommand(
  fromBundle: boolean,
  moduleUrl: string,
  execArgv: readonly string[],
  argv: readonly string[]
): { args: string[]; env?: Record<string, string> } {
  if (!fromBundle) {
    return { args: [...execArgv, fileURLToPath(new URL("../tui/main.ts", moduleUrl)), ...argv] };
  }
  return {
    args: [...execArgv, "--enable-source-maps", fileURLToPath(moduleUrl), ...argv],
    env: { [BUNDLE_ROLE_ENV]: "tui" },
  };
}

// 以子进程启动终端界面：继承终端，退出码原样带回。Ctrl+C 由界面自己处理（双击退出），本进程在其运行期间不响应
async function launchTui(argv: readonly string[]): Promise<void> {
  const ignore = (): void => {};
  process.on("SIGINT", ignore);
  const command = tuiChildCommand(FROM_BUNDLE, import.meta.url, process.execArgv, argv);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, command.args, {
        stdio: "inherit",
        ...(command.env !== undefined ? { env: { ...process.env, ...command.env } } : {}),
      });
      child.on("error", reject);
      child.on("exit", (exitCode, signal) => {
        resolve(exitCode ?? (signal !== null ? 1 : 0));
      });
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", ignore);
  }
}

// pigeon --line [参数]：命令行对话（决策 267：后备入口，只保证不坏）
async function lineMain(argv: string[]): Promise<void> {
  const startUsage = `pigeon --line 支持 ${SESSION_FLAGS_HINT}`;
  const flags = parseLaunchFlags(argv, {
    usage: startUsage,
    pushedMemory: true,
    sandbox: true,
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, startUsage));
  // 工作区准备（决策 034）：realpath 规范化（工具路径围栏以它为准）
  const workspaceRoot = prepareWorkspace(flags.root);
  const write = writeOut;
  const { ask, close } = createAsker(process.stdin, write);
  const sessionId = newSessionId();
  // 决策 237：--sandbox 先开容器（与沙箱不相容的参数在起容器之前报错）
  let sandbox: Sandbox | undefined;
  let opened: Awaited<ReturnType<typeof openSessionRuntime>>;
  try {
    // 决策 325、326：旧布局检查、设置快照与会执行命令的条目的确认（行内问答）
    const readSettings = await openSessionSettings(workspaceRoot, {
      confirmation: { kind: "interactive", ask: lineTrustAsker(ask, write) },
      notice: (line) => write(`${line}\n`),
    });
    // 决策 324：--line 不接钩子——无论旗标与否一律停用全部钩子
    const settings = withHooksDisabled(readSettings);
    sandbox = await startSandbox({
      flags,
      governanceRoot: workspaceRoot,
      settings,
      sessionId,
      log: sandboxLog(write),
    });
    // 会话运行面装配（决策 067）：MCP 启动、作用域与装配失败收口都在 application/session-runtime.ts
    opened = await openSessionRuntime({
      governanceRoot: workspaceRoot,
      settings,
      sessionId,
      streamFn,
      flags,
      ...(sandbox !== undefined
        ? { workspaceHost: sandbox.host, statusFacts: sandboxStatusFacts(sandbox) }
        : {}),
      ...webToolsOptionOf(flags, settings),
      // 决策 331：有人对话，带记忆工具；写入后打印一行记下的内容与层级
      memoryWrite: lineMemoryWrite(write),
      // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
      createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
      onMcpNote: (note) => {
        write(`[mcp] ${note}\n`);
      },
    });
  } catch (error) {
    close();
    await sandbox?.discard().catch(() => {});
    throw error;
  }
  const { bundle } = opened;
  // 决策 330：人写的说明超出上限被截断时提示一行
  if (bundle.instructionsNotice !== undefined) write(`${bundle.instructionsNotice}\n`);
  if (bundle.toolsNotice !== undefined) write(`${bundle.toolsNotice}\n`);
  try {
    await runRepl({
      adapter: bundle.adapter,
      ask,
      write,
      grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
      // M5 S2（决策 038）：/search 内容级检索
      search: { root: workspaceRoot },
      // M7（决策 079）：/fork 手动分叉（沙箱里不支持，说明原因）
      fork:
        sandbox !== undefined
          ? async () => SANDBOX_FORK_UNSUPPORTED
          : forkHandlerOf(opened, workspaceRoot, flags, streamFn),
      ...sandboxReplOptions(sandbox, bundle),
    });
  } finally {
    close();
    warnSandboxJobs(sandbox, bundle, write);
    await disposeRuntime(bundle);
    await finishSandbox(sandbox, write);
  }
}

// pigeon --version：包根下 package.json 的版本（源码与打包产物运行时都在包根下）；读不出时如实写 unknown
export function pigeonVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(packageFileUrl("package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

// 顶层帮助（pigeon --help）与未知子命令提示
export const TOP_LEVEL_HELP = [
  "用法：",
  "  pigeon [参数]                 启动终端界面（--no-spawn-workers 关掉主 agent 派 worker；--worker-concurrency、--worker-limit 调两个上限）",
  "  pigeon --continue [参数]      在终端界面里续接本项目最近的会话",
  "  pigeon --resume [sessionId]   在终端界面里续接指定会话（不带会话号时弹出会话列表）",
  "  pigeon --line [参数]          命令行对话（后备入口）",
  "  pigeon run [任务描述] [参数]  无人值守运行一个任务",
  "  pigeon resume <sessionId>     在命令行对话里续跑一个会话",
  "  pigeon trace <sessionId>      查看一个会话的关联视图",
  "  pigeon replay <runId>         回放一次运行",
  "  pigeon session list           列出本项目的会话",
  "  pigeon sandbox list|clean     查看或清理残留的沙箱容器",
  `  pigeon migrate-config         把旧配置并入三层 settings.json、旧位置的程序状态移入 ${pigeonRel("state")}/`,
  "  pigeon sandbox cache|clear-cache  查看或清空沙箱共用的下载缓存（npm、pnpm、yarn、pip、uv、cargo、go）",
  "  pigeon eval stream|stream-baseline|stream-manifest|stream-image-context  实验跑批",
].join("\n");

// 命令行对话与续跑接受的启动参数
const SESSION_FLAGS_HINT =
  "--yolo / --no-persist-thinking / --no-pushed-memory / --no-hooks（本次运行不接钩子）/ --no-web（本次运行不给联网工具）/ --thinking / --max-output-tokens / --context-window / --compact-threshold / --compact-keep / --root / --stream-fn / --provider / --model / --sandbox / --sandbox-network on|off / --sandbox-approval yolo|prompt / --sandbox-from-head（只从最新提交开工，不带未提交的改动）";

// 决策 237：沙箱的提示行
// 决策 326 ③：命令行对话的行内问答确认会执行命令的配置（输入结束按退出处理）
function lineTrustAsker(
  ask: (prompt: string) => Promise<string | null>,
  write: (text: string) => void
): (entries: readonly TrustEntry[]) => Promise<TrustChoice> {
  return async (entries) => {
    for (;;) {
      const answer = await ask(`${trustPromptText(entries)}\n> `);
      if (answer === null) return "quit";
      const choice = parseTrustAnswer(answer);
      if (choice !== undefined) return choice;
      write("请输入 a、s 或 q\n");
    }
  };
}

function sandboxLog(write: (text: string) => void): (line: string) => void {
  return (line) => write(`[沙箱] ${line}\n`);
}

// 决策 245：沙箱里提供 /export 手动交回（决策 365：有后台作业在跑时先提示）
function sandboxReplOptions(
  sandbox: Sandbox | undefined,
  bundle: RuntimeBundle
): {
  exportChanges?: () => Promise<string>;
} {
  return sandbox !== undefined ? { exportChanges: () => exportSandbox(sandbox, bundle.jobs) } : {};
}

// 决策 365：收尾交回沙箱前有后台作业在跑先提示（随后随运行面释放停掉）
function warnSandboxJobs(
  sandbox: Sandbox | undefined,
  bundle: RuntimeBundle,
  write: (text: string) => void
): void {
  const warning = sandbox !== undefined ? handbackJobsNotice(bundle.jobs, "close") : undefined;
  if (warning !== undefined) write(`[沙箱] ${warning}\n`);
}

// 决策 245：会话结束时自动交回一次，交回后删除容器；写明分支名与查看命令
async function finishSandbox(
  sandbox: Sandbox | undefined,
  write: (text: string) => void
): Promise<void> {
  if (sandbox !== undefined) {
    write(`[沙箱] ${(await closeSandbox(sandbox)).notice}\n`);
  }
}

// 仅作为入口直接运行时执行；被 import 时不启动 REPL。打包产物里由产物入口（src/bundle-entry.ts）分派，这里不判断
if (
  !FROM_BUNDLE &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// 决策 331：命令行对话写记忆的入口——来源记"命令行对话"，写入后打印一行
function lineMemoryWrite(write: (text: string) => void): MemoryWriteConfig {
  return {
    source: "line",
    onWritten: (notice) => write(`${memoryWriteNoticeLine(notice)}\n`),
  };
}

// M7（决策 079）：/fork 手动分叉——分支沿用本会话的模型接入与审批模式
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
        ...(flags.compaction !== undefined ? { compaction: flags.compaction } : {}),
        ...pushedMemoryRunOptions(flags),
      },
    });
}
