// 最简 agent 与 Pigeon 的模型设置同源（决策 203）：run_mini.py 里写死的单次输出上限与温度，须与 TS 侧的缺省值
// 一致；任何一边改了而另一边没跟上即变红。思考开关只查最简 agent 自己显式关掉（Pigeon 缺省开思考，决策 390）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { STREAM_DEFAULT_TEMPERATURE, STREAM_MAX_OUTPUT_TOKENS } from "./stream-agents.ts";

const RUN_MINI = readFileSync(
  new URL("../../eval/stream/mini/run_mini.py", import.meta.url),
  "utf8"
);

function constant(name: string): string {
  const match = new RegExp(`^${name} = (.+)$`, "m").exec(RUN_MINI);
  assert.ok(match, `run_mini.py 里找不到常量 ${name}`);
  return (match[1] ?? "").trim();
}

test("最简 agent 的单次输出上限、温度与跑批器 Pigeon 进程内条件的缺省值相同，思考显式关掉，且都确实用在发给 litellm 的参数里", () => {
  assert.equal(Number(constant("MAX_OUTPUT_TOKENS")), STREAM_MAX_OUTPUT_TOKENS);
  assert.equal(Number(constant("TEMPERATURE")), STREAM_DEFAULT_TEMPERATURE);
  // 最简 agent 显式关思考（决策 203）；Pigeon 的缺省档位自决策 390 起按模型信息定（DeepSeek 为 high），两者不再同值
  assert.equal(constant("THINKING"), '{"type": "disabled"}');
  for (const use of [
    '"max_tokens": MAX_OUTPUT_TOKENS',
    '"temperature": TEMPERATURE',
    '"thinking": THINKING',
  ]) {
    assert.ok(RUN_MINI.includes(use), `model_kwargs 里没有 ${use}`);
  }
});
