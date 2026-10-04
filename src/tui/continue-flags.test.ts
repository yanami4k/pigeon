// 决策 286 第 5 项：续接会话不用抄 ID——pigeon --continue 接本项目最近的主会话；/resume 与 pigeon --resume 不带 ID 时
// 弹出会话列表（↑↓ 选、回车进、Esc 退；每行时间、首条输入摘要、轮数，沙箱会话加标记；worker 与复盘会话不列）；
// 带 ID 的用法保持不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { listRecentMainSessions } from "../application/recent-sessions.ts";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import { git, initRepo } from "../application/tui-session-fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { resolveStartTarget, takeContinueFlags } from "./continue-flags.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiSessionBinding } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle, squashSpaces } from "./testing.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// 一个主会话：跑 turns 轮，每轮一条输入
async function mainSession(
  sessionsDir: string,
  inputs: string[]
): Promise<{ sessionId: SessionId; path: string }> {
  const session = createFixtureSession({ sessionsDir });
  for (const input of inputs) {
    session.startRun({ task: input });
    session.assistant({ text: "好" });
    session.endRun();
  }
  await tick();
  return session.close();
}

async function makeProject(): Promise<{
  root: string;
  older: SessionId;
  olderPath: string;
  middle: SessionId;
  newest: SessionId;
  sandboxed: SessionId;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-continue-"));
  initRepo(root, { "a.txt": "a\n" });
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const older = await mainSession(sessionsDir, ["最早的任务：修登录页\n第二行不显示"]);
  const middle = await mainSession(sessionsDir, ["中间的任务", "又一轮"]);
  // 中间的会话派过 worker（worker 会话不列）
  const withWorker = createFixtureSession({
    sessionsDir,
    sessionId: middle.sessionId,
    existingPath: middle.path,
  });
  withWorker.startRun({ task: "第三轮" });
  const worker = spawnFixtureWorker(withWorker, { sessionsDir, name: "w1", task: "worker 的任务" });
  worker.startRun({ task: "worker 的任务" });
  worker.endRun();
  await worker.close();
  withWorker.endRun();
  await withWorker.close();
  await tick();
  const sandboxed = await mainSession(sessionsDir, ["沙箱里的任务"]);
  git(root, ["branch", `pigeon/sandbox-${sandboxed.sessionId}`]);
  const newest = await mainSession(sessionsDir, ["最新的任务"]);
  // 复盘会话（从最新会话分叉，不列）
  const review = createFixtureSession({ sessionsDir, parentSessionId: newest.sessionId });
  review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
  review.endRun();
  await review.close();
  return {
    root,
    older: older.sessionId,
    olderPath: older.path,
    middle: middle.sessionId,
    newest: newest.sessionId,
    sandboxed: sandboxed.sessionId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("启动参数：--continue、--resume <id>、--resume 不带 id；两者互斥，其余参数原样交出", () => {
  assert.deepEqual(takeContinueFlags(["--yolo", "--continue", "--model", "m"]), {
    argv: ["--yolo", "--model", "m"],
    mode: { kind: "continue" },
  });
  assert.deepEqual(takeContinueFlags(["--resume", "01ABC", "--yolo"]), {
    argv: ["--yolo"],
    mode: { kind: "resume", sessionId: "01ABC" },
  });
  assert.deepEqual(takeContinueFlags(["--resume", "--yolo"]), {
    argv: ["--yolo"],
    mode: { kind: "resume" },
  });
  assert.deepEqual(takeContinueFlags(["--yolo"]), { argv: ["--yolo"], mode: { kind: "new" } });
  assert.throws(() => takeContinueFlags(["--continue", "--resume"]), /只能给一个/);
});

test("会话列表只列主会话（worker、复盘不列），按最近活动从新到旧，带首条输入、轮数与沙箱标记", async () => {
  const project = await makeProject();
  try {
    const sessions = listRecentMainSessions(project.root);
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      [project.newest, project.sandboxed, project.middle, project.older]
    );
    const middle = sessions.find((session) => session.sessionId === project.middle);
    assert.equal(middle?.turns, 3);
    assert.equal(middle?.firstInput, "中间的任务");
    const older = sessions.find((session) => session.sessionId === project.older);
    assert.equal(older?.firstInput, "最早的任务：修登录页 第二行不显示");
    assert.deepEqual(
      sessions.filter((session) => session.sandbox).map((session) => session.sessionId),
      [project.sandboxed]
    );
  } finally {
    project.cleanup();
  }
});

test("--continue 接本项目最近的主会话（本机启动不接沙箱会话，--sandbox 只接沙箱会话）；没有时开新会话", async () => {
  const project = await makeProject();
  try {
    const host = resolveStartTarget(project.root, { kind: "continue" }, false);
    assert.equal(host.kind, "resume");
    assert.equal(host.kind === "resume" ? host.sessionId : "", project.newest);
    assert.ok(host.kind === "resume" && host.report[0]?.startsWith(`会话 ${project.newest} 续跑`));
    const sandbox = resolveStartTarget(project.root, { kind: "continue" }, true);
    assert.equal(sandbox.kind === "resume" ? sandbox.sessionId : "", project.sandboxed);

    // 最旧的会话又被续聊：它成了最近的
    const sessionsDir = join(project.root, ".pigeon", "state", "sessions");
    const reopened = createFixtureSession({
      sessionsDir,
      sessionId: project.older,
      existingPath: project.olderPath,
    });
    await tick();
    reopened.startRun({ task: "续聊一轮" });
    reopened.endRun();
    await reopened.close();
    const after = resolveStartTarget(project.root, { kind: "continue" }, false);
    assert.equal(after.kind === "resume" ? after.sessionId : "", project.older);
  } finally {
    project.cleanup();
  }
  const empty = mkdtempSync(join(tmpdir(), "pigeon-tui-continue-empty-"));
  try {
    const target = resolveStartTarget(empty, { kind: "continue" }, false);
    assert.deepEqual(target, {
      kind: "new",
      picker: false,
      note: "本项目没有可续接的会话，开一个新会话",
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("--resume <id> 照旧直接续接；沙箱与本机不混用；不存在的会话在启动前报错；--resume 不带 id 开壳后弹列表", async () => {
  const project = await makeProject();
  try {
    const target = resolveStartTarget(
      project.root,
      { kind: "resume", sessionId: project.middle },
      false
    );
    assert.equal(target.kind === "resume" ? target.sessionId : "", project.middle);
    assert.throws(
      () =>
        resolveStartTarget(project.root, { kind: "resume", sessionId: project.sandboxed }, false),
      /是沙箱会话，请用 pigeon --sandbox --resume/
    );
    assert.throws(
      () => resolveStartTarget(project.root, { kind: "resume", sessionId: project.middle }, true),
      /不是沙箱会话/
    );
    assert.throws(
      () => resolveStartTarget(project.root, { kind: "resume", sessionId: newSessionId() }, false),
      /会话不存在/
    );
    assert.deepEqual(resolveStartTarget(project.root, { kind: "resume" }, false), {
      kind: "new",
      picker: true,
    });
    assert.throws(() => resolveStartTarget(project.root, { kind: "resume" }, true), /请给会话号/);
  } finally {
    project.cleanup();
  }
});

function makeResumeShell(root: string): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  rebinds: SessionId[];
  cleanup: () => void;
} {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-picker-log-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(120, 40);
  const rebinds: SessionId[] = [];
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    sessions: { root },
    resume: {
      root,
      rebind: (target): TuiSessionBinding => {
        rebinds.push(target);
        return { runtime: new ScriptedRuntime(target) };
      },
    },
  });
  return {
    shell,
    term,
    rebinds,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("/resume 不带 ID 弹出会话列表：↑↓ 选、回车进（照 /resume <id> 换绑）、Esc 退；沙箱会话标记且不在本机续接", async () => {
  const project = await makeProject();
  const { shell, term, rebinds, cleanup } = makeResumeShell(project.root);
  try {
    shell.start();
    await settle();
    term.input("/resume");
    term.input("\r");
    await settle();
    const listed = screenText(term);
    assert.ok(listed.includes("resume a session: up/down to move, enter to open, esc to cancel"));
    assert.ok(listed.includes("> "), listed);
    assert.ok(listed.includes("1 turns  最新的任务"), listed);
    assert.ok(listed.includes("1 turns [sandbox]  沙箱里的任务"), listed);
    assert.ok(listed.includes("3 turns  中间的任务"), listed);
    assert.ok(!listed.includes("worker 的任务"), "worker 会话不列");
    assert.ok(!listed.includes("复盘"), "复盘会话不列");

    // Esc 退出：不换绑
    term.input("\x1b");
    await settle();
    assert.ok(screenFlat(term).includes("已取消选择会话"));
    assert.deepEqual(rebinds, []);

    // ↓ 两次到"中间的任务"，回车进
    term.input("/resume");
    term.input("\r");
    await settle();
    term.input("\x1b[B");
    term.input("\x1b[B");
    term.input("\x1b[A");
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.deepEqual(rebinds, [project.middle]);
    assert.ok(screenFlat(term).includes(`会话 ${project.middle} 续跑`), screenText(term));

    // 选沙箱会话：给出用法，不换绑
    term.input("/resume");
    term.input("\r");
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.ok(
      squashSpaces(screenFlat(term)).includes(
        squashSpaces(`请用 pigeon --sandbox --resume ${project.sandboxed}`)
      ),
      screenText(term)
    );
    assert.deepEqual(rebinds, [project.middle]);

    // 带 ID 的用法保持不变
    term.input(`/resume ${project.older}`);
    term.input("\r");
    await settle();
    assert.deepEqual(rebinds, [project.middle, project.older]);
  } finally {
    cleanup();
    project.cleanup();
  }
});

test("启动时 --resume 不带 ID：壳一开就弹列表；没有可续接的会话时如实说明", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pigeon-tui-picker-empty-"));
  const { shell, term, cleanup } = makeResumeShell(empty);
  try {
    shell.start();
    shell.openSessionPicker();
    await settle();
    assert.ok(screenFlat(term).includes("没有可续接的会话"));
  } finally {
    cleanup();
    rmSync(empty, { recursive: true, force: true });
  }
});
