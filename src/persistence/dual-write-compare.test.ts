// 双写对照（决策 180 / 206）：同一次运行的新旧记录逐项比对。双写产出的会话零差异（含分叉出的分支会话与撞上限的 Run）；
// 新文件里的正文、收尾条目、验证结论被改动时报出对应差异。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHeadless } from "../application/headless.ts";
import type { McpSession } from "../application/mcp.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { compareDualWrite } from "./dual-write-compare.ts";
import { locateSessionFile } from "./session-reader.ts";

const NODE = `"${process.execPath}"`;
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

function repo(): { dir: string; home: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-compare-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-compare-home-"));
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
  thinking: "先看看",
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
  ],
});

// 逐行改写新存储的会话文件（测试篡改用；不删行，保持父链完整）
function rewrite(path: string, change: (line: Record<string, unknown>) => unknown): void {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const out = lines.flatMap((line, index) => {
    if (index === 0) return [line];
    return [JSON.stringify(change(JSON.parse(line) as Record<string, unknown>))];
  });
  writeFileSync(path, `${out.join("\n")}\n`);
}

test("双写对照：分叉重试与验证齐全的一次运行，来源与分支两个会话都零差异；撞上限的 Run 结束方式对得上", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({
        replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
      }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
      retryOnFail: 1,
    });
    const sessionsDir = join(dir, ".pigeon", "sessions");
    const source = compareDualWrite({ sessionsDir, sessionId: result.sessionId });
    assert.deepEqual(source.diffs, []);
    assert.deepEqual(source.counted, { messages: 4, runs: 1, verifications: 1 });
    const branchId = result.retries?.[0]?.branchSessionId ?? "";
    const branch = compareDualWrite({ sessionsDir, sessionId: branchId });
    assert.deepEqual(branch.diffs, []);
    assert.equal(branch.counted.runs, 1);

    const limited = await runHeadless({
      task: "改",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("x\n"), { text: "还没完" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      maxTurns: 1,
    });
    assert.equal(limited.status, "turn-limit");
    assert.deepEqual(compareDualWrite({ sessionsDir, sessionId: limited.sessionId }).diffs, []);
  } finally {
    cleanup();
  }
});

test("双写对照：新文件里正文被改、收尾条目缺失、验证结论不同，各自报出差异", async () => {
  const { dir, home, cleanup } = repo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("new\n"), { text: "好了" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: { command: `${NODE} check.mjs`, timeoutMs: 30_000 },
    });
    const sessionsDir = join(dir, ".pigeon", "sessions");
    assert.deepEqual(compareDualWrite({ sessionsDir, sessionId: result.sessionId }).diffs, []);
    const path = locateSessionFile(sessionsDir, result.sessionId)?.path ?? "";
    rewrite(path, (line) => {
      const message = line.message as { role?: string; content?: Array<{ text?: string }> };
      if (message?.role === "user" && message.content?.[0] !== undefined) {
        message.content[0].text = "被改过的题面";
      }
      // 收尾条目换成别的自定义条目：链不断，但新存储里不再有收尾
      if (line.customType === "pigeon.run-end") {
        line.customType = "other.app";
      }
      if (line.customType === "pigeon.verification") {
        (line.data as { verdict: string }).verdict = "fail";
      }
      return line;
    });
    const diffs = compareDualWrite({ sessionsDir, sessionId: result.sessionId }).diffs;
    assert.deepEqual(
      diffs.map((diff) => diff.area),
      ["消息", "Run 收尾", "验证记录"],
      JSON.stringify(diffs, null, 2)
    );
    assert.match(diffs[0]?.detail ?? "", /正文哈希/);
    assert.match(diffs[1]?.detail ?? "", /缺收尾条目/);
    assert.match(diffs[2]?.detail ?? "", /verdict/);
    assert.deepEqual(
      compareDualWrite({ sessionsDir: join(dir, "nowhere"), sessionId: result.sessionId }).diffs[0]
        ?.area,
      "会话文件"
    );
  } finally {
    cleanup();
  }
});
