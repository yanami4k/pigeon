// 剧本 M5.5：真实 Kimi 链路 + 真实 ConPTY 验收 M5.5（决策 040 / 048 / 049 / 050）。
//   m55a（一个进程）：两个 implementer 并行各改自己工作树里的文件，审批面板标明来源、一次一个；/workers；
//     主会话 run_command：面板显示完整命令，[a] 精确命令放权后同一命令免审，改参数重新问（拒绝）。
//   m55b（新进程）：派出 fix-c，在它的审批挂起时强杀进程（真实崩溃）。
//   m55c（新进程）：/resume fix-c 的 worker 会话——回到它自己的工作树对账续跑；在 worker 会话里 /spawn 被深度 1 拒绝。
//   m55d（两个窗口）：窗口 A 开着会话，窗口 B /resume 同一会话被会话打开锁拒绝。
// 事后核对：主仓库工作区零改动、各工作树写入、父子两族配对、trace 跨会话、exec receipt 证据。
// m55a 不对输出文本逐段匹配（差分渲染会重印尾部行，同一审批提示可能出现多次），而是跟踪状态栏的
// 状态迁移：进入 approval 才算一次审批，从非 idle 回到 idle 才算一次 Run 结束；worker 收尾按名字去重。
// 审批出现几次由模型决定（读错锚点会重提），按事件动态追加步骤，不假设固定次数。
// 从仓库根目录运行：KIMI_API_KEY=... node spikes/tui-acc/run-m55.mjs；产出写 tmp/tui-acc/，不入库。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSessionListCommand } from "../../src/application/session-list.ts";
import { runTraceCommand } from "../../src/cli/trace.ts";
import { materializeSession } from "../../src/persistence/event-log.ts";
import { runTuiScenario } from "./tui-driver-selfexit.mjs";

const root = resolve("tmp/tui-acc/ws-m55");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "pigeon@example.invalid"]);
git(["config", "user.name", "pigeon-acceptance"]);
git(["config", "core.autocrlf", "false"]);
const originalA = "alpha\nbeta\n";
const originalB = "one\ntwo\n";
writeFileSync(join(root, "a.txt"), originalA);
writeFileSync(join(root, "b.txt"), originalB);
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- m55a ----
const PROMPT_A =
  "请调用 run_command 工具，command 参数必须一字不差地是：node -e \"console.log('pigeon-m55')\"  不要改写命令，拿到结果后一句话说明输出。";
const PROMPT_A_AGAIN =
  "请再调用一次 run_command，command 参数与上一次一字不差：node -e \"console.log('pigeon-m55')\"  拿到结果后一句话说明。";
const PROMPT_B =
  "请调用 run_command，command 参数一字不差地是：node -e \"console.log('pigeon-m55-b')\"  如果被拒绝，就一句话说明被拒绝，不要重试。";
const execRuns = [
  { prompt: PROMPT_A, key: "a" },
  // 期望不出现审批；若出现按 y 放行并如实计数
  { prompt: PROMPT_A_AGAIN, key: "y" },
  { prompt: PROMPT_B, key: "n" },
];
const execApprovals = [0, 0, 0];
let execIndex = 0;
let parentA = "";
let workerApprovals = 0;
const settledNames = new Set();
let phase = "workers";
let eventSeq = 0;
const eventTrail = [];

