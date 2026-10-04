// 脚本编排的界面（决策 300、301、303、309）：开跑一行计划、log 行与结束汇总进消息区；树形视图接上脚本与阶段两层；界面上可停止
// 整个脚本（树形视图里选中脚本下的 worker 按 X，或 /orchestrate stop）；/orchestrate 发起即以人的输入提交、交给模型的文字带
// 关键词（点名与额度生效）；审批面板的"本次脚本内同类都允许"只对本脚本内同类生效，高危命令不提供。
// 真编排器与真 git 工作树、本机进程版执行器、虚拟屏。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { wrapScriptApprovals } from "../application/script-approvals.ts";
import { scriptCommands } from "../application/script-commands.ts";
import { type PlanInput, scriptHarness, type WorkerPlan } from "../application/script-fixtures.ts";
import { ScriptGate } from "../application/script-naming.ts";
import { commandInputText } from "../application/script-texts.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { localScriptLauncher, type ScriptProcess } from "../execution/script-sandbox.ts";
import { newSessionId } from "../state/ids.ts";
import { approvalBlockText, createTuiApprovalHandler } from "./approval.ts";
import { until } from "./orchestration-fixtures.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle } from "./testing.ts";
import type { TuiWorkersFace } from "./workers-view.ts";

const CTRL_X = "\x18";

// 等屏幕与等汇总的上限（与夹具 until 同为 15 秒）。脚本派 worker 时编排器同步跑 git（建工作树、收尾时
// git status）：Linux 上一次几毫秒，Windows 上一次约 0.3 秒（CPU 被争用时更长），一条用例要过好几个 worker
const WAIT_MS = 15_000;
// 收尾时等脚本运行结束的上限，到点即杀执行器子进程
const CLOSE_MS = 5_000;

// 等屏幕上出现一段文字。按键之后的回显不能靠固定的 settle()：批准之后 worker 随即收尾，编排器在同一串调用里
// 同步跑 git status，接着下一个 worker 又同步建工作树；Windows 上这几百毫秒把界面的节流重绘推到 settle 的
// 80ms 之后，断言读到的还是按键前的屏幕（Linux 上 git 快，碰不到）
async function untilScreen(term: MockTerminal, text: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!screenFlat(term).includes(text)) {
    if (Date.now() > deadline) assert.fail(`屏幕上没有等到「${text}」：\n${screenText(term)}`);
    await settle(10);
  }
}

