// M5 S5（决策 044）：Run 快照摘要与上下文指纹——
//   - run.started：每个 Run 开始时落模型、策略、实际广告工具、system prompt 哈希、Memory 与 Skill 清单；
//   - system prompt 全文以 role 为 system 的内容记录每会话写一次；
//   - llm.request：transformContext 只读观察，每次模型调用一条（条数、角色计数、估算字符数、
//     全部消息内容哈希的滚动哈希、system prompt 哈希），与内容文件按哈希可对上；
//   - 观察钩子不改写消息数组，自身出错原样返回、进 listenerErrors，绝不毒化 Run。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import {
  JsonlEventLog,
  materializeSession,
  readMessageContentFileDetailed,
} from "../persistence/event-log.ts";
import { newSessionId } from "../state/ids.ts";
import { createEditFileTool, type EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { type EventLogSink, PiRuntimeAdapter } from "./adapter.ts";
import { createFakeStreamFn, type FakeReply } from "./fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "./snapshot.ts";

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");
const SYSTEM_PROMPT = "你是 Pigeon 测试助手。\n\n## 常驻 Memory\n\n### .pigeon/memory/a.md\n约定";
const ORIGINAL = "alpha\nbeta\ngamma\n";

function makeSnapshot(): InjectionSnapshot {
  return {
    version: INJECTION_SNAPSHOT_VERSION,
    model: { provider: "fake-provider", id: "fake-model-1" },
    tools: {
      policy: { allow: ["edit_file"], deny: [], approvalMode: "yolo" },
      advertised: ["edit_file"],
    },
    context: { systemPrompt: SYSTEM_PROMPT },
    memory: [
      {
        path: ".pigeon/memory/a.md",
        hash: "b".repeat(64),
        bytes: 6,
        truncated: false,
        included: true,
      },
    ],
    skills: [
      {
        name: "deploy",
        path: ".pigeon/skills/deploy",
        files: [{ path: "SKILL.md", hash: "c".repeat(64), bytes: 10 }],
      },
    ],
    createdAt: 1_700_000_000_000,
  };
}

function editCall(): EditFileParams {
  return {
    path: "a.ts",
    snapshot: snapshotTag(ORIGINAL),
    edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
  };
}

function setup(replies: FakeReply[], wrapLog?: (log: JsonlEventLog) => EventLogSink) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-adapter-observe-"));
  writeFileSync(join(root, "a.ts"), ORIGINAL);
  const sessionsDir = join(root, ".pigeon", "sessions");
  const sessionId = newSessionId();
  const log = new JsonlEventLog(sessionsDir, sessionId);
  const registry = new ToolRegistry();
  registry.register({
    name: "edit_file",
    description: "hashline 锚定稀疏编辑",
    parameters: Type.Object({}),
    tier: "write",
    pathConfinement: { kind: "workspace" },
    executionMode: "sequential",
  });
  const streamFn = createFakeStreamFn({ replies });
  const adapter = new PiRuntimeAdapter({
    snapshot: makeSnapshot(),
    streamFn,
    registry,
    tools: [createEditFileTool(root)],
    sessionId,
    eventLog: wrapLog === undefined ? log : wrapLog(log),
  });
  const finish = async () => {
    await adapter.dispose();
    log.close();
    return materializeSession(sessionsDir, sessionId);
  };
  const contents = () =>
    readMessageContentFileDetailed(JsonlEventLog.contentFilePathFor(sessionsDir, sessionId))
      .records;
  return {
    root,
    adapter,
    streamFn,
    finish,
    contents,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("run.started 每 Run 一条且先于该 Run 的其他记录；system prompt 全文以 system 内容记录每会话写一次", async () => {
  const { adapter, finish, contents, cleanup } = setup([{ text: "一" }, { text: "二" }]);
  try {
    const first = await adapter.run("第一次");
    const second = await adapter.run("第二次");
    const materialized = await finish();

    assert.deepEqual(
      materialized.runStarteds.map((record) => record.runId),
      [first.runId, second.runId]
    );
    const snapshot = makeSnapshot();
    assert.deepEqual(materialized.runStarteds[0]?.payload, {
      model: snapshot.model,
      policy: snapshot.tools.policy,
      advertisedTools: ["edit_file"],
      systemPromptHash: sha256(SYSTEM_PROMPT),
      memory: snapshot.memory,
      skills: snapshot.skills,
    });
    const firstRunKinds = materialized.records
      .filter((record) => record.runId === first.runId)
      .map((record) => record.kind);
    assert.equal(firstRunKinds[0], "run.started");

    const system = contents().filter((record) => record.role === "system");
    assert.equal(system.length, 1, "两次 Run 只写一次 system prompt 全文");
    assert.equal(system[0]?.runSeq, 0);
    assert.deepEqual(system[0]?.blocks, [{ type: "text", text: SYSTEM_PROMPT, truncated: false }]);
  } finally {
    cleanup();
  }
});

test("llm.request 每次模型调用一条：条数与角色计数；滚动哈希与内容文件的消息哈希对得上", async () => {
  const { adapter, finish, contents, cleanup } = setup([
    { text: "改", toolCalls: [{ name: "edit_file", args: editCall() }] },
    { text: "完成" },
  ]);
  try {
    const result = await adapter.run("把 beta 改成大写");
    assert.equal(result.status, "completed");
    const materialized = await finish();
    const [user, assistant, toolResult] = contents()
      .filter((record) => record.role !== "system")
      .sort((a, b) => a.runSeq - b.runSeq);
    assert.ok(user !== undefined && assistant !== undefined && toolResult !== undefined);

    const requests = materialized.llmRequests.map((record) => record.payload);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.messageCount, 1);
    assert.deepEqual(requests[0]?.roleCounts, { user: 1 });
    assert.equal(requests[0]?.messagesHash, sha256(user.contentHash));
    assert.equal(requests[0]?.systemPromptHash, sha256(SYSTEM_PROMPT));
    assert.ok((requests[0]?.estimatedChars ?? 0) > 0);
    assert.equal(requests[1]?.messageCount, 3);
    assert.deepEqual(requests[1]?.roleCounts, { user: 1, assistant: 1, toolResult: 1 });
    assert.equal(
      requests[1]?.messagesHash,
      sha256([user, assistant, toolResult].map((record) => record.contentHash).join("\n"))
    );
    assert.ok(materialized.llmRequests.every((record) => record.runId === result.runId));
  } finally {
    cleanup();
  }
});

test("观察钩子只读：模型实际收到的消息与 llm.request 记录的条数一致（钩子改写消息数组变红）", async () => {
  const { adapter, streamFn, finish, cleanup } = setup([
    { text: "改", toolCalls: [{ name: "edit_file", args: editCall() }] },
    { text: "完成" },
  ]);
  try {
    await adapter.run("把 beta 改成大写");
    const materialized = await finish();
    assert.deepEqual(
      streamFn.calls.map((call) => call.context.messages.map((message) => message.role)),
      [["user"], ["user", "assistant", "toolResult"]]
    );
    assert.deepEqual(
      materialized.llmRequests.map((record) => record.payload.messageCount),
      streamFn.calls.map((call) => call.context.messages.length)
    );
  } finally {
    cleanup();
  }
});

test("观察落盘抛错不毒化 Run：Run 正常完成、模型照常收到消息、故障进 listenerErrors", async () => {
  const { adapter, streamFn, finish, cleanup } = setup([{ text: "好" }], (log) => ({
    appendRuntimeEvent: log.appendRuntimeEvent.bind(log),
    appendEntry: log.appendEntry.bind(log),
    appendIntent: log.appendIntent.bind(log),
    appendDecision: log.appendDecision.bind(log),
    appendReceipt: log.appendReceipt.bind(log),
    appendBreaker: log.appendBreaker.bind(log),
    appendSystemPrompt: log.appendSystemPrompt.bind(log),
    appendObservation: () => {
      throw new Error("模拟观察落盘失败");
    },
  }));
  try {
    const result = await adapter.run("你好");
    assert.equal(result.status, "completed");
    assert.equal(streamFn.calls[0]?.context.messages.length, 1);
    const failures = adapter
      .listenerErrors()
      .filter((error) => error instanceof Error && error.message === "模拟观察落盘失败");
    assert.equal(failures.length, 2, "run.started 与 llm.request 各失败一次，都进 listenerErrors");
    await finish();
  } finally {
    cleanup();
  }
});
