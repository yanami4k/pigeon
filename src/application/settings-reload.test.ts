// /reload 重读设置（决策 340）：改放权后重读，下一轮即生效；改命令短名后重读须确认，不确认沿用原内容、原来没有的不启用；
// MCP 只重启内容有变的服务：未变的连接沿用（不重启、旧运行面释放后仍连着），删掉的停止、改过的重启、新加的启动，
// 结果行列出改了哪些节；系统提示里开局冻结的部分（常驻 Memory、Skill 目录）不随重读变，由设置决定的部分按新快照变；
// 没有变化如实说明；有 worker 在跑时拒绝。
// 运行面重建照终端界面入口的做法：同一会话上按新快照重开（reloadFrom 给出旧运行面、还原上下文），再释放旧的。
// 用户级一律指到临时目录。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { createFixtureServer } from "../mcp/fixtures.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { learnedDirOf, projectLocalSettingsPath, projectSettingsPath } from "../state/paths.ts";
import { commandsConfigOf, mcpConfigOf, type SettingsSnapshot } from "../state/settings.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
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
// 内存传输的 MCP 服务：每次建传输按启动参数记一笔（看出哪些服务被重新启动）
function fixtureMcp(created: string[]) {
  return (
    target: { governanceRoot: string; workspaceRoot: string; reuse?: McpSession },
    settings: SettingsSnapshot
  ) =>
    startMcpSession({
      ...target,
      config: mcpConfigOf(settings),
      createTransport: (launch): Transport => {
        created.push(launch.type === "http" ? launch.url : (launch.args ?? []).join(" "));
        const { clientTransport } = createFixtureServer({
          tools: [
            {
              definition: { name: "echo", inputSchema: { type: "object" } },
              handler: () => ({ content: [{ type: "text" as const, text: "e" }] }),
            },
          ],
        });
        return clientTransport;
      },
    });
}

