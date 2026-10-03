// 撞上限续跑与流式重复检测的设置（决策 367）：不给即缺省（续跑开 2/5，检测开、omp 档、掐断）；档位打底、单项覆盖；
// 窗口容不下最长单元重复到门槛遍数即报问题，合并后的校验照报
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REPETITION_GUARD,
  DEFAULT_TRUNCATION_CONTINUATION,
  repetitionGuardSettings,
  truncationContinuationSettings,
  WIDE_REPETITION_PARAMS,
} from "./runaway-config.ts";
import { emptySettingsSnapshot, mergedSettingsProblems } from "./settings.ts";

test("缺省与覆盖：不给即缺省；wide 档打底、单项覆盖档位；窗口过小报问题，合并后的校验点名这一节", () => {
  assert.deepEqual(truncationContinuationSettings(undefined), DEFAULT_TRUNCATION_CONTINUATION);
  assert.deepEqual(truncationContinuationSettings({ maxPerRun: 9 }), {
    ...DEFAULT_TRUNCATION_CONTINUATION,
    maxPerRun: 9,
  });
  assert.deepEqual(repetitionGuardSettings(undefined), { settings: DEFAULT_REPETITION_GUARD });
  assert.deepEqual(repetitionGuardSettings({ mode: "log", preset: "wide", similarity: 0.9 }), {
    settings: {
      enabled: true,
      mode: "log",
      preset: "wide",
      params: { ...WIDE_REPETITION_PARAMS, similarity: 0.9 },
    },
  });
  assert.ok("problem" in repetitionGuardSettings({ preset: "wide", windowChars: 4096 }));
  const merged = { ...emptySettingsSnapshot("/").merged, repetitionGuard: { windowChars: 100 } };
  assert.ok(
    mergedSettingsProblems(merged).some((problem) => problem.startsWith("repetitionGuard"))
  );
});
