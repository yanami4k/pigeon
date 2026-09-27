// 新会话存储的写者（决策 176–181 / 184 / 210）：照 pi 原生布局建文件、以 Pigeon 会话号创建、完整存消息、
// 只写 custom 条目；写失败不抛（按内部故障交给 onFault），跨进程按会话文件加单写者锁。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createSessionBackendConformance } from "@earendil-works/pi-agent-core/session/testing";
import {
  acquireSessionFileLock,
  EventLogLockedError,
  sessionFileLockPath,
} from "../persistence/session-lock.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
  sessionDirectoryName,
} from "../persistence/session-reader.ts";
import { asRunId, asSessionId } from "../state/ids.ts";
import { type SessionCustomEntry, SessionEntryType } from "../state/session-entries.ts";
import type { AgentMessage } from "./index.ts";
import {
  createSessionRepo,
  forkSessionFile,
  openSessionStoreWriter,
  type SessionStoreWriterOptions,
  stripUndefined,
} from "./session-store.ts";

const RUN = asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS");

function tempRoot(): { root: string; sessions: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-store-"));
  return {
    root,
    sessions: join(root, ".pigeon", "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function runEnd(messageCount: number): SessionCustomEntry {
  return {
    customType: SessionEntryType.RunEnd,
    data: { version: 1, runId: RUN, ending: "completed", messageCount, endedAt: 2 },
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

test("写者：照 pi 原生布局以 Pigeon 会话号建文件，文件头带父会话与 metadata，消息与自定义条目按序落盘", async () => {
  const { root, sessions, cleanup } = tempRoot();
  try {
    const writer = openSessionStoreWriter(
      options(sessions, "sess_A", {
        parentSessionId: "sess_P",
        metadata: {
          version: 1,
          worker: {
            name: "w1",
            role: "implementer",
            workspace: { kind: "none" },
            startedAt: 5,
          },
        },
      })
    );
    writer.appendMessage(userMessage("你好"));
    writer.append(runEnd(1));
    await writer.close();
    const located = locateSessionFile(sessions, "sess_A");
    assert.ok(located !== undefined);
    assert.equal(dirname(located.path), join(sessions, sessionDirectoryName(root)));
    const view = readSessionFile(located.path);
    assert.ok(view !== undefined);
    assert.equal(view.header.parentSessionId, "sess_P");
    assert.deepEqual(view.header.metadata, {
      pigeon: {
        version: 1,
        worker: { name: "w1", role: "implementer", workspace: { kind: "none" }, startedAt: 5 },
      },
    });
    assert.deepEqual(
      view.entries.map((entry) => entry.type),
      ["message", "custom"]
    );
    assert.deepEqual(view.entries[0]?.message, userMessage("你好"));
    assert.equal(view.entries[1]?.customType, SessionEntryType.RunEnd);
    assert.equal(existsSync(sessionFileLockPath(located.path)), false, "关闭即释放锁");
    // pi 自己的打开照样能读（格式与语义一致）
    const reopened = await createSessionRepo(sessions).open({
      id: "sess_A",
      path: located.path,
    } as never);
    assert.equal((await reopened.findEntries({ type: "message" })).length, 1);
  } finally {
    cleanup();
  }
});

test("写者：消息完整存储、不截断；值为 undefined 的键在写入前剥掉（上游序列化会拒绝）", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const big = "x".repeat(200 * 1024);
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想", thinkingSignature: undefined },
        { type: "text", text: big },
      ],
      api: "anthropic-messages",
      provider: "p",
      model: "m",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      stopReason: "stop",
      errorMessage: undefined,
      timestamp: 3,
    } as unknown as AgentMessage;
    const faults: unknown[] = [];
    const writer = openSessionStoreWriter(
      options(sessions, "sess_B", { onFault: (error) => faults.push(error) })
    );
    writer.appendMessage(message);
    await writer.close();
    assert.deepEqual(faults, []);
    const view = readSessionFile(locateSessionFile(sessions, "sess_B")?.path ?? "");
    const stored = view?.entries[0]?.message as Record<string, unknown>;
    assert.equal(
      ((stored.content as Array<{ text?: string }>)[1]?.text ?? "").length,
      200 * 1024,
      "不截断"
    );
    assert.equal("errorMessage" in stored, false);
    assert.deepEqual(stored.content, [
      { type: "thinking", thinking: "想" },
      { type: "text", text: big },
    ]);
  } finally {
    cleanup();
  }
});

test("剥 undefined：只去掉对象里值为 undefined 的键，数组里的 undefined 按 JSON 语义记为 null，原对象不动", () => {
  const input = { a: 1, b: undefined, c: [undefined, { d: undefined, e: "x" }], f: null };
  assert.deepEqual(stripUndefined(input), { a: 1, c: [null, { e: "x" }], f: null });
  assert.equal("b" in input, true);
});

