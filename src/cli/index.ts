// Pigeon M3 极简 CLI 入口（决策 3：REPL 内联审批，单进程最小闭环，不依赖 M2 TUI）。
// M2 S1（决策 025）：装配根（buildRuntime）在 application/runtime.ts，审批 handler 由本入口
// 注入 REPL 问答版；resume 对账流程在 application/resume.ts，本文件只做参数解析与 IO 接线。
// 用法：node src/cli/index.ts [--yolo] [--root <工作区根>] --stream-fn <模块路径>
//   --stream-fn / PIGEON_STREAM_FN：默认导出 StreamFn 的模块
//   （形状 (model, context, options?) => AssistantMessageEventStream，与测试 fixtures 的 fake
//   streamFn 同型；provider 密钥等由该模块自行从环境变量读取）。
//   未配置时清晰报错退出，不静默失败。
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runResumeFlow } from "../application/resume.ts";
import { buildRuntime, type RuntimeBundle } from "../application/runtime.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { migrateLegacyLedger } from "../persistence/legacy-migration.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import type { SessionListFilters } from "../state/session-summary.ts";
import { createCliApprovalHandler } from "./approval-ui.ts";
import type { GrantsCommandContext } from "./grants.ts";
import { createAsker, runRepl } from "./repl.ts";
import { runReplayCommand } from "./replay.ts";
import { runSessionListCommand } from "./session.ts";
import { runTraceCommand } from "./trace.ts";

// 加载用户提供的 StreamFn 模块（默认导出必须是函数）
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

// pigeon trace <sessionId> [--run <runId>] [--root <dir>]：只读关联视图（M4 S3）——
// 不需要模型接入，永不写事件日志/工作区（只走 materializeSession 读路径，见 trace.ts）
function traceMain(argv: string[]): void {
  let sessionId: string | undefined;
  let runId: string | undefined;
  let root = process.cwd();
  const usage = "用法：pigeon trace <sessionId> [--run <runId>] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--run") {
      runId = argv[++i];
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
  process.stdout.write(
    runTraceCommand({
      root: realpathSync(root),
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
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
  const usage = "用法：pigeon replay <runId> [--session <sessionId>] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--session") {
      sessionId = argv[++i];
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
  process.stdout.write(
    runReplayCommand({
      root: realpathSync(root),
      runId,
      ...(sessionId !== undefined ? { sessionId } : {}),
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
  process.stdout.write(runSessionListCommand({ root: realpathSync(root), filters }));
}

// 模型接入 flags（start/resume 共用一套形状；resume 另加一个位置参数 sessionId）
interface ModelFlags {
  yolo: boolean;
  root: string;
  streamFnSpec?: string;
  provider: string;
  modelId: string;
}

function parseModelFlags(argv: string[], usage: string): ModelFlags {
  const flags: ModelFlags = {
    yolo: false,
    root: process.cwd(),
    provider: "custom",
    modelId: "cli",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--yolo") {
      flags.yolo = true;
    } else if (flag === "--root") {
      flags.root = argv[++i] ?? flags.root;
    } else if (flag === "--stream-fn") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--stream-fn 缺少取值（模块路径）");
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
    // 取值型 flag 的值也不以 -- 开头，一并带走（--yolo 无值）
    const next = argv[i + 1];
    if (arg !== "--yolo" && next !== undefined && !next.startsWith("--")) {
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
  const flags = parseModelFlags(
    modelArgv,
    "支持 --yolo / --root / --stream-fn / --provider / --model"
  );
  if (flags.streamFnSpec === undefined || flags.streamFnSpec === "") {
    throw new Error(
      "未配置模型接入：请用 --stream-fn <模块路径> 或环境变量 PIGEON_STREAM_FN 指定一个默认导出 " +
        "StreamFn 的模块（provider 密钥由该模块自行从环境变量读取）"
    );
  }
  const streamFnSpec = flags.streamFnSpec;
  const workspaceRoot = realpathSync(flags.root);
  // D8：M3 旧账本一次性迁移（resume 也走，旧会话恢复前先把账本事件化）
  migrateLegacyLedger(
    path.join(workspaceRoot, ".pigeon", "ledger.jsonl"),
    path.join(workspaceRoot, ".pigeon", "sessions")
  );
  const write = (text: string): void => {
    process.stdout.write(text);
  };
  const { ask, close } = createAsker(process.stdin, write);
  try {
    await runResumeFlow({
      root: workspaceRoot,
      sessionId: sessionIdArg,
      ask,
      write,
      // 对账收口后进入 REPL：同一 sessionId 续写事件日志；EOF/退出走正常 finally
      enterRepl: async () => {
        const streamFn = await loadStreamFn(streamFnSpec);
        // 决策 3b：grant 冷恢复种子——事件日志物化的生效 grant（created − revoked），
        // 静默继续有效，无重复确认环节
        const restoredGrants = materializeSession(
          path.join(workspaceRoot, ".pigeon", "sessions"),
          sessionId
        ).grants;
        const bundle = buildRuntime({
          streamFn,
          workspaceRoot,
          sessionId,
          yolo: flags.yolo,
          provider: flags.provider,
          modelId: flags.modelId,
          // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
          createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
          restoredGrants,
        });
        try {
          await runRepl({
            adapter: bundle.adapter,
            ask,
            write,
            grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
          });
        } finally {
          await bundle.adapter.dispose();
          bundle.eventLog.close();
        }
      },
    });
  } finally {
    close();
  }
}

async function main(argv: string[]): Promise<void> {
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
  const flags = parseModelFlags(argv, "支持 --yolo / --root / --stream-fn / --provider / --model");
  if (flags.streamFnSpec === undefined || flags.streamFnSpec === "") {
    throw new Error(
      "未配置模型接入：请用 --stream-fn <模块路径> 或环境变量 PIGEON_STREAM_FN 指定一个默认导出 " +
        "StreamFn 的模块（形状 (model, context, options?) => AssistantMessageEventStream，" +
        "与测试 fixtures 的 fake streamFn 同型；provider 密钥由该模块自行从环境变量读取）"
    );
  }
  const streamFn = await loadStreamFn(flags.streamFnSpec);
  // 工作区根：工具的路径围栏以它为准（realpath 规范化，见 paths.ts）
  const workspaceRoot = realpathSync(flags.root);
  // D8：M3 旧账本一次性迁移（不存在即 no-op；损坏响亮失败，启动中止）
  migrateLegacyLedger(
    path.join(workspaceRoot, ".pigeon", "ledger.jsonl"),
    path.join(workspaceRoot, ".pigeon", "sessions")
  );
  const write = (text: string): void => {
    process.stdout.write(text);
  };
  const { ask, close } = createAsker(process.stdin, write);
  const sessionId = newSessionId();
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot,
    sessionId,
    yolo: flags.yolo,
    provider: flags.provider,
    modelId: flags.modelId,
    // 决策 025：审批 handler 由 Actor 注入——cli 传 REPL 问答版
    createApprovalHandler: (grants) => createCliApprovalHandler(ask, write, { grants }),
  });
  try {
    await runRepl({
      adapter: bundle.adapter,
      ask,
      write,
      grants: grantCommandsOf(bundle, workspaceRoot, sessionId, write),
    });
  } finally {
    close();
    await bundle.adapter.dispose();
    bundle.eventLog.close();
  }
}

// 仅作为入口直接运行时执行；被 import（如测试取 loadStreamFn）时不启动 REPL
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
