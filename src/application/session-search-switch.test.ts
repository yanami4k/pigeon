// 记忆条件的两个开关（决策 193、217）：会话检索关掉时不注册 search_sessions、read_session_entry 与 list_sessions（339）、系统提示去掉提到它们
// 的那一句，其余逐字不变；缺省照旧开着。推送记忆打开时 headless 在装配前报错（推送记忆另行施工）
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LIST_SESSIONS_TOOL,
  READ_SESSION_ENTRY_TOOL,
  SEARCH_SESSIONS_TOOL,
} from "../memory/search-tools.ts";
import { listSessionRefs } from "../persistence/session-catalog.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { runHeadless } from "./headless-core.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const SEARCH_SENTENCE =
  "需要以前会话里的信息时，可用 list_sessions 浏览本项目以前的会话，用 search_sessions 按关键词检索以前会话里的对话，" +
  "再用 read_session_entry 按 entryId 读原文；检索片段只是线索，结论要回查原文。";

async function assembled(
  sessionSearch: boolean | undefined,
  replies: FakeReply[] = [{ text: "好" }]
) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-switch-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-search-switch-home-"));
  try {
    const streamFn = createFakeStreamFn({ replies });
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
      lastMessages: JSON.stringify(context?.messages ?? []),
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

test("会话检索关掉时模型硬调检索工具：按未注册的工具拒绝，不去读治理根里的会话", async () => {
  const off = await assembled(false, [
    { text: "", toolCalls: [{ name: SEARCH_SESSIONS_TOOL, args: { keywords: ["x"] } }] },
    { text: "好" },
  ]);
  assert.match(off.lastMessages, /search_sessions/);
  assert.doesNotMatch(off.lastMessages, /命中片段只是线索/);
});

test("推送记忆打开：headless 照常装配运行；无人值守只推送、不注册记忆工具，两层都空时不推这一段", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-pushed-memory-"));
  try {
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const result = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      skillRoots: [],
      agentsMd: false,
      homeDir: root,
      pushedMemory: true,
    });
    assert.equal(result.status, "completed");
    const first = streamFn.calls[0];
    assert.ok(!first?.context.systemPrompt?.includes("## 学到的记忆"));
    assert.ok(!(first?.context.tools ?? []).some((tool) => tool.name === "update_memory"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.match(searched, /^命中 1 条/);
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
    assert.match(output, /^命中 1 条/);
    assert.ok(output.includes(earlier.sessionId), output);
    assert.ok(!output.includes(parent.sessionId), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
