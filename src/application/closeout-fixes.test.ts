// M7 收口修复：两处缺陷的回归测试（原第二处"并行派发里验证记录写入失败被吞"随决策 322 的验证删除失去对象）。
// 一、快照 ref 序号竞态：同一会话在运行时只能存在一个快照器实例（序号计数在实例内存里），分叉入口复用运行面已挂的实例；
//     update-ref 另加旧值守卫（新建用创建语义），并发写同号时明确失败而不是静默覆盖。
// 二、快照器的内部故障无人读：向标准错误输出告警，同一类故障只说一次，文案说明后果。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CheckpointError, createCheckpointer } from "../orchestration/checkpoint.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runForkCommand } from "./fork-command.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { dedupedWarner } from "./warnings.ts";

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

function repo(prefix: string) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const home = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "pigeon@example.invalid"]);
  git(dir, ["config", "user.name", "pigeon-test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "old\n");
  writeFileSync(
    join(dir, "check.mjs"),
    'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "new\\n" ? 0 : 1);\n'
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return {
    dir,
    home,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const edit = (from: string, to: string) => ({
  text: "改",
  toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: from, new_string: to } }],
});

// 捕获标准错误：告警走生产缺省口径（写 stderr），测试按前缀取自己关心的行
async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await run();
    return { result, lines };
  } finally {
    process.stderr.write = original;
  }
}

// ---- 一、快照 ref 序号竞态 ----

test("分叉复用运行面已挂的快照器：分叉前后的快照 ref 编号连续，三个 ref 都在、都能解析、互不覆盖", async () => {
  const { dir, home, cleanup } = repo("pigeon-cp-race-");
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: createFakeStreamFn({
        replies: [
          edit("old\n", "one\n"),
          { text: "第一次改好" },
          edit("one\n", "two\n"),
          { text: "第二次改好" },
        ],
      }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      await opened.bundle.adapter.run("改一次");
      assert.ok(opened.checkpoints !== undefined, "主会话在 git 工作区里挂了快照器");
      // 从任务开始处分叉：分叉点早于首次改动，改前基线要另挂一个 ref（第 2 号）
      await runForkCommand({
        governanceRoot: dir,
        opened,
        args: "--at 1",
        run: {
          streamFn: createFakeStreamFn({ replies: [edit("old\n", "new\n"), { text: "分支改好" }] }),
          yolo: true,
          homeDir: home,
          startMcp: noMcp,
        },
      });
      // 分叉之后来源会话继续改：新快照不能撞上分叉挂的那个 ref
      await opened.bundle.adapter.run("再改一次");
      assert.deepEqual(opened.checkpoints?.errors(), [], "快照器没有内部故障");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    // 只数快照 ref
    const own = git(dir, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/pigeon/checkpoints/",
    ])
      .split(/\r?\n/)
      .filter((line) => line.includes(sessionId));
    assert.equal(own.length, 3, `来源会话应有三个快照 ref：${own.join(" / ")}`);
    const numbers = own
      .map((line) => Number(line.split(" ")[0]?.split("/").at(-1)))
      .sort((left, right) => left - right);
    assert.deepEqual(numbers, [1, 2, 3], "编号连续，没有互相覆盖");
    assert.equal(new Set(own.map((line) => line.split(" ")[1])).size, 3, "指向三个不同的提交");
    for (const line of own) {
      const [ref = "", commit = ""] = line.split(" ");
      assert.equal(git(dir, ["rev-parse", ref]).trim(), commit, `${ref} 能解析`);
    }
  } finally {
    cleanup();
  }
});

test("快照 ref 旧值守卫：同一会话的两个快照器实例写同号时明确失败，先写的 ref 原样还在", async () => {
  const { dir, cleanup } = repo("pigeon-cp-guard-");
  try {
    const sessionId = newSessionId();
    const first = createCheckpointer({ workspaceRoot: dir, sessionId });
    const second = createCheckpointer({ workspaceRoot: dir, sessionId });
    await first.beforeChange();
    await second.beforeChange();
    writeFileSync(join(dir, "a.txt"), "one\n");
    const snapshot = await first.afterChange();
    assert.ok(snapshot !== undefined);
    writeFileSync(join(dir, "a.txt"), "two\n");
    await assert.rejects(() => second.afterChange(), /拒绝覆盖/);
    assert.equal(git(dir, ["rev-parse", snapshot.ref]).trim(), snapshot.commit, "先写的没被覆盖");
  } finally {
    cleanup();
  }
});

// ---- 二、内部故障无人读 ----

test("去重告警器：同一类故障只说一次，不同类各说一次", () => {
  const said: string[] = [];
  const warn = dedupedWarner((line) => said.push(line));
  warn(new Error("git add 失败：索引 A"), "第一类");
  warn(new Error("git add 失败：索引 B"), "第一类又一次");
  warn(new Error("write-tree 失败：索引 C"), "第二类");
  assert.deepEqual(said, ["第一类", "第二类"]);
});

test("快照器内部故障：向标准错误告警一次，文案说明后果；错误仍进内部清单，运行照常收尾", async () => {
  const { dir, home, cleanup } = repo("pigeon-cp-warn-");
  try {
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId,
      streamFn: createFakeStreamFn({
        replies: [
          edit("old\n", "one\n"),
          { text: "第一次改好" },
          edit("one\n", "two\n"),
          { text: "第二次改好" },
        ],
      }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    const gitDir = join(dir, ".git");
    const parked = join(dir, ".git-parked");
    try {
      // 挂载之后工作区不再是 git 工作区：快照生成必定失败（真实故障，不是桩）
      renameSync(gitDir, parked);
      const { lines } = await captureStderr(async () => {
        await opened.bundle.adapter.run("改一次");
        await opened.bundle.adapter.run("再改一次");
        // 决策 350：快照在后台拍，等它们拍完（失败）再看
        await opened.checkpoints?.settle();
      });
      // 故障确实发生：记基线一次、两次改动的快照各一次，都是 git 失败（不是等待超时）
      const errors = opened.checkpoints?.errors() ?? [];
      assert.equal(errors.length, 3, `故障次数对得上：${errors.map(String).join(" | ")}`);
      assert.ok(errors.every((error) => error instanceof CheckpointError));
      const warnings = lines.filter((line) => line.startsWith("工作区快照告警："));
      assert.equal(warnings.length, 1, `同一类故障只告警一次：${warnings.join(" | ")}`);
      // 后果：从这里分叉明确报错，不退回更早的快照
      assert.match(warnings[0] ?? "", /明确报错/);
      assert.match(warnings[0] ?? "", /不退回/);
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "two\n", "运行照常收尾");
    } finally {
      renameSync(parked, gitDir);
      await disposeRuntime(opened.bundle);
    }
  } finally {
    cleanup();
  }
});
