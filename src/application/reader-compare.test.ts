// 读者对照（决策 180 / 206，账本重构第二段）：同一次运行的旧读法与新读法逐项比较。双写产出的会话——失败自动分叉重试的来源与
// 分支、撞上限、回炉、上游拦截与域错误、prompt 档无审批通道的策略拒绝、授权建立与撤销——没有未预期差异，已知的预期差异
// 带原因标出；新文件被篡改时报出未预期差异。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { newGrantId, newRunId, newSessionId } from "../state/ids.ts";
import { runHeadless } from "./headless.ts";
import { runHeadlessOnce } from "./headless-core.ts";
import type { McpSession } from "./mcp.ts";
import { compareReaders, EXPECTED, type ReaderDiff } from "./reader-compare.ts";
import { teeGrantEvents } from "./session-store.ts";

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

function repo(): { dir: string; home: string; sessionsDir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-readers-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-readers-home-"));
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
    sessionsDir: join(dir, ".pigeon", "sessions"),
    cleanup: () => {
      try {
        git(dir, ["worktree", "prune"]);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const edit = (content: string, from = "old\n") => ({
  text: "改",
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: from, new_string: content } },
  ],
});
const VERIFY = { command: `${NODE} check.mjs`, timeoutMs: 30_000 };

const unexpected = (diffs: readonly ReaderDiff[]) =>
  diffs.filter((diff) => diff.expected === undefined);

test("读者对照：失败自动分叉重试的来源与分支、撞上限的会话，新旧读法没有差异", async () => {
  const { dir, home, sessionsDir, cleanup } = repo();
  try {
    const retried = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({
        replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
      }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: VERIFY,
      retryOnFail: 1,
    });
    const branchId = retried.retries?.[0]?.branchSessionId;
    assert.ok(branchId !== undefined);
    const source = compareReaders({ sessionsDir, sessionId: retried.sessionId });
    assert.deepEqual(source.diffs, []);
    assert.ok(source.checked > 20, `比较了 ${source.checked} 项`);
    assert.deepEqual(compareReaders({ sessionsDir, sessionId: branchId }).diffs, []);

    const limited = await runHeadless({
      task: "改",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("x\n", "wrong\n"), { text: "还没完" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      maxTurns: 1,
    });
    assert.equal(limited.status, "turn-limit");
    assert.deepEqual(compareReaders({ sessionsDir, sessionId: limited.sessionId }).diffs, []);
  } finally {
    cleanup();
  }
});

test("读者对照：回炉一步、上游拦截与域错误、prompt 档策略拒绝——只有标出原因的预期差异", async () => {
  const { dir, home, sessionsDir, cleanup } = repo();
  try {
    const repaired = await runHeadlessOnce({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({
        replies: [edit("wrong\n"), { text: "改了" }, edit("new\n", "wrong\n"), { text: "修好了" }],
      }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: VERIFY,
      repairRounds: 1,
    });
    assert.equal(repaired.repair?.verdict, "pass");
    assert.deepEqual(compareReaders({ sessionsDir, sessionId: repaired.sessionId }).diffs, []);

    // 参数校验失败（上游拦截）与找不到替换原文（工具域错误）
    const errored = await runHeadless({
      task: "改",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({
        replies: [
          { text: "试", toolCalls: [{ name: "edit_file", args: { path: "a.txt" } }] },
          edit("x\n", "不存在的原文\n"),
          { text: "放弃" },
        ],
      }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
    });
    const diffs = compareReaders({ sessionsDir, sessionId: errored.sessionId }).diffs;
    assert.deepEqual(unexpected(diffs), [], JSON.stringify(diffs, null, 2));
    assert.deepEqual(
      diffs.map((diff) => [diff.area, diff.old, diff.new, diff.expected]),
      [["工具分类", { category: "business" }, { category: "unknown" }, EXPECTED.errorKind]]
    );

    // prompt 档无审批通道：写调用 fail-closed 拒绝，两边都记非失败
    const rejected = await runHeadless({
      task: "改",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("new\n"), { text: "被拒了" }] }),
      yolo: false,
      homeDir: home,
      startMcp: noMcp,
    });
    assert.deepEqual(compareReaders({ sessionsDir, sessionId: rejected.sessionId }).diffs, []);
  } finally {
    cleanup();
  }
});

test("读者对照：授权建立与撤销双写后生效授权一致", async () => {
  const { sessionsDir, dir, cleanup } = repo();
  try {
    const sessionId = newSessionId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    const store = openSessionStoreWriter({ sessionsRoot: sessionsDir, sessionId, cwd: dir });
    const grants = teeGrantEvents(log, store);
    const kept = newGrantId();
    const dropped = newGrantId();
    const runId = newRunId();
    const created = (grantId: typeof kept, tool: string) => ({
      runId,
      grantId,
      tool,
      firstCall: { toolCallId: "tc", args: {} },
      createdAt: Date.now(),
    });
    grants.appendGrantCreated({ ...created(kept, "edit_file"), pathPrefix: "src" });
    grants.appendGrantCreated(created(dropped, "run_command"));
    grants.appendGrantRevoked({ runId, grantId: dropped, revokedAt: Date.now() });
    log.close();
    await store.close();
    const result = compareReaders({ sessionsDir, sessionId });
    assert.deepEqual(result.diffs, []);
  } finally {
    cleanup();
  }
});

test("读者对照：新文件里的验证结论、收尾条目被篡改时报出未预期差异；新存储里没有文件时直说", async () => {
  const { dir, home, sessionsDir, cleanup } = repo();
  try {
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn: createFakeStreamFn({ replies: [edit("new\n"), { text: "好了" }] }),
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: VERIFY,
    });
    assert.equal(result.label, "Passed");
    const path = locateSessionFile(sessionsDir, result.sessionId)?.path ?? "";
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const changed = lines.map((line, index) => {
      if (index === 0) return line;
      const value = JSON.parse(line) as { customType?: string; data?: { verdict?: string } };
      if (value.customType === "pigeon.verification" && value.data !== undefined) {
        value.data.verdict = "fail";
      }
      if (value.customType === "pigeon.run-end") {
        value.customType = "other.app";
      }
      return JSON.stringify(value);
    });
    writeFileSync(path, `${changed.join("\n")}\n`);
    const diffs = unexpected(compareReaders({ sessionsDir, sessionId: result.sessionId }).diffs);
    const areas = new Set(diffs.map((diff) => diff.area));
    assert.ok(areas.has("失败分类"), JSON.stringify(diffs));
    assert.ok(areas.has("成败标签"), JSON.stringify(diffs));
    assert.ok(areas.has("运行指标"), JSON.stringify(diffs));
    assert.deepEqual(
      compareReaders({ sessionsDir: join(dir, "nowhere"), sessionId: result.sessionId }).diffs.map(
        (diff) => diff.area
      ),
      ["会话"]
    );
  } finally {
    cleanup();
  }
});
