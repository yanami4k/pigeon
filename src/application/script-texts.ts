// 脚本编排的说明与返回文字（决策 309–314；按 271 定稿文字的风格拟稿、过目后定稿）：工具说明、参数说明、各情形的返回文字、
// worker 附言与改正、开跑计划行、log 行、结束汇总、收回请示与审批新键的回显。数值与名字由调用方填入。
// 决策 428：给模型看的（工具说明与参数说明、返回文字、worker 附言与改正、斜杠命令交给模型的话、结束汇总）为英文；
// 只给人看的（开跑计划行、log 行、收回请示的来源行、审批新键与回显）照旧中文。
import { SCRIPT_COMMAND, SCRIPT_KEYWORD } from "./script-naming.ts";

export const ORCHESTRATE_TOOL = "orchestrate";

// 结束汇总进主 agent 下一轮时的前缀（与 worker 通知同一样式显示成系统行）
export const SCRIPT_NOTICE_PREFIX = "[Script notice] ";
// 决策 428 之前的说法：回看旧会话时据此认出程序通知
export const LEGACY_SCRIPT_NOTICE_PREFIX = "[脚本通知] ";

// 工具说明；modelDecides 为项目配置打开"由模型判断何时用"时的第 2 句
export function orchestrateDescription(options: { modelDecides: boolean }): string {
  return [
    "Submit an orchestration script for the program to run in an isolated container, spawning workers in batches and chaining them as the script directs. It returns a run ID right after submission, without waiting for the script to finish; when the script ends, a notice returns a summary.",
    options.modelDecides
      ? "Use it when a task needs many workers, several phases, or batch processing along a fixed flow; for two or three independent subtasks, spawn_worker is enough."
      : `Use it only when the user asks for it by name: the user's current input contains "${SCRIPT_KEYWORD}", or the user started it with /${SCRIPT_COMMAND}. Do not use it when the user has not asked for it; the call will be rejected. To spawn a few workers, use spawn_worker.`,
    "The script is a JavaScript function body (await and return are allowed) with six building blocks. agent(task, options) spawns a worker and waits for it to finish, returning {ok, status, name, branch, files, summary, output, error, errorKind}; the options are label, phase, role (explorer, implementer, or tester; default implementer), schema (a JSON Schema: at the end the worker returns data in that shape, placed in output; if it does not match, the program has the worker correct it in the same session, at most twice), and relay (the result of an earlier agent call: the new worker continues from that worker's branch). parallel([() => agent(…), …]) returns only when all have finished, with the results in order. pipeline(items, step1, step2, …) takes each item through the steps in order without waiting for other items; a step is (previousResult, item, index) => …, and the previous result the first step receives is the item itself; if a step fails, the remaining steps for that item are skipped. agent calls after phase(name) belong to that phase; log(text) writes a line in the user's message area; args holds the arguments given at submission.",
    [
      "Example:",
      'phase("Survey");',
      'const scan = await agent("List the modules under src/ that have no unit tests", { role: "explorer", schema: { type: "object", properties: { modules: { type: "array", items: { type: "string" } } }, required: ["modules"] } });',
      'phase("Add tests");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是脚本原文（容器里执行的 JavaScript），不是本文件的模板字符串
      "const written = await parallel((scan.output?.modules ?? []).map((m) => () => agent(`Write unit tests for ${m}`, { label: m })));",
      "return { collect: written.filter((r) => r.ok) };",
    ].join("\n"),
    "The script only schedules: it cannot read or write files, run commands, or access the network, and it has no require, import, or process; reading the time (Date.now, new Date()) or generating random numbers (Math.random) throws an error. Have workers look up the information you need, or pass it in through args. Workers cannot see this session's conversation, so write complete tasks.",
    "By default, workers start from a snapshot of the main working directory taken when the script starts; with relay, a worker continues from that worker's branch. The main working directory stays untouched while the script runs. End the script with return { collect: [results to collect] }: after the script finishes, the program applies each of those workers' changes to the main working directory in order with a three-way merge, asking for approval once for the whole batch; conflicts and files deleted by workers are listed in the summary. Without collect, nothing is collected.",
    "A single worker's failure does not stop the script: agent returns as usual with ok set to false, plus the status and reason, and the script decides what to do; the framework does not retry automatically.",
    'When the user asks for it, they may have set a spending limit: once it is reached, no new workers are spawned, running ones finish, and the script ends with "ran out of budget". To resume, give the previous run ID in resume_run: the script reruns from the start, calls identical to last time reuse their results directly, and only unfinished, failed, or changed calls are spawned again; when a relayed upstream call is redone, its downstream calls are redone too.',
  ].join("\n");
}

