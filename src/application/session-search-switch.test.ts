// 记忆条件的两个开关（决策 193、217）：会话检索关掉时不注册 search_sessions 与 read_session_entry、系统提示去掉提到它们
// 的那一句，其余逐字不变；缺省照旧开着。推送记忆打开时 headless 在装配前报错（推送记忆另行施工）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { READ_SESSION_ENTRY_TOOL, SEARCH_SESSIONS_TOOL } from "../memory/search-tools.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { runHeadless } from "./headless-core.ts";

const SEARCH_SENTENCE =
  "需要以前会话里的信息时，用 search_sessions 按关键词检索本项目历史消息，" +
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

test("会话检索开关：关掉时两件工具都不注册、系统提示去掉那一句，其余逐字不变；缺省与显式开着一致", async () => {
  const on = await assembled(true);
  const byDefault = await assembled(undefined);
  const off = await assembled(false);
  assert.ok(on.tools.includes(SEARCH_SESSIONS_TOOL) && on.tools.includes(READ_SESSION_ENTRY_TOOL));
  assert.deepEqual(byDefault.tools, on.tools);
  assert.equal(byDefault.systemPrompt, on.systemPrompt);
  assert.ok(on.systemPrompt.includes(SEARCH_SENTENCE));
  assert.deepEqual(
    off.tools,
    on.tools.filter((name) => name !== SEARCH_SESSIONS_TOOL && name !== READ_SESSION_ENTRY_TOOL)
  );
  assert.equal(off.systemPrompt, on.systemPrompt.replace(SEARCH_SENTENCE, ""));
  assert.doesNotMatch(off.systemPrompt, /search_sessions|read_session_entry/);
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
