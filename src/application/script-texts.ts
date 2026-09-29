// 脚本编排的说明与返回文字（决策 309–314；按 271 定稿文字的风格拟稿、过目后定稿）：工具说明、参数说明、各情形的返回文字、
// worker 附言与改正、开跑计划行、log 行、结束汇总、收回请示与审批新键的回显。数值与名字由调用方填入。
import { SCRIPT_COMMAND, SCRIPT_KEYWORD } from "./script-naming.ts";

export const ORCHESTRATE_TOOL = "orchestrate";

// 结束汇总进主 agent 下一轮时的前缀（与 worker 通知同一样式显示成系统行）
export const SCRIPT_NOTICE_PREFIX = "[脚本通知] ";

// 工具说明；modelDecides 为项目配置打开"由模型判断何时用"时的第 2 句
export function orchestrateDescription(options: { modelDecides: boolean }): string {
  return [
    "提交一段编排脚本，由程序在隔离容器里执行，批量派 worker 并按脚本把它们串起来。提交后立即返回运行号，不等它跑完；脚本结束时有一条通知交回汇总。",
    options.modelDecides
      ? "任务要派很多个 worker、分几个阶段，或要按固定流程批量处理时用；两三个独立子任务用 spawn_worker 就够。"
      : `只在人点名时用：人本次输入里写了"${SCRIPT_KEYWORD}"，或用 /${SCRIPT_COMMAND} 发起。人没点名时不要用，调用会被拒绝；派几个 worker 用 spawn_worker。`,
    "脚本是 JavaScript 函数体（可用 await 与 return），积木六个：agent(任务, 选项) 派一个 worker 并等它结束，返回 {ok, status, name, branch, files, summary, output, error, errorKind}；选项 label、phase、role（explorer、implementer、tester，缺省 implementer）、schema（JSON Schema：worker 最后按它交回数据，放在 output；不合格式时程序让它在原会话改正，至多两次）、relay（先前某次 agent 的结果：新 worker 从那个 worker 的分支接着开工）。parallel([() => agent(…), …]) 全部结束才返回，结果按顺序。pipeline(items, 步骤1, 步骤2, …) 每项各自依次走完各步骤、不等其他项，步骤为 (上一步结果, 项, 序号) => …，第一步收到的上一步结果就是该项本身；某步失败即跳过该项后面的步骤。phase(名) 之后的 agent 归入这个阶段；log(文字) 在人的消息区写一行；args 为提交时给的参数。",
    [
      "例：",
      'phase("调查");',
      'const scan = await agent("列出 src/ 下没有单元测试的模块", { role: "explorer", schema: { type: "object", properties: { modules: { type: "array", items: { type: "string" } } }, required: ["modules"] } });',
      'phase("补测试");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是脚本原文（容器里执行的 JavaScript），不是本文件的模板字符串
      "const written = await parallel((scan.output?.modules ?? []).map((m) => () => agent(`给 ${m} 写单元测试`, { label: m })));",
      "return { collect: written.filter((r) => r.ok) };",
    ].join("\n"),
    "脚本只做调度：不能读写文件、跑命令、联网，没有 require、import 与 process；读时间（Date.now、new Date()）与取随机数（Math.random）会报错。要的信息让 worker 查回来，或经 args 传入。worker 看不到本会话的对话，任务要写全。",
    "worker 缺省从脚本开跑时拍的主工作目录快照开工，给了 relay 即从那个 worker 的分支接着做；脚本运行期间主工作目录不动。脚本最后 return { collect: [要收回的结果] }：结束后程序按先后把这些 worker 各自的改动以三方叠加并入主工作目录，整批请示一次；冲突与 worker 删除的文件列在汇总里。不给 collect 即不收回。",
    "单个 worker 失败不中断脚本：agent 照常返回，ok 为 false，带状态与原因，由脚本决定怎么办；框架不自动重试。",
    '人点名时可能给了花费上限：到上限即不再派新 worker，在跑的做完，脚本以"额度用完"结束。续跑：resume_run 给上一次的运行号，脚本从头重跑，和上次相同的调用直接复用结果，只重派没做完、失败或改过的；接力的上游重做时下游也重做。',
  ].join("\n");
}

export const ORCHESTRATE_PARAM_TEXTS = {
  name: "脚本名，显示在开跑的计划行与树形视图里",
  phases: "各阶段名，按先后，显示在计划行",
  script: "脚本正文（JavaScript 函数体，可用 await 与 return）",
  args: "传给脚本的参数，脚本里用 args 读",
  resumeRun: "续跑时给上一次的脚本运行号；不给即新开一次",
} as const;

