// 会话树（M7 S6，决策 068 / 077）：上游 Session 存储只经 pi-runtime 引用。
// - 账本投影：树里的消息由账本与内容文件投影而来（正文取内容文件，助手消息的停止原因、用量与错误取对应轮次的
//   turn.completed，工具调用参数取 tool.proposed，模型身份取 run.started）；写穿与重建共用这一个投影，结果逐条一致；
// - 树存储：每个根会话一个树文件，放 .pigeon/trees/；根会话走 main 通道，分支会话在分叉条目上建以分支会话号命名的通道；
//   条目号直接用账本的条目号；分支消息由 buildSessionContext 从根到分叉点还原。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventRecord } from "../state/event-log.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import type { MessageContentRecord } from "../state/message-content.ts";
import {
  ledgerTreeMessages,
  openSessionTree,
  projectLedgerMessage,
  TREE_MAIN_LANE,
} from "./session-tree.ts";

const HASH = "0".repeat(64);
const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function content(
  runSeq: number,
  role: string,
  blocks: unknown[],
  extra: Record<string, unknown> = {}
): MessageContentRecord {
  return {
    version: 1,
    sessionId: newSessionId(),
    runId: newRunId(),
    runSeq,
    entryId: newEntryId(),
    role,
    timestamp: 1000 + runSeq,
    blocks,
    contentHash: HASH,
    ...extra,
  } as MessageContentRecord;
}

test("账本投影：用户、助手（正文、思考、带参数的工具调用、停止原因、用量、错误）、工具结果；未持久化的思考不进消息", () => {
  const user = projectLedgerMessage(
    content(1, "user", [{ type: "text", text: "改 a.txt", truncated: false }]),
    { model: { provider: "p", id: "m" }, toolArgs: new Map() }
  );
  assert.deepEqual(user, {
    role: "user",
    content: [{ type: "text", text: "改 a.txt" }],
    timestamp: 1001,
  });
  const assistant = projectLedgerMessage(
    content(2, "assistant", [
      { type: "thinking", thinking: "想", truncated: false },
      { type: "thinking", thinking: "", truncated: false, omitted: true },
      { type: "text", text: "改", truncated: false },
      { type: "toolCall", id: "tc-1", name: "edit_file" },
    ]),
    {
      model: { provider: "p", id: "m" },
      toolArgs: new Map([["tc-1", { path: "a.txt" }]]),
      stopReason: "toolUse",
      usage: USAGE,
      errorMessage: "半路出错",
    }
  );
  assert.deepEqual(assistant, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "想" },
      { type: "text", text: "改" },
      { type: "toolCall", id: "tc-1", name: "edit_file", arguments: { path: "a.txt" } },
    ],
    api: "unknown",
    provider: "p",
    model: "m",
    usage: USAGE,
    stopReason: "toolUse",
    errorMessage: "半路出错",
    timestamp: 1002,
  });
  const result = projectLedgerMessage(
    content(3, "toolResult", [{ type: "text", text: "已编辑", truncated: false }], {
      toolCallId: "tc-1",
      toolName: "edit_file",
      isError: false,
    }),
    { model: { provider: "p", id: "m" }, toolArgs: new Map() }
  );
  assert.deepEqual(result, {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "edit_file",
    content: [{ type: "text", text: "已编辑" }],
    isError: false,
    timestamp: 1003,
  });
});

