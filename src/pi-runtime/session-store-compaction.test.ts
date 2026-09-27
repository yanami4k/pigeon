// 上下文压缩在新会话存储上的读写（决策 188、179）：写者读主分支（排在此前的写入之后）、写压缩条目（原始消息保留），
// 续跑按 pi 的 buildSessionContext 从最后一个压缩条目往后接。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { CompactResult } from "@earendil-works/pi-agent-core";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { asRunId, newSessionId } from "../state/ids.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import type { AgentMessage } from "./index.ts";
import {
  openSessionStoreWriter,
  restoreSessionContext,
  type SessionStoreFault,
  type SessionStoreWriterOptions,
} from "./session-store.ts";

const RUN = asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS");

// 会话文件的主分支（从根到叶），与续跑同一条读法
function mainBranch(
  sessions: string,
  sessionId: string
): Array<{ type: string } & Record<string, unknown>> {
  const located = locateSessionFile(sessions, sessionId);
  assert.ok(located !== undefined);
  const loaded = loadStoreSessionFile(located.path);
  assert.ok(loaded !== undefined);
  return loaded.main as unknown as Array<{ type: string } & Record<string, unknown>>;
}

function tempRoot(): { sessions: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-store-compaction-"));
  return {
    sessions: join(root, ".pigeon", "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function options(
  sessions: string,
  sessionId: string,
  extra: Partial<SessionStoreWriterOptions> = {}
): SessionStoreWriterOptions {
  return {
    sessionsRoot: sessions,
    sessionId,
    cwd: dirname(dirname(sessions)),
    lock: acquireSessionFileLock,
    ...extra,
  };
}

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistant(text: string, timestamp: number, thinking?: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      ...(thinking !== undefined ? [{ type: "thinking", thinking }] : []),
      { type: "text", text },
    ],
    api: "anthropic-messages",
    provider: "fake",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

function compactResult(retainedTail: AgentMessage[]): CompactResult {
  return {
    summary: "## Goal\n摘要正文",
    tokensBefore: 1234,
    retainedTail,
    details: { readFiles: ["a.ts"], modifiedFiles: [] },
  };
}

test("写者读主分支：排在此前的写入之后，从根到叶，消息与自定义条目都在", async () => {
  const { sessions, cleanup } = tempRoot();
  const branchSessionId = newSessionId();
  try {
    const writer = openSessionStoreWriter(options(sessions, branchSessionId));
    writer.append({
      customType: SessionEntryType.RunEnd,
      data: { version: 1, runId: RUN, ending: "completed", messageCount: 0, endedAt: 1 },
    });
    writer.appendMessage(user("第一问", 1));
    writer.appendMessage(assistant("第一答", 2));
    // 不先 flush：读分支本身排在队尾
    const branch = await writer.branch();
    assert.ok(branch !== undefined);
    assert.deepEqual(
      branch.map((entry) =>
        entry.type === "message" ? `message:${entry.message.role}` : entry.type
      ),
      ["custom", "message:user", "message:assistant"]
    );
    await writer.close();
  } finally {
    cleanup();
  }
});

test("写者写压缩条目：排在此前的写入之后落盘，原始消息保留，返回写入后的主分支；续跑从压缩条目往后接", async () => {
  const { sessions, cleanup } = tempRoot();
  const compactSessionId = newSessionId();
  try {
    const writer = openSessionStoreWriter(options(sessions, compactSessionId));
    writer.appendMessage(user("早先的问题", 1));
    writer.appendMessage(assistant("早先的回答", 2));
    writer.appendMessage(user("最近的问题", 3));
    const after = await writer.appendCompaction(compactResult([user("最近的问题", 3)]));
    assert.ok(after !== undefined);
    const last = after.at(-1);
    assert.equal(last?.type, "compaction");
    writer.appendMessage(assistant("压缩后的回答", 5));
    await writer.close();

    const main = mainBranch(sessions, compactSessionId);
    // 原始消息一条不少（179），压缩条目夹在中间
    assert.deepEqual(
      main.map((entry) =>
        entry.type === "message"
          ? `message:${(entry as unknown as { message: AgentMessage }).message.role}`
          : entry.type
      ),
      ["message:user", "message:assistant", "message:user", "compaction", "message:assistant"]
    );
    const compaction = main[3] as unknown as Record<string, unknown>;
    assert.equal(compaction.summary, "## Goal\n摘要正文");
    assert.equal(compaction.tokensBefore, 1234);
    assert.deepEqual(compaction.details, { readFiles: ["a.ts"], modifiedFiles: [] });
    assert.equal((compaction.retainedTail as unknown[]).length, 1);

    // 续跑（183）：pi 的 buildSessionContext 从最后一个压缩条目往后接——摘要、保留段、压缩后的消息
    const { messages, interrupted } = restoreSessionContext(main);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["compactionSummary", "user", "assistant"]
    );
    assert.equal(interrupted.length, 0);
  } finally {
    cleanup();
  }
});

test("写者写压缩条目：思考不持久化时，保留段里助手消息的思考块同样剥去", async () => {
  const { sessions, cleanup } = tempRoot();
  const noThinkSessionId = newSessionId();
  try {
    const writer = openSessionStoreWriter(
      options(sessions, noThinkSessionId, { persistThinking: false })
    );
    writer.appendMessage(user("问题", 1));
    const after = await writer.appendCompaction(
      compactResult([assistant("回答", 2, "不该落盘的思考")])
    );
    await writer.close();
    assert.ok(after !== undefined);
    const text = JSON.stringify(mainBranch(sessions, noThinkSessionId));
    assert.equal(text.includes("不该落盘的思考"), false);
  } finally {
    cleanup();
  }
});

test("写者没能打开会话文件：读分支与写压缩条目都返回 undefined，故障交给 onFault，不抛", async () => {
  const { sessions, cleanup } = tempRoot();
  const brokenSessionId = newSessionId();
  try {
    mkdirSync(sessions, { recursive: true });
    const bogus = join(sessions, "not-a-session.jsonl");
    writeFileSync(bogus, "这不是 jsonl\n");
    const faults: SessionStoreFault[] = [];
    const writer = openSessionStoreWriter(
      options(sessions, brokenSessionId, {
        existingPath: bogus,
        onFault: (fault) => faults.push(fault),
      })
    );
    assert.equal(await writer.branch(), undefined);
    assert.equal(await writer.appendCompaction(compactResult([])), undefined);
    await writer.close();
    assert.ok(faults.length >= 1);
  } finally {
    cleanup();
  }
});
