// 会话树（决策 304）：家谱拼装（从当前会话上溯到根主会话；分支的分支、分支里派的 worker、分支的复盘；失败重试；不列别家；
// 只读文件头找一家、只全读家里的成员；读不到的不中断）；各种类节点的显示；树形视图里 Tab 切换两种模式；各动作（查看历史、
// 在此续接、沙箱会话给用法、当前会话不能续接、运行中拒绝续接、复盘与 worker 不可续接）；本次运行的 worker 进入其会话、
// 以前运行的只看历史；Esc 回树。会话数据用真实写者写进临时会话存储，界面用虚拟屏。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { familyTotal, flattenFamily, loadSessionFamily } from "../application/session-family.ts";
import {
  createFixtureSession,
  type FixtureSession,
  spawnFixtureWorker,
} from "../application/session-store-fixtures.ts";
import { textRun } from "../application/session-view-fixtures.ts";
import { git, initRepo } from "../application/tui-session-fixtures.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import { readSessionView } from "../persistence/session-catalog.ts";
import { newRunId, newSessionId, type SessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION } from "../state/session-entries.ts";
import type { ForkTrigger } from "../state/session-payloads.ts";
import { orchestrationHarness } from "./orchestration-fixtures.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiSessionBinding } from "./shell.ts";
import { MockTerminal, screenFlat, settle } from "./testing.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const TAB = "\t";
const CTRL_X = "\x18";

function branchOf(sessionsDir: string, source: string, trigger: ForkTrigger): FixtureSession {
  return createFixtureSession({
    sessionsDir,
    parentSessionId: source,
    metadata: {
      version: SESSION_ENTRY_VERSION,
      branch: {
        sourceSessionId: source as SessionId,
        forkPoint: { runId: newRunId(), runSeq: 1 },
        checkpoint: { ref: "refs/pigeon/checkpoints/x", commit: "a".repeat(40) },
        workspace: { kind: "git-worktree", path: "/worktrees/b", branch: "pigeon/b" },
        trigger,
        startedAt: Date.now(),
      },
    },
  });
}

function reviewOf(
  sessionsDir: string,
  source: string,
  kind: "closing" | "pre-compaction"
): FixtureSession {
  const review = createFixtureSession({ sessionsDir, parentSessionId: source });
  review.startRun({ task: "复盘", config: { memoryReview: { kind, template: "t" } } });
  review.endRun();
  return review;
}

interface Family {
  root: string;
  sessionsDir: string;
  main: string;
  branch: string;
  branchOfBranch: string;
  branchWorker: string;
  branchReview: string;
  retry: string;
  worker: string;
  review: string;
  other: string;
  otherBranch: string;
  cleanup(): void;
}

