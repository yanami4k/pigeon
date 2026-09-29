// 编排进度界面（决策 301）：编排面板（各列、实时刷新、过滤与 "+N"、淡出、无 worker 不占行）；树形视图（切换、分层、展开显示
// 最近调用、任务清单标注、脚本与阶段两层的数据接口）；从面板与树形视图进入 worker 会话（实时显示、发消息、停止、补批续做、
// 退出回主会话）；进入期间主会话照常运行、审批照常弹出；状态栏的本会话花费含在跑 worker 的实时花费；/workers 与面板同一排版；
// 窄终端与缩放。真编排器 + 用例逐步驱动的 worker 运行面替身，虚拟屏断言。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { textRun } from "../application/session-view-fixtures.ts";
import type { TaskItem } from "../application/task-list-tool.ts";
import type { WorkerActivity, WorkerRef } from "../application/workers-commands.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope } from "../state/events.ts";
import { newEntryId, newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { rejectInWorkerSession, rejectWhileRunning } from "./command-table.ts";
import { orchestrationHarness, until } from "./orchestration-fixtures.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { assertWidthsWithin, MockTerminal, screenFlat, settle } from "./testing.ts";
import { WorkerActivityTracker } from "./worker-activity.ts";
import type { OrchestrationScriptNode } from "./worker-tree.ts";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const CTRL_X = "\x18";

function shellWith(options: Partial<TuiShellOptions> & { cols?: number; rows?: number } = {}): {
  term: MockTerminal;
  shell: PigeonTuiShell;
  runtime: ScriptedRuntime;
  sessionId: SessionId;
} {
  const { cols, rows, ...rest } = options;
  const term = new MockTerminal(cols ?? 120, rows ?? 40);
  const sessionId = newSessionId();
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir: mkdtempSync(join(tmpdir(), "pigeon-tui-o2-")),
    workerRefreshMs: 20,
    ...rest,
  });
  return { term, shell, runtime, sessionId };
}

// 面板里某个 worker 的一行（行首一格边距，再是两格选中标记）；取屏幕上最后一个匹配
function panelRow(term: MockTerminal, name: string): string | undefined {
  const pattern = new RegExp(`^ (?:> | {2})${name} `);
  return term.screen
    .contentLines()
    .filter((line) => pattern.test(line))
    .at(-1);
}

function lines(term: MockTerminal): string[] {
  return term.screen.contentLines();
}

// 标题：屏幕上第一行非空内容（标题组件上下各留一行空白）
function titleLine(term: MockTerminal): string | undefined {
  return lines(term).find((line) => line.trim() !== "");
}

// 输入一段文字；末尾的回车单独按（同现有用例的写法）
async function type(term: MockTerminal, text: string): Promise<void> {
  if (text.length > 1 && text.endsWith("\r")) {
    term.input(text.slice(0, -1));
    term.input("\r");
  } else {
    term.input(text);
  }
  await settle();
}

