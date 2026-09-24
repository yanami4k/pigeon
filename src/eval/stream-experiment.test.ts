import assert from "node:assert/strict";
import { test } from "node:test";
import { streamPigeonOptions } from "./stream-experiment.ts";

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