// 一家：主会话 M（两轮、花 $0.50；派过 worker W 已完成）→ 分支 B1 →（分支的分支 B2、B1 里派的 worker W2、B1 的压缩前复盘 V2）；
// M 的失败重试 R（以 error 结束、验证未过）；M 的收尾复盘 V。另有别家 X 与其分支
async function seedFamily(): Promise<Family> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-tree-"));
  initRepo(root, { "a.txt": "a\n" });
  const sessionsDir = sessionsDirOf(root);
  const main = createFixtureSession({ sessionsDir });
  main.startRun({ task: "主会话的第一件事" });
  main.assistant({
    text: "好的",
    usage: {
      input: 100,
      totalTokens: 100,
      cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    },
  });
  const worker = spawnFixtureWorker(main, {
    sessionsDir,
    name: "look-old",
    role: "explorer",
    task: "查",
  });
  textRun(worker, "查", ["查完了"]);
  await worker.close();
  main.workerSettled({ childSessionId: worker.sessionId, name: "look-old", status: "completed" });
  main.endRun();
  textRun(main, "主会话的第二件事", ["做完了"]);
  await main.close();
  const branch = branchOf(sessionsDir, main.sessionId, "manual");
  textRun(branch, "分支里试另一种做法", ["分支的回复"]);
  await branch.close();
  const branchOfBranch = branchOf(sessionsDir, branch.sessionId, "manual");
  textRun(branchOfBranch, "分支的分支", ["再分一次"]);
  await branchOfBranch.close();
  const branchWorker = createFixtureSession({
    sessionsDir,
    parentSessionId: branch.sessionId,
    metadata: {
      version: SESSION_ENTRY_VERSION,
      worker: {
        name: "fix-b",
        role: "implementer",
        workspace: { kind: "git-worktree", path: "/worktrees/fix-b", branch: "fix-b" },
        startedAt: Date.now(),
      },
    },
  });
  textRun(branchWorker, "修", ["修好了"]);
  await branchWorker.close();
  const branchReview = reviewOf(sessionsDir, branch.sessionId, "pre-compaction");
  await branchReview.close();
  const retry = branchOf(sessionsDir, main.sessionId, "retry-on-fail");
  retry.startRun({ task: "重试" });
  retry.assistant({ text: "又失败了" });
  retry.verification({ verdict: "fail", exitCode: 1 });
  retry.endRun({ ending: "error" });
  await retry.close();
  const review = reviewOf(sessionsDir, main.sessionId, "closing");
  await review.close();
  const other = createFixtureSession({ sessionsDir });
  textRun(other, "别家的任务", ["别家"]);
  await other.close();
  const otherBranch = branchOf(sessionsDir, other.sessionId, "manual");
  textRun(otherBranch, "别家的分支", ["别家分支"]);
  await otherBranch.close();
  return {
    root,
    sessionsDir,
    main: main.sessionId,
    branch: branch.sessionId,
    branchOfBranch: branchOfBranch.sessionId,
    branchWorker: branchWorker.sessionId,
    branchReview: branchReview.sessionId,
    retry: retry.sessionId,
    worker: worker.sessionId,
    review: review.sessionId,
    other: other.sessionId,
    otherBranch: otherBranch.sessionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("会话家谱：从分支的分支上溯到根主会话，列出这一家（分支的分支、分支的 worker 与复盘、失败重试、worker、复盘），不列别家；只全读家里的成员；读不到的不中断", async () => {
  const family = await seedFamily();
  try {
    let fullReads = 0;
    const loaded = loadSessionFamily(family.sessionsDir, family.branchOfBranch, {
      readView: (ref) => {
        fullReads += 1;
        if (ref.sessionId === family.branchWorker) throw new Error("坏文件");
        return readSessionView(ref);
      },
    });
    const rows = flattenFamily(loaded.root).map((row) => [row.depth, row.node.sessionId]);
    assert.equal(loaded.root.sessionId, family.main);
    assert.deepEqual(
      rows.filter(([, id]) => id === family.other || id === family.otherBranch),
      [],
      "不列别家"
    );
    const depthOf = (id: string) => rows.find(([, row]) => row === id)?.[0];
    assert.equal(depthOf(family.main), 0);
    assert.equal(depthOf(family.branch), 1);
    assert.equal(depthOf(family.branchOfBranch), 2);
    assert.equal(depthOf(family.branchWorker), 2);
    assert.equal(depthOf(family.branchReview), 2);
    assert.equal(depthOf(family.retry), 1);
    assert.equal(depthOf(family.worker), 1);
    assert.equal(depthOf(family.review), 1);
    const nodes = new Map(flattenFamily(loaded.root).map((row) => [row.node.sessionId, row.node]));
    assert.equal(nodes.get(family.main)?.kind, "main");
    assert.equal(nodes.get(family.main)?.turns, 2);
    assert.equal(nodes.get(family.main)?.cost?.cost, 0.5);
    assert.equal(nodes.get(family.branch)?.kind, "branch");
    assert.equal(nodes.get(family.retry)?.kind, "retry");
    assert.equal(nodes.get(family.retry)?.result, "error，验证未过");
    assert.equal(nodes.get(family.worker)?.kind, "worker");
    assert.deepEqual(nodes.get(family.worker)?.worker, { name: "look-old", role: "explorer" });
    assert.equal(nodes.get(family.worker)?.result, "完成");
    assert.equal(nodes.get(family.review)?.kind, "review");
    assert.equal(nodes.get(family.review)?.review, "closing");
    assert.equal(nodes.get(family.branchReview)?.review, "pre-compaction");
    assert.equal(nodes.get(family.branchWorker)?.unreadable, "全文读不出");
    // 这一家合计等于各节点之和（节点只计自己的花费）
    const total = familyTotal(loaded.root);
    const sum = flattenFamily(loaded.root).reduce(
      (acc, { node }) => ({
        cost: acc.cost + (node.cost?.cost ?? 0),
        turns: acc.turns + (node.turns ?? 0),
      }),
      { cost: 0, turns: 0 }
    );
    assert.equal(total.cost.cost, sum.cost);
    assert.equal(total.turns, sum.turns);
    assert.equal(total.sessions, rows.length);
    assert.equal(total.cost.cost, 0.5, "只有主会话花了钱，合计不重复计入子节点");
    // 文件头读了全部文件，全文只读这一家的成员
    assert.equal(loaded.headersRead, rows.length + 2);
    assert.equal(fullReads, rows.length);
    assert.equal(loaded.fullyRead, rows.length);
  } finally {
    family.cleanup();
  }
});

function shellOn(family: Pick<Family, "root">, current: string) {
  const term = new MockTerminal(160, 40);
  const runtime = new ScriptedRuntime(current as SessionId);
  const rebinds: string[] = [];
  const harness = orchestrationHarness();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: current as SessionId,
    logDir: mkdtempSync(join(tmpdir(), "pigeon-session-tree-log-")),
    sessions: { root: family.root },
    resume: {
      root: family.root,
      rebind: (sessionId): TuiSessionBinding => {
        rebinds.push(sessionId);
        return { runtime: new ScriptedRuntime(sessionId) };
      },
    },
    workers: harness.face,
    workerRefreshMs: 20,
  });
  return { term, shell, runtime, rebinds, harness };
}

