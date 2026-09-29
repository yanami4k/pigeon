// 脚本编排的界面（决策 300、301、303、309）：开跑一行计划、log 行与结束汇总进消息区；树形视图接上脚本与阶段两层；界面上可停止
// 整个脚本（树形视图里选中脚本下的 worker 按 X，或 /orchestrate stop）；/orchestrate 发起即以人的输入提交、交给模型的文字带
// 关键词（点名与额度生效）；审批面板的"本次脚本内同类都允许"只对本脚本内同类生效，高危命令不提供。
// 真编排器与真 git 工作树、本机进程版执行器、虚拟屏。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { wrapScriptApprovals } from "../application/script-approvals.ts";
import { scriptCommands } from "../application/script-commands.ts";
import { type PlanInput, scriptHarness, type WorkerPlan } from "../application/script-fixtures.ts";
import { ScriptGate } from "../application/script-naming.ts";
import { commandInputText } from "../application/script-texts.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { newSessionId } from "../state/ids.ts";
import { approvalBlockText, createTuiApprovalHandler } from "./approval.ts";
import { until } from "./orchestration-fixtures.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenFlat, settle } from "./testing.ts";
import type { TuiWorkersFace } from "./workers-view.ts";

const CTRL_X = "\x18";

async function type(term: MockTerminal, text: string): Promise<void> {
  if (text.length > 1 && text.endsWith("\r")) {
    term.input(text.slice(0, -1));
    term.input("\r");
  } else {
    term.input(text);
  }
  await settle();
}

// 与终端界面入口同形的装配：编排面、脚本的树形视图数据与命令面、点名入口、包在审批外面的同类放行
function scriptShell(planner: (input: PlanInput) => WorkerPlan | Promise<WorkerPlan>) {
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
  return { harness, shell, term, runtime, gate, asked };
}

const script = (source: string, phases: string[] = []) => ({ name: "t", phases, script: source });

test("开跑的计划行、log 行与结束汇总进消息区；树形视图接上脚本与阶段两层，面板照常列出各 worker", async () => {
  const release = Promise.withResolvers<void>();
  const { harness, shell, term } = scriptShell((input) =>
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
    await done;
    await settle(150);
    const after = screenFlat(term);
    assert.ok(after.includes(`script t (${runId})  done`), after);
    assert.ok(after.includes("phase 修改  done"), after);
    await type(term, CTRL_X);
    assert.ok(screenFlat(term).includes(`[脚本通知] 脚本 t（运行号 ${runId}）已完成。`));
  } finally {
    shell.stop();
  }
});

test("界面上停止整个脚本：树形视图里选中脚本下的 worker 按 X；/orchestrate stop；在跑的 worker 停下，结果照常交回", async () => {
  const { harness, shell, term } = scriptShell(() => ({ hang: true }));
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
    const summary = await done;
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
    assert.match(await second, new RegExp(`运行号 ${other}）已停止`));
  } finally {
    shell.stop();
  }
});

test("/orchestrate 发起：以人的输入提交，交给模型的文字带关键词，点名与额度生效；下一条没带即收回", async () => {
  const { shell, term, runtime, gate } = scriptShell(() => ({}));
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
    shell.stop();
  }
});

test("审批：本次脚本内同类都允许只对本脚本内同类生效；高危命令不提供 [s]，照常逐次请示", async () => {
  const { harness, shell, term, asked } = scriptShell((input) => ({
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
    await settle();
    assert.ok(screenFlat(term).includes("[s] 本次脚本内同类都允许"), screenFlat(term));
    await type(term, "s");
    assert.ok(
      screenFlat(term).includes("已允许本次脚本内同类调用（跑命令 npm test），脚本结束即失效")
    );
    // 第二个 npm test 不再请示；rm 照常请示且不提供 [s]
    await until(() => asked.length === 2, "rm 的请示");
    await settle();
    assert.equal(asked[1]?.args && (asked[1].args as { command: string }).command, "rm -rf build");
    assert.equal(asked[1]?.script?.kind, undefined);
    const rmBlock = screenFlat(term).split("—— 人工审批 ——").at(-1) ?? "";
    assert.ok(!rmBlock.includes("[s]"), rmBlock);
    await type(term, "s");
    assert.ok(screenFlat(term).includes("state: approval"), "按 s 不起作用，仍在等审批");
    await type(term, "y");
    await first;
    // 另一个脚本里照常请示
    const second = harness.nextNotice();
    await harness.runs.start(script('await agent("三"); return 1;'), undefined);
    await until(() => asked.length === 3, "另一个脚本的请示");
    const third = asked[2]?.args as { command: string } | undefined;
    assert.equal(third?.command, "npm test");
    await settle();
    await type(term, "y");
    await second;
    assert.equal(asked.length, 3);
  } finally {
    shell.stop();
  }
});

test("收回的请示：来源写明脚本与运行号，按 take_worker 的写操作请示一次", async () => {
  const { harness, shell } = scriptShell(() => ({ files: { "n.txt": "n\n" } }));
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
    assert.match(await done, /收回：叠入 n\.txt/);
    assert.equal(harness.collectRequests.length, 1);
  } finally {
    shell.stop();
  }
});
