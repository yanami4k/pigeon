// /reload 重读设置（决策 340）：改放权后重读，下一轮即生效；改命令短名后重读须确认，不确认沿用原内容、原来没有的不启用；
// MCP 定义变化后服务重启（旧会话关闭、按新快照重新启动），结果行列出改了哪些节；没有变化如实说明；有 worker 在跑时拒绝。
// 运行面重建照终端界面入口的做法：同一会话上按新快照重开（还原上下文），再释放旧的。用户级一律指到临时目录。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { projectLocalSettingsPath, projectSettingsPath } from "../state/paths.ts";
import { commandsConfigOf, mcpConfigOf, type SettingsSnapshot } from "../state/settings.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime, type RuntimeBundle } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { openSessionSettings, pendingTrustEntries } from "./session-settings.ts";
import { createSettingsReloader } from "./settings-reload.ts";

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

const GRANT = {
  tool: "edit_file",
  promotedFrom: {
    grantId: "grant_01J5Z7K8W9ABCDEFGHJKMNPQRS",
    sessionId: "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS",
    firstCall: { toolCallId: "t0", args: {} },
    promotedAt: 1,
  },
};

// 一个终端界面式的会话：快照可换，换时按新快照在同一会话上重建运行面；MCP 启动记下当时快照里的服务
async function session(root: string, home: string, streamFn: StreamFn) {
  let settings: SettingsSnapshot = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const sessionId: SessionId = newSessionId();
  const asked: ApprovalRequest[] = [];
  const mcpStarts: string[][] = [];
  let mcpCloses = 0;
  const startMcp = async (): Promise<McpSession> => {
    mcpStarts.push(mcpConfigOf(settings).servers.map((server) => JSON.stringify(server.launch)));
    return {
      tools: [],
      prompts: [],
      problems: [],
      connections: [],
      summary: () => ({ mcpTools: [], mcpServers: [] }),
      close: async () => {
        mcpCloses += 1;
      },
    };
  };
  const open = (resume: boolean) =>
    openSessionRuntime({
      governanceRoot: root,
      settings,
      sessionId,
      streamFn,
      flags: { yolo: false, provider: "fake", modelId: "fake", persistThinking: true },
      homeDir: home,
      startMcp,
      createApprovalHandler: () => async (request) => {
        asked.push(request);
        return { approved: true };
      },
      ...(resume ? { resume: true } : {}),
    });
  let bundle: RuntimeBundle = (await open(false)).bundle;
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    apply: async (snapshot) => {
      settings = snapshot;
      await bundle.sessionStore.flush();
      const next = (await open(true)).bundle;
      const previous = bundle;
      bundle = next;
      await disposeRuntime(previous);
    },
  });
  return {
    reload,
    asked,
    mcpStarts,
    mcpCloses: () => mcpCloses,
    settings: () => settings,
    run: (task: string) => bundle.adapter.run(task),
    dispose: () => disposeRuntime(bundle),
  };
}

test("改放权后 /reload：下一轮即生效（写操作凭新放权免审）", async () => {
  const root = temp("pigeon-reload-grant-");
  const home = temp("pigeon-reload-home-");
  writeFileSync(join(root, "a.txt"), "a\n");
  const edit = (from: string, to: string) => [
    { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
    {
      text: "改",
      toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: from, new_string: to } }],
    },
    { text: "好" },
  ];
  const s = await session(
    root,
    home,
    createFakeStreamFn({ replies: [...edit("a", "b"), ...edit("b", "c")] })
  );
  try {
    const first = await s.run("改一");
    assert.equal(first.toolExecutions.at(-1)?.decision?.approvedBy, "human");
    write(projectLocalSettingsPath(root), { permissions: { grants: [GRANT] } });
    const lines = await s.reload([]);
    assert.match(lines.join("\n"), /改了 permissions 节/);
    const second = await s.run("改二");
    assert.equal(second.toolExecutions.at(-1)?.decision?.approvedBy, "policy:config");
    assert.equal(s.asked.length, 1, "重读之后不再问人");
  } finally {
    await s.dispose();
  }
});