async function press(term: MockTerminal, key: string): Promise<void> {
  term.input(key);
  await settle();
}

function selectedLine(term: MockTerminal): string {
  return term.screen.contentLines().find((line) => line.startsWith(" >")) ?? "";
}

// 在会话树里把光标移到含 needle 的那一行
async function moveTo(term: MockTerminal, needle: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const lines = term.screen.contentLines();
    const at = lines.findIndex((line) => line.startsWith(" >"));
    const target = lines.findIndex((line) => line.includes(needle) && !/^\s*==/.test(line));
    assert.ok(at >= 0 && target >= 0, `${needle}\n${lines.join("\n")}`);
    if (at === target) return;
    await press(term, target > at ? DOWN : UP);
  }
  assert.fail(`光标没能移到 ${needle}`);
}

test("会话树：树形视图里 Tab 在运行中与会话树两种模式间切换；节点写种类、会话号、轮数、花费与结果，当前会话标出", async () => {
  const family = await seedFamily();
  const { term, shell, harness } = shellOn(family, family.branchOfBranch);
  try {
    shell.start();
    await settle();
    await press(term, CTRL_X);
    assert.ok(screenFlat(term).includes("== workers tree | [tab] sessions"), "Ctrl+X 进运行中模式");
    await press(term, TAB);
    const lines = term.screen.contentLines();
    assert.ok(lines.some((line) => line.startsWith("== sessions tree | [tab] running")));
    assert.ok(
      lines.some((line) => /^ {2}这一家合计：8 个会话 {2}\d+t {2}\$0\.50/.test(line)),
      lines.join("\n")
    );
    const lineOf = (id: string) =>
      lines.find((line) => line.includes(id) && !/^\s*==/.test(line)) ?? "";
    assert.match(
      lineOf(family.main),
      new RegExp(`主会话  ${family.main}  \\d\\d-\\d\\d \\d\\d:\\d\\d  2t  \\$0\\.50`)
    );
    assert.match(lineOf(family.branch), /分支 {2}.* {2}1t {2}/);
    assert.match(lineOf(family.branchOfBranch), /分支 .*\(current\)$/);
    assert.ok(selectedLine(term).includes(family.branchOfBranch), "光标落在当前会话");
    assert.match(lineOf(family.retry), /失败重试 .*error，验证未过/);
    assert.match(lineOf(family.worker), /worker look-old（explorer） .*完成/);
    assert.match(lineOf(family.branchWorker), /worker fix-b（implementer）/);
    assert.match(lineOf(family.review), /复盘（收尾）/);
    assert.match(lineOf(family.branchReview), /复盘（压缩前）/);
    assert.equal(lineOf(family.other), "", "不列别家");
    // 逐层嵌套：分支的分支比分支多缩进一层
    assert.ok(
      lineOf(family.branchOfBranch).indexOf("分支") > lineOf(family.branch).indexOf("分支")
    );
    await press(term, TAB);
    assert.ok(screenFlat(term).includes("== workers tree | [tab] sessions"));
    await press(term, ESC);
    assert.equal(shell.currentView(), "main");
  } finally {
    shell.stop();
    await harness.stopAll();
    family.cleanup();
  }
});

