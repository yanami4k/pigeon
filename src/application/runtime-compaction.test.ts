// 上下文压缩的装配（决策 188、203、218、192、207）：Pigeon 的运行面缺省开启压缩（产品缺省：1M 窗口减预留），
// 阈值与保留量可配置并写进 Run 开始条目；摘要请求经主请求同一个模型接入（跑批时即同一网关、同一计量与花费上限），
// 关思考、温度同主请求的设置、输出上限按上游规则；压缩前回调经装配根接上。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import type { BeforeCompactionInfo } from "../pi-runtime/compaction.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { type RunStartData, SessionEntryType } from "../state/session-entries.ts";
import { runHeadless } from "./headless.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

const SUMMARY_PROMPT_HEAD = "You are a context summarization assistant.";

function runStarts(sessions: string, sessionId: string): RunStartData[] {
  const located = locateSessionFile(sessions, sessionId);
  assert.ok(located !== undefined);
  const loaded = loadStoreSessionFile(located.path);
  assert.ok(loaded !== undefined);
  return (loaded.main as unknown as Array<{ type: string; customType?: string; data?: unknown }>)
    .filter((entry) => entry.type === "custom" && entry.customType === SessionEntryType.RunStart)
    .map((entry) => entry.data as RunStartData);
}

test("缺省开启：Run 开始条目记下产品缺省的压缩配置（1M 窗口、预留 16384、保留 20000、触发点 983616）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-default-"));
  try {
    const result = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
    });
    const [start] = runStarts(join(root, ".pigeon", "state", "sessions"), result.sessionId);
    assert.deepEqual(start?.compaction, {
      contextWindow: 1_000_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      thresholdTokens: 983_616,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("调低触发点：一次 Run 内轮间压缩；摘要请求经同一个模型接入发出，温度同主请求（0）、不请求推理、输出上限取 0.8 倍预留", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-headless-"));
  try {
    writeFileSync(join(root, "a.txt"), "内容\n");
    const fake = createFakeStreamFn({
      replies: [
        {
          // 足够长：保留量 20 落在这条助手消息上（工具结果本身比保留量短），长任务那条进待摘要段
          text: "我先读一下文件。".repeat(20),
          toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
          contextTokens: 5000,
        },
        { text: "## Goal\n读文件" },
        { text: "读完了", contextTokens: 300 },
      ],
    });
    const seen: Array<{ system: string; options: unknown }> = [];
    const streamFn: StreamFn = (model, context, options) => {
      seen.push({ system: context.systemPrompt ?? "", options });
      return fake(model, context, options);
    };
    const result = await runHeadless({
      task: `请读 a.txt。${"背景说明。".repeat(60)}`,
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      temperature: 0,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
    });
    assert.equal(result.status, "completed");
    const summaries = seen.filter((call) => call.system.startsWith(SUMMARY_PROMPT_HEAD));
    assert.ok(summaries.length >= 1, "摘要请求应经同一个模型接入发出");
    for (const call of summaries) {
      const options = call.options as {
        temperature?: number;
        reasoning?: unknown;
        maxTokens?: number;
      };
      assert.equal(options.temperature, 0);
      assert.equal(options.reasoning, undefined);
      assert.ok(options.maxTokens !== undefined && options.maxTokens <= Math.floor(0.8 * 16_384));
    }
    const [start] = runStarts(join(root, ".pigeon", "state", "sessions"), result.sessionId);
    assert.deepEqual(start?.compaction, {
      contextWindow: 1_000_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20,
      thresholdTokens: 1000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("主请求开思考时摘要请求仍关思考：摘要不请求推理", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-thinking-"));
  try {
    const fake = createFakeStreamFn({
      replies: [
        { text: "第一问的回答，内容比较长。".repeat(4), contextTokens: 5000 },
        { text: "## Goal\n第一问" },
        { text: "第二问的回答", contextTokens: 300 },
      ],
    });
    const seen: Array<{ system: string; reasoning: unknown }> = [];
    const streamFn: StreamFn = (model, context, options) => {
      seen.push({ system: context.systemPrompt ?? "", reasoning: options?.reasoning });
      return fake(model, context, options);
    };
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      thinkingLevel: "high",
      compaction: { thresholdTokens: 1000, keepRecentTokens: 5 },
    });
    try {
      await bundle.adapter.run(`第一问。${"背景说明。".repeat(60)}`);
      await bundle.adapter.run("第二问");
      const summary = seen.find((call) => call.system.startsWith(SUMMARY_PROMPT_HEAD));
      assert.ok(summary !== undefined);
      assert.equal(summary.reasoning, undefined);
      const main = seen.filter((call) => !call.system.startsWith(SUMMARY_PROMPT_HEAD));
      assert.ok(main.every((call) => call.reasoning === "high"));
    } finally {
      await disposeRuntime(bundle);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("压缩前回调经装配根接上：压缩真正执行之前被调用", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-hook-"));
  try {
    const before: BeforeCompactionInfo[] = [];
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          { text: "第一问的回答，内容比较长。".repeat(4), contextTokens: 5000 },
          { text: "## Goal\n第一问" },
          { text: "第二问的回答", contextTokens: 300 },
        ],
      }),
      workspaceRoot: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 5 },
      beforeCompaction: (info) => {
        before.push(info);
      },
    });
    try {
      await bundle.adapter.run(`第一问。${"背景说明。".repeat(60)}`);
      await bundle.adapter.run("第二问");
      assert.deepEqual(
        before.map((info) => info.trigger),
        ["run-start"]
      );
    } finally {
      await disposeRuntime(bundle);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readFileTurns(): StreamFn {
  const fake = createFakeStreamFn({
    replies: [
      {
        text: "我先读一下文件。".repeat(20),
        toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
        contextTokens: 5000,
      },
      {
        text: "再读一遍。".repeat(30),
        toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
        contextTokens: 6000,
      },
      { text: "读完了", contextTokens: 300 },
    ],
  });
  // 摘要请求一律被拒（如撞上花费上限），主请求照常
  return (model, context, options) =>
    context.systemPrompt?.startsWith(SUMMARY_PROMPT_HEAD) === true
      ? Promise.reject(new Error("网关拒绝：花费上限"))
      : fake(model, context, options);
}

test("无头运行：自动压缩没压成时向标准错误输出告警，同一类只说一次，文案说明本轮按原上下文继续", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-warn-"));
  try {
    writeFileSync(join(root, "a.txt"), "内容\n");
    const lines: string[] = [];
    const result = await runHeadless({
      task: `请读 a.txt。${"背景说明。".repeat(60)}`,
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: readFileTurns(),
      yolo: true,
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
      warn: (line) => lines.push(line),
    });
    assert.equal(result.status, "completed");
    const incomplete = lines.filter((line) => line.startsWith("上下文压缩未完成"));
    assert.deepEqual(incomplete, [
      "上下文压缩未完成（自动，轮间）：网关拒绝：花费上限；本轮按原上下文继续",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("无头运行：压缩前回调失败时向标准错误输出告警，文案说明压缩照常进行", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compaction-hook-warn-"));
  try {
    writeFileSync(join(root, "a.txt"), "内容\n");
    const lines: string[] = [];
    await runHeadless({
      task: `请读 a.txt。${"背景说明。".repeat(60)}`,
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "我先读一下文件。".repeat(20),
            toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
            contextTokens: 5000,
          },
          { text: "## Goal\n读文件" },
          { text: "读完了", contextTokens: 300 },
        ],
      }),
      yolo: true,
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      compaction: { thresholdTokens: 1000, keepRecentTokens: 20 },
      beforeCompaction: () => {
        throw new Error("复盘失败：记忆文件被锁");
      },
      warn: (line) => lines.push(line),
    });
    assert.deepEqual(
      lines.filter((line) => line.startsWith("压缩前回调失败")),
      ["压缩前回调失败：复盘失败：记忆文件被锁；压缩照常进行"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
