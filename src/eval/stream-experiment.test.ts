import assert from "node:assert/strict";
import { test } from "node:test";
import { effectivePigeonSettings, streamPigeonOptions } from "./stream-experiment.ts";

test("延续式跑批的 Pigeon 各条件一律无人值守放权（yolo），不依赖调用方传；调用方传了 false 也不算数", () => {
  assert.equal(streamPigeonOptions({ provider: "kimi-coding", modelId: "m" }).yolo, true);
  const forced = streamPigeonOptions({
    provider: "kimi-coding",
    modelId: "m",
    ...({ yolo: false } as object),
  });
  assert.equal(forced.yolo, true);
  assert.equal(forced.provider, "kimi-coding");
});

test("身份头与结果行记 Pigeon 实际生效的参数：没给的推理档位与单轮输出上限记运行时缺省（off、16,384），不记 null；给了的原样记", () => {
  assert.deepEqual(effectivePigeonSettings({}, "kimi-for-coding"), {
    provider: "kimi-coding",
    modelId: "kimi-for-coding",
    temperature: null,
    thinking: "off",
    maxOutputTokens: 16_384,
  });
  assert.deepEqual(
    effectivePigeonSettings(
      { temperature: 0, thinking: "high", maxOutputTokens: 8_000, modelId: "m2" },
      "kimi-for-coding"
    ),
    {
      provider: "kimi-coding",
      modelId: "m2",
      temperature: 0,
      thinking: "high",
      maxOutputTokens: 8_000,
    }
  );
});
