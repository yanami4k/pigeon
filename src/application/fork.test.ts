// 会话树分叉与续跑（M7 S6，决策 068 / 077 / 078 / 079）：真实 git 仓库 + 真实装配根 + 假模型。
// - 分叉顺序：从会话存储读来源会话 → 来源文件记分叉条目 → 开独立工作树 → pi 的 fork 建分支文件；
// - 续跑：从分叉点之前最近的快照开独立工作树，以 buildSessionContext 从分支文件还原的消息作为 Agent 初始状态，
//   新分支是新的 Pigeon 会话，文件头指向来源会话与分叉点；用户工作区不受影响；
// - 非 git 工作区发起分叉明确报错，不降级、不留分叉条目；
// - 冷会话被另一进程持有时，来源分叉条目写不成，在建工作树之前报错，不留工作树与分支文件；
// - 分支续跑沿用来源尝试的采样温度与工作方式指令（决策 087 修订、110：同一个模型换一个温度就是换了尺子）。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { NotGitWorkspaceError } from "../orchestration/checkpoint.ts";
import { sessionFileLockPath } from "../persistence/session-lock.ts";
import { listSessionFiles, locateSessionFile } from "../persistence/session-reader.ts";
import { type LoadedStoreSession, loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { isStatusText } from "../state/status-text.ts";
import { ForkError, runForkBranch } from "./fork.ts";
import { runHeadless } from "./headless-core.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

// 决策 363：开工状态块与状态追加是用户消息，但不是对话
function isStatusMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>)
            .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
            .join("")
        : "";
  return isStatusText(text);
}

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// 读会话存储里的会话（必须存在）
function storeSession(dir: string, sessionId: string): LoadedStoreSession {
  const loaded = loadStoreSession(join(dir, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(loaded !== undefined, `会话存储里应有会话 ${sessionId}`);
  return loaded;
}

// 子进程对会话文件取锁并常驻（模拟另一个进程正打开着这个会话），stdout 打出 ready 后返回
async function spawnLockHolder(path: string) {
  const moduleUrl = pathToFileURL(
    join(import.meta.dirname, "..", "persistence", "session-lock.ts")
  ).href;
  const script =
    `const { acquireSessionFileLock } = await import(${JSON.stringify(moduleUrl)});` +
    `acquireSessionFileLock(${JSON.stringify(path)});` +
    `process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<void>();
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("ready")) ready.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("exit", (code) => ready.reject(new Error(`持有进程提前退出（${code}）：${stderr}`)));
  await ready.promise;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, exited };
}

function repo(): { dir: string; home: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-fork-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-home-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "old\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return {
    dir,
    home,
    cleanup: () => {
      try {
        git(dir, ["worktree", "prune"]);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const edit = (content: string) => ({
  text: "改",
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
  ],
});

test("分叉续跑：来源先记分叉条目，从分叉点前最近的快照开独立工作树，分支文件复制分叉点之前的历史，分支消息只到分叉点", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const sourceId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId: sourceId,
      streamFn: createFakeStreamFn({ replies: [edit("wrong\n"), { text: "改好了" }] }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    let branch: Awaited<ReturnType<typeof runForkBranch>>;
    let taskSeq = 0;
    const branchModel = createFakeStreamFn({ replies: [edit("new\n"), { text: "这次对了" }] });
    try {
      await opened.bundle.adapter.run("把 a.txt 改成 new");
      await opened.bundle.sessionStore.flush();
      const source = storeSession(dir, sourceId).view;
      const runId = source.runs[0]?.runId;
      assert.ok(runId !== undefined);
      assert.equal(source.runs[0]?.checkpoints.length, 1);
      // 任务消息的条目号（决策 363：排在它前面的是开工状态块）
      taskSeq =
        (source.runs[0]?.messages.findIndex(
          (ref) => ref.message.role === "user" && !isStatusMessage(ref.message)
        ) ?? -1) + 1;
      assert.ok(taskSeq > 1);
      branch = await runForkBranch({
        governanceRoot: dir,
        sourceSessionId: sourceId,
        sourceStore: opened.bundle.sessionStore,
        forkPoint: { runId, runSeq: taskSeq },
        trigger: "manual",
        run: {
          streamFn: branchModel,
          provider: "custom",
          modelId: "custom",
          yolo: true,
          homeDir: home,
          startMcp: noMcp,
        },
      });
    } finally {
      await disposeRuntime(opened.bundle);
    }
    const storeSource = storeSession(dir, sourceId);
    const storeBranch = storeSession(dir, branch.branchSessionId);
    assert.equal(storeSource.view.forks.length, 1, "来源会话先记一条分叉条目");
    const forked = storeSource.view.forks[0]?.data;
    assert.ok(forked !== undefined);
    assert.equal(forked.branchSessionId, branch.branchSessionId);
    assert.equal(forked.trigger, "manual");
    assert.equal(
      forked.checkpoint.commit,
      storeSource.view.runs[0]?.checkpoints[0]?.data.baseCommit,
      "分叉点早于首次改动：取改前基线"
    );
    assert.equal(git(dir, ["rev-parse", forked.checkpoint.ref]).trim(), forked.checkpoint.commit);

    // 分支文件头：父会话是来源会话，分支来历记来源、分叉点与工作树
    assert.equal(storeBranch.view.parentSessionId, sourceId);
    const header = storeBranch.view.metadata?.branch;
    assert.ok(header !== undefined);
    assert.equal(header.sourceSessionId, sourceId);
    assert.deepEqual(header.forkPoint, forked.forkPoint);
    assert.equal(header.trigger, "manual");
    assert.deepEqual(header.checkpoint, forked.checkpoint);
    assert.ok(header.startedAt >= forked.forkedAt, "分支来历晚于分叉条目");
    assert.ok(existsSync(header.workspace.path));
    assert.equal(readFileSync(join(header.workspace.path, "a.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "wrong\n", "用户工作区不受分支影响");
    assert.equal(branch.label, "Unknown", "无验证而正常完成记未知（决策 322）");

    // 分支初始消息只到分叉点（任务消息）；开工状态块与分支开工时的状态追加不算对话
    const firstCall = (branchModel.calls[0]?.context.messages ?? []).filter(
      (message) => !isStatusMessage(message)
    );
    assert.equal(firstCall.length, 1, "分支初始消息只到分叉点（任务消息）");
    assert.equal(firstCall[0]?.role, "user");

    // 来源文件的分叉条目指向分叉点的消息条目；分支文件由 pi 的 fork 复制根到分叉点的历史，
    // 分支运行面在它上面续写；派生会话树不建
    const taskEntry = storeSource.view.runs[0]?.messages[taskSeq - 1]?.entryId;
    assert.ok(taskEntry !== undefined);
    assert.equal(forked.forkEntryId, taskEntry);
    const copied = storeSource.main.findIndex((entry) => entry.id === taskEntry) + 1;
    assert.deepEqual(
      storeBranch.main.slice(0, copied).map((entry) => entry.id),
      storeSource.main.slice(0, copied).map((entry) => entry.id),
      "分支文件开头是来源的 Run 开始条目到任务消息"
    );
    assert.equal(storeBranch.view.runs.length, 1);
    assert.deepEqual(
      storeBranch.view.runs[0]?.messages
        .filter((ref) => !isStatusMessage(ref.message))
        .map((ref) => ref.message.role),
      ["assistant", "toolResult", "assistant"],
      "分支自己的消息（改文件、工具结果、收尾回复）全部写进分支文件"
    );
    assert.equal(existsSync(join(dir, ".pigeon", "trees")), false);
  } finally {
    cleanup();
  }
});

test("非 git 工作区发起分叉：明确报错，不降级、不留分叉条目", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fork-nogit-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-nogit-home-"));
  try {
    const result = await runHeadless({
      task: "做点事",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
    });
    const runId = storeSession(dir, result.sessionId).view.runs[0]?.runId;
    assert.ok(runId !== undefined);
    await assert.rejects(
      () =>
        runForkBranch({
          governanceRoot: dir,
          sourceSessionId: result.sessionId,
          forkPoint: { runId, runSeq: 1 },
          trigger: "manual",
          run: {
            streamFn: createFakeStreamFn({ replies: [{ text: "x" }] }),
            yolo: true,
            homeDir: home,
            startMcp: noMcp,
          },
        }),
      NotGitWorkspaceError
    );
    assert.equal(storeSession(dir, result.sessionId).view.forks.length, 0);
    assert.equal(
      listSessionFiles(join(dir, ".pigeon", "state", "sessions")).length,
      1,
      "不建分支会话文件"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("冷会话被另一进程持有：来源分叉条目写不成，在建工作树之前报错，不留工作树与分支文件", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("new\n"), { text: "改好了" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
    });
    const sessionsDir = join(dir, ".pigeon", "state", "sessions");
    const sourcePath = locateSessionFile(sessionsDir, result.sessionId)?.path;
    assert.ok(sourcePath !== undefined);
    const runId = storeSession(dir, result.sessionId).view.runs[0]?.runId;
    assert.ok(runId !== undefined);
    const worktreesBefore = git(dir, ["worktree", "list", "--porcelain"]);
    const sourceBefore = readFileSync(sourcePath, "utf8");
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const { child, exited } = await spawnLockHolder(sourcePath);
    try {
      process.stderr.write = ((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      await assert.rejects(
        () =>
          runForkBranch({
            governanceRoot: dir,
            sourceSessionId: result.sessionId,
            forkPoint: { runId, runSeq: 1 },
            trigger: "manual",
            run: {
              streamFn: createFakeStreamFn({ replies: [{ text: "x" }] }),
              yolo: true,
              homeDir: home,
              startMcp: noMcp,
            },
          }),
        (error: unknown) => error instanceof ForkError && /分叉条目没有写成/.test(error.message)
      );
    } finally {
      process.stderr.write = originalWrite;
      child.kill();
      await exited;
    }
    // 会话锁的失败经会话存储告警报出（指明另一个进程）
    assert.ok(
      captured.some(
        (line) => line.startsWith("会话存储告警：") && line.includes(String(child.pid))
      ),
      captured.join(" | ")
    );
    assert.equal(
      git(dir, ["worktree", "list", "--porcelain"]),
      worktreesBefore,
      "没有建任何工作树"
    );
    assert.equal(existsSync(join(dir, ".pigeon", "state", "worktrees")), false);
    assert.equal(readFileSync(sourcePath, "utf8"), sourceBefore, "来源会话文件原样不动");
    assert.equal(listSessionFiles(sessionsDir).length, 1, "不建分支会话文件");
    assert.ok(existsSync(sessionFileLockPath(sourcePath)), "持有进程的锁没有被误删");
  } finally {
    cleanup();
  }
});

test("分叉沿用来源尝试的采样温度与工作方式指令：分支的调用选项与 Run 开始条目与来源尝试一致（决策 087 修订、110）", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const calls: Array<{ temperature: unknown; systemPrompt: string }> = [];
    const track =
      (fake: FakeStreamFn): StreamFn =>
      (model, context, options) => {
        calls.push({
          temperature: (options as { temperature?: unknown } | undefined)?.temperature,
          systemPrompt: context.systemPrompt ?? "",
        });
        return fake(model, context, options);
      };
    const directive = "Your task is to make a.txt read new.";
    const source = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: track(createFakeStreamFn({ replies: [edit("new\n"), { text: "改好了" }] })),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      temperature: 0,
      taskDirective: directive,
    });
    const runId = storeSession(dir, source.sessionId).view.runs[0]?.runId;
    assert.ok(runId !== undefined);
    const branch = await runForkBranch({
      governanceRoot: dir,
      sourceSessionId: source.sessionId,
      forkPoint: { runId, runSeq: 1 },
      trigger: "manual",
      run: {
        streamFn: track(createFakeStreamFn({ replies: [edit("new\n"), { text: "改好了" }] })),
        provider: "custom",
        modelId: "custom",
        yolo: true,
        homeDir: home,
        startMcp: noMcp,
        temperature: 0,
        taskDirective: directive,
      },
    });
    // 来源两轮、分支两轮：每一次调用都带温度 0 与同一句指令
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.temperature, 0);
      assert.ok(call.systemPrompt.includes(directive));
    }
    // 分支会话自己的 Run（不含从来源复制过来的那一段）的开始条目
    const branchView = storeSession(dir, branch.branchSessionId).view;
    assert.equal(branchView.runs.length, 1);
    assert.equal(branchView.runs[0]?.start.model.temperature, 0);
    assert.equal(branchView.runs[0]?.start.taskDirective, directive);
  } finally {
    cleanup();
  }
});