async function session(
  root: string,
  home: string,
  streamFn: StreamFn,
  mcp?: ReturnType<typeof fixtureMcp>,
  pushedMemory = false
) {
  let settings: SettingsSnapshot = await openSessionSettings(root, {
    homeDir: home,
    confirmation: { kind: "interactive", ask: async () => "trust" },
  });
  const sessionId: SessionId = newSessionId();
  const asked: ApprovalRequest[] = [];
  const startMcp = async (target: {
    governanceRoot: string;
    workspaceRoot: string;
    reuse?: McpSession;
  }): Promise<McpSession> => {
    if (mcp !== undefined) return mcp(target, settings);
    return {
      tools: [],
      prompts: [],
      problems: [],
      connections: [],
      summary: () => ({ mcpTools: [], mcpServers: [] }),
      close: async () => {},
    };
  };
  const open = (reloadFrom?: RuntimeBundle) =>
    openSessionRuntime({
      governanceRoot: root,
      settings,
      sessionId,
      streamFn,
      flags: {
        yolo: false,
        provider: "fake",
        modelId: "fake",
        persistThinking: true,
        ...(pushedMemory ? { pushedMemory: true } : {}),
      },
      homeDir: home,
      startMcp,
      createApprovalHandler: () => async (request) => {
        asked.push(request);
        return { approved: true };
      },
      ...(reloadFrom !== undefined ? { resume: true, reloadFrom } : {}),
    });
  let bundle: RuntimeBundle = (await open()).bundle;
  const reload = createSettingsReloader({
    current: () => settings,
    homeDir: home,
    apply: async (snapshot) => {
      settings = snapshot;
      await bundle.sessionStore.flush();
      const next = (await open(bundle)).bundle;
      const previous = bundle;
      bundle = next;
      await disposeRuntime(previous);
    },
  });
  return {
    reload,
    asked,
    settings: () => settings,
    bundle: () => bundle,
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

test("MCP 定义变化后 /reload：只重启内容有变的服务——未变的连接沿用（旧运行面释放后仍连着），删掉的停止、新加的启动", async () => {
  const root = temp("pigeon-reload-mcp-");
  const home = temp("pigeon-reload-home-");
  const created: string[] = [];
  write(join(root, ".mcp.json"), {
    mcpServers: {
      keep: { command: "node", args: ["keep.js"] },
      fx: { command: "node", args: ["a.js"] },
      old: { command: "node", args: ["o.js"] },
    },
  });
  const s = await session(
    root,
    home,
    createFakeStreamFn({ replies: [{ text: "好" }] }),
    fixtureMcp(created)
  );
  try {
    assert.deepEqual([...created].sort(), ["a.js", "keep.js", "o.js"]);
    const before = s.bundle().mcp?.connections ?? [];
    const keptBefore = before.find((connection) => connection.name === "keep");
    const oldBefore = before.find((connection) => connection.name === "old");
    write(join(root, ".mcp.json"), {
      mcpServers: {
        keep: { command: "node", args: ["keep.js"] },
        fx: { command: "node", args: ["b.js"] },
        add: { command: "node", args: ["n.js"] },
      },
    });
    // 只改风险档（不改启动定义）的服务也不重启
    write(projectSettingsPath(root), { mcp: { servers: { keep: { defaultTier: "read" } } } });
    await s.reload([]);
    const lines = (await s.reload(["confirm"])).join("\n");
    assert.match(lines, /改了 mcp 节/);
    assert.match(lines, /MCP 服务：重启 fx；停止 old；启动 add/);
    assert.ok(!/重启 [^；]*keep/.test(lines), lines);
    assert.deepEqual(
      [...created].sort(),
      ["a.js", "b.js", "keep.js", "n.js", "o.js"],
      "keep 不重新启动"
    );
    const after = s.bundle().mcp?.connections ?? [];
    const keptAfter = after.find((connection) => connection.name === "keep");
    assert.equal(keptAfter, keptBefore, "沿用同一条连接");
    assert.equal(keptAfter?.state, "connected", "旧运行面释放后仍连着");
    assert.equal(oldBefore?.state, "closed", "删掉的服务停止");
    assert.deepEqual(after.map((connection) => connection.name).sort(), ["add", "fx", "keep"]);
    // 新运行面里 keep 的工具按新的风险档登记
    const keepTool = s.bundle().mcp?.tools.find((tool) => tool.server === "keep");
    assert.equal(keepTool?.configuredTier, "read");
  } finally {
    await s.dispose();
  }
});

test("系统提示里开局冻结的部分不随 /reload 变：中途改 .pigeon/memory 与 Skill 后重读，那几段不变；由设置决定的部分按新快照变", async () => {
  const root = temp("pigeon-reload-frozen-");
  const home = temp("pigeon-reload-home-");
  mkdirSync(join(root, ".pigeon", "memory"), { recursive: true });
  writeFileSync(join(root, ".pigeon", "memory", "notes.md"), "开局写下的约定\n");
  mkdirSync(join(root, ".pigeon", "skills", "alpha"), { recursive: true });
  writeFileSync(
    join(root, ".pigeon", "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: 开局的技能\n---\n正文\n"
  );
  mkdirSync(learnedDirOf(root), { recursive: true });
  writeFileSync(join(learnedDirOf(root), "MEMORY.md"), "- 开局学到的一条\n");
  const s = await session(
    root,
    home,
    createFakeStreamFn({ replies: [{ text: "好" }] }),
    fixtureMcp([]),
    true
  );
  try {
    const prompt = () => s.bundle().adapter.snapshot().context.systemPrompt;
    const before = prompt();
    assert.match(before, /开局写下的约定/);
    assert.match(before, /alpha：开局的技能/);
    assert.match(before, /开局学到的一条/);
    assert.ok(!before.includes("## 外部工具"));
    writeFileSync(join(root, ".pigeon", "memory", "notes.md"), "中途改过的约定\n");
    writeFileSync(join(root, ".pigeon", "memory", "more.md"), "中途新加的记忆\n");
    writeFileSync(join(learnedDirOf(root), "MEMORY.md"), "- 中途学到的一条\n");
    mkdirSync(join(root, ".pigeon", "skills", "beta"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "skills", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: 中途的技能\n---\n正文\n"
    );
    write(join(root, ".mcp.json"), { mcpServers: { fx: { command: "node", args: ["a.js"] } } });
    await s.reload([]);
    await s.reload(["confirm"]);
    const after = prompt();
    assert.match(after, /## 外部工具/, "由设置决定的部分（MCP 一段）按新快照变");
    assert.ok(s.bundle().adapter.snapshot().tools.advertised.includes("mcp__fx__echo"));
    assert.match(after, /开局写下的约定/);
    assert.ok(
      !after.includes("中途改过的约定") && !after.includes("中途新加的记忆"),
      "常驻 Memory 不变"
    );
    assert.match(after, /alpha：开局的技能/);
    assert.ok(!after.includes("beta"), "Skill 目录不变");
    assert.match(after, /开局学到的一条/);
    assert.ok(!after.includes("中途学到的一条"), "推送的记忆不变");
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

test("确认指纹在重建成功后才记下：重建失败保持未确认，/reload 再列出、可重试（复审 P2 回归）", async () => {
  const root = temp("pigeon-reload-retry-");
  const home = temp("pigeon-reload-home-");
  write(projectSettingsPath(root), { commands: { commands: { mark: "git tag a" } } });
  const { loadSettings } = await import("../persistence/settings.ts");
  let currentSnapshot = loadSettings(root, { homeDir: home });
  write(projectSettingsPath(root), { commands: { commands: { mark: "git tag b" } } });
  let attempts = 0;
  const reload = createSettingsReloader({
    current: () => currentSnapshot,
    apply: (next) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("装配失败"));
      currentSnapshot = next;
      return Promise.resolve();
    },
    homeDir: home,
  });
  const listed = (await reload([])).join("\n");
  assert.match(listed, /命令短名 mark：git tag b/);
  await assert.rejects(reload(["confirm"]), /装配失败/);
  // 指纹未落盘、当前快照未换：再次 /reload 仍列出同一条目，可重试
  const relisted = (await reload([])).join("\n");
  assert.match(relisted, /命令短名 mark：git tag b/);
  const done = (await reload(["confirm"])).join("\n");
  assert.match(done, /改了 commands 节/);
  assert.equal(attempts, 2);
  assert.deepEqual(await reload([]), ["设置没有变化"]);
});
