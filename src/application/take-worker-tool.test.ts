// 取用 worker 自身改动的工具 take_worker（决策 279）：真实 git 仓库与工作树、假编排器状态。各情形的返回文字为定稿原文；
// 叠加的硬性规则在执行层 worker-overlay.test.ts，这里核对工具层的判定与文字：已叠入、冲突（带查看命令）、没改动、未收尾、
// 不存在、工作树已清理、没有起点、未装配。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { snapshotWorkdir } from "../execution/workdir-snapshot.ts";
import { WorkerOrchestrator, type WorkerStatus } from "../orchestration/workers.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newGrantId, newSessionId } from "../state/ids.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import { collectApprover } from "./script-host.ts";
import { SpawnWorkerBudget, SpawnWorkerSlot } from "./spawn-worker-tool.ts";
import {
  createTakeWorkerTool,
  TAKE_WORKER_DESCRIPTION,
  TAKE_WORKER_TEXTS,
  TAKE_WORKER_TOOL,
  takeWorkerChanges,
  takeWorkerRegistration,
} from "./take-worker-tool.ts";
import { workerStartPoint } from "./workers.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// 主仓库带未提交改动（a.txt），拍快照，从快照开出 worker 工作树 fix-a
function fixture() {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-take-worker-")));
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "pigeon@example.invalid");
  git(main, "config", "user.name", "pigeon-test");
  git(main, "config", "core.autocrlf", "false");
  writeFileSync(join(main, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(main, "a.txt"), "a1\na2\na3\n");
  writeFileSync(join(main, "b.txt"), "b1\nb2\nb3\n");
  writeFileSync(join(main, "d.txt"), "d\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  writeFileSync(join(main, "a.txt"), "a1 main\na2\na3\n");
  const snap = snapshotWorkdir({ repoRoot: main, ref: "refs/pigeon/worker-start/fix-a" });
  const worktree = join(main, ".pigeon", "state", "worktrees", "s-fix-a");
  mkdirSync(join(main, ".pigeon", "state", "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "pigeon/fix-a", worktree, snap.commit);
  // noBase：派出记录里没有起点（没注入起点提供者的旧记录）
  const status = (state: WorkerStatus["state"], noBase = false): WorkerStatus => ({
    sessionId: newSessionId(),
    name: "fix-a",
    role: "implementer",
    state,
    turns: 3,
    branch: "pigeon/fix-a",
    startedAt: 0,
    workspace: {
      kind: "git-worktree",
      path: worktree,
      branch: "pigeon/fix-a",
      ...(noBase ? {} : { baseCommit: snap.commit }),
    },
  });
  return {
    main,
    worktree,
    base: snap.commit,
    status,
    host: (entries: WorkerStatus[]) => ({
      orchestrator: { status: () => entries },
      workspaceRoot: main,
    }),
    cleanup: () => rmSync(main, { recursive: true, force: true }),
  };
}

test("已叠入：只取 worker 自己的改动写进主工作目录；worker 删除的文件不删只列出；返回定稿文字", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.worktree, "b.txt"), "b1\nb2 worker\nb3\n");
    writeFileSync(join(f.worktree, "n.txt"), "new\n");
    rmSync(join(f.worktree, "d.txt"));
    const { text, details } = takeWorkerChanges(f.host([f.status("completed")]), "fix-a");
    const expected = {
      applied: ["b.txt", "n.txt"],
      unchanged: [],
      conflicts: [],
      deletedByWorker: ["d.txt"],
    };
    // 关键片段（模板原文在冲突一条逐字核对，那条删除个数为 0）：叠入的文件与个数；没有冲突时不给查看命令；
    // worker 删除的文件个数非零时照列、注明未删
    assert.ok(text.includes("Files applied (2): b.txt, n.txt. "), text);
    assert.ok(text.includes("Files with conflicts, not written (0): none."), text);
    assert.ok(!text.includes("git -C"), text);
    assert.ok(text.endsWith("Files deleted by the worker (1, not deleted here): d.txt."), text);
    assert.deepEqual(details.result, expected);
    assert.equal(readFileSync(join(f.main, "b.txt"), "utf8"), "b1\nb2 worker\nb3\n");
    assert.equal(readFileSync(join(f.main, "n.txt"), "utf8"), "new\n");
    assert.equal(
      readFileSync(join(f.main, "a.txt"), "utf8"),
      "a1 main\na2\na3\n",
      "主的未提交改动原样"
    );
    assert.equal(existsSync(join(f.main, "d.txt")), true);
    // 再取一次：已一致，不算改动也不冲突
    const again = takeWorkerChanges(f.host([f.status("completed")]), "fix-a");
    assert.deepEqual(again.details.result?.unchanged, ["b.txt", "n.txt"]);
  } finally {
    f.cleanup();
  }
});