// 事件泵：从驱动游标起扫描状态栏迁移与 worker 收尾行，返回下一个"事件"（形如正则匹配结果）
const tracker = { state: "idle" };
const TOKEN =
  /state: (approval|running|idle|resume|cancelling)|== worker (fix-[a-z]+)（[a-z]+）收尾：|worker（(\d+)）：/g;
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
      } else if (token[2] !== undefined) {
        if (settledNames.has(token[2])) {
          continue;
        }
        kind = "settled";
        name = token[2];
      } else {
        kind = "list";
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

const stepsA = [];
const pumpStep = () => ({
  wait: pump,
  sendKey: (match) => {
    eventTrail.push(`${phase}:${match.kind}${match.workerName ? `:${match.workerName}` : ""}`);
    if (phase === "workers") {
      if (match.kind === "approval") {
        workerApprovals += 1;
        stepsA.push({ ...pumpStep(), snapshot: `worker-approval-${++eventSeq}` });
        return "y";
      }
      if (match.kind === "settled" && settledNames.size >= 2) {
        phase = "list";
        stepsA.push(pumpStep());
        return "/workers\r";
      }
      stepsA.push(pumpStep());
      return undefined;
    }
    if (phase === "list") {
      stepsA.push(pumpStep());
      if (match.kind === "list") {
        phase = "exec";
        return `${execRuns[0].prompt}\r`;
      }
      return undefined;
    }
    if (phase === "exec") {
      if (match.kind === "approval") {
        execApprovals[execIndex] += 1;
        stepsA.push({ ...pumpStep(), snapshot: `exec-approval-${++eventSeq}` });
        return execRuns[execIndex].key;
      }
      if (match.kind === "idle") {
        execIndex += 1;
        if (execIndex < execRuns.length) {
          stepsA.push({ ...pumpStep(), snapshot: `exec-run-${execIndex}` });
          return `${execRuns[execIndex].prompt}\r`;
        }
        phase = "done";
        return "/quit\r";
      }
      stepsA.push(pumpStep());
      return undefined;
    }
    return undefined;
  },
});

stepsA.push(
  {
    wait: idle,
    snapshot: "a-start",
    send: (match) => {
      parentA = match[1];
      return '/spawn implementer --name fix-a "把 a.txt 第二行 beta 改成 BETA-A。先用 read_file 读 a.txt，再用 edit_file 修改，只改这一处，完成后一句话说明。"';
    },
  },
  {
    wait: /已派出 worker fix-a/,
    send: '/spawn implementer --name fix-b "把 b.txt 第二行 two 改成 TWO-B。先用 read_file 读 b.txt，再用 edit_file 修改，只改这一处，完成后一句话说明。"',
  },
  pumpStep()
);
const m55a = await runTuiScenario({
  name: "m55a",
  expectSelfExit: true,
  args,
  timeoutMs: 900_000,
  steps: stepsA,
});

// ---- m55b：派出后强杀 ----
let parentB = "";
const m55b = await runTuiScenario({
  name: "m55b",
  expectSelfExit: true,
  args,
  timeoutMs: 600_000,
  steps: [
    {
      wait: idle,
      snapshot: "b-start",
      send: (match) => {
        parentB = match[1];
        return '/spawn implementer --name fix-c "把 a.txt 第一行 alpha 改成 ALPHA-C。先用 read_file 读 a.txt，再用 edit_file 修改，只改这一处。"';
      },
    },
    // 审批挂起时强杀：父会话只有 child.spawned，worker 会话留下没收尾的 Run（时序确定）
    { wait: /来源：worker fix-c/, snapshot: "crash-approval", kill: 300 },
  ],
});
const workerC = materializeSession(sessionsDir, parentB).children[0]?.spawned.childSessionId ?? "";

// ---- m55c：恢复 worker 会话，深度 1 ----
const m55c = await runTuiScenario({
  name: "m55c",
  expectSelfExit: true,
  args,
  timeoutMs: 300_000,
  steps: [
    { wait: idle, snapshot: "c-start", send: `/resume ${workerC}` },
    { wait: /冷恢复对账/, snapshot: "resume-report" },
    { wait: /以下为续跑/, snapshot: "resume-history", send: '/spawn explorer "看看目录结构"' },
    { wait: /深度 1/, snapshot: "depth-rejected", send: "/quit" },
  ],
});

// ---- m55d：两个窗口恢复同一会话 ----
let windowASession = "";
const windowA = runTuiScenario({
  name: "m55d-a",
  expectSelfExit: true,
  args,
  timeoutMs: 90_000,
  steps: [
    {
      wait: idle,
      send: (match) => {
        windowASession = match[1];
        return undefined;
      },
    },
    // 不会出现：窗口 A 一直开着，直到超时被强杀
    { wait: /__never__/ },
  ],
}).catch((error) => ({ error: String(error) }));
while (windowASession === "") {
  await sleep(200);
}
const m55dB = await runTuiScenario({
  name: "m55d-b",
  expectSelfExit: true,
  args,
  timeoutMs: 120_000,
  steps: [
    { wait: idle, send: `/resume ${windowASession}` },
    { wait: /恢复失败：会话已被另一个进程打开/, snapshot: "lock-rejected", send: "/quit" },
  ],
});
await windowA;

// ---- 事后核对 ----
const parentAView = materializeSession(sessionsDir, parentA);
const workers = parentAView.children.map(({ spawned, settled }) => {
  const worker = materializeSession(sessionsDir, spawned.childSessionId);
  const file = spawned.name === "fix-a" ? "a.txt" : "b.txt";
  return {
    name: spawned.name,
    sessionId: spawned.childSessionId,
    branch: spawned.workspace.branch,
    status: settled?.status,
    changedFiles: settled?.result?.changedFiles,
    headerParentMatches: worker.sessionHeader?.parentSessionId === parentA,
    intents: worker.intents.map((intent) => `${intent.toolName}:${intent.decision.approvedBy}`),
    decisions: worker.decisions.map((decision) => `${decision.toolName}:${decision.decision.reason}`),
    receipts: worker.receipts.length,
    pendingReconcile: worker.reconcile.unknown.length,
    worktreeFile: readFileSync(join(spawned.workspace.path, file), "utf8"),
  };
});
const execIntents = parentAView.intents
  .filter((intent) => intent.toolName === "run_command")
  .map((intent) => ({ command: intent.rawArgs.command, approvedBy: intent.decision.approvedBy }));
const execDecisions = parentAView.decisions
  .filter((decision) => decision.toolName === "run_command")
  .map((decision) => ({ command: decision.rawArgs.command, reason: decision.decision.reason }));
const execReceipts = parentAView.receipts
  .filter((receipt) => receipt.exec !== undefined)
  .map((receipt) => ({
    command: receipt.exec.command,
    exitCode: receipt.exec.exitCode,
    output: receipt.exec.output.trim(),
    outputHash: receipt.exec.outputHash.slice(0, 12),
    fileChanges: receipt.exec.fileChanges,
  }));
const traceParent = runTraceCommand({ root, sessionId: parentA });
const traceWorker = workers[0] ? runTraceCommand({ root, sessionId: workers[0].sessionId }) : "";
const parentBView = materializeSession(sessionsDir, parentB);
const workerCView = workerC === "" ? undefined : materializeSession(sessionsDir, workerC);
const summary = {
  exitCodes: { m55a: m55a.code, m55bKilled: m55b.killed, m55c: m55c.code, m55dB: m55dB.code },
  mainWorkspaceClean:
    git(["status", "--porcelain", "--untracked-files=no"]) === "" &&
    readFileSync(join(root, "a.txt"), "utf8") === originalA &&
    readFileSync(join(root, "b.txt"), "utf8") === originalB,
  parentA,
  eventTrail,
  workerApprovalsAnswered: workerApprovals,
  approvalSourceLinesInStream: {
    "fix-a": (m55a.stripped.match(/来源：worker fix-a/g) ?? []).length,
    "fix-b": (m55a.stripped.match(/来源：worker fix-b/g) ?? []).length,
  },
  workers,
  exec: {
    approvalsPerRun: execApprovals,
    intents: execIntents,
    decisions: execDecisions,
    receipts: execReceipts,
    fullCommandShownInPanel: m55a.stripped.includes("node -e \\\"console.log('pigeon-m55')\\\""),
  },
  execGrants: parentAView.grantCreateds.map((grant) => ({ tool: grant.tool, command: grant.command })),
  traceParentListsWorkers: traceParent.includes("派出的 worker（2）："),
  traceParentEntryHints: workers.every((worker) => traceParent.includes(`trace ${worker.sessionId}`)),
  traceWorkerLineage: traceWorker.includes(`父会话 ${parentA}`),
  crash: {
    parentB,
    workerC,
    parentBUnsettled: parentBView.children[0] !== undefined && parentBView.children[0].settled === undefined,
    parentTraceMarksUnsettled: runTraceCommand({ root, sessionId: parentB }).includes("未收尾"),
    workerCUnfinishedRuns: workerCView?.unfinishedRuns.length,
    workerCIntents: workerCView?.intents.map((intent) => intent.decision.approvedBy),
    workerCReceipts: workerCView?.receipts.length,
    workerCResolutions: workerCView?.resolutions.length,
    workerCPending: workerCView?.reconcile.unknown.length,
    resumeReported: m55c.stripped.includes("冷恢复对账"),
    resumeShowsCrashResidue: m55c.stripped.includes("崩溃残留"),
    depthRejected: m55c.stripped.includes("深度 1：worker 会话不能再派 worker"),
  },
  lockRejected: m55dB.stripped.includes("恢复失败：会话已被另一个进程打开"),
  sessionList: runSessionListCommand({ root }),
};
writeFileSync("tmp/tui-acc/m55-summary.json", `${JSON.stringify(summary, null, 1)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 1));
