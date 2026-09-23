// 回放的保真度（M8 收口补遗）：被验证那次尝试的推理档位必须沿用。
// 同一个模型换推理档位就是换了尺子；而推理档位在失效判据的封闭四项清单里属于"只记录不判定"，
// 两头落空就成了一个没人管的变量。拿不到或认不出的档位一律拒绝验证，不默默按缺省算。
// 核对本身在 replay/fidelity.ts（用例见其测试）；这里只守验证命令一侧仍报前置不满足。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertThinkingLevelReproducible } from "./rerun.ts";
import { VerifyPreconditionError } from "./verify-command.ts";

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
