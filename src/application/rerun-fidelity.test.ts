// 回放的保真度（M8 收口补遗）：被验证那次尝试的推理档位必须沿用。
// 同一个模型换推理档位就是换了尺子；而推理档位在失效判据的封闭四项清单里属于"只记录不判定"，
// 两头落空就成了一个没人管的变量。拿不到或认不出的档位一律拒绝验证，不默默按缺省算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { assertThinkingLevelReproducible, verifierRuntimeDeps } from "./rerun.ts";
import { VerifyPreconditionError } from "./verify-command.ts";

const streamFn = createFakeStreamFn({ replies: [{ text: "ok" }] });

test("推理档位：解出来的档位一路传到验证器的运行面依赖上", () => {
  const deps = verifierRuntimeDeps({
    model: { provider: "p", id: "m", thinkingLevel: "high", maxOutputTokens: 4096 },
    streamFn,
    persistThinking: true,
  });
  assert.equal(deps.thinkingLevel, "high");
  assert.equal(deps.provider, "p");
  assert.equal(deps.modelId, "m");
  assert.equal(deps.maxOutputTokens, 4096);
  assert.equal(deps.persistThinking, true);
});

test("推理档位：off 同样要沿用——它是一个明确的档位，不是缺省", () => {
  const deps = verifierRuntimeDeps({
    model: { provider: "p", id: "m", thinkingLevel: "off" },
    streamFn,
    persistThinking: false,
  });
  assert.equal(deps.thinkingLevel, "off");
  assert.equal(deps.maxOutputTokens, undefined);
});

test("推理档位：认不出或没记下来的档位一律拒绝验证，不按缺省算", () => {
  assert.throws(
    () => assertThinkingLevelReproducible({ provider: "p", id: "m", thinkingLevel: "turbo" }),
    (error: unknown) => error instanceof VerifyPreconditionError && /推理档位/.test(String(error))
  );
  assert.throws(
    () => assertThinkingLevelReproducible({ provider: "p", id: "m" }),
    (error: unknown) => error instanceof VerifyPreconditionError && /推理档位/.test(String(error))
  );
  assert.doesNotThrow(() =>
    assertThinkingLevelReproducible({ provider: "p", id: "m", thinkingLevel: "low" })
  );
});