test("会话树的动作：Enter 只读看历史、Esc 回树；当前会话、复盘与 worker 不能续接；以前运行的 worker 只看历史；本次运行的 worker 进入其会话；r 在分支上续接走 /resume 同一流程", async () => {
  const family = await seedFamily();
  const { term, shell, rebinds, harness } = shellOn(family, family.branchOfBranch);
  try {
    shell.start();
    await settle();
    // 本次运行编排器里的 worker：会话文件挂在当前会话下
    const live = harness.orchestrator.spawn({
      role: "explorer",
      task: "看",
      name: "live-a",
      origin: "agent",
    });
    const liveFile = createFixtureSession({
      sessionsDir: family.sessionsDir,
      sessionId: live,
      parentSessionId: family.branchOfBranch,
      metadata: {
        version: SESSION_ENTRY_VERSION,
        worker: {
          name: "live-a",
          role: "explorer",
          workspace: { kind: "git-worktree", path: "/worktrees/live-a", branch: "live-a" },
          startedAt: Date.now(),
        },
      },
    });
    textRun(liveFile, "看", ["正在看"]);
    await liveFile.close();
    await press(term, CTRL_X);
    await press(term, TAB);
    // 主会话：Enter 只读看历史，Esc 回会话树
    await moveTo(term, family.main);
    await press(term, "\r");
    assert.equal(shell.currentView(), "history");
    let flat = screenFlat(term);
    assert.ok(flat.includes(`history | session ${family.main} | read only`), flat);
    assert.ok(flat.includes("主会话的第二件事") && flat.includes("做完了"), flat);
    assert.ok(flat.includes("history: read only | [esc] back to tree"), flat);
    await press(term, "x");
    assert.equal(shell.currentView(), "history", "只读：其余按键吞掉");
    await press(term, ESC);
    assert.equal(shell.currentView(), "tree");
    assert.ok(screenFlat(term).includes("== sessions tree"));
    // 当前会话、复盘、worker 不能续接
    await moveTo(term, family.branchOfBranch);
    await press(term, "r");
    assert.ok(screenFlat(term).includes("当前会话不能续接"));
    await moveTo(term, family.review);
    await press(term, "r");
    assert.ok(screenFlat(term).includes("复盘会话只能查看，不能续接"));
    await moveTo(term, family.worker);
    await press(term, "r");
    assert.ok(screenFlat(term).includes("worker 会话在这里只能查看，不能续接"));
    // 以前运行的 worker：只看历史
    await press(term, "\r");
    assert.equal(shell.currentView(), "history");
    assert.ok(screenFlat(term).includes("查完了"));
    await press(term, ESC);
    // 复盘：只看历史
    await moveTo(term, family.review);
    await press(term, "\r");
    assert.equal(shell.currentView(), "history");
    await press(term, ESC);
    // 本次运行的 worker：进入其会话（实时加历史），Esc 回会话树
    await moveTo(term, live);
    await press(term, "\r");
    assert.equal(shell.currentView(), "worker");
    flat = screenFlat(term);
    assert.ok(flat.includes("worker live-a | session") && flat.includes("正在看"), flat);
    harness.runtime("live-a").turn("实时的一句");
    await settle();
    assert.ok(screenFlat(term).includes("实时的一句"));
    await press(term, ESC);
    assert.equal(shell.currentView(), "tree");
    assert.ok(screenFlat(term).includes("== sessions tree"));
    assert.equal(rebinds.length, 0);
    // 分支：在此续接（/resume 同一流程：有 worker 在跑时照旧拒绝，先停掉本次派出的）
    await harness.stopAll();
    await moveTo(term, `分支  ${family.branch}`);
    await press(term, "r");
    await settle(200);
    assert.deepEqual(rebinds, [family.branch]);
    assert.equal(shell.currentView(), "main");
    assert.ok(screenFlat(term).includes(`session ${family.branch}`), screenFlat(term));
  } finally {
    shell.stop();
    await harness.stopAll();
    family.cleanup();
  }
});

