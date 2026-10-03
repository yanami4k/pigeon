// 最简 agent 与 Pigeon 的模型设置同源（决策 203）：run_mini.py 里写死的单次输出上限、温度与思考开关，须与 TS 侧的缺省值
// 一致；任何一边改了而另一边没跟上即变红
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_THINKING_LEVEL } from "../pi-runtime/index.ts";
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

test("最简 agent 的单次输出上限、温度、思考开关与跑批器 Pigeon 进程内条件的缺省值相同，且确实用在发给 litellm 的参数里", () => {
  assert.equal(Number(constant("MAX_OUTPUT_TOKENS")), STREAM_MAX_OUTPUT_TOKENS);
  assert.equal(Number(constant("TEMPERATURE")), STREAM_DEFAULT_TEMPERATURE);
  // Pigeon 缺省不请求推理（off），pi-ai 据此发 thinking disabled；最简 agent 显式发同一个值
  assert.equal(DEFAULT_THINKING_LEVEL, "off");
  assert.equal(constant("THINKING"), '{"type": "disabled"}');
  for (const use of [
    '"max_tokens": MAX_OUTPUT_TOKENS',
    '"temperature": TEMPERATURE',
    '"thinking": THINKING',
  ]) {
    assert.ok(RUN_MINI.includes(use), `model_kwargs 里没有 ${use}`);
  }
});
