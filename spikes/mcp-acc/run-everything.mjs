// 剧本 M5.7 everything（决策 041 / 043 / 052 / 053 / 055）：真实 @modelcontextprotocol/server-everything（npx 经 048 启动器）
// + 真实装配根 + 剧本模型（fake streamFn，不接外部模型）。自动核对：
//   启动计划走 cmd.exe 启动器；注解与配置冲突落 run.started，冲突工具走审批；server 的无参 prompt 进 Skill Catalog、
//   load_skill 读取留 skill.loaded；初始化后条件工具注册触发的 tools/list_changed 被记录；write 档调用 receipt 带 mcp 块；
//   强杀 server 进程后 MCP 调用报环境错误、核心 read_file 照跑、下个 Run 的 run.started 记 server 不可用，trace 头可见。
// 夹具：spikes/mcp-acc/.mcp.json 与 spikes/mcp-acc/.pigeon/mcp.json（filesystem 也会随配置启动，本剧本不用它）。
// 从仓库根目录运行：node spikes/mcp-acc/run-everything.mjs；产出写 tmp/mcp-acc/，不入库。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startMcpSession } from "../../src/application/mcp.ts";
import { buildRuntime, disposeRuntime } from "../../src/application/runtime.ts";
import { runTraceCommand } from "../../src/cli/trace.ts";
import { materializeSession } from "../../src/persistence/event-log.ts";
import { createFakeStreamFn } from "../../src/pi-runtime/fixtures.ts";
import { newSessionId } from "../../src/state/ids.ts";
import { canonicalJson, sha256Hex } from "../../src/state/message-content.ts";
import { allowedEnv, planMcpLaunch } from "../../src/tools/run-command.ts";

const root = resolve("tmp/mcp-acc/ws-everything");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, ".pigeon"), { recursive: true });
copyFileSync("spikes/mcp-acc/.mcp.json", join(root, ".mcp.json"));
copyFileSync("spikes/mcp-acc/.pigeon/mcp.json", join(root, ".pigeon", "mcp.json"));
writeFileSync(join(root, "a.txt"), "alpha\n");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const plan = planMcpLaunch({
  command: "npx",
  args: ["--no", "mcp-server-everything", "stdio"],
  cwd: root,
  env: allowedEnv(process.env),
});

const startedAt = Date.now();
const mcp = await startMcpSession({ governanceRoot: root, workspaceRoot: root, maxRestarts: 0 });
const startMs = Date.now() - startedAt;
// 条件工具在 server 的初始化回调里注册，清单变更通知在其后到达
await sleep(2000);
const everything = mcp.connections.find((connection) => connection.name === "everything");

const approvals = [];
const sessionId = newSessionId();
const bundle = buildRuntime({
  streamFn: createFakeStreamFn({
    replies: [
      { text: "调用 echo", toolCalls: [{ name: "mcp__everything__echo", args: { message: "pigeon-m57" } }] },
      {
        text: "读 prompt",
        toolCalls: [{ name: "load_skill", args: { name: "mcp__everything__simple_prompt" } }],
      },
      { text: "第一轮完成" },
      { text: "再调 echo", toolCalls: [{ name: "mcp__everything__echo", args: { message: "after-kill" } }] },
      { text: "读文件", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { text: "第二轮完成" },
    ],
  }),
  workspaceRoot: root,
  homeDir: root,
  sessionId,
  yolo: false,
  provider: "script",
  modelId: "everything-acceptance",
  mcp,
  createApprovalHandler: () => async (request) => {
    approvals.push(request.toolName);
    return { approved: true };
  },
});

let first;
let second;
let killedCount = 0;
try {
  first = await bundle.adapter.run("第一轮：echo 与 prompt");
  // 强杀 everything server 进程树（排除执行查询的 PowerShell 自身）
  killedCount = Number(
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$targets = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*mcp-server-everything*' -and $_.ProcessId -ne $PID }; " +
          "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " +
          "($targets | Measure-Object).Count",
      ],
      { encoding: "utf8" }
    ).trim()
  );
  for (let waited = 0; waited < 15_000 && everything?.state === "connected"; waited += 200) {
    await sleep(200);
  }
  await everything?.idle();
  second = await bundle.adapter.run("第二轮：server 已不可用");
} finally {
  await disposeRuntime(bundle);
}