test("冲突：同一处双方都改的文件不写入，返回里带查看 worker 改动的命令（工作树路径与快照号）", () => {
  const f = fixture();
  try {
    // 快照之后主工作目录又改了 a.txt 第 1 行，worker 也改了第 1 行；b.txt 只有 worker 改
    writeFileSync(join(f.main, "a.txt"), "a1 main-later\na2\na3\n");
    writeFileSync(join(f.worktree, "a.txt"), "a1 worker\na2\na3\n");
    writeFileSync(join(f.worktree, "b.txt"), "b1\nb2\nb3 worker\n");
    const { text } = takeWorkerChanges(f.host([f.status("completed")]), "fix-a");
    assert.equal(
      text,
      `Applied the changes of worker fix-a to the working directory. Files applied (1): b.txt. Files with conflicts, not written (1): a.txt; to see the worker's changes to these files: git -C ${f.worktree} diff ${f.base.slice(0, 12)} -- <file>. Files deleted by the worker (0, not deleted here): none.`
    );
    assert.equal(
      readFileSync(join(f.main, "a.txt"), "utf8"),
      "a1 main-later\na2\na3\n",
      "冲突文件未写入"
    );
    assert.equal(readFileSync(join(f.main, "b.txt"), "utf8"), "b1\nb2\nb3 worker\n");
  } finally {
    f.cleanup();
  }
});

test("没改动、未收尾、不存在、工作树已清理、没有起点：各返回定稿的一句，工作目录不动", () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.main, "a.txt"), "utf8");
    assert.equal(
      takeWorkerChanges(f.host([f.status("completed")]), "fix-a").text,
      TAKE_WORKER_TEXTS.noChanges("fix-a")
    );
    assert.equal(
      TAKE_WORKER_TEXTS.noChanges("fix-a"),
      "Worker fix-a has no changes relative to its start snapshot; the working directory is unchanged."
    );
    assert.equal(
      takeWorkerChanges(f.host([f.status("running")]), "fix-a").text,
      "Worker fix-a has not finished yet; take its changes after it returns."
    );
    assert.equal(
      takeWorkerChanges(f.host([f.status("queued")]), " fix-a ").details.rejected,
      "running"
    );
    assert.equal(
      takeWorkerChanges(f.host([f.status("completed")]), "nope").text,
      "There is no worker named nope; use the name given in the result returned by spawn_worker."
    );
    assert.equal(
      takeWorkerChanges(f.host([f.status("completed", true)]), "fix-a").text,
      "Worker fix-a has no recorded start snapshot, so its changes cannot be taken."
    );
    // 工作树已清理（日常使用里不自动清理；人用 git worktree remove 之后）
    writeFileSync(join(f.worktree, "b.txt"), "changed\n");
    git(f.main, "worktree", "remove", "--force", f.worktree);
    assert.equal(
      takeWorkerChanges(f.host([f.status("completed")]), "fix-a").text,
      "The worktree of worker fix-a has been cleaned up, so its changes cannot be taken."
    );
    assert.equal(readFileSync(join(f.main, "a.txt"), "utf8"), before);
    assert.equal(
      existsSync(join(f.main, "b.txt")) &&
        readFileSync(join(f.main, "b.txt"), "utf8") === "b1\nb2\nb3\n",
      true
    );
  } finally {
    f.cleanup();
  }
});