test("账本到树消息：按 Run 内第几条助手消息对应第几次 turn.completed，工具参数取 tool.proposed，模型取 run.started", () => {
  const sessionId = newSessionId();
  const runId = newRunId();
  const entryIds = [newEntryId(), newEntryId(), newEntryId(), newEntryId()];
  const envelope = (timestamp: number) => ({
    version: 11,
    id: newEntryId(),
    sessionId,
    runId,
    timestamp,
  });
  const records = [
    {
      ...envelope(1),
      kind: "run.started",
      payload: {
        model: { provider: "p", id: "m" },
        policy: { allow: [], deny: [], approvalMode: "yolo" },
        advertisedTools: [],
        systemPromptHash: HASH,
        memory: [],
        skills: [],
      },
    },
    { ...envelope(2), id: entryIds[0], kind: "entry", runSeq: 1, role: "user" },
    { ...envelope(3), id: entryIds[1], kind: "entry", runSeq: 2, role: "assistant" },
    {
      ...envelope(4),
      kind: "tool.proposed",
      payload: { toolCallId: "tc-1", toolName: "edit_file", args: { path: "a" } },
    },
    { ...envelope(5), id: entryIds[2], kind: "entry", runSeq: 3, role: "toolResult" },
    {
      ...envelope(6),
      kind: "turn.completed",
      payload: { stopReason: "toolUse", syntheticFailure: false, usage: USAGE },
    },
    { ...envelope(7), id: entryIds[3], kind: "entry", runSeq: 4, role: "assistant" },
    {
      ...envelope(8),
      kind: "turn.completed",
      payload: { stopReason: "stop", syntheticFailure: false },
    },
  ] as EventRecord[];
  const contents = new Map<string, MessageContentRecord>([
    [entryIds[0] as string, content(1, "user", [{ type: "text", text: "任务", truncated: false }])],
    [
      entryIds[1] as string,
      content(2, "assistant", [{ type: "toolCall", id: "tc-1", name: "edit_file" }]),
    ],
    [
      entryIds[2] as string,
      content(3, "toolResult", [{ type: "text", text: "ok", truncated: false }], {
        toolCallId: "tc-1",
        toolName: "edit_file",
        isError: false,
      }),
    ],
    [
      entryIds[3] as string,
      content(4, "assistant", [{ type: "text", text: "完", truncated: false }]),
    ],
  ]);
  const messages = ledgerTreeMessages({ records, contentByEntryId: contents });
  assert.deepEqual(
    messages.map((item) => item.id),
    entryIds
  );
  const first = messages[1]?.message as {
    stopReason: string;
    content: Array<{ arguments?: unknown }>;
  };
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual(first.content[0]?.arguments, { path: "a" });
  const second = messages[3]?.message as { stopReason: string; usage: { totalTokens: number } };
  assert.equal(second.stopReason, "stop");
  assert.equal(second.usage.totalTokens, 0, "该轮没有用量记录时为零");
});

test("树存储：放在 .pigeon/trees 下；main 通道追加、在分叉条目上建分支通道、分支消息从根还原到分叉点；重开可见；可删除", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tree-store-"));
  try {
    const rootSessionId = newSessionId();
    const branchSessionId = newSessionId();
    const ids = [newEntryId(), newEntryId(), newEntryId(), newEntryId()];
    const message = (text: string, role = "user") =>
      role === "user"
        ? { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 }
        : ({
            role: "assistant",
            content: [{ type: "text", text }],
            api: "unknown",
            provider: "p",
            model: "m",
            usage: USAGE,
            stopReason: "stop",
            timestamp: 1,
          } as never);
    const tree = await openSessionTree({ governanceRoot: root, rootSessionId });
    await tree.append(TREE_MAIN_LANE, [
      { id: ids[0] as string, message: message("任务") },
      { id: ids[1] as string, message: message("来源第一步", "assistant") },
      { id: ids[2] as string, message: message("来源走岔", "assistant") },
    ]);
    await tree.createLane(branchSessionId, ids[0] as string);
    await tree.append(branchSessionId, [
      { id: ids[3] as string, message: message("分支做法", "assistant") },
    ]);
    assert.ok(existsSync(join(root, ".pigeon", "trees")));
    const atFork = await tree.messagesUpTo(ids[0] as string);
    assert.deepEqual(
      atFork.map((item) => (item as { content: Array<{ text: string }> }).content[0]?.text),
      ["任务"]
    );
    const reopened = await openSessionTree({ governanceRoot: root, rootSessionId });
    assert.deepEqual(
      (await reopened.lanePath(branchSessionId)).map((entry) => entry.id),
      [ids[0], ids[3]]
    );
    assert.deepEqual(
      (await reopened.lanePath(TREE_MAIN_LANE)).map((entry) => entry.id),
      [ids[0], ids[1], ids[2]]
    );
    assert.equal(await reopened.hasLane(branchSessionId), true);
    await reopened.remove();
    assert.equal(
      readdirSync(join(root, ".pigeon", "trees"), { recursive: true }).filter((name) =>
        String(name).endsWith(".jsonl")
      ).length,
      0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
