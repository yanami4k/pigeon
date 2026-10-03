// M5 S2（决策 038）：/search 命令层——cli 与 tui 共用，参数解析、命中排版、片段经
// sanitizeTerminalText 净化（去净化变红）。会话数据写在新会话存储里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEGACY_READER_HINT, loadSessionView } from "../persistence/session-catalog.ts";
import { runSearchCommand } from "./search.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { writeLegacySessionFile } from "./session-view-fixtures.ts";

function withRoot(run: (root: string, sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-cmd-"));
  return run(root, join(root, ".pigeon", "state", "sessions")).finally(() =>
    rmSync(root, { recursive: true, force: true })
  );
}

test("/search 命中排版：条数、会话、run 内序号、角色、命中的关键词与片段；缺省只搜对话正文，--tool-output、--role 与 --limit 生效", () =>
  withRoot(async (root, sessionsDir) => {
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "部署网关" });
    session.toolTurn({ name: "read_file", result: "部署日志第一行" });
    session.endRun();
    const { sessionId } = await session.close();
    const [user, , result] = loadSessionView(sessionsDir, sessionId)?.messages ?? [];

    const time = (timestamp: number) =>
      new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
    assert.equal(
      await runSearchCommand({ root, args: ["部署", "网关"] }),
      [
        "命中 1 条（关键词：部署、网关；范围：对话正文；按命中的关键词数从多到少，同数从新到旧）",
        `${time(user?.timestamp ?? 0)}  ${sessionId}  第 1 条 user  ${user?.entryId}  命中：部署、网关`,
        "  部署网关",
        "",
      ].join("\n")
    );
    const all = await runSearchCommand({ root, args: ["部署", "--tool-output"] });
    assert.equal(
      all,
      [
        "命中 2 条（关键词：部署；范围：对话正文与工具输出；按命中的关键词数从多到少，同数从新到旧）",
        `${time(result?.timestamp ?? 0)}  ${sessionId}  第 3 条 toolResult（read_file）  ${result?.entryId}  命中：部署`,
        "  部署日志第一行",
        `${time(user?.timestamp ?? 0)}  ${sessionId}  第 1 条 user  ${user?.entryId}  命中：部署`,
        "  部署网关",
        "",
      ].join("\n")
    );

    const onlyResults = await runSearchCommand({ root, args: ["部署", "--role", "toolResult"] });
    assert.match(onlyResults, /命中 1 条/);
    assert.doesNotMatch(onlyResults, /第 1 条 user/);

    const limited = await runSearchCommand({
      root,
      args: ["部署", "--tool-output", "--limit", "1"],
    });
    assert.match(limited, /命中 1 条/);
    assert.match(limited, /共 2 条命中，只列出前 1 条/);
  }));

test("/search 末尾提示会话根下未列出的旧格式会话条数；没有旧格式文件时不出现", () =>
  withRoot(async (root, sessionsDir) => {
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "部署网关" });
    await session.close();
    assert.doesNotMatch(await runSearchCommand({ root, args: ["部署"] }), /旧格式会话/);

    writeLegacySessionFile(sessionsDir);
    writeLegacySessionFile(sessionsDir);
    const output = await runSearchCommand({ root, args: ["部署"] });
    assert.match(output, /命中 1 条/);
    assert.ok(
      output.endsWith(`另有 2 个旧格式会话（迁移之前创建）未列出；${LEGACY_READER_HINT}\n`),
      output
    );
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
    await session.close();
    const output = await runSearchCommand({ root, args: ["部署"] });
    assert.ok(output.includes("␛]52"), output);
    assert.ok(!output.includes("\x1b"));
    assert.ok(!output.includes("\x07"));
  }));
