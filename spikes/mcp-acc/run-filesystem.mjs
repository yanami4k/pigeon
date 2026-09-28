// 只适用于旧格式：本脚本读写旧账本或会话树写穿（persistence/event-log.ts 等模块已在账本重构第四段删除），只能在只读旧版代码 455d88d 上运行；新代码上不再维护。
// 剧本 M5.7 filesystem（决策 051 / 053 / 054 / 055）：真实 Kimi 链路 + 真实 ConPTY + 真实 @modelcontextprotocol/server-filesystem
// （npx 经 048 启动器，不带目录参数，只靠 client 广告的 roots）。
//   两个 implementer 并行：各自的 filesystem server 以其工作树为 roots，各用 write_file 在自己工作树里建文件——
//   write 档逐次审批且面板标明来源 worker，read 档（list_allowed_directories 等）自动放行；
//   随后主会话 run_command 跑 npm --prefix app test（Windows 上 npm 是 .cmd，经启动器）。
// 事后核对：worker 回执 mcp 块（参数哈希与 intent 原始参数对上、返回摘要点名写入的文件）与 changedFiles 对得上、
//   serverEvidence 在场与否如实记录（该 server 的 structuredContent 不带 evidence 键）、主仓库工作区零改动、
//   npm test 的 exec 回执标明经启动器。
// 验收工作区根目录不放 package.json：npx 按最近的 package.json 定前缀，放了会找不到本仓库装好的 server。
// 从仓库根目录运行：KIMI_API_KEY=... node spikes/mcp-acc/run-filesystem.mjs；产出写 tmp/，不入库。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTraceCommand } from "../../src/cli/trace.ts";
import { materializeSession } from "../../src/persistence/event-log.ts";
import { canonicalJson, sha256Hex } from "../../src/state/message-content.ts";
import { runTuiScenario } from "../tui-acc/tui-driver-selfexit.mjs";

const root = resolve("tmp/mcp-acc/ws-filesystem");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, ".pigeon"), { recursive: true });
mkdirSync(join(root, "app"), { recursive: true });
mkdirSync("tmp/tui-acc", { recursive: true });
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "pigeon@example.invalid"]);
git(["config", "user.name", "pigeon-acceptance"]);
git(["config", "core.autocrlf", "false"]);
const readme = "filesystem acceptance\n";
writeFileSync(join(root, "README.txt"), readme);
writeFileSync(
  join(root, "app", "package.json"),
  `${JSON.stringify(
    { name: "fs-acc", private: true, scripts: { test: "node -e \"console.log('fs-acc-test-ok')\"" } },
    null,
    2
  )}\n`
);
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);
// 配置不入工作区版本库（.pigeon/ 是运行态目录；.mcp.json 放根目录但不提交，worker 读治理根的配置）
copyFileSync("spikes/mcp-acc/.mcp.json", join(root, ".mcp.json"));
copyFileSync("spikes/mcp-acc/.pigeon/mcp.json", join(root, ".pigeon", "mcp.json"));
writeFileSync(join(root, ".git", "info", "exclude"), ".mcp.json\n", { flag: "a" });
const sessionsDir = join(root, ".pigeon", "sessions");

const args = [
  "--root",
  root,
  "--stream-fn",
  "spikes/real-stream-fn.mjs",
  "--provider",
  "kimi-coding",
  "--model",
  "kimi-for-coding",
];
const idle = /session (sess_[0-9A-Z]{26})[\s\S]*?state: idle/;
const taskFor = (name) =>
  `只用 MCP filesystem 工具完成，不要用 read_file 或 edit_file：先调用 mcp__filesystem__list_allowed_directories 查看允许目录，` +
  `再调用 mcp__filesystem__write_file，在允许目录下创建 notes-${name}.txt（path 用允许目录拼出的绝对路径），` +
  `内容为一行 written-by-${name}。完成后一句话说明写到了哪个路径。`;
const EXEC_PROMPT =
  "请调用 run_command 工具，command 参数一字不差地是：npm --prefix app test  拿到结果后一句话说明输出里有没有 fs-acc-test-ok。";

let parent = "";
let phase = "workers";
let eventSeq = 0;
let workerApprovals = 0;
let execApprovals = 0;
const settledNames = new Set();
const eventTrail = [];
const tracker = { state: "idle" };
const TOKEN = /state: (approval|running|idle|resume|cancelling)|== worker (fs-[a-z]+)（[a-z]+）收尾：/g;
const pump = {
  exec(text) {
    let state = tracker.state;
    for (const token of text.matchAll(TOKEN)) {
      let kind;
      let name;
      if (token[1] !== undefined) {
        const previous = state;
        state = token[1];
        if (state === "approval" && previous !== "approval") {
          kind = "approval";
        } else if (state === "idle" && previous !== "idle") {
          kind = "idle";
        } else {
          continue;
        }
      } else {
        if (settledNames.has(token[2])) {
          continue;
        }
        kind = "settled";
        name = token[2];
      }
      tracker.state = state;
      if (name !== undefined) {
        settledNames.add(name);
      }
      const match = [token[0]];
      match.index = token.index;
      match.kind = kind;
      match.workerName = name;
      return match;
    }
    return null;
  },
};