test("编排面板：agent 派与人派的 worker 都即时出现，名字、状态、耗时、轮数、花费、正在做什么随活动实时刷新；/workers 与面板同一排版", async () => {
  const clock = { now: 1_700_000_000_000 };
  const h = orchestrationHarness({ now: () => clock.now });
  const { term, shell } = shellWith({ workers: h.face, now: () => clock.now });
  try {
    shell.start();
    await settle();
    assert.equal(panelRow(term, "look-a"), undefined);
    // agent 派出：不经壳的任何命令
    h.orchestrator.spawn({ role: "explorer", task: "看看", name: "look-a", origin: "agent" });
    await settle();
    assert.match(panelRow(term, "look-a") ?? "", /look-a\s+running\s+0s\s+0t\s+\$0\s+starting$/);
    h.runtime("look-a").toolCall("c1", "read_file", { path: "src/a.ts" });
    clock.now += 65_000;
    h.runtime("look-a").turn("读完了", { totalTokens: 1200, cost: 0.5 });
    await settle();
    assert.match(
      panelRow(term, "look-a") ?? "",
      /look-a\s+running\s+1m05s\s+1t\s+\$0\.50\s+\$ read_file \{"path":"src\/a\.ts"\}$/
    );
    // 人派：/spawn
    await type(term, '/spawn implementer --name fix-b "修 b"\r');
    assert.match(panelRow(term, "fix-b") ?? "", /fix-b\s+running\s+0s\s+0t/);
    h.runtime("fix-b").toolCall("c2", "edit_file", { path: "b.ts" });
    await settle();
    assert.match(panelRow(term, "fix-b") ?? "", /\$ edit_file \{"path":"b\.ts"\}$/);
    // 收尾：状态与耗时定格，正在做什么换成自述的第一行
    h.runtime("look-a").finish("结论：没问题\n细节略");
    await settle();
    assert.match(
      panelRow(term, "look-a") ?? "",
      /look-a\s+done\s+1m05s\s+1t\s+\$0\.50\s+结论：没问题$/
    );
    // /workers：每个 worker 的一行与面板那一行逐字相同
    const shown = [panelRow(term, "look-a"), panelRow(term, "fix-b")].map((row) => row?.trim());
    await type(term, "/workers\r");
    const flat = lines(term).map((line) => line.trim());
    assert.ok(flat.includes("workers (2):"), screenFlat(term));
    for (const row of shown) {
      assert.ok(row !== undefined && flat.filter((line) => line === row).length >= 2, row);
    }
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("编排面板的过滤：行数有上限、超出折成 +N；结束的过了淡出期消失；没有要列的 worker 时面板不占行", async () => {
  const clock = { now: 1_700_000_000_000 };
  const h = orchestrationHarness({ now: () => clock.now });
  const { term, shell } = shellWith({
    workers: h.face,
    now: () => clock.now,
    panelMaxRows: 2,
    panelFadeMs: 10_000,
  });
  try {
    shell.start();
    await settle();
    const bottom = lines(term).at(-1);
    assert.equal(bottom, " cost $0", "没有 worker：状态栏是最后一行");
    for (const name of ["w-a", "w-b", "w-c"]) {
      h.orchestrator.spawn({ role: "explorer", task: name, name, origin: "agent" });
    }
    await settle();
    assert.ok(panelRow(term, "w-a") !== undefined && panelRow(term, "w-b") !== undefined);
    assert.equal(panelRow(term, "w-c"), undefined);
    assert.equal(lines(term).at(-1), "   +1 more (/workers, ctrl+x)");
    // 结束的排在在跑的之后
    h.runtime("w-a").finish("好了");
    await settle();
    assert.ok(panelRow(term, "w-b") !== undefined && panelRow(term, "w-c") !== undefined);
    assert.equal(lines(term).at(-1), "   +1 more (/workers, ctrl+x)");
    // 过了淡出期：结束的那个不再计入
    clock.now += 11_000;
    await settle(120);
    assert.equal(lines(term).at(-1)?.startsWith("   +"), false, lines(term).join("\n"));
    await h.orchestrator.cancel(h.orchestrator.status()[1]?.sessionId as SessionId);
    await h.orchestrator.cancel(h.orchestrator.status()[2]?.sessionId as SessionId);
    await settle();
    assert.match(panelRow(term, "w-b") ?? "", /w-b\s+cancelled/);
    clock.now += 11_000;
    await settle(120);
    assert.equal(lines(term).at(-1), " cost $0", "全部淡出后面板不占行");
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("树形视图：Ctrl+X 与 /agents 切换整屏；主 agent、嵌套 worker 分层；展开才显示最近的工具调用；按标签标出清单项；脚本与阶段有数据才显示", async () => {
  const h = orchestrationHarness({ maxDepth: 2 });
  const tasks: TaskItem[] = [
    { id: "1", title: "写登录", status: "in_progress", workerLabel: "T1" },
    { id: "2", title: "写注册", status: "pending" },
  ];
  let scripts: OrchestrationScriptNode[] = [];
  const { term, shell, sessionId } = shellWith({
    workers: h.face,
    taskItems: () => tasks,
    scripts: () => scripts,
  });
  try {
    shell.start();
    await settle();
    const parent = h.orchestrator.spawn({
      role: "implementer",
      task: "登录",
      name: "plan-a",
      label: "T1",
      origin: "agent",
    });
    const child = h.orchestrator.spawn({
      role: "explorer",
      task: "查接口",
      name: "sub-b",
      from: parent,
      origin: "agent",
    });
    const runtime = h.runtime("plan-a");
    for (let i = 1; i <= 7; i += 1) {
      runtime.toolCall(`c${i}`, "read_file", { path: `f${i}` });
      if (i < 7) runtime.toolDone(`c${i}`, "read_file");
    }
    await settle();
    await type(term, CTRL_X);
    assert.equal(shell.currentView(), "tree");
    const tree = lines(term);
    assert.ok(
      tree.some((line) => line.startsWith("== workers tree")),
      tree.join("\n")
    );
    assert.ok(!screenFlat(term).includes("state: idle"), "整屏：主会话的状态行与输入框不显示");
    assert.ok(tree.some((line) => line.includes(`main agent | session ${sessionId}`)));
    const parentLine = tree.find((line) => line.includes("[+] plan-a")) ?? "";
    const childLine = tree.find((line) => line.includes("[+] sub-b")) ?? "";
    assert.ok(parentLine.startsWith(" >"), "光标在第一个 worker");
    assert.ok(parentLine.includes("[task #1 写登录 (in_progress)]"), parentLine);
    assert.ok(!childLine.includes("[task"), childLine);
    assert.ok(childLine.indexOf("[+]") > parentLine.indexOf("[+]"), "嵌套的 worker 缩进一层");
    assert.ok(!tree.some((line) => line.includes("| $ read_file")), "收起时不显示调用");
    assert.ok(
      !tree.some((line) => /^ .\s*(script|phase) /.test(line)),
      "没有脚本数据：不显示这两层"
    );
    // 展开：最近 5 条调用（f3 到 f7），已结束的带结果状态
    await type(term, RIGHT);
    const expanded = lines(term).filter((line) => line.includes("| $ read_file"));
    assert.deepEqual(
      expanded.map((line) => line.trim()),
      [3, 4, 5, 6, 7].map((i) => `| $ read_file {"path":"f${i}"}${i < 7 ? " -> ok" : ""}`)
    );
    // 脚本与阶段两层：接上数据即显示，阶段下的 worker 不再挂在派出方下
    scripts = [
      {
        id: "s1",
        title: "batch",
        state: "running",
        phases: [{ id: "p1", title: "stage one", workers: [child] }],
      },
    ];
    await type(term, DOWN);
    const layered = lines(term);
    const scriptAt = layered.findIndex((line) => line.includes("script batch  running"));
    const phaseAt = layered.findIndex((line) => line.includes("phase stage one"));
    const childAt = layered.findIndex((line) => line.includes("sub-b"));
    assert.ok(scriptAt > 0 && phaseAt > scriptAt && childAt > phaseAt, layered.join("\n"));
    assert.equal(layered.filter((line) => line.includes("sub-b")).length, 1);
    // Esc 回主会话；/agents 同样打开，Ctrl+X 关上
    await type(term, ESC);
    assert.equal(shell.currentView(), "main");
    assert.ok(screenFlat(term).includes("state: idle"));
    await type(term, "/agents\r");
    assert.equal(shell.currentView(), "tree");
    await type(term, CTRL_X);
    assert.equal(shell.currentView(), "main");
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("进入 worker 会话：从面板（输入框为空时按 ↓）选中进入，实时看对话与工具调用，输入即发消息，/stop 停止，Esc 回主会话", async () => {
  const h = orchestrationHarness();
  const { term, shell, sessionId } = shellWith({ workers: h.face });
  try {
    shell.start();
    await settle();
    h.orchestrator.spawn({ role: "explorer", task: "一", name: "look-a", origin: "agent" });
    h.orchestrator.spawn({ role: "implementer", task: "二", name: "fix-b", origin: "agent" });
    await settle();
    await type(term, DOWN);
    assert.ok(panelRow(term, "look-a")?.startsWith(" > "), "进入面板，选中第一行");
    assert.ok(screenFlat(term).includes("[up/down] select, [enter] open session"));
    await type(term, DOWN);
    assert.ok(panelRow(term, "fix-b")?.startsWith(" > "));
    await type(term, "\r");
    assert.equal(shell.currentView(), "worker");
    assert.ok(titleLine(term)?.includes("worker fix-b | session"), titleLine(term));
    assert.ok(screenFlat(term).includes("worker: fix-b running | [enter] message, /stop"));
    // 实时：正文与工具调用
    const runtime = h.runtime("fix-b");
    runtime.turn("正在看 b.ts");
    runtime.toolCall("c1", "read_file", { path: "b.ts" });
    runtime.toolDone("c1", "read_file", "b 的内容");
    await settle();
    const flat = screenFlat(term);
    assert.ok(flat.includes("正在看 b.ts"), flat);
    assert.ok(flat.includes('$ read_file {"path":"b.ts"} -> ok'), flat);
    assert.ok(flat.includes("| b 的内容"), flat);
    // 另一个 worker 的活动不进来
    h.runtime("look-a").turn("look-a 的话");
    await settle();
    assert.ok(!screenFlat(term).includes("look-a 的话"));
    // 发消息
    await type(term, "先看 c.ts\r");
    assert.deepEqual(runtime.notes, ["先看 c.ts"]);
    assert.ok(screenFlat(term).includes("已把话递给 worker fix-b，它在下一轮看到"));
    // worker 会话里不能用的命令说明原因，输入留在输入框
    await type(term, "/compact\r");
    assert.ok(screenFlat(term).includes("在 worker 会话里不能用 /compact"), screenFlat(term));
    term.input("\x03");
    await settle();
    // /stop
    await type(term, "/stop\r");
    await until(() => h.orchestrator.status()[1]?.state === "cancelled", "fix-b 取消");
    await settle();
    assert.ok(screenFlat(term).includes("[cancel] worker fix-b interrupt requested"));
    assert.ok(
      screenFlat(term).includes("== worker fix-b（implementer）收尾：已取消"),
      screenFlat(term)
    );
    // Esc 回主会话
    await type(term, ESC);
    assert.equal(shell.currentView(), "main");
    assert.ok(titleLine(term)?.includes(`session ${sessionId}`));
    assert.ok(screenFlat(term).includes("state: idle"));
    assert.ok(!screenFlat(term).includes("正在看 b.ts"), "主会话的消息区不含 worker 的对话");
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("进入 worker 会话：先显示它会话记录里已有的对话（与 /resume 同一份历史渲染），再接实时", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-o2-history-"));
  const h = orchestrationHarness();
  const { term, shell } = shellWith({ workers: h.face, sessions: { root } });
  try {
    shell.start();
    await settle();
    const id = h.orchestrator.spawn({
      role: "explorer",
      task: "查",
      name: "look-a",
      origin: "agent",
    });
    const session = createFixtureSession({ sessionsDir: sessionsDirOf(root), sessionId: id });
    textRun(session, "查一下 a.ts", ["a.ts 里有三个函数"]);
    await type(term, DOWN);
    await type(term, "\r");
    h.runtime("look-a").turn("接着看 b.ts");
    await settle();
    const flat = screenFlat(term);
    const historyAt = flat.indexOf(`== 历史：会话 ${id}`);
    const pastAt = flat.indexOf("a.ts 里有三个函数");
    const liveAt = flat.indexOf("接着看 b.ts");
    assert.ok(historyAt >= 0 && pastAt > historyAt, flat);
    assert.ok(liveAt > flat.indexOf("== 历史结束，以下为实时 =="), flat);
  } finally {
    shell.stop();
    await h.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("进入 worker 会话：从树形视图选中进入；面板与树形视图里按 x 停止选中的 worker", async () => {
  const h = orchestrationHarness();
  const { term, shell } = shellWith({ workers: h.face });
  try {
    shell.start();
    await settle();
    h.orchestrator.spawn({ role: "explorer", task: "一", name: "look-a", origin: "agent" });
    h.orchestrator.spawn({ role: "explorer", task: "二", name: "look-b", origin: "agent" });
    h.orchestrator.spawn({ role: "explorer", task: "三", name: "look-c", origin: "agent" });
    await settle();
    await type(term, CTRL_X);
    await type(term, DOWN);
    await type(term, "\r");
    assert.equal(shell.currentView(), "worker");
    assert.ok(titleLine(term)?.includes("worker look-b | session"), titleLine(term));
    h.runtime("look-b").turn("b 在干活");
    await settle();
    assert.ok(screenFlat(term).includes("b 在干活"));
    await type(term, ESC);
    // 树形视图里 x 停止选中的（光标仍在上次选中的 look-b）
    await type(term, CTRL_X);
    assert.ok(
      lines(term).some((line) => line.startsWith(" >  [+] look-b")),
      lines(term).join("\n")
    );
    await type(term, "x");
    await until(() => h.orchestrator.status()[1]?.state === "cancelled", "look-b 取消");
    await type(term, ESC);
    // 面板里 x 停止选中的：在跑的在前（look-a、look-c），结束的在后
    await type(term, DOWN);
    await type(term, DOWN);
    assert.ok(panelRow(term, "look-c")?.startsWith(" > "));
    await type(term, "x");
    await until(() => h.orchestrator.status()[2]?.state === "cancelled", "look-c 取消");
    assert.equal(h.orchestrator.status()[0]?.state, "running");
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("补批续做：请示等满时限交回后，面板标 blocked 且不淡出；进入它的会话 /approve 即放行同一个调用并接着做；收尾后再发话即带着这段话接着做", async () => {
  const clock = { now: 1_700_000_000_000 };
  let asked = 0;
  const h = orchestrationHarness({
    now: () => clock.now,
    approvalTimeoutMs: 30,
    approvals: () => {
      asked += 1;
      return new Promise(() => {});
    },
  });
  const { term, shell } = shellWith({ workers: h.face, now: () => clock.now, panelFadeMs: 1000 });
  try {
    shell.start();
    await settle();
    const id = h.orchestrator.spawn({
      role: "tester",
      task: "跑测试",
      name: "ship",
      origin: "agent",
    });
    void h.runtime("ship").ask("npm test");
    await until(() => h.orchestrator.status()[0]?.state === "failed", "请示超时交回");
    await settle();
    assert.match(
      panelRow(term, "ship") ?? "",
      /ship\s+blocked\s+.*needs approval: 跑命令 npm test$/
    );
    clock.now += 5_000;
    await settle(120);
    assert.ok(panelRow(term, "ship") !== undefined, "停在等审批的不淡出");
    await type(term, DOWN);
    await type(term, "\r");
    assert.ok(screenFlat(term).includes("worker: ship blocked | /approve to approve and continue"));
    await type(term, "/approve 顺便跑 lint\r");
    await until(() => h.runtimes("ship").length === 2, "续做的运行面");
    const second = h.runtime("ship");
    assert.equal(second.request.sessionId, id);
    assert.equal(second.request.resume, true);
    assert.equal(
      second.inputs[0],
      "人已批准你之前等待审批的调用（跑命令 npm test）。请重新发起这个调用，然后接着完成任务。\n顺便跑 lint"
    );
    // 重新发起的同一个调用直接放行，不再问人
    const decision = await second.ask("npm test");
    assert.equal(decision.approved, true);
    assert.equal(asked, 1);
    second.finish("测试全过");
    await until(() => h.orchestrator.status()[0]?.state === "completed", "续做完成");
    await settle();
    const flat = screenFlat(term);
    assert.ok(flat.includes("已补批 worker ship 的调用（跑命令 npm test），它接着做"), flat);
    assert.ok(flat.includes("== 已补批，worker 接着做 =="), flat);
    assert.ok(flat.includes("== worker ship（tester）收尾：完成"), flat);
    // 已收尾：/approve 说明不需要；普通输入带着这段话接着做
    await type(term, "/approve\r");
    assert.ok(screenFlat(term).includes("worker ship 没有停在等审批，不需要补批"));
    await type(term, "再补一个用例\r");
    await until(() => h.runtimes("ship").length === 3, "再续做");
    assert.deepEqual(h.runtime("ship").inputs, ["再补一个用例"]);
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("进入 worker 会话期间：主 agent 照常运行（结果留在主会话的消息区），主会话的审批到来时回到主会话照常弹出面板", async () => {
  const h = orchestrationHarness();
  const { term, shell, runtime } = shellWith({ workers: h.face });
  try {
    shell.start();
    await settle();
    runtime.autoResolve = false;
    await type(term, "主任务\r");
    h.orchestrator.spawn({ role: "explorer", task: "一", name: "look-a", origin: "agent" });
    await settle();
    await type(term, DOWN);
    await type(term, "\r");
    assert.equal(shell.currentView(), "worker");
    // 主 agent 这一轮在后台结束
    runtime.finishAll();
    await settle();
    assert.ok(!screenFlat(term).includes("== run: completed"), "worker 会话里不显示主会话的消息");
    // 主会话的审批：回到主会话弹出面板，四键照常
    const request: ApprovalRequest = {
      toolName: "edit_file",
      toolCallId: "tc-1",
      args: { path: "src/a.ts" },
      runId: newRunId(),
    };
    const answer = shell.askApproval(request);
    await settle();
    assert.equal(shell.currentView(), "main");
    const flat = screenFlat(term);
    assert.ok(flat.includes("有待审批的调用，已回到主会话"), flat);
    assert.ok(flat.includes("== run: completed"), "主会话的消息区在后台照常更新");
    assert.ok(flat.includes("state: approval"), flat);
    await type(term, "y");
    assert.deepEqual(await answer, { key: "y" });
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("状态栏的本会话花费含在跑 worker 的实时花费（与面板同源），worker 收尾后不重复计入", async () => {
  const h = orchestrationHarness();
  const { term, shell, runtime } = shellWith({ workers: h.face });
  try {
    shell.start();
    await settle();
    await type(term, "主任务\r");
    runtime.emit("turn.started" as never, {});
    runtime.emit("turn.completed" as never, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: {
        input: 10,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      },
    });
    await settle();
    assert.equal(lines(term).at(-1), " cost $0.1000");
    h.orchestrator.spawn({ role: "explorer", task: "一", name: "look-a", origin: "agent" });
    h.runtime("look-a").turn("一轮", { totalTokens: 100, cost: 0.25 });
    await settle();
    assert.equal(h.orchestrator.status()[0]?.state, "running");
    assert.ok(lines(term).includes(" cost $0.3500"), lines(term).join("\n"));
    assert.match(panelRow(term, "look-a") ?? "", /\$0\.25/);
    h.runtime("look-a").finish();
    await settle();
    assert.ok(lines(term).includes(" cost $0.3500"), lines(term).join("\n"));
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("worker 活动记录：会话记录计入之后实时花费清零、续做的新花费照常累计", () => {
  const tracker = new WorkerActivityTracker();
  const worker: WorkerRef = {
    sessionId: newSessionId(),
    name: "w",
    role: "explorer",
    origin: "agent",
    depth: 1,
    parentSessionId: newSessionId(),
  };
  const turn = (cost: number): WorkerActivity => ({
    kind: "event",
    worker,
    event: {
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId: worker.sessionId,
      runId: newRunId(),
      timestamp: 1,
      kind: "turn.completed",
      payload: {
        stopReason: "stop",
        syntheticFailure: false,
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
      },
    } as EventEnvelope,
  });
  tracker.record(turn(0.25));
  assert.equal(tracker.uncountedTotal(() => false).cost, 0.25);
  assert.equal(tracker.uncountedTotal(() => true).cost, 0);
  tracker.record(turn(0.1));
  assert.equal(tracker.uncountedTotal(() => true).cost, 0.1);
  assert.equal(tracker.get(worker.sessionId)?.cost.cost, 0.35);
});

test("命令表：/agents、/stop、/approve 运行中可用；worker 会话里只放行标明可用的命令；主会话里 /stop 说明怎么进入", async () => {
  assert.equal(rejectWhileRunning("/agents"), undefined);
  assert.equal(rejectWhileRunning("/stop"), undefined);
  assert.equal(rejectWhileRunning("/approve 附言"), undefined);
  for (const ok of ["/stop", "/approve x", "/agents", "/workers", "/tasks", "/quit"]) {
    assert.equal(rejectInWorkerSession(ok), undefined, ok);
  }
  assert.ok(rejectInWorkerSession("/spawn a b")?.startsWith("在 worker 会话里不能用 /spawn"));
  const h = orchestrationHarness();
  const { term, shell } = shellWith({ workers: h.face });
  try {
    shell.start();
    await settle();
    await type(term, "/stop\r");
    assert.ok(screenFlat(term).includes("/stop 与 /approve 在 worker 会话里用"), screenFlat(term));
  } finally {
    shell.stop();
    await h.stopAll();
  }
});

test("窄终端与缩放：面板、树形视图与 worker 会话的行都不越出宽度，缩放后重排", async () => {
  const h = orchestrationHarness();
  const { term, shell } = shellWith({ workers: h.face, cols: 44, rows: 24 });
  try {
    shell.start();
    await settle();
    h.orchestrator.spawn({
      role: "implementer",
      task: "一",
      name: "implementer-long",
      origin: "agent",
    });
    h.runtime("implementer-long").toolCall("c1", "read_file", {
      path: "源码/很长的目录名/很长很长的文件名.ts",
    });
    await settle();
    assertWidthsWithin(term, 44);
    assert.ok(panelRow(term, "implementer-long") !== undefined);
    await type(term, CTRL_X);
    await type(term, RIGHT);
    assertWidthsWithin(term, 44);
    term.resize(30, 24);
    await settle();
    assertWidthsWithin(term, 30);
    await type(term, "\r");
    assert.equal(shell.currentView(), "worker");
    assertWidthsWithin(term, 30);
    term.resize(100, 24);
    await settle();
    assertWidthsWithin(term, 100);
    await type(term, ESC);
    assert.match(
      panelRow(term, "implementer-long") ?? "",
      /implementer-long\s+running\s+\d+s\s+0t\s+\$0\s+\$ read_file \{"path":"源码/
    );
  } finally {
    shell.stop();
    await h.stopAll();
  }
});
