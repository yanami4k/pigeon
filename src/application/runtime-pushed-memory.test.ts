// 推送记忆的装配（决策 191、244、331、332）：推送段放在常驻 Memory 之后、Skill 目录之前；Run 开始条目记两层记忆的身份与
// 文字版本；只有带写入配置的主会话（终端界面、--line）注册 update_memory、推送段带"被纠正时记下"的说明与交互版的冲突处理；
// pigeon run、worker 只推送；记忆工具免审批，写入后交出一行提示；两层上限取设置的 memory 一节；日常入口的启动参数缺省开着，
// --no-pushed-memory 关掉。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MEMORY_FILE_HEADERS, type MemoryLayer } from "../memory/learned.ts";
import { memoryLocation } from "../memory/learned-store.ts";
import { MEMORY_CONFLICT_TEXTS, MEMORY_WRITE_GUIDANCE } from "../memory/pushed.ts";
import type { MemoryWriteNotice } from "../memory/update-memory-tool.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { type RunStartData, SessionEntryType } from "../state/session-entries.ts";
import { runHeadless } from "./headless.ts";
import { parseLaunchFlags } from "./launch-flags.ts";
import type { McpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type RuntimeDeps } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { createSessionWorkers } from "./workers.ts";

const PROJECT_ENTRY = "- [P1] 提交信息用英文祈使句 〔2026-09-30 · 终端界面 · 会话 sess_A〕\n";
const USER_ENTRY = "- [U1] 回复用中文 〔2026-09-30 · 命令行对话 · 会话 sess_B〕\n";
const TODAY = new Date(2026, 9, 1, 9, 0);

// 用户级记忆所在的主目录：放在临时根下的 home/（不与项目级同一个文件）
const homeOf = (root: string) => join(root, "home");