test("写者：已有会话文件时打开续写，seq 接着原文件", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const first = openSessionStoreWriter(options(sessions, "sess_C"));
    first.appendMessage(userMessage("一"));
    await first.close();
    const path = locateSessionFile(sessions, "sess_C")?.path;
    assert.ok(path !== undefined);
    const second = openSessionStoreWriter(options(sessions, "sess_C", { existingPath: path }));
    second.appendMessage(userMessage("二"));
    await second.close();
    const view = readSessionFile(path);
    assert.deepEqual(
      view?.entries.map((entry) => entry.seq),
      [1, 2]
    );
    assert.deepEqual(view?.warnings, []);
  } finally {
    cleanup();
  }
});

test("写者：一条写不进（非 JSON 数据）只报一次故障、不抛，后续条目照写", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const faults: unknown[] = [];
    const writer = openSessionStoreWriter(
      options(sessions, "sess_D", { onFault: (error) => faults.push(error) })
    );
    writer.appendMessage(userMessage("前"));
    writer.append({
      customType: SessionEntryType.RunEnd,
      data: { version: 1, runId: RUN, ending: "completed", messageCount: 1n as never, endedAt: 1 },
    });
    writer.appendMessage(userMessage("后"));
    await writer.close();
    assert.equal(faults.length, 1);
    assert.match(String((faults[0] as Error).message), /写入 pigeon\.run-end 条目失败/);
    const view = readSessionFile(locateSessionFile(sessions, "sess_D")?.path ?? "");
    assert.deepEqual(
      view?.entries.map((entry) => entry.type),
      ["message", "message"]
    );
  } finally {
    cleanup();
  }
});