test("工具形态：名字、定稿说明、参数说明、写档注册；未装配编排器时按失败回话；装配后走同一套逻辑", async () => {
  assert.equal(TAKE_WORKER_TOOL, "take_worker");
  assert.equal(
    TAKE_WORKER_DESCRIPTION,
    [
      "Apply a finished worker's own changes to your working directory. A worker starts from a snapshot taken at spawn time; this tool takes only the files it changed after that snapshot and merges them file by file with a three-way merge, using the snapshot version as the common ancestor, into your working directory.",
      "Only files the worker changed are written; files it did not touch are left alone. Nothing in your working directory is deleted or reverted. Files the worker deleted are not deleted automatically; they are only listed in the result, and you decide whether to delete them.",
      "Files that cannot be merged (you also changed the same spot) are not written and are listed as conflicts; the worker's branch and worktree are kept as they are, and you can see its changes to those files with: git -C <worktree path> diff <snapshot> -- <file>. Applying cannot be undone: review the returned summary and changed files before applying.",
      "Take the changes of several workers one at a time as needed, finishing one before taking the next; if a later one changed the same spot as an earlier one, it is listed as a conflict.",
      "Returns three lists: files applied, files with conflicts that were not written, and files the worker deleted.",
    ].join("\n")
  );
  const registration = takeWorkerRegistration();
  assert.equal(registration.tier, "write");
  assert.deepEqual(registration.pathConfinement, { kind: "workspace" });
  assert.equal(registration.executionMode, "sequential");
  assert.equal(
    (registration.parameters as { properties: { worker: { description: string } } }).properties
      .worker.description,
    "The worker's name, as given in the result returned by spawn_worker (branch pigeon/<name>)"
  );

  const slot = new SpawnWorkerSlot();
  const tool = createTakeWorkerTool(slot);
  assert.equal(tool.name, "take_worker");
  assert.equal(tool.executionMode, "sequential");
  const unbound = await tool.execute("c1", { worker: "fix-a" }, undefined);
  assert.equal(
    unbound.content[0]?.type === "text" ? unbound.content[0].text : "",
    "Taking the changes of worker fix-a failed: this session has no worker orchestrator set up. Files applied (0): none."
  );
  assert.equal(unbound.details.rejected, "unbound");

  const f = fixture();
  try {
    writeFileSync(join(f.worktree, "n.txt"), "new\n");
    slot.bind({
      orchestrator: {
        status: () => [f.status("completed")],
        spawn: () => {
          throw new Error("不派");
        },
        awaitResult: () => Promise.reject(new Error("不等")),
        cancel: async () => {},
        wait: () => Promise.reject(new Error("不等")),
        send: async () => "delivered" as const,
        subscribe: () => () => {},
      },
      workspaceRoot: f.main,
      budget: new SpawnWorkerBudget({ maxAgentSpawns: 16 }),
      spawnAttempts: () => Promise.reject(new Error("不派")),
    });
    const taken = await tool.execute("c2", { worker: "fix-a" }, undefined);
    assert.equal(
      taken.content[0]?.type === "text" ? taken.content[0].text : "",
      TAKE_WORKER_TEXTS.taken(
        "fix-a",
        { applied: ["n.txt"], unchanged: [], conflicts: [], deletedByWorker: [] },
        { worktree: f.worktree, base: f.base }
      )
    );
    assert.equal(readFileSync(join(f.main, "n.txt"), "utf8"), "new\n");
  } finally {
    f.cleanup();
  }
});