function writeMemory(root: string, layer: MemoryLayer, text: string): void {
  const file = memoryLocation(layer, { governanceRoot: root, homeDir: homeOf(root) }).file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function readMemory(root: string, layer: MemoryLayer): string {
  return readFileSync(
    memoryLocation(layer, { governanceRoot: root, homeDir: homeOf(root) }).file,
    "utf8"
  );
}

function seed(root: string): void {
  writeMemory(root, "project", MEMORY_FILE_HEADERS.project + PROJECT_ENTRY);
  writeMemory(root, "user", MEMORY_FILE_HEADERS.user + USER_ENTRY);
  mkdirSync(join(root, ".pigeon", "memory"), { recursive: true });
  writeFileSync(join(root, ".pigeon", "memory", "rules.md"), "人写的规矩\n");
  mkdirSync(join(root, ".pigeon", "skills", "deploy"), { recursive: true });
  writeFileSync(
    join(root, ".pigeon", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: 部署步骤\n---\n# 部署正文\n"
  );
}

function deps(root: string, extra: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "fake-provider",
    modelId: "fake-model",
    homeDir: homeOf(root),
    ...extra,
  };
}

function runStarts(root: string, sessionId: string): RunStartData[] {
  const located = locateSessionFile(join(root, ".pigeon", "state", "sessions"), sessionId);
  assert.ok(located !== undefined);
  const loaded = loadStoreSessionFile(located.path);
  assert.ok(loaded !== undefined);
  return (loaded.main as unknown as Array<{ type: string; customType?: string; data?: unknown }>)
    .filter((entry) => entry.type === "custom" && entry.customType === SessionEntryType.RunStart)
    .map((entry) => entry.data as RunStartData);
}

function fakeMcp(): McpSession {
  return {
    tools: [],
    prompts: [],
    problems: [],
    connections: [],
    summary: () => ({ mcpTools: [], mcpServers: [] }),
    close: async () => {},
  };
}

function withRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("只推送：推送段在常驻 Memory 之后、Skill 目录之前，两层都推；不注册 update_memory、不带写入说明；Run 开始条目记两层身份与文字版本", () =>
  withRoot("pigeon-pushed-only-", async (root) => {
    seed(root);
    const bundle = buildRuntime(deps(root, { learnedMemory: {} }));
    try {
      await bundle.adapter.run("你好");
      const snapshot = bundle.adapter.snapshot();
      const prompt = snapshot.context.systemPrompt;
      const resident = prompt.indexOf("## 常驻 Memory");
      const pushed = prompt.indexOf("## 学到的记忆");
      const skills = prompt.indexOf("- deploy：部署步骤");
      assert.ok(resident >= 0 && pushed > resident && skills > pushed, prompt);
      assert.ok(prompt.includes(PROJECT_ENTRY.trimEnd()));
      assert.ok(prompt.includes(USER_ENTRY.trimEnd()));
      assert.ok(prompt.includes(MEMORY_CONFLICT_TEXTS.unattended));
      assert.ok(!prompt.includes(MEMORY_WRITE_GUIDANCE));
      assert.ok(!snapshot.tools.advertised.includes("update_memory"));
      await bundle.sessionStore.flush();
      const [start] = runStarts(root, bundle.adapter.sessionId);
      const hash = (text: string) => createHash("sha256").update(text).digest("hex");
      assert.deepEqual(start?.pushedMemory, {
        textVersion: "v2",
        layers: [
          {
            layer: "project",
            path: ".pigeon/state/memory.md",
            hash: hash(MEMORY_FILE_HEADERS.project + PROJECT_ENTRY),
            bytes: Buffer.byteLength(MEMORY_FILE_HEADERS.project + PROJECT_ENTRY),
            entries: 1,
            limitChars: 4000,
          },
          {
            layer: "user",
            path: "~/.pigeon/state/memory.md",
            hash: hash(MEMORY_FILE_HEADERS.user + USER_ENTRY),
            bytes: Buffer.byteLength(MEMORY_FILE_HEADERS.user + USER_ENTRY),
            entries: 1,
            limitChars: 4000,
          },
        ],
      });
      assert.equal(start?.learnedMemory, undefined);
    } finally {
      await disposeRuntime(bundle);
    }
  }));

test("关着（缺省）：没有推送段、不注册 update_memory、Run 开始条目不带推送的记忆", () =>
  withRoot("pigeon-pushed-off-", async (root) => {
    seed(root);
    const bundle = buildRuntime(deps(root));
    try {
      await bundle.adapter.run("你好");
      const snapshot = bundle.adapter.snapshot();
      assert.ok(!snapshot.context.systemPrompt.includes("## 学到的记忆"));
      assert.ok(!snapshot.tools.advertised.includes("update_memory"));
      await bundle.sessionStore.flush();
      assert.equal(runStarts(root, bundle.adapter.sessionId)[0]?.pushedMemory, undefined);
    } finally {
      await disposeRuntime(bundle);
    }
  }));

test("带写入配置：注册 update_memory、推送段带写入说明与交互版的冲突处理；免审批（无审批通道的非 yolo 会话照样执行）；写入后交出提示", () =>
  withRoot("pigeon-pushed-write-", async (root) => {
    const notices: MemoryWriteNotice[] = [];
    const bundle = buildRuntime(
      deps(root, {
        yolo: false,
        streamFn: createFakeStreamFn({
          replies: [
            {
              text: "记一条",
              toolCalls: [
                {
                  name: "update_memory",
                  args: { action: "add", layer: "user", content: "回复先给结论" },
                },
              ],
            },
            { text: "记好了" },
          ],
        }),
        learnedMemory: {
          write: { source: "line", onWritten: (notice) => notices.push(notice), now: () => TODAY },
        },
      })
    );
    try {
      const prompt = bundle.adapter.snapshot().context.systemPrompt;
      assert.ok(prompt.includes(MEMORY_WRITE_GUIDANCE));
      assert.ok(prompt.includes(MEMORY_CONFLICT_TEXTS.interactive));
      assert.ok(bundle.adapter.snapshot().tools.advertised.includes("update_memory"));
      await bundle.adapter.run("记下来");
    } finally {
      await disposeRuntime(bundle);
    }
    assert.equal(
      readMemory(root, "user"),
      `${MEMORY_FILE_HEADERS.user}- [U1] 回复先给结论 〔2026-10-01 · 命令行对话 · 会话 ${bundle.adapter.sessionId}〕\n`
    );
    assert.deepEqual(notices, [
      { layer: "user", action: "add", id: "U1", content: "回复先给结论" },
    ]);
  }));

test("两层上限取设置的 memory 一节：推送段与记忆工具都按它", () =>
  withRoot("pigeon-pushed-limits-", async (root) => {
    seed(root);
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "settings.json"),
      `${JSON.stringify({ memory: { projectLimitChars: 1234, userLimitChars: 567 } })}\n`
    );
    const settings = loadSettings(root, { homeDir: join(root, "no-home") });
    const streamFn = createFakeStreamFn({
      replies: [
        {
          text: "记",
          toolCalls: [
            { name: "update_memory", args: { action: "add", layer: "project", content: "甲" } },
          ],
        },
        { text: "好" },
      ],
    });
    const bundle = buildRuntime(
      deps(root, {
        settings,
        learnedMemory: { write: { source: "tui", now: () => TODAY } },
        streamFn,
      })
    );
    try {
      const prompt = bundle.adapter.snapshot().context.systemPrompt;
      assert.ok(prompt.includes("/1234 字符"), prompt);
      assert.ok(prompt.includes("/567 字符"), prompt);
      await bundle.adapter.run("记");
    } finally {
      await disposeRuntime(bundle);
    }
    // 工具回话里的上限取设置的值
    assert.match(
      JSON.stringify(streamFn.calls[1]?.context.messages),
      /已在项目级新增 P2（当前 \d+\/1234 字符）。/
    );
    assert.ok(readMemory(root, "project").includes("- [P2] 甲 〔2026-10-01 · 终端界面 · 会话 "));
  }));