const steps = [];
const pumpStep = () => ({
  wait: pump,
  sendKey: (match) => {
    eventTrail.push(`${phase}:${match.kind}${match.workerName ? `:${match.workerName}` : ""}`);
    if (phase === "workers") {
      if (match.kind === "approval") {
        workerApprovals += 1;
        steps.push({ ...pumpStep(), snapshot: `m57fs-worker-approval-${++eventSeq}` });
        return "y";
      }
      if (match.kind === "settled" && settledNames.size >= 2) {
        phase = "exec";
        steps.push({ ...pumpStep(), snapshot: "m57fs-workers-settled" });
        return `${EXEC_PROMPT}\r`;
      }
      steps.push(pumpStep());
      return undefined;
    }
    if (phase === "exec") {
      if (match.kind === "approval") {
        execApprovals += 1;
        steps.push({ ...pumpStep(), snapshot: `m57fs-exec-approval-${++eventSeq}` });
        return "y";
      }
      if (match.kind === "idle") {
        phase = "done";
        return "/quit\r";
      }
      steps.push(pumpStep());
      return undefined;
    }
    return undefined;
  },
});

steps.push(
  {
    wait: idle,
    snapshot: "m57fs-start",
    send: (match) => {
      parent = match[1];
      return `/spawn implementer --name fs-a "${taskFor("fs-a")}"`;
    },
  },
  { wait: /已派出 worker fs-a/, send: `/spawn implementer --name fs-b "${taskFor("fs-b")}"` },
  pumpStep()
);

const run = await runTuiScenario({
  name: "m57fs",
  expectSelfExit: true,
  args,
  timeoutMs: 1_200_000,
  steps,
});

// ---- 事后核对 ----
const parentView = materializeSession(sessionsDir, parent);
const workers = parentView.children.map(({ spawned, settled }) => {
  const view = materializeSession(sessionsDir, spawned.childSessionId);
  const notes = join(spawned.workspace.path, `notes-${spawned.name}.txt`);
  const mcpReceipts = view.receipts
    .filter((receipt) => receipt.mcp !== undefined)
    .map((receipt) => {
      const intent = view.intents.find((candidate) => candidate.toolCallId === receipt.toolCallId);
      return {
        tool: receipt.mcp.tool,
        approvedBy: receipt.approvedBy,
        executed: receipt.executed,
        argsHashMatchesIntent: intent !== undefined && receipt.mcp.argsHash === sha256Hex(canonicalJson(intent.rawArgs)),
        argsPath: intent?.rawArgs?.path,
        resultSummary: receipt.mcp.resultSummary,
        resultHash: receipt.mcp.resultHash.slice(0, 12),
        truncated: receipt.mcp.truncated,
        structuredHash: receipt.mcp.structuredHash?.slice(0, 12),
        serverEvidence: receipt.mcp.serverEvidence ?? null,
      };
    });
  const settledTools = view.runtimeEvents.flatMap((record) =>
    record.kind === "tool.settled" ? [`${record.payload.toolName}${record.payload.isError ? ":error" : ""}`] : []
  );
  const writeReceipt = mcpReceipts.find((receipt) => receipt.tool === "write_file");
  return {
    name: spawned.name,
    sessionId: spawned.childSessionId,
    branch: spawned.workspace.branch,
    status: settled?.status,
    changedFiles: settled?.result?.changedFiles,
    intents: view.intents.map((intent) => `${intent.toolName}:${intent.decision.approvedBy}`),
    settledTools,
    mcpReceipts,
    runStartedServers: view.runStarteds[0]?.payload.mcpServers,
    notesContent: existsSync(notes) ? readFileSync(notes, "utf8") : null,
    receiptMatchesChangedFiles:
      writeReceipt !== undefined &&
      (settled?.result?.changedFiles ?? []).includes(`notes-${spawned.name}.txt`) &&
      writeReceipt.resultSummary.includes(`notes-${spawned.name}.txt`),
    readTierAutoAllowed:
      settledTools.some((tool) => tool.startsWith("mcp__filesystem__list_allowed_directories")) &&
      !view.intents.some((intent) => intent.toolName === "mcp__filesystem__list_allowed_directories"),
  };
});
const execReceipts = parentView.receipts
  .filter((receipt) => receipt.exec !== undefined)
  .map((receipt) => ({
    command: receipt.exec.command,
    launcher: receipt.exec.launcher,
    shell: receipt.exec.shell,
    argv: receipt.exec.argv,
    exitCode: receipt.exec.exitCode,
    outputHasMarker: receipt.exec.output.includes("fs-acc-test-ok"),
  }));
const traceParent = runTraceCommand({ root, sessionId: parent });
const summary = {
  exitCode: run.code,
  parent,
  eventTrail,
  workerApprovalsAnswered: workerApprovals,
  execApprovalsAnswered: execApprovals,
  approvalSourceLinesInStream: {
    "fs-a": (run.stripped.match(/来源：worker fs-a/g) ?? []).length,
    "fs-b": (run.stripped.match(/来源：worker fs-b/g) ?? []).length,
  },
  panelShowsMcpToolName: run.stripped.includes("工具：mcp__filesystem__write_file"),
  mainWorkspaceClean:
    git(["status", "--porcelain", "--untracked-files=no"]) === "" &&
    readFileSync(join(root, "README.txt"), "utf8") === readme &&
    !existsSync(join(root, "notes-fs-a.txt")) &&
    !existsSync(join(root, "notes-fs-b.txt")),
  workers,
  exec: execReceipts,
  parentRunStartedServers: parentView.runStarteds.map((record) => record.payload.mcpServers),
  traceParentMcpLines: traceParent.split("\n").filter((line) => line.includes("MCP")),
  traceParentListsWorkers: traceParent.includes("派出的 worker（2）："),
};
writeFileSync("tmp/mcp-acc/filesystem-summary.json", `${JSON.stringify(summary, null, 1)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 1));
