// 基准：交互快照（checkpoint）移出关键路径（决策 350，提交 6ccfdde；合入 e51a94b）。改动前，写档、命令档工具落定后在事件
// 分派里同步拍快照，下一次模型请求要等快照拍完才发出；改动后先写"拍摄中"标记，快照在后台拍，与下一次模型请求同时进行，
// 只有下一次工具执行（Adapter 的等待口）、分叉与退出之前才等它拍完。
// 做法：真实运行面（openSessionRuntime）+ 真 git 仓库（文件足够多，快照要几十毫秒）+ 仓库的假模型（createFakeStreamFn）。
// 每次迭代跑一轮：模型发一个 edit_file → 工具执行 → 下一次模型请求 → 模型收尾；工具之后的那次请求另加 MODEL_LATENCY_MS
// 毫秒的模拟模型延迟。快照在关键路径外时它藏在模型延迟里，一轮的耗时约为"工具 + 模型延迟"；退回到关键路径上即多出整段
// 快照时间。迭代末尾 settle（等快照拍完）也算在内，免得上一轮的快照拖进下一轮的等待口。
// "工具结束 → 下一次请求发出"的间隔本身在每轮另记一笔，afterAll 打出中位数与最大值（快照在关键路径外时应接近 0）。
// 为了让这笔间隔从工具结果交回的那一刻算起（早于快照挂件的观察口），先停掉运行面自带的快照挂件，登记计时观察口之后
// 再挂一份同样的（attachCheckpoints，与 checkpoints-async.test.ts 里分叉用例的做法相同）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { attachCheckpoints, type CheckpointAttachment } from "./checkpoints.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

// 仓库里跟踪的文件数（快照的 add -A 要逐个比对）与工具之后那次请求的模拟模型延迟
const TRACKED_FILES = 8_000;
const FILES_PER_DIR = 200;
const MODEL_LATENCY_MS = 300;

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-bench-checkpoint-")));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "pigeon@example.invalid"]);
  git(root, ["config", "user.name", "pigeon-bench"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(root, "a.txt"), "counter: 0\n");
  for (let i = 0; i < TRACKED_FILES; i++) {
    const dir = join(root, "src", `d${Math.floor(i / FILES_PER_DIR)}`);
    if (i % FILES_PER_DIR === 0) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

// 一轮的两条回复：把 a.txt 的计数从 n 改到 n + 1，然后收尾
function editRound(n: number): FakeReply[] {
  return [
    {
      text: "改",
      toolCalls: [
        {
          name: "edit_file",
          args: { path: "a.txt", old_string: `counter: ${n}\n`, new_string: `counter: ${n + 1}\n` },
        },
      ],
    },
    { text: "改好了" },
  ];
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}

describe("交互快照：工具结束到下一次模型请求（决策 350）", () => {
  let root = "";
  let home = "";
  let opened: Awaited<ReturnType<typeof openSessionRuntime>> | undefined;
  let attached: CheckpointAttachment | undefined;
  // 每轮换一份假模型回复；工具之后的那次请求先等模拟模型延迟
  let current: StreamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  let counter = 0;
  let toolEndedAt: number | undefined;
  let toolError: string | undefined;
  const intervals: number[] = [];

  const streamFn: StreamFn = async (model, context, options) => {
    if (toolEndedAt !== undefined) {
      intervals.push(performance.now() - toolEndedAt);
      toolEndedAt = undefined;
      await delay(MODEL_LATENCY_MS);
    }
    return current(model, context, options);
  };

  const round = async (): Promise<void> => {
    if (opened === undefined || attached === undefined) throw new Error("夹具没有建好");
    current = createFakeStreamFn({ replies: editRound(counter) });
    await opened.bundle.adapter.run("把计数加一");
    await attached.settle();
    if (toolError !== undefined) {
      throw new Error(`edit_file 失败，夹具失效：${toolError}`);
    }
    counter += 1;
  };

  beforeAll(async () => {
    root = makeRepo();
    home = mkdtempSync(join(tmpdir(), "pigeon-bench-checkpoint-home-"));
    opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId: newSessionId(),
      streamFn,
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    if (opened.checkpoints === undefined) {
      throw new Error("运行面没有挂上快照（工作区不是 git 仓库？）");
    }
    // 计时观察口登记在快照挂件之前（见文件头）
    opened.checkpoints.stop();
    opened.bundle.adapter.subscribeToolResults((notice) => {
      toolEndedAt = performance.now();
      if (notice.isError) toolError = notice.text;
    });
    attached = attachCheckpoints({ bundle: opened.bundle, workspaceRoot: root });
    if (attached === undefined) throw new Error("快照挂件没有挂上");
    // 预热：首轮另有基线快照、开工状态块等一次性开销
    await round();
    if (attached.errors().length > 0) {
      throw new Error(`快照出错，夹具失效：${String(attached.errors()[0])}`);
    }
    intervals.length = 0;
  });

  afterAll(async () => {
    if (intervals.length > 0) {
      const median = percentile(intervals, 0.5).toFixed(1);
      const p90 = percentile(intervals, 0.9).toFixed(1);
      const max = Math.max(...intervals).toFixed(1);
      console.log(
        `工具结束 → 下一次请求发出：${intervals.length} 轮，中位 ${median} ms，p90 ${p90} ms，最大 ${max} ms`
      );
    }
    try {
      await attached?.close();
      if (opened !== undefined) await disposeRuntime(opened.bundle);
    } finally {
      if (root !== "") rmSync(root, { recursive: true, force: true });
      if (home !== "") rmSync(home, { recursive: true, force: true });
    }
  });

  test(`一轮 edit_file：工具结束 → 下一次请求（模拟模型延迟 ${MODEL_LATENCY_MS} ms，快照应藏在其中）`, async ({
    bench,
  }) => {
    await bench(
      `一轮 edit_file：工具结束 → 下一次请求（模拟模型延迟 ${MODEL_LATENCY_MS} ms，快照应藏在其中）`,
      round
    ).run({ time: 5_000, warmupIterations: 1 });
  });
});