test("改命令短名后 /reload 须确认：skip 沿用原内容、原来没有的不启用；confirm 记下并生效", async () => {
  const root = temp("pigeon-reload-commands-");
  const home = temp("pigeon-reload-home-");
  write(projectSettingsPath(root), { commands: { commands: { mark: "git tag a" } } });
  const s = await session(root, home, createFakeStreamFn({ replies: [{ text: "好" }] }));
  try {
    write(projectSettingsPath(root), {
      commands: { commands: { mark: "git tag b", fresh: "npm test" } },
      orchestration: { maxConcurrent: 2 },
    });
    const listed = (await s.reload([])).join("\n");
    assert.match(listed, /命令短名 mark：git tag b/);
    assert.match(listed, /命令短名 fresh：npm test/);
    assert.match(listed, /\/reload confirm/);
    assert.deepEqual(
      commandsConfigOf(s.settings()).commands,
      { mark: "git tag a" },
      "确认之前不变"
    );
    const skipped = (await s.reload(["skip"])).join("\n");
    assert.match(skipped, /改了 orchestration 节/);
    assert.match(skipped, /沿用原内容/);
    assert.deepEqual(commandsConfigOf(s.settings()).commands, { mark: "git tag a" });
    assert.equal(s.settings().merged.orchestration?.maxConcurrent, 2, "其余改动照常生效");
    // 再读一次并确认：记下指纹，新内容生效
    await s.reload([]);
    const confirmed = (await s.reload(["confirm"])).join("\n");
    assert.match(confirmed, /改了 commands 节/);
    assert.deepEqual(commandsConfigOf(s.settings()).commands, {
      mark: "git tag b",
      fresh: "npm test",
    });
    assert.deepEqual(pendingTrustEntries(s.settings(), home), [], "确认即记下指纹，下次启动不再问");
    assert.deepEqual(await s.reload([]), ["设置没有变化"]);
    assert.deepEqual(await s.reload(["confirm"]), ["没有待确认的重读；先输入 /reload"]);
  } finally {
    await s.dispose();
  }
});

test("MCP 定义变化后 /reload：确认后服务按新定义重启（旧会话关闭），结果行列出重启、停止、启动", async () => {
  const root = temp("pigeon-reload-mcp-");
  const home = temp("pigeon-reload-home-");
  write(join(root, ".mcp.json"), {
    mcpServers: {
      fx: { command: "node", args: ["a.js"] },
      old: { command: "node", args: ["o.js"] },
    },
  });
  const s = await session(root, home, createFakeStreamFn({ replies: [{ text: "好" }] }));
  try {
    assert.equal(s.mcpStarts.length, 1);
    write(join(root, ".mcp.json"), {
      mcpServers: {
        fx: { command: "node", args: ["b.js"] },
        add: { command: "node", args: ["n.js"] },
      },
    });
    await s.reload([]);
    const lines = (await s.reload(["confirm"])).join("\n");
    assert.match(lines, /改了 mcp 节/);
    assert.match(lines, /MCP 服务：重启 fx；停止 old；启动 add/);
    assert.equal(s.mcpStarts.length, 2, "按新快照重新启动");
    assert.equal(s.mcpCloses(), 1, "旧会话的服务关闭");
    assert.deepEqual(s.mcpStarts[1], [
      JSON.stringify({ command: "node", args: ["n.js"] }),
      JSON.stringify({ command: "node", args: ["b.js"] }),
    ]);
  } finally {
    await s.dispose();
  }
});

test("有 worker 在跑等不能重载时如实拒绝；沙箱会话里 sandbox 一节有变化另给一行提示", async () => {
  const root = temp("pigeon-reload-busy-");
  const home = temp("pigeon-reload-home-");
  let settings = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  let busy: string | undefined = "有 worker 仍在运行：先 /cancel 或等其收尾，再 /reload";
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    busy: () => busy,
    sandboxSessionId: () => "sess_X",
    apply: async (snapshot) => {
      settings = snapshot;
    },
  });
  assert.deepEqual(await reload([]), [busy]);
  busy = undefined;
  write(projectSettingsPath(root), { sandbox: { image: "python:3.12" } });
  await reload([]);
  const lines = (await reload(["confirm"])).join("\n");
  assert.match(lines, /pigeon resume sess_X --sandbox/);
  assert.deepEqual(await reload(["what"]), [
    "用法：/reload（重读设置）｜/reload confirm（确认列出的条目并生效）｜/reload skip（不确认，沿用原内容）",
  ]);
});