test("入口：终端界面与 --line（openSessionRuntime 给写入配置）有 update_memory 与写入说明；pigeon run（headless）只推送", () =>
  withRoot("pigeon-pushed-entries-", async (root) => {
    seed(root);
    const flags = {
      yolo: true,
      provider: "custom",
      modelId: "custom",
      persistThinking: true,
      pushedMemory: true,
    };
    for (const source of ["tui", "line"] as const) {
      const opened = await openSessionRuntime({
        governanceRoot: root,
        sessionId: newSessionId(),
        streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
        flags,
        homeDir: homeOf(root),
        memoryWrite: { source },
        startMcp: async () => fakeMcp(),
      });
      try {
        const snapshot = opened.bundle.adapter.snapshot();
        assert.ok(snapshot.tools.advertised.includes("update_memory"), source);
        assert.ok(snapshot.context.systemPrompt.includes(MEMORY_WRITE_GUIDANCE), source);
      } finally {
        await disposeRuntime(opened.bundle);
      }
    }
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const run = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: homeOf(root),
      pushedMemory: true,
    });
    assert.equal(run.status, "completed");
    const first = streamFn.calls[0];
    assert.ok(first?.context.systemPrompt?.includes(PROJECT_ENTRY.trimEnd()));
    assert.ok(!first?.context.systemPrompt?.includes(MEMORY_WRITE_GUIDANCE));
    assert.ok(!(first?.context.tools ?? []).some((tool) => tool.name === "update_memory"));
  }));

test("日常入口：推送缺省开着，--no-pushed-memory 关掉；--memory-limit 不再是启动参数（上限在设置里）；不接受的入口当作未知参数", () => {
  const usage = "用法";
  assert.equal(parseLaunchFlags([], { usage, pushedMemory: true }).pushedMemory, true);
  assert.equal(
    parseLaunchFlags(["--no-pushed-memory"], { usage, pushedMemory: true }).pushedMemory,
    false
  );
  assert.throws(
    () => parseLaunchFlags(["--memory-limit", "4000"], { usage, pushedMemory: true }),
    /未知参数/
  );
  assert.throws(() => parseLaunchFlags(["--no-pushed-memory"], { usage }), /未知参数/);
});

// 决策 331：worker 只推送记忆、不带记忆工具；父会话带写入配置也一样
for (const role of ["explorer", "implementer", "tester"] as const) {
  test(`worker（${role}）：父会话推送且可写入时，系统提示带推送段，但不带写入说明、不广告 update_memory`, async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-pushed-worker-")));
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "pigeon@example.invalid"]);
      git(["config", "user.name", "pigeon-test"]);
      writeFileSync(join(repo, "a.ts"), "alpha\n");
      git(["add", "a.ts"]);
      git(["commit", "-q", "-m", "init"]);
      seed(repo);
      const parent = buildRuntime({
        ...deps(repo, { streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }) }),
        learnedMemory: { write: { source: "tui" } },
      });
      try {
        assert.ok(parent.adapter.snapshot().tools.advertised.includes("update_memory"));
        const orchestrator = createSessionWorkers({
          governanceRoot: repo,
          bundle: parent,
          approvals: async () => ({ approved: true }),
          streamFn: createFakeStreamFn({ replies: [{ text: "做完了" }] }),
          provider: "fake-provider",
          modelId: "fake-model",
          homeDir: homeOf(repo),
        });
        const workerId = orchestrator.spawn({ role, task: "看看", name: "w" });
        const outcome = await orchestrator.awaitResult(workerId);
        assert.equal(outcome.status, "completed", JSON.stringify(outcome));
        const [start] = runStarts(repo, workerId);
        assert.ok(start?.systemPrompt.includes(PROJECT_ENTRY.trimEnd()));
        assert.ok(start?.systemPrompt.includes(MEMORY_CONFLICT_TEXTS.unattended));
        assert.ok(!start?.systemPrompt.includes(MEMORY_WRITE_GUIDANCE));
        assert.ok(!start?.advertisedTools.includes("update_memory"));
        assert.ok(!start?.policy.allow.includes("update_memory"));
        assert.equal(start?.pushedMemory?.layers.length, 2);
      } finally {
        await disposeRuntime(parent);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}