export const ORCHESTRATE_PARAM_TEXTS = {
  name: "Script name, shown in the start plan line and the tree view",
  phases: "Phase names, in order, shown in the plan line",
  script: "The script body (a JavaScript function body; await and return are allowed)",
  args: "Arguments passed to the script, read in the script as args",
  resumeRun: "To resume, give the previous script run ID; omit it to start a new run",
} as const;

// 模型没有价格却给了金额额度（工具的拒绝原样交回模型，/orchestrate resume 时给人看）
export const SCRIPT_BUDGET_NO_PRICE =
  "This model has no price, so a money budget cannot be calculated; write the budget in tokens instead (such as 300k), or set no budget";

export const ORCHESTRATE_TEXTS = {
  started: (name: string, runId: string) =>
    `Started script ${name}, run ID ${runId}. A notice will return the summary when it finishes; the main working directory stays untouched while it runs.`,
  resumed: (name: string, runId: string) =>
    `Resumed script ${name}, run ID ${runId}, using the snapshot from when it first started; calls finished last time are reused directly. A notice will return the summary when it finishes.`,
  notNamed: `The user's current input did not ask for script orchestration, so a script cannot be submitted. If needed, ask the user to write "${SCRIPT_KEYWORD}" in their input or to start it with /${SCRIPT_COMMAND}; for a few independent subtasks, use spawn_worker.`,
  unknownRun: (runId: string) =>
    `There is no script with run ID ${runId} (resuming is limited to this session).`,
  stillRunning: (runId: string) =>
    `Script ${runId} is still running and cannot be resumed; wait for it to finish or ask the user to stop it first.`,
  noDocker: (reason: string) =>
    `Docker is unavailable, so script orchestration cannot run: ${reason}.`,
  // 以下为装配与前置检查的失败（不在定稿清单内的兜底，沿用 spawn_worker 的"不是 git 仓库"说法）
  notGit: "The current workspace is not a git repository, so orchestration scripts cannot run.",
  unbound: "This session has no script orchestration set up.",
  failed: (reason: string) => `The script did not start: ${reason}.`,
} as const;

// 给了输出格式时附在任务后面的话
export function schemaAppendix(schema: unknown): string {
  return `\n\nWhen you finish, your last reply must contain only one JSON object that conforms to the JSON Schema below (it may be inside a \`\`\`json code block), with no other text:\n${JSON.stringify(schema, null, 2)}`;
}

// 让 worker 在原会话里改正
export function schemaCorrection(problems: readonly string[], schema: unknown): string {
  return `What you returned last does not match the required format: ${problems.join("; ")}. In your last reply, give only one JSON object that conforms to the JSON Schema below, with no other text:\n${JSON.stringify(schema, null, 2)}`;
}

// /orchestrate 发起时交给模型的文字：带着点名关键词（点名判定看人的输入里有没有它，见 script-naming.ts）
export function commandInputText(task: string): string {
  return `(The user started this with /${SCRIPT_COMMAND}, asking for it to be done with script orchestration, "${SCRIPT_KEYWORD}".)\n${task}`;
}

// 开跑计划行
export function planLine(input: {
  name: string;
  runId: string;
  phases: readonly string[];
  items?: number;
  budget?: string;
}): string {
  const phases = input.phases.length > 0 ? input.phases.join(" → ") : "（未列）";
  return `[脚本] ${input.name}（运行号 ${input.runId}）开跑：阶段 ${phases}；${
    input.items !== undefined ? `已知 ${input.items} 项；` : ""
  }额度 ${input.budget ?? "不限"}。`;
}

export function logLine(name: string, text: string): string {
  return `[脚本 ${name}] ${text}`;
}

// 结束方式
export type ScriptEnding =
  | { kind: "completed" }
  | { kind: "budget" }
  | { kind: "stopped" }
  | { kind: "stalled"; minutes: number }
  | { kind: "error"; reason: string };

