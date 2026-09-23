// 重跑的一致性核对（决策 087 及修订、110、156）：预算、工具、推理档位、采样温度与工作方式指令一律沿用原尝试，
// 任何放宽即拒绝。用例自原回放执行体（application/rerun.ts）的测试迁来，核对逻辑不变。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttemptBudget } from "../state/attempt-config.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import {
  AttemptFidelityError,
  assertThinkingLevelReproducible,
  BudgetWidenedError,
  effectiveLimits,
  intersectAttemptTools,
  reproducedRuntime,
  samplingOf,
} from "./fidelity.ts";

const DEFAULTS = { maxTurns: 50, wallClockMs: 600_000 };

test("预算：沿用被验证那次尝试的上限，逐项照搬", () => {
  const budget: AttemptBudget = { maxTurns: 7, wallClockMs: 60_000, maxTokens: 9000 };
  assert.deepEqual(effectiveLimits(budget, DEFAULTS), budget);
});

test("预算：尝试没设某项上限时按调用方缺省收紧，不放宽", () => {
  const limits = effectiveLimits({ maxTurns: 3 }, DEFAULTS);
  assert.equal(limits.maxTurns, 3);
  assert.equal(limits.wallClockMs, DEFAULTS.wallClockMs, "未设墙钟按缺省收紧");
  assert.equal(limits.maxTokens, undefined);
});

test("预算：任何一项放宽都被拒绝——这条是回放结论成立的前提", () => {
  const budget: AttemptBudget = { maxTurns: 7, wallClockMs: 60_000, maxTokens: 9000 };
  const base = effectiveLimits(budget, DEFAULTS);
  for (const widened of [
    { ...base, maxTurns: 8 },
    { ...base, wallClockMs: 60_001 },
    { ...base, maxTokens: 9001 },
  ]) {
    assert.throws(() => effectiveLimits(budget, DEFAULTS, widened), BudgetWidenedError);
  }
  // 收紧允许：回放拿到的资源少于原尝试，结论只会偏保守
  assert.deepEqual(effectiveLimits(budget, DEFAULTS, { ...base, maxTurns: 6 }).maxTurns, 6);
});

test("预算：原尝试某项不设限时，回放给该项设限属收紧，放开成不设限属放宽", () => {
  assert.equal(
    effectiveLimits({ maxTurns: 3 }, DEFAULTS, { maxTurns: 3, wallClockMs: 1000 }).wallClockMs,
    1000
  );
  assert.throws(
    () =>
      effectiveLimits({ maxTurns: 3, maxTokens: 100 }, DEFAULTS, {
        maxTurns: 3,
        wallClockMs: 1000,
      }),
    BudgetWidenedError
  );
});

test("工具取交集：原尝试没有的工具，回放也不给——工具多一件与预算多一点是同一类失效", () => {
  const ceiling = ["edit_file", "read_file", "run_command"];
  assert.deepEqual(intersectAttemptTools(ceiling).sort(), ceiling, "没给原尝试名单时按上限给");
  assert.deepEqual(intersectAttemptTools(ceiling, ["read_file", "edit_file"]).sort(), [
    "edit_file",
    "read_file",
  ]);
  // 原尝试有而上限没有的工具，不会被带进来
  assert.deepEqual(
    intersectAttemptTools(ceiling, ["read_file", "edit_file", "run_command", "x"]).sort(),
    ceiling
  );
  assert.deepEqual(intersectAttemptTools(ceiling, []), []);
});

test("推理档位：解出来的档位一路传到运行面参数上", () => {
  const runtime = reproducedRuntime({
    model: { provider: "p", id: "m", thinkingLevel: "high", maxOutputTokens: 4096 },
  });
  assert.equal(runtime.thinkingLevel, "high");
  assert.equal(runtime.provider, "p");
  assert.equal(runtime.modelId, "m");
  assert.equal(runtime.maxOutputTokens, 4096);
});

test("推理档位：off 同样要沿用——它是一个明确的档位，不是缺省", () => {
  const runtime = reproducedRuntime({ model: { provider: "p", id: "m", thinkingLevel: "off" } });
  assert.equal(runtime.thinkingLevel, "off");
  assert.equal(runtime.maxOutputTokens, undefined);
});

test("推理档位：认不出或没记下来的档位一律拒绝，不按缺省算", () => {
  assert.throws(
    () => assertThinkingLevelReproducible({ provider: "p", id: "m", thinkingLevel: "turbo" }),
    (error: unknown) => error instanceof AttemptFidelityError && /推理档位/.test(String(error))
  );
  assert.throws(
    () => assertThinkingLevelReproducible({ provider: "p", id: "m" }),
    (error: unknown) => error instanceof AttemptFidelityError && /推理档位/.test(String(error))
  );
  assert.throws(
    () => reproducedRuntime({ model: { provider: "p", id: "m" } }),
    AttemptFidelityError,
    "照搬运行面参数之前先核对档位"
  );
  assert.doesNotThrow(() =>
    assertThinkingLevelReproducible({ provider: "p", id: "m", thinkingLevel: "low" })
  );
});

test("运行面：计划里的温度与工作方式指令原样传下去；计划里没有就不设", () => {
  const runtime = reproducedRuntime({
    model: { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
    taskDirective: "Your task is to fix the issue.",
  });
  assert.equal(runtime.temperature, 0);
  assert.equal(runtime.taskDirective, "Your task is to fix the issue.");
  const plain = reproducedRuntime({ model: { provider: "p", id: "m", thinkingLevel: "off" } });
  assert.equal("temperature" in plain, false);
  assert.equal("taskDirective" in plain, false);
});

test("采样参数整组交出：模型参数与工作方式指令一起，缺哪样就不带哪样", () => {
  const base = {
    sessionId: newSessionId(),
    runId: newRunId(),
    task: "t",
    startCommit: "a".repeat(40),
    startSource: "given" as const,
    budget: { maxTurns: 1 },
    budgetSource: "run-started" as const,
    approvalMode: "yolo" as const,
    tools: [],
  };
  assert.deepEqual(
    samplingOf({
      ...base,
      model: { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
      taskDirective: "D",
    }),
    {
      model: { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
      taskDirective: "D",
    }
  );
  assert.deepEqual(samplingOf({ ...base, model: { provider: "p", id: "m" } }), {
    model: { provider: "p", id: "m" },
  });
});
