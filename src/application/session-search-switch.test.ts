// 记忆条件的两个开关（决策 193、217）：会话检索关掉时不注册 search_sessions、read_session_entry 与 list_sessions（339）、系统提示去掉提到它们
// 的那一句，其余逐字不变；缺省照旧开着。推送记忆的装配见 runtime-pushed-memory.test.ts。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { listSessionRefs } from "../persistence/session-catalog.ts";
import { sessionFileName } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const SEARCH_SENTENCE =
  "需要以前会话里的信息时，可用 list_sessions 浏览本项目以前的会话，用 search_sessions 按关键词检索以前会话里的对话，" +
  "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。";

async function assembled(sessionSearch: boolean | undefined) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-switch-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-search-switch-home-"));
  try {
    // 决策 359：本项目有历史会话才注册会话检索三件——先放一个之前的会话
    const earlier = { kind: "header", version: 4, id: newSessionId(), createdAt: 1, cwd: root };
    mkdirSync(join(sessionsDirOf(root), "earlier"), { recursive: true });
    const file = join(sessionsDirOf(root), "earlier", sessionFileName(1, earlier.id));
    writeFileSync(file, `${JSON.stringify(earlier)}\n`);
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const result = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
      ...(sessionSearch !== undefined ? { sessionSearch } : {}),
    });
    const context = streamFn.calls.at(-1)?.context;
    return {
      result,
      systemPrompt: context?.systemPrompt ?? "",
      tools: ((context?.tools ?? []) as unknown as { name: string }[]).map((t) => t.name),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("会话检索开关：关掉时三件工具都不注册、系统提示去掉那一句，其余逐字不变；缺省与显式开着一致", async () => {
  const on = await assembled(true);
  const byDefault = await assembled(undefined);
  const off = await assembled(false);
  const searchTools = [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, LIST_SESSIONS_TOOL];
  assert.ok(searchTools.every((name) => on.tools.includes(name)));
  assert.deepEqual(byDefault.tools, on.tools);
  assert.equal(byDefault.systemPrompt, on.systemPrompt);
  assert.ok(on.systemPrompt.includes(SEARCH_SENTENCE));
  assert.deepEqual(
    off.tools,
    on.tools.filter((name) => !searchTools.includes(name))
  );
  assert.equal(off.systemPrompt, on.systemPrompt.replace(SEARCH_SENTENCE, ""));
  assert.doesNotMatch(off.systemPrompt, /search_sessions|read_session_entry|list_sessions/);
});

test("决策 382：使用者开关关掉即不注册检索三件、开局记录写明原因；跑批条件关掉（无原因）照旧不记", async () => {
  const searchTools = [SEARCH_SESSIONS_TOOL, READ_SESSION_ENTRY_TOOL, LIST_SESSIONS_TOOL];
  const run = async (input: {
    settingsEnabled?: boolean;
    sessionSearch?: boolean;
    offReason?: string;
  }) => {
    const root = mkdtempSync(join(tmpdir(), "pigeon-search-user-switch-"));
    try {
      // 有历史会话（排除"没有历史会话"那条 skip，只留开关的原因）
      const earlier = { kind: "header", version: 4, id: newSessionId(), createdAt: 1, cwd: root };
      mkdirSync(join(sessionsDirOf(root), "earlier"), { recursive: true });
      writeFileSync(
        join(sessionsDirOf(root), "earlier", sessionFileName(1, earlier.id)),
        `${JSON.stringify(earlier)}\n`
      );
      const settings = emptySettingsSnapshot(root);
      if (input.settingsEnabled !== undefined) {
        settings.merged.sessionSearch = { enabled: input.settingsEnabled };
      }
      const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
      const sessionId = newSessionId();
      const bundle = buildRuntime({
        streamFn,
        governanceRoot: root,
        workspaceRoot: root,
        homeDir: root,
        sessionId,
        yolo: true,
        provider: "fake-provider",
        modelId: "fake-model-1",
        settings,
        ...(input.sessionSearch !== undefined ? { sessionSearch: input.sessionSearch } : {}),
        ...(input.offReason !== undefined ? { sessionSearchOffReason: input.offReason } : {}),
      });
      const advertised = bundle.adapter.snapshot().tools.advertised;
      await bundle.adapter.run("你好").finally(() => disposeRuntime(bundle));
      return {
        tools: advertised,
        skipped: loadStoreSession(sessionsDirOf(root), sessionId)?.view.runs[0]?.start.skippedTools,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  // 设置项关掉：不注册，记原因
  const bySettings = await run({ settingsEnabled: false });
  assert.ok(searchTools.every((name) => !bySettings.tools.includes(name)));
  assert.deepEqual(bySettings.skipped, [
    { tools: searchTools, reason: "设置 sessionSearch.enabled 为 false（使用者关掉了会话检索）" },
  ]);
  // 启动参数关掉（session-runtime 把 flags 译成 deps 与原因）：不注册，记原因
  const byFlag = await run({
    sessionSearch: false,
    offReason: "使用者以 --no-session-search 关掉了会话检索",
  });
  assert.ok(searchTools.every((name) => !byFlag.tools.includes(name)));
  assert.deepEqual(byFlag.skipped, [
    { tools: searchTools, reason: "使用者以 --no-session-search 关掉了会话检索" },
  ]);
  // 跑批按条件关掉：不注册，照旧不记
  const byCondition = await run({ sessionSearch: false });
  assert.ok(searchTools.every((name) => !byCondition.tools.includes(name)));
  assert.deepEqual(byCondition.skipped ?? [], []);
  // 开着（缺省）：注册，不记
  const on = await run({});
  assert.ok(searchTools.every((name) => on.tools.includes(name)));
});

test("决策 339 ①⑥：装配出的检索工具排除本次运行自己的会话（续接同一会话文件时同样排除），可搜文本缓存在 .pigeon/state/search-cache/", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-self-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-search-self-home-"));
  try {
    const run = (task: string, replies: FakeReply[], sessionId?: SessionId) => {
      const streamFn = createFakeStreamFn({ replies });
      return runHeadless({
        task,
        governanceRoot: root,
        workspaceRoot: root,
        streamFn,
        yolo: true,
        homeDir: home,
        skillRoots: [],
        agentsMd: false,
        ...(sessionId !== undefined ? { sessionId } : {}),
      }).then((result) => ({ result, streamFn }));
    };
    const earlier = await run("needle 以前", [{ text: "好" }]);
    const current = await run("needle 第一次", [{ text: "好" }]);
    // 续接 current：同一会话号、同一会话文件，文件里已有"needle 第一次"
    const resumed = await run(
      "needle 第二次",
      [
        { text: "", toolCalls: [{ name: SEARCH_SESSIONS_TOOL, args: { keywords: ["needle"] } }] },
        { text: "", toolCalls: [{ name: LIST_SESSIONS_TOOL, args: {} }] },
        { text: "好" },
      ],
      current.result.sessionId
    );
    assert.equal(resumed.result.sessionId, current.result.sessionId);
    assert.equal(listSessionRefs(sessionsDirOf(root)).length, 2);
    const outputs = (resumed.streamFn.calls.at(-1)?.context.messages ?? []).flatMap((message) =>
      message.role === "toolResult"
        ? [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")]
        : []
    );
    assert.equal(outputs.length, 2);
    const [searched = "", listed = ""] = outputs;
    assert.match(searched, /^命中 1 个会话/);
    assert.ok(searched.includes(earlier.result.sessionId) && searched.includes("needle 以前"));
    assert.ok(!searched.includes(current.result.sessionId), searched);
    assert.match(listed, /^以前的会话 1 个/);
    assert.ok(listed.includes(earlier.result.sessionId));
    assert.ok(!listed.includes(current.result.sessionId), listed);
    assert.ok(
      readdirSync(join(root, ".pigeon", "state", "search-cache")).includes(
        `${earlier.result.sessionId}.json`
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("决策 339 ①：worker 运行面的检索排除派出它的会话（父会话取自本运行面的来历，不等 worker 自己的会话文件写出）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-lineage-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-search-lineage-home-"));
  try {
    const headless = (task: string) =>
      runHeadless({
        task,
        governanceRoot: root,
        workspaceRoot: root,
        streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
        yolo: true,
        homeDir: home,
        skillRoots: [],
        agentsMd: false,
      });
    const earlier = await headless("PR 4242 以前的讨论");
    const parent = await headless("PR 4242 主会话");
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "", toolCalls: [{ name: SEARCH_SESSIONS_TOOL, args: { keywords: ["4242"] } }] },
        { text: "好" },
      ],
    });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model",
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
      storeLineage: {
        worker: {
          parentSessionId: parent.sessionId,
          worker: { name: "w1", role: "explorer" },
          workspace: { kind: "none" },
          startedAt: Date.now(),
        },
      },
    });
    try {
      await bundle.adapter.run("worker 的活");
    } finally {
      await disposeRuntime(bundle);
    }
    const output = (streamFn.calls.at(-1)?.context.messages ?? [])
      .flatMap((message) =>
        message.role === "toolResult"
          ? message.content.map((block) => (block.type === "text" ? block.text : ""))
          : []
      )
      .join("");
    assert.match(output, /^命中 1 个会话/);
    assert.ok(output.includes(earlier.sessionId), output);
    assert.ok(!output.includes(parent.sessionId), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
