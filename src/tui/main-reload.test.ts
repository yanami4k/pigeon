// 终端界面 /reload 的实际重建路径（main-reload.ts，main.ts 的 apply 调它）：重建后 update_memory 仍注册且可写、
// /memory 的上限随新快照更新、重建失败时上限不变。用户级一律指到临时目录。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseLaunchFlags } from "../application/launch-flags.ts";
import type { McpSession } from "../application/mcp.ts";
import { disposeRuntime, type RuntimeBundle } from "../application/runtime.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { openSessionSettings } from "../application/session-settings.ts";
import { createSettingsReloader } from "../application/settings-reload.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { projectSettingsPath } from "../state/paths.ts";
import { memoryLimitsOf, type SettingsSnapshot } from "../state/settings.ts";
import { type MainReloadContext, reopenMainSessionForReload } from "./main-reload.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

test("/reload 经终端界面的重建路径：update_memory 仍注册且可写，/memory 的上限随新快照更新", async () => {
  const root = temp("pigeon-main-reload-");
  const home = temp("pigeon-main-reload-home-");
  const flags = parseLaunchFlags(["--root", root, "--provider", "fake", "--model", "fake"], {
    usage: "u",
    pushedMemory: true,
    spawnWorkers: true,
  });
  const streamFn = createFakeStreamFn({
    replies: [
      {
        text: "记",
        toolCalls: [
          {
            name: "update_memory",
            args: { action: "add", layer: "project", content: "提交信息用英文" },
          },
        ],
      },
      { text: "好" },
    ],
  });
  let settings: SettingsSnapshot = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const memoryContext = { limits: memoryLimitsOf(settings) };
  const context: MainReloadContext = {
    governanceRoot: root,
    streamFn,
    flags,
    warn: () => {},
    createApprovalHandler: () => async () => ({ approved: true }),
    memoryWrite: { source: "tui" },
    memoryContext,
    webToolsFor: () => ({}),
    hooksNotice: () => {},
    onMcpNote: () => {},
    homeDir: home,
    startMcp: noMcp,
  };
  const sessionId = newSessionId();
  let bundle: RuntimeBundle = (
    await openSessionRuntime({
      governanceRoot: root,
      settings,
      sessionId,
      streamFn,
      flags,
      memoryWrite: context.memoryWrite,
      createApprovalHandler: context.createApprovalHandler,
      homeDir: home,
      startMcp: noMcp,
    })
  ).bundle;
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    apply: async (snapshot) => {
      const reloaded = await reopenMainSessionForReload(context, snapshot, { sessionId, bundle });
      settings = snapshot;
      const previous = bundle;
      bundle = reloaded.opened.bundle;
      await disposeRuntime(previous);
    },
  });
  try {
    assert.ok(bundle.adapter.snapshot().tools.advertised.includes("update_memory"), "开局就注册");
    write(projectSettingsPath(root), { memory: { projectLimitChars: 5000 } });
    await reload([]);
    assert.ok(bundle.adapter.snapshot().tools.advertised.includes("update_memory"), "重建后仍注册");
    assert.equal(memoryContext.limits.project, 5000, "/memory 的上限按新快照");
    const run = await bundle.adapter.run("记一下");
    assert.equal(run.status, "completed", JSON.stringify(run.errorMessage));
    assert.equal(run.toolExecutions.at(-1)?.state, "settled");
    const memoryFile = join(root, ".pigeon", "state", "memory.md");
    assert.ok(
      existsSync(memoryFile) && readFileSync(memoryFile, "utf8").includes("提交信息用英文")
    );
  } finally {
    await disposeRuntime(bundle);
  }
});

test("/reload 重建失败：/memory 的上限不变（先建后换）", async () => {
  const root = temp("pigeon-main-reload-fail-");
  const home = temp("pigeon-main-reload-fail-home-");
  const flags = parseLaunchFlags(["--root", root, "--provider", "fake", "--model", "fake"], {
    usage: "u",
    pushedMemory: true,
  });
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const settings = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const memoryContext = { limits: memoryLimitsOf(settings) };
  const sessionId = newSessionId();
  const bundle = (
    await openSessionRuntime({
      governanceRoot: root,
      settings,
      sessionId,
      streamFn,
      flags,
      homeDir: home,
      startMcp: noMcp,
    })
  ).bundle;
  write(projectSettingsPath(root), { memory: { projectLimitChars: 5000 } });
  const next = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  try {
    await assert.rejects(
      reopenMainSessionForReload(
        {
          governanceRoot: root,
          streamFn,
          flags,
          warn: () => {},
          createApprovalHandler: () => async () => ({ approved: true }),
          memoryWrite: { source: "tui" },
          memoryContext,
          webToolsFor: () => ({}),
          hooksNotice: () => {},
          onMcpNote: () => {},
          homeDir: home,
          startMcp: async () => {
            throw new Error("MCP 起不来");
          },
        },
        next,
        { sessionId, bundle }
      ),
      /MCP 起不来/
    );
    assert.equal(memoryContext.limits.project, memoryLimitsOf(settings).project, "上限不变");
  } finally {
    await disposeRuntime(bundle);
  }
});