export function endingText(ending: ScriptEnding): string {
  switch (ending.kind) {
    case "completed":
      return "completed";
    case "budget":
      return "ran out of budget";
    case "stopped":
      return "was stopped";
    case "stalled":
      return `stalled: no worker was running or queued for ${counted(ending.minutes, "minute")} and the script had not finished, so it was stopped`;
    default:
      return `failed with an error: ${ending.reason}`;
  }
}

export interface SummaryInput {
  name: string;
  runId: string;
  ending: ScriptEnding;
  workers: number;
  succeeded: number;
  failed: number;
  reused: number;
  spent: string;
  failures: ReadonlyArray<{ who: string; status: string; reason: string }>;
  awaitingApproval: ReadonlyArray<{ who: string; action: string }>;
  // 因额度用完没有派出的调用数（额度用完时在场）
  notStarted?: number;
  // 额度用完、被停或卡住时已做完的 worker 与分支（不自动收回）
  done?: ReadonlyArray<{ name: string; branch: string }>;
  collection:
    | { kind: "done"; applied: string[]; conflicts: string[]; deletedByWorker: string[] }
    | { kind: "skipped"; reason: CollectionSkip };
  returned?: unknown;
}

// 没有收回的原因：调用方（script-runner.ts）给的键沿用中文写法，汇总里写成英文
export type CollectionSkip = "脚本没有正常结束" | "人没有批准" | "没有要收回的";
const COLLECTION_SKIP_TEXTS: Readonly<Record<CollectionSkip, string>> = {
  脚本没有正常结束: "the script did not finish normally",
  人没有批准: "the user did not approve",
  没有要收回的: "there was nothing to collect",
};

// 条数与名词：1 minute、2 minutes
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function list(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

// 汇总里脚本返回值那一行的开头
export const SCRIPT_RETURNED_LEAD = "Script returned: ";

export function summaryText(input: SummaryInput): string {
  const lines = [
    `Script ${input.name} (run ID ${input.runId}) ${endingText(input.ending)}. Workers: ${input.workers}; succeeded ${input.succeeded}, failed ${input.failed}, of which ${input.reused} reused results from the last run. Spent ${input.spent}.`,
  ];
  if (input.failures.length > 0) {
    lines.push(
      `Failed: ${input.failures.map((item) => `${item.who}: ${item.status}, ${item.reason}`).join("; ")}`
    );
  }
  if (input.awaitingApproval.length > 0) {
    lines.push(
      `Waiting for approval timed out (after approval, resume with resume_run=${input.runId}): ${input.awaitingApproval
        .map((item) => `${item.who}: ${item.action}`)
        .join("; ")}`
    );
  }
  if (input.notStarted !== undefined) {
    lines.push(
      `Not done because the budget ran out: ${input.notStarted === 1 ? "1 call was" : `${input.notStarted} calls were`} not spawned; raise the budget and resume with resume_run=${input.runId}.`
    );
  }
  if (input.done !== undefined && input.done.length > 0) {
    lines.push(
      `Already done: ${input.done.map((item) => `${item.name} (branch ${item.branch})`).join(", ")}. They can be taken one by one with /take, or raise the budget and resume; finished work will be reused.`
    );
  }
  const collection = input.collection;
  lines.push(
    collection.kind === "done"
      ? `Collected: applied ${list(collection.applied)}; conflicts, not written: ${list(collection.conflicts)}; deleted by workers, not deleted here: ${list(collection.deletedByWorker)}.`
      : `Not collected: ${COLLECTION_SKIP_TEXTS[collection.reason]}.`
  );
  if (input.returned !== undefined && input.returned !== null) {
    let text: string;
    try {
      text = JSON.stringify(input.returned) ?? "";
    } catch {
      text = String(input.returned);
    }
    lines.push(`${SCRIPT_RETURNED_LEAD}${text.slice(0, 1000)}`);
  }
  return lines.join("\n");
}

// 收回请示的来源行
export function collectSourceLine(name: string, runId: string): string {
  return `来源：脚本 ${name}（运行号 ${runId}）收回`;
}

// 审批新键
export const SCRIPT_KIND_KEY_LABEL = "[s] 本次脚本内同类都允许";

export function scriptKindAllowedLine(kind: string): string {
  return `已允许本次脚本内同类调用（${kind}），脚本结束即失效`;
}