// 决策 279 修订：起点引用建树后即删——worker 分支指向起点快照提交，提交不会被回收；取用照样按快照号比对
test("派出后 refs/pigeon/ 下不留该 worker 的起点引用；gc 之后 take_worker 仍按快照号比对并叠入", async () => {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-take-release-")));
  try {
    git(main, "init", "-q", "-b", "main");
    git(main, "config", "user.email", "pigeon@example.invalid");
    git(main, "config", "user.name", "pigeon-test");
    git(main, "config", "core.autocrlf", "false");
    writeFileSync(join(main, ".gitignore"), ".pigeon/\n");
    writeFileSync(join(main, "a.txt"), "a1\na2\na3\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "init");
    // 主工作目录的未提交改动：派出时带进快照
    writeFileSync(join(main, "a.txt"), "a1 main\na2\na3\n");
    const orchestrator = new WorkerOrchestrator({
      governanceRoot: main,
      session: { sessionId: newSessionId() },
      parentPolicy: { allow: ["read_file", "edit_file"], deny: [], approvalMode: "yolo" },
      parentLog: { appendChildSpawned: () => {}, appendChildSettled: () => {} },
      approvals: async () => ({ approved: true }),
      startPoint: workerStartPoint(main),
      // worker 在自己的工作树里改 a.txt 末行、新建 n.txt（不提交）
      createRuntime: (request) => ({
        run: async () => {
          const path = request.workspace.kind === "git-worktree" ? request.workspace.path : "";
          writeFileSync(join(path, "a.txt"), "a1 main\na2\na3 worker\n");
          writeFileSync(join(path, "n.txt"), "new\n");
          return { status: "completed" };
        },
        interrupt: async () => {},
        subscribe: () => () => {},
        summary: () => "改好了",
        dispose: async () => {},
      }),
    });
    const id = orchestrator.spawn({ role: "implementer", task: "改", name: "fix-a" });
    assert.equal(git(main, "for-each-ref", "refs/pigeon/"), "", "建树后起点引用已删");
    const outcome = await orchestrator.awaitResult(id);
    assert.equal(outcome.start?.snapshot, true);
    const base = outcome.start?.commit ?? "";
    assert.equal(git(main, "rev-parse", "pigeon/fix-a"), base, "worker 分支指向起点快照提交");
    git(main, "gc", "-q", "--prune=now");
    assert.equal(git(main, "cat-file", "-t", base), "commit", "gc 之后快照提交仍在");
    const { text, details } = takeWorkerChanges({ orchestrator, workspaceRoot: main }, "fix-a");
    assert.deepEqual(details.result?.applied, ["a.txt", "n.txt"], text);
    assert.equal(readFileSync(join(main, "a.txt"), "utf8"), "a1 main\na2\na3 worker\n");
    assert.deepEqual(orchestrator.errors(), []);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

// 决策 340：叠回内容写到 .pigeon 下（仓库已跟踪的 .pigeon/settings.json）时，take_worker 按受保护路径处理——放权不算、逐次问人、
// 请示里列出这些路径；yolo 放行；叠回内容不含 .pigeon 时放权照常生效
function protectedFixture(touchPigeon: boolean) {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-take-protected-")));
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "pigeon@example.invalid");
  git(main, "config", "user.name", "pigeon-test");
  // 关掉换行转换：否则全局 core.autocrlf=true 的机器上叠回会把 \n 变成 \r\n
  git(main, "config", "core.autocrlf", "false");
  mkdirSync(join(main, ".pigeon"));
  writeFileSync(join(main, ".pigeon", ".gitignore"), "state/\nsettings.local.json\n");
  writeFileSync(join(main, ".pigeon", "settings.json"), "{}\n");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const snap = snapshotWorkdir({ repoRoot: main, ref: "refs/pigeon/worker-start/fix-a" });
  const worktree = join(main, ".pigeon", "state", "worktrees", "s-fix-a");
  mkdirSync(join(main, ".pigeon", "state", "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "pigeon/fix-a", worktree, snap.commit);
  writeFileSync(join(worktree, "a.txt"), "A\n");
  if (touchPigeon) {
    writeFileSync(join(worktree, ".pigeon", "settings.json"), '{"permissions":{}}\n');
  }
  const slot = new SpawnWorkerSlot();
  const status: WorkerStatus = {
    sessionId: newSessionId(),
    name: "fix-a",
    role: "implementer",
    state: "completed",
    turns: 1,
    branch: "pigeon/fix-a",
    startedAt: 0,
    workspace: {
      kind: "git-worktree",
      path: worktree,
      branch: "pigeon/fix-a",
      baseCommit: snap.commit,
    },
  };
  slot.bind({
    orchestrator: {
      status: () => [status],
      spawn: () => {
        throw new Error("不派");
      },
      awaitResult: () => Promise.reject(new Error("不等")),
      cancel: async () => {},
      wait: () => Promise.reject(new Error("不等")),
      send: async () => "delivered" as const,
      subscribe: () => () => {},
    },
    workspaceRoot: main,
    budget: new SpawnWorkerBudget({ maxAgentSpawns: 16 }),
    spawnAttempts: () => Promise.reject(new Error("不派")),
  });
  return { main, slot, cleanup: () => rmSync(main, { recursive: true, force: true }) };
}

async function takeWithGrant(touchPigeon: boolean, yolo: boolean) {
  const f = protectedFixture(touchPigeon);
  const asked: ApprovalRequest[] = [];
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({
      replies: [
        { text: "取", toolCalls: [{ name: "take_worker", args: { worker: "fix-a" } }] },
        { text: "完" },
      ],
    }),
    workspaceRoot: f.main,
    sessionId: newSessionId(),
    yolo,
    provider: "fake",
    modelId: "fake",
    spawnWorker: f.slot,
    configGrants: [
      {
        tool: "take_worker",
        promotedFrom: {
          grantId: newGrantId(),
          sessionId: newSessionId(),
          firstCall: { toolCallId: "t0", args: {} },
          promotedAt: 1,
        },
      },
    ],
    createApprovalHandler: () => async (request) => {
      asked.push(request);
      return { approved: false };
    },
  });
  try {
    await bundle.adapter.run("取");
    return { asked, settings: readFileSync(join(f.main, ".pigeon", "settings.json"), "utf8") };
  } finally {
    await disposeRuntime(bundle);
    f.cleanup();
  }
}

test("决策 340：叠回内容含 .pigeon 下的路径时 take_worker 按受保护路径请示（配置放权不算），请示里列出这些路径", async () => {
  const { asked, settings } = await takeWithGrant(true, false);
  assert.deepEqual(
    asked.map((request) => [request.toolName, request.protectedPath]),
    [["take_worker", ".pigeon/settings.json"]]
  );
  assert.equal(settings, "{}\n", "没批准即不叠回");
  const plain = await takeWithGrant(false, false);
  assert.deepEqual(plain.asked, [], "不含 .pigeon 时配置放权照常免审");
  const yolo = await takeWithGrant(true, true);
  assert.deepEqual(yolo.asked, [], "yolo 放行");
  assert.equal(yolo.settings, '{"permissions":{}}\n');
});

test("决策 340：脚本整批收回含 .pigeon 下的路径时按受保护路径请示，放权不算", async () => {
  const f = protectedFixture(true);
  try {
    const status = f.slot.host?.orchestrator.status()[0];
    assert.ok(status?.workspace.kind === "git-worktree");
    const asked: ApprovalRequest[] = [];
    const approve = collectApprover(f.main, {
      yolo: false,
      grants: { match: () => ({ granted: true }) },
      handler: async (request) => {
        asked.push(request);
        return { approved: false };
      },
    });
    const target = {
      name: "fix-a",
      worktree: status.workspace.path,
      base: status.workspace.baseCommit ?? "",
    };
    assert.equal(
      await approve({ runId: "r1", title: "脚本", workers: ["fix-a"], targets: [target] }),
      false
    );
    assert.deepEqual(
      asked.map((request) => request.protectedPath),
      [".pigeon/settings.json"]
    );
  } finally {
    f.cleanup();
  }
});