export const ORCHESTRATE_TEXTS = {
  started: (name: string, runId: string) =>
    `已开跑脚本 ${name}，运行号 ${runId}。结束时会有通知交回汇总；运行期间主工作目录不动。`,
  resumed: (name: string, runId: string) =>
    `已续跑脚本 ${name}，运行号 ${runId}，沿用上次开跑时的快照，上次做完的调用直接复用。结束时会有通知交回汇总。`,
  notNamed: `人本次输入没有点名脚本编排，不能提交脚本。需要时请人在输入里写"${SCRIPT_KEYWORD}"或用 /${SCRIPT_COMMAND} 发起；几个独立子任务用 spawn_worker。`,
  unknownRun: (runId: string) => `没有运行号为 ${runId} 的脚本（续跑只限本会话）。`,
  stillRunning: (runId: string) => `脚本 ${runId} 还在跑，不能续跑；等它结束或请人先停下。`,
  noDocker: (reason: string) => `Docker 不可用，脚本编排跑不了：${reason}。`,
  // 以下为装配与前置检查的失败（不在定稿清单内的兜底，沿用 spawn_worker 的"不是 git 仓库"说法）
  notGit: "当前工作区不是 git 仓库，不能跑编排脚本。",
  unbound: "本会话没有装配脚本编排。",
  failed: (reason: string) => `脚本没有开跑：${reason}。`,
} as const;

// 给了输出格式时附在任务后面的话
export function schemaAppendix(schema: unknown): string {
  return `\n\n完成后，最后一条回复只给一个符合下面 JSON Schema 的 JSON 对象（可放在 \`\`\`json 代码块里），不要别的文字：\n${JSON.stringify(schema, null, 2)}`;
}

// 让 worker 在原会话里改正
export function schemaCorrection(problems: readonly string[], schema: unknown): string {
  return `你最后交回的内容不合要求的格式：${problems.join("；")}。请在最后一条回复里只给一个符合下面 JSON Schema 的 JSON 对象，不要别的文字：\n${JSON.stringify(schema, null, 2)}`;
}

// /orchestrate 发起时交给模型的文字
export function commandInputText(task: string): string {
  return `（人用 /${SCRIPT_COMMAND} 点名用${SCRIPT_KEYWORD}做这件事）\n${task}`;
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
  | { kind: "error"; reason: string };

export function endingText(ending: ScriptEnding): string {
  switch (ending.kind) {
    case "completed":
      return "已完成";
    case "budget":
      return "额度用完";
    case "stopped":
      return "已停止";
    default:
      return `出错：${ending.reason}`;
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
  collection:
    | { kind: "done"; applied: string[]; conflicts: string[]; deletedByWorker: string[] }
    | { kind: "skipped"; reason: "脚本没有正常结束" | "人没有批准" | "没有要收回的" };
  returned?: unknown;
}

function list(items: readonly string[]): string {
  return items.length > 0 ? items.join("、") : "无";
}

export function summaryText(input: SummaryInput): string {
  const lines = [
    `脚本 ${input.name}（运行号 ${input.runId}）${endingText(input.ending)}。worker ${input.workers} 个：成功 ${input.succeeded}，失败 ${input.failed}，其中复用上次结果 ${input.reused}。花费 ${input.spent}。`,
  ];
  if (input.failures.length > 0) {
    lines.push(
      `失败：${input.failures.map((item) => `${item.who}：${item.status}，${item.reason}`).join("；")}`
    );
  }
  if (input.awaitingApproval.length > 0) {
    lines.push(
      `等审批超时（补批后用 resume_run=${input.runId} 续跑）：${input.awaitingApproval
        .map((item) => `${item.who}：要${item.action}`)
        .join("；")}`
    );
  }
  if (input.notStarted !== undefined) {
    lines.push(
      `额度用完未做：${input.notStarted} 个调用没有派出；调高额度后用 resume_run=${input.runId} 续跑。`
    );
  }
  const collection = input.collection;
  lines.push(
    collection.kind === "done"
      ? `收回：叠入 ${list(collection.applied)}；冲突未写入 ${list(collection.conflicts)}；worker 删除未删 ${list(collection.deletedByWorker)}。`
      : `未收回：${collection.reason}。`
  );
  if (input.returned !== undefined && input.returned !== null) {
    let text: string;
    try {
      text = JSON.stringify(input.returned) ?? "";
    } catch {
      text = String(input.returned);
    }
    lines.push(`脚本返回：${text.slice(0, 1000)}`);
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
