// 上下文裁剪的装配（决策 361）：运行面缺省挂上裁剪——请求里旧的工具结果换成占位并写一条裁剪记录，从会话文件取回的
// 记录重放出同样的内容；压缩之前先裁，降到触发点以下即不再摘要；状态栏的用量按实际发出的上下文估算。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { type CompactionConfigInput, contextTokens } from "../pi-runtime/compaction.ts";
import { ContextPruner, pruneSeedFromEntries } from "../pi-runtime/context-prune.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import type { ContextPruneSection } from "../state/prune-config.ts";
import { contextPruneSettings } from "../state/prune-config.ts";
import { type PruneData, SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";
import type { RuntimeBundle } from "./runtime.ts";

// 读一个大文件（约 2000 token）、再读一个小文件（这时的用量报 6000）、收尾（last 缺省正常回复）
async function run(
  root: string,
  contextPrune: ContextPruneSection,
  options: { compaction?: CompactionConfigInput; last?: FakeReply } = {}
) {
  writeFileSync(join(root, "big.txt"), "大文件的一行内容。\n".repeat(600));
  writeFileSync(join(root, "small.txt"), "小\n");
  const fake = createFakeStreamFn({
    replies: [
      { text: "读大文件", toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] },
      {
        text: "读小文件",
        toolCalls: [{ name: "read_file", args: { path: "small.txt" } }],
        contextTokens: 6000,
      },
      options.last ?? { text: "完", contextTokens: 100 },
    ],
  });
  let bundle: RuntimeBundle | undefined;
  const empty = emptySettingsSnapshot(root);
  const result = await runHeadless({
    task: "读文件",
    governanceRoot: root,
    workspaceRoot: root,
    streamFn: fake,
    yolo: true,
    homeDir: root,
    skillRoots: [],
    agentsMd: false,
    settings: { ...empty, merged: { ...empty.merged, contextPrune } },
    ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    onBundle: (opened) => {
      bundle = opened;
    },
  });
  const located = locateSessionFile(join(root, ".pigeon", "state", "sessions"), result.sessionId);
  const loaded = located !== undefined ? loadStoreSessionFile(located.path) : undefined;
  assert.ok(loaded !== undefined);
  const prunes = (loaded.main as unknown as Array<{ customType?: string; data?: PruneData }>)
    .filter((entry) => entry.customType === SessionEntryType.Prune)
    .map((entry) => entry.data as PruneData);
  assert.ok(bundle !== undefined);
  return { fake, main: loaded.main, prunes, status: result.status, adapter: bundle.adapter };
}

function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-prune-wiring-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("请求里旧的读取换成占位并留记录；从会话文件取回的记录重放出同样的内容", () =>
  withRoot(async (root) => {
    const { fake, main, prunes, status } = await run(root, {
      protectTurns: 1,
      priceRatio: 1,
      minBatchTokens: 0,
    });
    assert.equal(status, "completed");
    assert.deepEqual(
      prunes.map((record) => record.trigger),
      ["paid"]
    );
    const toolCallId = prunes[0]?.items[0]?.toolCallId;
    const sent = fake.calls[2]?.context.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === toolCallId
    );
    assert.equal(
      JSON.stringify(sent?.role === "toolResult" ? sent.content : undefined),
      JSON.stringify([{ type: "text", text: prunes[0]?.items[0]?.placeholder }])
    );
    // 续跑：会话文件还原的消息照记录重放
    const replay = new ContextPruner(
      contextPruneSettings({ enabled: false }, undefined),
      {},
      pruneSeedFromEntries(main)
    ).view(restoreSessionContext(main).messages);
    const replayed = replay.find(
      (message) => message.role === "toolResult" && message.toolCallId === toolCallId
    );
    assert.deepEqual(
      replayed?.role === "toolResult" ? replayed.content : undefined,
      sent?.role === "toolResult" ? sent.content : undefined
    );
  }));

test("压缩之前先裁：裁掉之后降到触发点以下即不再摘要", () =>
  withRoot(async (root) => {
    const { fake, prunes } = await run(
      root,
      { protectTurns: 1 },
      { compaction: { thresholdTokens: 5000 } }
    );
    assert.deepEqual(
      prunes.map((record) => record.trigger),
      ["compaction"]
    );
    // 三次请求都是主请求，没有摘要请求
    assert.equal(fake.calls.length, 3);
  }));

test("状态栏的用量按实际发出的上下文估算：裁剪之后的那次请求出错、没有新的 usage 时，裁掉的量也已减去", () =>
  withRoot(async (root) => {
    const { prunes, adapter } = await run(
      root,
      { protectTurns: 1, priceRatio: 1, minBatchTokens: 0 },
      { last: { text: "", streamError: "连接中断" } }
    );
    const pruned = prunes[0]?.prunedTokens ?? 0;
    assert.ok(pruned > 0);
    // 估算所用的仍是第二次回复的 usage（裁剪之前发出的上下文），裁掉的量要从中减去
    assert.equal(adapter.contextUsage()?.tokens, contextTokens(adapter.transcript()) - pruned);
  }));

test("新裁出错时只应用已有的裁剪：之前的占位不撤，那次请求的前缀不变", () =>
  withRoot(async (root) => {
    writeFileSync(join(root, "big.txt"), "大文件的一行内容。\n".repeat(600));
    writeFileSync(join(root, "small.txt"), "小\n");
    const read = (path: string) => ({
      text: `读 ${path}`,
      toolCalls: [{ name: "read_file", args: { path } }],
    });
    const fake = createFakeStreamFn({
      replies: [read("big.txt"), read("small.txt"), read("small.txt"), { text: "完" }],
    });
    const empty = emptySettingsSnapshot(root);
    const contextPrune = { protectTurns: 1, priceRatio: 1, minBatchTokens: 0 };
    let calls = 0;
    const result = await runHeadless({
      task: "读文件",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: fake,
      yolo: true,
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      settings: { ...empty, merged: { ...empty.merged, contextPrune } },
      // 第四次请求之前的新裁出错
      onBundle: (bundle) => {
        const original = bundle.prune.beforeRequest.bind(bundle.prune);
        bundle.prune.beforeRequest = (messages, write) => {
          calls += 1;
          if (calls === 4) throw new Error("模拟出错");
          return original(messages, write);
        };
      },
    });
    assert.equal(result.status, "completed");
    const prefix = (call: number) => JSON.stringify(fake.calls[call]?.context.messages.slice(0, 4));
    assert.match(prefix(2), /\[已裁剪\]/);
    assert.equal(prefix(3), prefix(2));
  }));
