// 上下文裁剪的装配（决策 361）：运行面缺省挂上裁剪——请求里旧的工具结果换成占位并写一条裁剪记录，从会话文件取回的
// 记录重放出同样的内容；压缩之前先裁，降到触发点以下即不再摘要。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import type { CompactionConfigInput } from "../pi-runtime/compaction.ts";
import { ContextPruner, pruneSeedFromEntries } from "../pi-runtime/context-prune.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { restoreSessionContext } from "../pi-runtime/session-store.ts";
import type { ContextPruneSection } from "../state/prune-config.ts";
import { contextPruneSettings } from "../state/prune-config.ts";
import { type PruneData, SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";

// 读一个大文件（约 2000 token）、再读一个小文件（这时的用量报 6000）、收尾
async function run(
  root: string,
  contextPrune: ContextPruneSection,
  compaction?: CompactionConfigInput
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
      { text: "完", contextTokens: 100 },
    ],
  });
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
    ...(compaction !== undefined ? { compaction } : {}),
  });
  assert.equal(result.status, "completed");
  const located = locateSessionFile(join(root, ".pigeon", "state", "sessions"), result.sessionId);
  const loaded = located !== undefined ? loadStoreSessionFile(located.path) : undefined;
  assert.ok(loaded !== undefined);
  const prunes = (loaded.main as unknown as Array<{ customType?: string; data?: PruneData }>)
    .filter((entry) => entry.customType === SessionEntryType.Prune)
    .map((entry) => entry.data as PruneData);
  return { fake, main: loaded.main, prunes };
}

function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-prune-wiring-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("请求里旧的读取换成占位并留记录；从会话文件取回的记录重放出同样的内容", () =>
  withRoot(async (root) => {
    const { fake, main, prunes } = await run(root, {
      protectTurns: 1,
      priceRatio: 1,
      minBatchTokens: 0,
    });
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
    const { fake, prunes } = await run(root, { protectTurns: 1 }, { thresholdTokens: 5000 });
    assert.deepEqual(
      prunes.map((record) => record.trigger),
      ["compaction"]
    );
    // 三次请求都是主请求，没有摘要请求
    assert.equal(fake.calls.length, 3);
  }));
