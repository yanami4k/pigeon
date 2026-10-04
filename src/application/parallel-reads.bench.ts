// 基准：纯读批并行执行（决策 353，提交 a79d0c9；合入 79f28ba）。一次回复里的多个只读工具调用（read_file、grep、glob 等，
// 见 tool-execution-modes.ts 的 PARALLEL_TOOLS）同时执行，整批耗时应接近单个读取，而不是逐个相加。
// 做法照 tool-execution-modes.test.ts：真实运行面（buildRuntime）+ 仓库的假模型（createFakeStreamFn），执行端是本机实现外包
// 一层，每次按字节读文件固定等 READ_DELAY_MS 毫秒（模拟慢盘或容器往返）。量一次 Run：模型一次发出 BATCH 个 read_file →
// 执行 → 模型收尾。同组另量只发 1 个 read_file 的一轮作参照：并行时两者接近，退回逐个执行时前者约为 BATCH 倍。
// 整批是否同时开始由 tool-execution-modes.test.ts 的「纯读的一批同时执行；读与命令混排的一批按顺序逐个执行」把关。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { buildRuntime, disposeRuntime, type RuntimeBundle } from "./runtime.ts";

const BATCH = 8;
const READ_DELAY_MS = 50;
const OPTIONS = { time: 3_000, warmupIterations: 2 };
const SUITE = `纯读批并行：一次回复里 ${BATCH} 个 read_file（每次读固定 ${READ_DELAY_MS} ms，决策 353）`;
const BATCH_BENCH = `一轮 ${BATCH} 个 read_file（应接近单个，而非 ${BATCH} 倍）`;

// 一轮的两条回复：一次发出 count 个 read_file，然后收尾
function readRound(count: number): FakeReply[] {
  return [
    {
      text: "",
      toolCalls: Array.from({ length: count }, (_, index) => ({
        name: "read_file",
        args: { path: `f${index}.txt` },
      })),
    },
    { text: "完成" },
  ];
}

describe(SUITE, () => {
  let root = "";
  let bundle: RuntimeBundle | undefined;
  let current: StreamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  let readError: string | undefined;

  const round = async (count: number): Promise<void> => {
    if (bundle === undefined) throw new Error("夹具没有建好");
    current = createFakeStreamFn({ replies: readRound(count) });
    await bundle.adapter.run("读这些文件");
    if (readError !== undefined) throw new Error(`read_file 失败，夹具失效：${readError}`);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pigeon-bench-parallel-reads-"));
    for (let index = 0; index < BATCH; index++) {
      writeFileSync(join(root, `f${index}.txt`), `file ${index}\n`.repeat(20));
    }
    const local = createLocalWorkspaceHost(root);
    const host: WorkspaceHost = {
      ...local,
      // read_file 按字节读：每次读固定等一会儿
      async readBytes(resolved) {
        await delay(READ_DELAY_MS);
        const bytes = await local.readBytes?.(resolved);
        return bytes ?? Buffer.from(await local.readText(resolved), "utf8");
      },
    };
    // 每轮换一份假模型回复（运行面只建一次）
    const streamFn: StreamFn = (model, context, options) => current(model, context, options);
    // yolo 且注入执行端（容器形，不接交互审批），同 tool-execution-modes.test.ts
    bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      homeDir: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      workspaceHost: host,
    });
    bundle.adapter.subscribeToolResults((notice) => {
      if (notice.isError) readError = notice.text;
    });
    // 预热：首轮另有开工状态块等一次性开销
    await round(BATCH);
  });

  afterAll(async () => {
    try {
      if (bundle !== undefined) await disposeRuntime(bundle);
    } finally {
      if (root !== "") rmSync(root, { recursive: true, force: true });
    }
  });

  test(BATCH_BENCH, async ({ bench }) => {
    await bench(BATCH_BENCH, async () => round(BATCH)).run(OPTIONS);
  });

  test("参照：一轮 1 个 read_file", async ({ bench }) => {
    await bench("参照：一轮 1 个 read_file", async () => round(1)).run(OPTIONS);
  });
});
