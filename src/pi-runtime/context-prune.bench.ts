// 基准：缓存感知的上下文裁剪每次请求之前的计算（决策 361，提交 e472fd0 加入裁剪器、8215e0b 接进运行面：Adapter 每次模型请求
// 之前调 ContextPruner.beforeRequest）。这段计算在每次请求的关键路径上：估算每条消息的 token、找候选（过时读取要往后看
// 同一文件的读写、无事发生的结果、较大的旧结果）、为每个候选拼占位并估算大小、按价格比选改写起点，再按已有裁剪组装上下文。
// 用一段足够长的合成会话历史（TURNS 轮，混合 read_file、grep、glob、run_command、edit_file，带思考与正文），量两件事：
//   - 常见路径：付费时机算账后不裁（缺省设置，取不到价格时价格比按 50），同一个裁剪器反复调用，状态不变；
//   - 裁的路径：价格比为 2 时算账后裁一批（每次用新的裁剪器，量的是找候选、拼占位、写记录、生效的整套）。
// 计算变成按消息数平方增长或多遍整段估算时，这里明显变慢。正确性由 context-prune.test.ts 把关；夹具在 beforeAll 里先确认
// 两条路径确实一条不裁、一条裁（否则报错：夹具失效，量的不是想量的那条路径）。
import { describe, test } from "vitest";
import { type ContextPruneSettings, contextPruneSettings } from "../state/prune-config.ts";
import { ContextPruner, type PruneEffects } from "./context-prune.ts";
import type { AgentMessage } from "./index.ts";

const TURNS = 300;
const OPTIONS = { time: 2_000, warmupIterations: 5 };

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NO_CHANGES = { added: [], removed: [], modified: [], truncated: false };

// 约 tokens 个 token 的文本（上游按 4 字符一个 token 估算）
const sized = (tokens: number, seed: string) => `${seed} `.padEnd(tokens * 4, "x");

interface Call {
  name: string;
  args: Record<string, unknown>;
  text: string;
  details: Record<string, unknown>;
}

// 第 i 轮的工具调用：40 个文件反复整读（后来的读取覆盖先前的，即过时读取）、零命中与有命中的搜索、带输出的命令、小编辑
function callOf(i: number): Call {
  const file = `/work/src/f${i % 40}.ts`;
  switch (i % 6) {
    case 0:
      return {
        name: "read_file",
        args: { path: file },
        text: sized(1_200, `read ${i}`),
        details: { resolvedPath: file, offset: 1, returnedLines: 200 },
      };
    case 1: {
      const total = i % 4 === 1 ? 0 : 12;
      return {
        name: "grep",
        args: { pattern: `name${i}` },
        text: total === 0 ? "没有匹配" : sized(600, `grep ${i}`),
        details: { total },
      };
    }
    case 2: {
      const output = sized(900, `out ${i}`);
      return {
        name: "run_command",
        args: { command: `npm test -- case${i}` },
        text: `${output}\n退出码：0`,
        details: {
          exitCode: 0,
          output,
          outputBytes: output.length,
          truncated: false,
          fileChanges: NO_CHANGES,
        },
      };
    }
    case 3:
      return {
        name: "edit_file",
        args: { path: file, old_string: "a", new_string: "b" },
        text: sized(100, `edit ${i}`),
        details: { resolvedPath: file },
      };
    case 4:
      return {
        name: "read_file",
        args: { path: `/work/docs/n${i}.md`, offset: 1, limit: 40 },
        text: sized(300, `note ${i}`),
        details: { resolvedPath: `/work/docs/n${i}.md`, offset: 1, returnedLines: 40 },
      };
    default:
      return {
        name: "glob",
        args: { pattern: `src/**/*${i}.ts` },
        text: sized(400, `glob ${i}`),
        details: { total: 30 },
      };
  }
}

// 合成会话：一条用户消息，之后每轮一条带思考、正文与一个工具调用的助手消息及其结果
function syntheticHistory(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "user", content: "任务", timestamp: 0 }];
  for (let i = 0; i < turns; i++) {
    const id = `call${i}`;
    const call = callOf(i);
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: sized(200, `think ${i}`) },
          { type: "text", text: sized(30, `say ${i}`) },
          { type: "toolCall", id, name: call.name, arguments: call.args },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: USAGE,
        stopReason: "toolUse",
        timestamp: i + 1,
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: id,
        toolName: call.name,
        content: [{ type: "text", text: call.text }],
        details: call.details,
        isError: false,
        timestamp: i + 1,
      } as AgentMessage
    );
  }
  return messages;
}

function settings(overrides: Partial<ContextPruneSettings> = {}): ContextPruneSettings {
  return { ...contextPruneSettings(undefined, undefined), ...overrides };
}

// 补落盘不碰磁盘：直接给一个虚拟路径
const effects: PruneEffects = {
  saveOutput: () => "pigeon://outputs/sess_00000000000000000000000000/001",
  forgetRead: () => {},
};

const history = syntheticHistory(TURNS);
const idleSettings = settings();
const pruneSettings = settings({ priceRatio: 2 });

// 夹具自检：缺省设置算账不裁，价格比为 2 时裁
const steady = new ContextPruner(idleSettings, effects);
if (steady.beforeRequest(history).record !== undefined) {
  throw new Error("夹具失效：缺省设置下这段历史被裁了，量不到「算账后不裁」的路径");
}
if (new ContextPruner(pruneSettings, effects).beforeRequest(history).record === undefined) {
  throw new Error("夹具失效：价格比为 2 时这段历史没有被裁，量不到「算账并裁」的路径");
}

describe(`上下文裁剪：每次请求之前的计算（${TURNS} 轮合成历史，决策 361）`, () => {
  test("付费时机算账后不裁（缺省设置，同一个裁剪器）", async ({ bench }) => {
    await bench("付费时机算账后不裁（缺省设置，同一个裁剪器）", () => {
      steady.beforeRequest(history);
    }).run(OPTIONS);
  });

  test("付费时机算账并裁一批（价格比 2，每次新的裁剪器）", async ({ bench }) => {
    await bench("付费时机算账并裁一批（价格比 2，每次新的裁剪器）", () => {
      new ContextPruner(pruneSettings, effects).beforeRequest(history, () => {});
    }).run(OPTIONS);
  });
});