test("会话树的续接：沙箱会话不换绑、给出 pigeon --sandbox --resume 用法；主 agent 运行中照 /resume 的规则拒绝并说明原因", async () => {
  const family = await seedFamily();
  git(family.root, ["branch", `pigeon/sandbox-${family.main}`]);
  const { term, shell, runtime, rebinds, harness } = shellOn(family, family.branchOfBranch);
  try {
    shell.start();
    await settle();
    await press(term, CTRL_X);
    await press(term, TAB);
    await moveTo(term, family.main);
    await press(term, "r");
    assert.ok(
      screenFlat(term).includes(`请用 pigeon --sandbox --resume ${family.main}`),
      screenFlat(term)
    );
    assert.equal(shell.currentView(), "tree");
    // 主 agent 运行中
    await press(term, ESC);
    runtime.autoResolve = false;
    term.input("主任务");
    await press(term, "\r");
    await press(term, CTRL_X);
    await press(term, TAB);
    await moveTo(term, `分支  ${family.branch}`);
    await press(term, "r");
    assert.ok(
      screenFlat(term).includes(
        "运行中不能在此续接：它会改动主会话状态（换到另一个会话）。等本轮结束或按 Esc 中断后再用"
      ),
      screenFlat(term)
    );
    assert.equal(shell.currentView(), "tree");
    assert.deepEqual(rebinds, []);
    runtime.finishAll();
  } finally {
    shell.stop();
    await harness.stopAll();
    family.cleanup();
  }
});

test("会话树：父会话没有文件时根写一行读不到，不中断，其下照常列出", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-tree-missing-"));
  const sessionsDir = sessionsDirOf(root);
  const missing = newSessionId();
  const orphan = branchOf(sessionsDir, missing, "manual");
  textRun(orphan, "孤儿分支", ["还在"]);
  await orphan.close();
  const { term, shell, harness } = shellOn({ root }, orphan.sessionId);
  try {
    shell.start();
    await settle();
    await press(term, CTRL_X);
    await press(term, TAB);
    const lines = term.screen.contentLines();
    assert.ok(
      lines.some(
        (line) => line.includes(`读不到  ${missing}`) && line.includes("读不到（没有会话文件）")
      ),
      lines.join("\n")
    );
    assert.ok(lines.some((line) => line.includes(orphan.sessionId) && line.includes("(current)")));
    await moveTo(term, missing);
    await press(term, "\r");
    assert.ok(screenFlat(term).includes("读不到这个会话，不能查看"));
    assert.equal(shell.currentView(), "tree");
  } finally {
    shell.stop();
    await harness.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