// 子进程对同一个会话文件取锁并常驻
async function spawnLockHolder(filePath: string) {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "../persistence/session-lock.ts")).href;
  const script =
    `const { acquireSessionFileLock } = await import(${JSON.stringify(moduleUrl)});` +
    `acquireSessionFileLock(${JSON.stringify(filePath)});` +
    `process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<void>();
  child.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("ready")) ready.resolve();
  });
  child.on("exit", (code) => ready.reject(new Error(`持锁进程提前退出（${code}）`)));
  await ready.promise;
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return { child, exited };
}

test("写者：会话文件被另一个存活进程持锁时不打开、不写，报加锁故障且不抛；持锁进程退出后可以接管", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const first = openSessionStoreWriter(options(sessions, "sess_E"));
    first.appendMessage(userMessage("一"));
    await first.close();
    const path = locateSessionFile(sessions, "sess_E")?.path ?? "";
    const before = readFileSync(path, "utf8");
    const { child, exited } = await spawnLockHolder(path);
    try {
      assert.throws(() => acquireSessionFileLock(path), EventLogLockedError);
      const faults: unknown[] = [];
      const blocked = openSessionStoreWriter(
        options(sessions, "sess_E", { existingPath: path, onFault: (error) => faults.push(error) })
      );
      blocked.appendMessage(userMessage("二"));
      await blocked.close();
      assert.equal(faults.length, 1);
      assert.match(String((faults[0] as Error).message), /打开失败.*另一个进程/);
      assert.equal(readFileSync(path, "utf8"), before, "未取得锁即一个字节都不写");
    } finally {
      child.kill();
      await exited;
    }
    const after = openSessionStoreWriter(options(sessions, "sess_E", { existingPath: path }));
    after.appendMessage(userMessage("三"));
    await after.close();
    assert.equal(readSessionFile(path)?.entries.length, 2);
  } finally {
    cleanup();
  }
});

test("写者：同进程对同一会话再开写者时共用同一个 pi 会话实例，最后一个关闭才释放锁", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const first = openSessionStoreWriter(options(sessions, "sess_F"));
    const second = openSessionStoreWriter(options(sessions, "sess_F"));
    first.appendMessage(userMessage("一"));
    second.appendMessage(userMessage("二"));
    await first.close();
    const path = (await second.filePath()) ?? "";
    assert.ok(existsSync(sessionFileLockPath(path)), "仍有写者打开，锁保留");
    second.appendMessage(userMessage("三"));
    await second.close();
    assert.equal(existsSync(sessionFileLockPath(path)), false);
    const view = readSessionFile(path);
    assert.deepEqual(
      view?.entries.map((entry) => entry.seq),
      [1, 2, 3]
    );
  } finally {
    cleanup();
  }
});

test("分叉：用 pi 的 fork 把分叉点（含）之前的历史复制进新文件，新文件头记来源会话与分支来历", async () => {
  const { root, sessions, cleanup } = tempRoot();
  try {
    const writer = openSessionStoreWriter(options(sessions, "sess_G"));
    writer.appendMessage(userMessage("一"));
    writer.appendMessage(userMessage("二"));
    writer.appendMessage(userMessage("三"));
    await writer.close();
    const source = locateSessionFile(sessions, "sess_G");
    assert.ok(source !== undefined);
    const sourceView = readSessionFile(source.path);
    const target = sourceView?.entries[1]?.id ?? "";
    const worktree = join(root, "wt");
    const path = await forkSessionFile({
      sessionsRoot: sessions,
      source: { sessionId: "sess_G", path: source.path },
      entryId: target,
      branchSessionId: "sess_H",
      cwd: worktree,
      metadata: {
        version: 1,
        branch: {
          sourceSessionId: asSessionId("sess_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
          forkPoint: { runId: RUN, runSeq: 2 },
          checkpoint: { ref: "refs/x", commit: "a".repeat(40) },
          workspace: { kind: "git-worktree", path: worktree, branch: "b" },
          trigger: "manual",
          startedAt: 9,
        },
      },
    });
    assert.equal(locateSessionFile(sessions, "sess_H")?.path, path);
    assert.equal(dirname(path), join(sessions, sessionDirectoryName(worktree)));
    const view = readSessionFile(path);
    assert.ok(view !== undefined);
    assert.equal(view.header.parentSessionId, "sess_G");
    assert.equal(
      (view.header.metadata?.pigeon as { branch?: { trigger?: string } } | undefined)?.branch
        ?.trigger,
      "manual"
    );
    assert.deepEqual(
      branchEntries(view, view.lanes.get("main") ?? null).map((entry) => entry.id),
      sourceView?.entries.slice(0, 2).map((entry) => entry.id)
    );
    // 分支文件接着由自己的写者打开续写
    const branch = openSessionStoreWriter(options(sessions, "sess_H", { existingPath: path }));
    branch.appendMessage(userMessage("分支"));
    await branch.close();
    assert.equal(readSessionFile(path)?.entries.length, 3);
  } finally {
    cleanup();
  }
});

test("长路径：工作目录很深、会话文件全路径超过 260 个字符时，建文件、续写、锁、定位与读取都正常", async () => {
  const { root, sessions, cleanup } = tempRoot();
  try {
    let cwd = root;
    while (cwd.length < 200) {
      cwd = join(cwd, "deeply-nested-directory-segment");
    }
    mkdirSync(cwd, { recursive: true });
    const writer = openSessionStoreWriter({
      ...options(sessions, "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS"),
      cwd,
    });
    writer.appendMessage(userMessage("深"));
    const path = (await writer.filePath()) ?? "";
    assert.ok(path.length > 260, `全路径 ${path.length} 个字符`);
    assert.ok(existsSync(sessionFileLockPath(path)));
    await writer.close();
    const again = openSessionStoreWriter({
      ...options(sessions, "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS", { existingPath: path }),
      cwd,
    });
    again.appendMessage(userMessage("续"));
    await again.close();
    assert.equal(locateSessionFile(sessions, "sess_01J5Z7K8W9ABCDEFGHJKMNPQRS")?.path, path);
    assert.equal(readSessionFile(path)?.entries.length, 2);
  } finally {
    cleanup();
  }
});

// pi 的契约测试套件接新存储的仓库（与写者同一套配置；用例 create 不带 cwd，补上每例独立的临时根）
const cases = createSessionBackendConformance(async () => {
  const { root, sessions, cleanup } = tempRoot();
  const inner = createSessionRepo(sessions);
  const repository = {
    create: (options: Parameters<typeof inner.create>[0] | { id?: string }) =>
      inner.create({ cwd: root, ...options }),
    open: (metadata: Parameters<typeof inner.open>[0]) => inner.open(metadata),
    list: () => inner.list(),
    delete: (metadata: Parameters<typeof inner.delete>[0]) => inner.delete(metadata),
    fork: (source: Parameters<typeof inner.fork>[0], options: object) =>
      inner.fork(source, { cwd: root, ...options } as Parameters<typeof inner.fork>[1]),
  };
  return { repository: repository as never, [Symbol.asyncDispose]: async () => cleanup() };
});
const groups = new Map<string, typeof cases>();
for (const entry of cases) {
  groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
}
for (const [group, entries] of groups) {
  describe(`新会话存储契约（core 0.84.4 v4 JSONL）：${group}`, () => {
    for (const entry of entries) {
      it(entry.name, () => entry.run());
    }
  });
}
