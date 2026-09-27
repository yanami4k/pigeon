// M5 S2（决策 038）：/search 命令层——cli 与 tui 共用，参数解析、命中排版、片段经
// sanitizeTerminalText 净化（去净化变红）。会话数据写在新会话存储里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { runSearchCommand } from "./search.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { markLegacyEventFile } from "./session-view-fixtures.ts";

function withRoot(run: (root: string, sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-cmd-"));
  return run(root, join(root, ".pigeon", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

test("/search 命中排版：条数、会话、run 内序号、角色与片段；--role 与 --limit 生效", () =>
  withRoot(async (root, sessionsDir) => {
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "部署网关" });
    session.toolTurn({ name: "read_file", result: "部署日志第一行" });
    session.endRun();
    const { sessionId } = await session.close();
    markLegacyEventFile(sessionsDir, sessionId);
    const [user, , result] = loadSessionView(sessionsDir, sessionId)?.messages ?? [];

    const all = await runSearchCommand({ root, args: ["部署"] });
    const time = (timestamp: number) =>
      new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
    assert.equal(
      all,
      [
        "命中 2 条（关键词：部署；从新到旧）",
        `${time(user?.timestamp ?? 0)}  ${sessionId}  第 1 条 user  ${user?.entryId}`,
        "  部署网关",
        `${time(result?.timestamp ?? 0)}  ${sessionId}  第 3 条 toolResult（read_file）  ${result?.entryId}`,
        "  部署日志第一行",
        "",
      ].join("\n")
    );

    const onlyResults = await runSearchCommand({ root, args: ["部署", "--role", "toolResult"] });
    assert.match(onlyResults, /命中 1 条/);
    assert.doesNotMatch(onlyResults, /第 1 条 user/);

    const limited = await runSearchCommand({ root, args: ["部署", "--limit", "1"] });
    assert.match(limited, /命中 1 条/);
    assert.match(limited, /已达 1 条上限/);
  }));

test("/search 无关键词给用法；未知角色响亮报错", () =>
  withRoot(async (root) => {
    assert.match(await runSearchCommand({ root, args: [] }), /用法：\/search/);
    await assert.rejects(runSearchCommand({ root, args: ["x", "--role", "wizard"] }), /未知角色/);
  }));

test("/search 片段净化：正文里的终端控制序列可见化，原始 ESC 与 BEL 不出命令层（去净化变红）", () =>
  withRoot(async (root, sessionsDir) => {
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "注入\x1b]52;c;ZXZpbA==\x07部署\x1b[2J" });
    const { sessionId } = await session.close();
    markLegacyEventFile(sessionsDir, sessionId);
    const output = await runSearchCommand({ root, args: ["部署"] });
    assert.ok(output.includes("␛]52"), output);
    assert.ok(!output.includes("\x1b"));
    assert.ok(!output.includes("\x07"));
  }));