// 等一个承诺兑现（汇总通知之类），有上限：卡住即判失败，用例走到 finally 收尾，不吊在这里
async function within<T>(promise: Promise<T>, what: string, ms = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}没有等到`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function type(term: MockTerminal, text: string): Promise<void> {
  if (text.length > 1 && text.endsWith("\r")) {
    term.input(text.slice(0, -1));
    term.input("\r");
  } else {
    term.input(text);
  }
  await settle();
}

// 与终端界面入口同形的装配：编排面、脚本的树形视图数据与命令面、点名入口、包在审批外面的同类放行。
// 用例在 finally 里调返回的 close 收尾（见 closeScript）
function scriptShell(planner: (input: PlanInput) => WorkerPlan | Promise<WorkerPlan>) {
  // 本用例起的执行器子进程：收尾时兜底杀掉
  const procs = new Set<ScriptProcess>();
  const shellHolder: { current?: PigeonTuiShell } = {};
  const asked: ApprovalRequest[] = [];
  const grants = new SessionGrantStore({ workspaceRoot: "/nonexistent" });
  const panel = createTuiApprovalHandler(grants, () => shellHolder.current);
  const runsHolder: { current?: ReturnType<typeof scriptHarness>["runs"] } = {};
  const approvals = wrapScriptApprovals(
    async (request) => {
      asked.push(request);
      return panel(request);
    },
    () => runsHolder.current
  );
  const harness = scriptHarness({
    planner,
    approvals: (request) => approvals(request),
    display: (line) => {
      shellHolder.current?.addSystem(line);
      shellHolder.current?.render();
    },
    launcher: async () => {
      const launch = localScriptLauncher();
      return (input) => {
        const proc = launch(input);
        procs.add(proc);
        return proc;
      };
    },
  });
  runsHolder.current = harness.runs;
  const orchestrator = harness.orchestrator;
  const face: TuiWorkersFace = {
    spawn: (request) => orchestrator.spawn({ ...request, origin: "human" }),
    subscribe: (listener) => orchestrator.subscribe((event) => listener(event)),
    observe: (listener) => orchestrator.observe(listener),
    send: (id, text) => orchestrator.send(id, text),
    resume: (id, options) => orchestrator.resume(id, options),
    cancel: (id) => orchestrator.cancel(id),
    status: () => orchestrator.status(),
    awaitResult: (id) => orchestrator.awaitResult(id),
  };
  const gate = new ScriptGate({ modelDecides: false });
  const commands = scriptCommands(harness.runs, orchestrator);
  const term = new MockTerminal(160, 50);
  const sessionId = newSessionId();
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir: mkdtempSync(join(tmpdir(), "pigeon-tui-o3-")),
    workerRefreshMs: 20,
    workers: face,
    scripts: () => harness.runs.nodes(),
    scriptCommands: () => commands,
    onHumanInput: (text) => gate.humanInput(text),
  });
  shellHolder.current = shell;
  const close = () => closeScript(harness, shell, procs);
  return { harness, shell, term, runtime, gate, asked, close };
}

// 收尾（用例通过与否都走）：先停在跑的脚本（在跑的 worker 被中断，其余调用不再派），再停壳（挂着的审批按拒绝
// 收口），再中断仍在跑的 worker（壳停之后才来的请示被拒，worker 要等中断才交回）；等运行结束有上限，到点杀掉
// 执行器子进程。不这样收尾，失败的用例会留下等中断的 worker 与活着的执行器子进程（管道让事件循环一直不空），
// 进程要等 worker 的卡住判定（10 分钟）到点、脚本跑完才退出
async function closeScript(
  harness: ReturnType<typeof scriptHarness>,
  shell: PigeonTuiShell,
  procs: ReadonlySet<ScriptProcess>
): Promise<void> {
  const { orchestrator, runs } = harness;
  const live = runs.running();
  await Promise.allSettled(live.map((runId) => runs.stop(runId)));
  shell.stop();
  await Promise.allSettled(orchestrator.status().map((w) => orchestrator.cancel(w.sessionId)));
  const settled = Promise.allSettled(live.map((runId) => runs.settled(runId)));
  await within(settled, "脚本运行收尾", CLOSE_MS).catch(() => {});
  await Promise.allSettled([...procs].map((proc) => proc.kill()));
  runs.dispose();
}

const script = (source: string, phases: string[] = []) => ({ name: "t", phases, script: source });

test("开跑的计划行、log 行与结束汇总进消息区；树形视图接上脚本与阶段两层，面板照常列出各 worker", async () => {
  const release = Promise.withResolvers<void>();
  const { harness, shell, term, close } = scriptShell((input) =>
    input.task === "查" ? { wait: release.promise } : {}
  );
  shell.start();
  try {
    const done = harness.nextNotice();
    const runId = await harness.runs.start(
      script('phase("调查"); log("开始了"); await agent("查"); phase("修改"); await agent("改");', [
        "调查",
        "修改",
      ]),
      { unit: "cny", amount: 5 }
    );
    await until(() => harness.sink.spawned.length === 1, "派出第一个");
    await settle();
    const flat = screenFlat(term);
    assert.ok(flat.includes(`[脚本] t（运行号 ${runId}）开跑：阶段 调查 → 修改；额度 ¥5。`), flat);
    assert.ok(flat.includes("[脚本 t] 开始了"), flat);
    assert.ok(flat.includes(`${runId}-1`), "面板照常列出脚本派出的 worker");
    await type(term, CTRL_X);
    const tree = screenFlat(term);
    assert.ok(tree.includes(`script t (${runId})  running`), tree);
    assert.ok(tree.includes("phase 调查  running"), tree);
    assert.ok(tree.includes("[X] stop script"), tree);
    release.resolve();
    await within(done, "脚本的汇总");
    await settle(150);
    const after = screenFlat(term);
    assert.ok(after.includes(`script t (${runId})  done`), after);
    assert.ok(after.includes("phase 修改  done"), after);
    await type(term, CTRL_X);
    assert.ok(screenFlat(term).includes(`[脚本通知] 脚本 t（运行号 ${runId}）已完成。`));
  } finally {
    await close();
  }
});

test("界面上停止整个脚本：树形视图里选中脚本下的 worker 按 X；/orchestrate stop；在跑的 worker 停下，结果照常交回", async () => {
  const { harness, shell, term, close } = scriptShell(() => ({ hang: true }));
  shell.start();
  try {
    const done = harness.nextNotice();
    const runId = await harness.runs.start(
      script(
        'const r = await parallel([() => agent("一"), () => agent("二")]); await agent("三"); return r.length;'
      ),
      undefined
    );
    await until(() => harness.sink.spawned.length === 2, "派出两个");
    await type(term, CTRL_X);
    await type(term, "X");
    const summary = await within(done, "停止后的汇总");
    assert.match(
      summary,
      new RegExp(`脚本 t（运行号 ${runId}）已停止。worker 2 个：成功 0，失败 2`)
    );
    assert.match(summary, /失败：[^\n]*取消/);
    assert.equal(harness.sink.spawned.length, 2, "停止之后不再派");
    // 那一行写在主会话的消息区：关上树形视图再看
    await type(term, CTRL_X);
    assert.ok(screenFlat(term).includes(`已停止脚本 ${runId}`));
    // /orchestrate stop 停在跑的全部
    const second = harness.nextNotice();
    const other = await harness.runs.start(script('await agent("四");'), undefined);
    await until(() => harness.sink.spawned.length === 3, "派出第四个");
    await type(term, "/orchestrate stop\r");
    const stopped = await within(second, "/orchestrate stop 之后的汇总");
    assert.match(stopped, new RegExp(`运行号 ${other}）已停止`));
  } finally {
    await close();
  }
});

test("/orchestrate 发起：以人的输入提交，交给模型的文字带关键词，点名与额度生效；下一条没带即收回", async () => {
  const { shell, term, runtime, gate, close } = scriptShell(() => ({}));
  shell.start();
  try {
    await type(term, "/orchestrate 给各模块补测试 额度 ¥5\r");
    assert.deepEqual(runtime.runs, [commandInputText("给各模块补测试 额度 ¥5")]);
    assert.ok(gate.allowed());
    assert.deepEqual(gate.budget(), { unit: "cny", amount: 5 });
    await type(term, "谢谢\r");
    assert.ok(!gate.allowed());
    await type(term, "/orchestrate\r");
    assert.ok(screenFlat(term).includes("用法：/orchestrate <任务>"));
  } finally {
    await close();
  }
});

test("审批：本次脚本内同类都允许只对本脚本内同类生效；高危命令不提供 [s]，照常逐次请示", async () => {
  const { harness, shell, term, asked, close } = scriptShell((input) => ({
    ask: input.task.startsWith("删") ? "rm -rf build" : "npm test",
  }));
  shell.start();
  try {
    const first = harness.nextNotice();
    await harness.runs.start(
      script('await agent("一"); await agent("二"); await agent("删"); return 1;'),
      undefined
    );
    await until(() => asked.length === 1, "第一次请示");
    await untilScreen(term, "[s] 本次脚本内同类都允许");
    await type(term, "s");
    // 按 s 之后第一个 worker 随即收尾（同步 git），回显要等重绘：等它出现，不靠固定的 settle
    await untilScreen(term, "已允许本次脚本内同类调用（跑命令 npm test），脚本结束即失效");
    // 第二个 npm test 不再请示；rm 照常请示且不提供 [s]
    await until(() => asked.length === 2, "rm 的请示");
    assert.equal(asked[1]?.args && (asked[1].args as { command: string }).command, "rm -rf build");
    assert.equal(asked[1]?.script?.kind, undefined);
    await untilScreen(term, "命令：rm -rf build");
    const rmBlock = screenFlat(term).split("—— 人工审批 ——").at(-1) ?? "";
    assert.ok(!rmBlock.includes("[s]"), rmBlock);
    await type(term, "s");
    assert.ok(screenFlat(term).includes("state: approval"), "按 s 不起作用，仍在等审批");
    await type(term, "y");
    await within(first, "第一个脚本的汇总");
    // 另一个脚本里照常请示
    const second = harness.nextNotice();
    await harness.runs.start(script('await agent("三"); return 1;'), undefined);
    await until(() => asked.length === 3, "另一个脚本的请示");
    const third = asked[2]?.args as { command: string } | undefined;
    assert.equal(third?.command, "npm test");
    await settle();
    await type(term, "y");
    await within(second, "另一个脚本的汇总");
    assert.equal(asked.length, 3);
  } finally {
    await close();
  }
});

test("收回的请示：来源写明脚本与运行号，按 take_worker 的写操作请示一次", async () => {
  const { harness, shell, close } = scriptShell(() => ({ files: { "n.txt": "n\n" } }));
  shell.start();
  try {
    // 夹具的收回请示直接批；这里只看面板的写法
    const text = approvalBlockText({
      toolName: "take_worker",
      toolCallId: "script-collect-s1",
      args: { workers: ["s1-1"] },
      tier: "write",
      script: { runId: "s1", title: "t" },
    });
    assert.match(text, /^—— 人工审批 ——\n来源：脚本 t（运行号 s1）收回\n工具：take_worker/);
    assert.doesNotMatch(text, /\[s\]/);
    const done = harness.nextNotice();
    await harness.runs.start(
      script('const r = await agent("写"); return { collect: [r] };'),
      undefined
    );
    assert.match(await within(done, "收回后的汇总"), /收回：叠入 n\.txt/);
    assert.equal(harness.collectRequests.length, 1);
  } finally {
    await close();
  }
});