const session = materializeSession(join(root, ".pigeon", "sessions"), sessionId);
const [startedFirst, startedSecond] = session.runStarteds.map((record) => record.payload);
const everythingTools = (startedFirst?.mcpTools ?? []).filter((tool) => tool.server === "everything");
const serverFirst = startedFirst?.mcpServers?.find((server) => server.name === "everything");
const serverSecond = startedSecond?.mcpServers?.find((server) => server.name === "everything");
const settled = session.runtimeEvents.flatMap((record) =>
  record.kind === "tool.settled" ? [record.payload] : []
);
const echoIntent = session.intents.find((intent) => intent.toolName === "mcp__everything__echo");
const echoReceipt = session.receipts.find((receipt) => receipt.toolCallId === echoIntent?.toolCallId);
const trace = runTraceCommand({ root, sessionId });

const checks = {
  launchViaLauncher: plan.mode === "launcher",
  echoConflictInRunStarted: everythingTools.some(
    (tool) =>
      tool.tool === "echo" &&
      tool.conflict === true &&
      tool.configuredTier === "write" &&
      tool.effectiveTier === "write" &&
      tool.declaredHint?.readOnlyHint === true
  ),
  echoAskedApproval: approvals.includes("mcp__everything__echo"),
  promptInCatalog: (startedFirst?.skills ?? []).some(
    (skill) => skill.name === "mcp__everything__simple_prompt" && skill.path === "mcp:everything/simple-prompt"
  ),
  skillLoaded: session.skillLoadeds.some((record) => record.payload.name === "mcp__everything__simple_prompt"),
  argsPromptsSkipped: mcp.problems.some((problem) => problem.includes("args-prompt")),
  listChangedRecorded: (serverFirst?.listChanges ?? []).some((change) => change.list === "tools"),
  echoReceiptMcpBlock:
    echoReceipt?.mcp?.tool === "echo" &&
    echoReceipt.mcp.argsHash === sha256Hex(canonicalJson(echoIntent?.rawArgs)),
  firstRunCompleted: first?.failure === null,
  killedServerProcesses: killedCount > 0,
  secondRunServerUnavailable: serverSecond?.state === "unavailable",
  echoAfterKillEnvironmentError: settled.some(
    (payload) =>
      payload.toolName === "mcp__everything__echo" && payload.isError && payload.errorKind === "environment"
  ),
  coreReadFileOk: settled.some((payload) => payload.toolName === "read_file" && !payload.isError),
  secondRunCompleted: second?.failure === null,
  traceShowsConflict: trace.includes("MCP 工具集冲突") && trace.includes("mcp__everything__echo（声明只读"),
  traceShowsUnavailable: trace.includes("MCP server everything 不可用"),
};

const summary = {
  checks,
  allPassed: Object.values(checks).every(Boolean),
  launchPlan: { mode: plan.mode, program: plan.program, args: plan.args },
  startMs,
  problems: mcp.problems,
  approvals,
  conflicts: everythingTools.filter((tool) => tool.conflict === true),
  serverFirst,
  serverSecond,
  echoReceiptMcp: echoReceipt?.mcp,
  settled: settled.map((payload) => [payload.toolName, payload.isError, payload.errorKind ?? null]),
  traceMcpLines: trace.split("\n").filter((line) => line.includes("MCP")),
  killedCount,
};
mkdirSync("tmp/mcp-acc", { recursive: true });
writeFileSync("tmp/mcp-acc/everything-summary.json", `${JSON.stringify(summary, null, 1)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 1));
process.exitCode = summary.allPassed ? 0 : 1;
