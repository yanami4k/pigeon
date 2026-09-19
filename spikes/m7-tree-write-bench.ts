// M7 S6 写穿耗时基准（决策 077）：量两件事——
//   1. 会话树追加的单条延迟（上游 JsonlSessionRepo，异步写、不 fsync）；
//   2. 同一段假模型会话（每轮一次读工具调用）开写穿与不开写穿的主循环耗时（Run 墙钟），以及写穿队列排空的额外等待。
// 用法：node spikes/m7-tree-write-bench.ts [轮数=200] [重复=5]
// 只量本机数量级，不作性能承诺；数字记入审计。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSession } from "../src/application/mcp.ts";
import { disposeRuntime } from "../src/application/runtime.ts";
import { openSessionRuntime } from "../src/application/session-runtime.ts";
import { attachTreeWriteThrough } from "../src/application/session-tree.ts";
import { createFakeStreamFn } from "../src/pi-runtime/fixtures.ts";
import { openSessionTree, TREE_MAIN_LANE } from "../src/pi-runtime/session-tree.ts";
import { newEntryId, newSessionId } from "../src/state/ids.ts";

const turns = Number(process.argv[2] ?? 200);
const repeats = Number(process.argv[3] ?? 5);

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return `mean ${mean.toFixed(3)} ms ｜ p50 ${pick(0.5).toFixed(3)} ｜ p95 ${pick(0.95).toFixed(3)} ｜ max ${pick(1).toFixed(3)}`;
}

async function appendLatency(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tree-bench-"));
  try {
    const tree = await openSessionTree({ governanceRoot: root, rootSessionId: newSessionId() });
    const samples: number[] = [];
    const text = "x".repeat(2000);
    for (let index = 0; index < 1000; index++) {
      const started = performance.now();
      await tree.append(TREE_MAIN_LANE, [
        {
          id: newEntryId(),
          message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
        },
      ]);
      samples.push(performance.now() - started);
    }
    console.log(`单条追加（2,000 字符正文，1,000 条）：${stats(samples)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runOnce(withTree: boolean): Promise<{ runMs: number; drainMs: number }> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tree-bench-run-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-tree-bench-home-"));
  try {
    writeFileSync(join(root, "a.txt"), "hello\n");
    const replies = [
      ...Array.from({ length: turns }, () => ({
        text: "读",
        toolCalls: [{ name: "read_file", args: { path: "a.txt" } }],
      })),
      { text: "完成" },
    ];
    const sessionId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: createFakeStreamFn({ replies }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
      review: { enabled: false, everyTurns: 0 },
    });
    try {
      const writer = withTree
        ? attachTreeWriteThrough({
            bundle: opened.bundle,
            tree: await openSessionTree({ governanceRoot: root, rootSessionId: sessionId }),
            lane: TREE_MAIN_LANE,
          })
        : undefined;
      const started = performance.now();
      await opened.bundle.adapter.run("一直读");
      const runMs = performance.now() - started;
      const drainStarted = performance.now();
      await writer?.idle();
      const drainMs = performance.now() - drainStarted;
      writer?.stop();
      return { runMs, drainMs };
    } finally {
      await disposeRuntime(opened.bundle);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function runOverhead(): Promise<void> {
  const off: number[] = [];
  const on: number[] = [];
  const drain: number[] = [];
  // 预热一次，不计
  await runOnce(false);
  for (let index = 0; index < repeats; index++) {
    off.push((await runOnce(false)).runMs);
    const result = await runOnce(true);
    on.push(result.runMs);
    drain.push(result.drainMs);
  }
  const messages = turns * 2 + 2;
  console.log(`主循环（${turns} 轮、约 ${messages} 条消息，重复 ${repeats} 次）`);
  console.log(`  不开写穿 Run 墙钟：${stats(off)}`);
  console.log(`  开写穿   Run 墙钟：${stats(on)}`);
  console.log(`  Run 结束后写穿队列排空：${stats(drain)}`);
}

console.log(`node ${process.version} ｜ ${process.platform} ${process.arch}`);
await appendLatency();
await runOverhead();
