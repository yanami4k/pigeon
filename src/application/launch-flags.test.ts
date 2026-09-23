// 启动参数解析（决策 067）：cli、tui、headless 共用一份模型与运行参数解析。
// 三处模型占位缺省统一为同一常量（provider 与 model 均为 custom）；cli 补 PIGEON_STREAM_FN 回退，
// 与既有报错文案一致；非法取值一律响亮失败。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MODEL_PLACEHOLDER,
  parseLaunchFlags,
  resolveStreamFnSpec,
} from "./launch-flags.ts";

const USAGE = "用法：测试";

test("模型占位缺省统一为 custom/custom（三个入口同一常量）", () => {
  assert.deepEqual(DEFAULT_MODEL_PLACEHOLDER, { provider: "custom", modelId: "custom" });
  const flags = parseLaunchFlags([], { usage: USAGE, env: {} });
  assert.equal(flags.provider, "custom");
  assert.equal(flags.modelId, "custom");
  assert.equal(flags.yolo, false);
  assert.equal(flags.persistThinking, true);
});

test("PIGEON_STREAM_FN 回退：环境变量提供缺省，--stream-fn 覆盖它", () => {
  const fromEnv = parseLaunchFlags([], { usage: USAGE, env: { PIGEON_STREAM_FN: "./env.mjs" } });
  assert.equal(fromEnv.streamFnSpec, "./env.mjs");
  const overridden = parseLaunchFlags(["--stream-fn", "./flag.mjs"], {
    usage: USAGE,
    env: { PIGEON_STREAM_FN: "./env.mjs" },
  });
  assert.equal(overridden.streamFnSpec, "./flag.mjs");
});

test("未配置模型接入：响亮失败并指出两种配置方式", () => {
  const flags = parseLaunchFlags([], { usage: USAGE, env: {} });
  assert.throws(() => resolveStreamFnSpec(flags, USAGE), /未配置模型接入/);
  assert.equal(
    resolveStreamFnSpec(
      parseLaunchFlags(["--stream-fn", "./a.mjs"], { usage: USAGE, env: {} }),
      USAGE
    ),
    "./a.mjs"
  );
});

test("取值校验：推理档位、Memory 预算、单轮输出上限非法即失败；未知参数响亮失败", () => {
  assert.throws(
    () => parseLaunchFlags(["--thinking", "turbo"], { usage: USAGE, env: {} }),
    /--thinking/
  );
  assert.throws(
    () => parseLaunchFlags(["--memory-budget", "-1"], { usage: USAGE, env: {} }),
    /--memory-budget/
  );
  assert.throws(
    () => parseLaunchFlags(["--max-output-tokens", "0"], { usage: USAGE, env: {} }),
    /--max-output-tokens/
  );
  assert.throws(() => parseLaunchFlags(["--nope"], { usage: USAGE, env: {} }), /未知参数/);
});

test("--history-limit 只属 TUI：允许时解析为正整数，未允许时按未知参数处理", () => {
  const tuiFlags = parseLaunchFlags(["--history-limit", "120"], {
    usage: USAGE,
    env: {},
    historyLimit: true,
  });
  assert.equal(tuiFlags.historyLimit, 120);
  assert.throws(
    () => parseLaunchFlags(["--history-limit", "120"], { usage: USAGE, env: {} }),
    /未知参数/
  );
});

test("开关与取值型参数照常解析：--yolo / --no-persist-thinking / --root / --provider / --model", () => {
  const flags = parseLaunchFlags(
    [
      "--yolo",
      "--no-persist-thinking",
      "--root",
      "/tmp/ws",
      "--provider",
      "kimi-coding",
      "--model",
      "kimi-for-coding",
      "--thinking",
      "medium",
      "--memory-budget",
      "4000",
      "--max-output-tokens",
      "2048",
    ],
    { usage: USAGE, env: {} }
  );
  assert.equal(flags.yolo, true);
  assert.equal(flags.persistThinking, false);
  assert.equal(flags.root, "/tmp/ws");
  assert.equal(flags.provider, "kimi-coding");
  assert.equal(flags.modelId, "kimi-for-coding");
  assert.equal(flags.thinkingLevel, "medium");
  assert.equal(flags.memoryBudgetChars, 4000);
  assert.equal(flags.maxOutputTokens, 2048);
});

test("审阅与自动验证参数已随第一版学习闭环退役（决策 137）：--no-review、--review-every、--auto-verify 按未知参数响亮失败", () => {
  for (const argv of [["--no-review"], ["--review-every", "4"], ["--auto-verify"]]) {
    assert.throws(
      () => parseLaunchFlags(argv, { usage: USAGE, env: {}, verify: true, retry: true }),
      /未知参数/
    );
  }
});
