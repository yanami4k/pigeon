// 摩擦派生的判据（决策 131），用合成的验证记录直接喂给纯函数：失败清单不全时不认"已修好"、按指纹逐个追踪红转绿、
// 同一次验证里同键报错去重并合并名字、无法判断时不猜。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newEntryId, newRunId, newSessionId, type RunId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";
import { deriveSessionFrictions } from "./structured-memory.ts";
import { MAX_FINGERPRINTS_PER_STEP } from "./verify-fingerprint.ts";
import type { VerifyStepResult } from "./verify-steps.ts";

const WORKSPACE = "/repo";

type StepSpec = Pick<VerifyStepResult, "name" | "verdict" | "output"> & { truncated?: boolean };

// 一个回炉开启的会话：每次验证是一个 Run 的一条验证记录（时间依次递增）
function sessionOf(
  verifications: StepSpec[][],
  verify: { command: string; steps?: Array<{ name: string; command: string }> } = {
    command: "分步",
    steps: [],
  }
) {
  const sessionId = newSessionId();
  const runs: RunId[] = verifications.map(() => newRunId());
  const runStarteds = runs.map((runId) => ({
    runId,
    payload: {
      repairRounds: 3,
      verify: { ...verify, timeoutMs: 1000 },
    },
  }));
  const attemptVerifieds = verifications.map((steps, index) => {
    const legacy = verify.steps === undefined;
    const results = steps.map((step) => ({
      name: step.name,
      exitCode: step.verdict === "pass" ? 0 : 1,
      verdict: step.verdict,
      output: step.output,
      truncated: step.truncated ?? false,
    }));
    const failed = results.some((step) => step.verdict === "fail");
    return {
      id: newEntryId(),
      kind: "attempt.verified",
      sessionId,
      timestamp: 1_000 * (index + 1),
      target: { sessionId, runId: runs[index] },
      command: [],
      exitCode: failed ? 1 : 0,
      timedOut: false,
      durationMs: 1,
      outputBytes: 1,
      outputHash: "0".repeat(64),
      output: legacy ? (results[0]?.output ?? "") : "",
      truncated: legacy ? (results[0]?.truncated ?? false) : false,
      workspace: WORKSPACE,
      verdict: failed ? "fail" : "pass",
      verifiedAt: 1_000 * (index + 1),
      ...(legacy ? {} : { steps: results }),
    };
  });
  return {
    sessionId,
    records: [],
    runStarteds,
    attemptVerifieds,
    checkpoints: [],
  } as unknown as Pick<
    MaterializedSession,
    "sessionId" | "records" | "runStarteds" | "attemptVerifieds" | "checkpoints"
  >;
}

const tsc = (entries: Array<[file: string, code: string, name: string]>): string =>
  entries
    .map(([file, code, name]) => `${file}(1,1): error ${code}: Cannot find name '${name}'.`)
    .join("\n");

const nodeTests = (entries: Array<[file: string, name: string]>): string =>
  [
    "✖ failing tests:",
    "",
    ...entries.flatMap(([file, name]) => [`test at ${file}:1:1`, `✖ ${name} (1ms)`, ""]),
  ].join("\n");

const pass = (name: string): StepSpec => ({ name, verdict: "pass", output: "ok" });

test('失败清单不全（输出截断或指纹达上限）时不凭"不在清单里"认定已修好，只认整步通过', () => {
  const facts = deriveSessionFrictions(
    sessionOf([
      [{ name: "测试", verdict: "fail", output: nodeTests([["src/a.test.ts", "甲"]]) }],
      // 截断的输出里恰好没有"甲"：不能据此认定甲已修好
      [
        {
          name: "测试",
          verdict: "fail",
          output: nodeTests([["src/b.test.ts", "乙"]]),
          truncated: true,
        },
      ],
      [pass("测试")],
    ])
  );
  const first = facts.find((fact) => fact.fingerprint.test === "甲");
  assert.equal(first?.at, 3_000, "甲在整步通过那次才算修好");
  // 指纹达上限的清单同样不全
  const many = Array.from(
    { length: MAX_FINGERPRINTS_PER_STEP + 1 },
    (_, index) => [`src/t${index}.test.ts`, `用例${index}`] as [string, string]
  );
  const capped = deriveSessionFrictions(
    sessionOf([
      [{ name: "测试", verdict: "fail", output: nodeTests([["src/a.test.ts", "甲"]]) }],
      [{ name: "测试", verdict: "fail", output: nodeTests(many) }],
      [pass("测试")],
    ])
  );
  assert.equal(capped.find((fact) => fact.fingerprint.test === "甲")?.at, 3_000);
});

const pytestFailed = (entries: Array<[file: string, name: string]>): string =>
  [
    "=========================== short test summary info ============================",
    ...entries.map(([file, name]) => `FAILED ${file}::${name} - assert False`),
    `========================= ${entries.length} failed in 0.10s =========================`,
  ].join("\n");

test('测试运行被中断（收集错误、提前停止、文件级失败）时清单不全，不认"已修好"，只认整步通过', () => {
  const interrupted: string[] = [
    // pytest：某个导入被改坏、收集中断
    [
      "==================================== ERRORS ====================================",
      "_______________________ ERROR collecting tests/test_b.py ________________________",
      "ImportError while importing test module",
      "=========================== short test summary info ============================",
      "ERROR tests/test_b.py",
      "!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!",
      "=============================== 1 error in 0.12s ===============================",
    ].join("\n"),
    // pytest -x / --maxfail：第一个失败即停
    [
      "=========================== short test summary info ============================",
      "FAILED tests/test_c.py::test_other - assert False",
      "!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "========================= 1 failed in 0.10s =========================",
    ].join("\n"),
  ];
  for (const output of interrupted) {
    const facts = deriveSessionFrictions(
      sessionOf([
        [{ name: "测试", verdict: "fail", output: pytestFailed([["tests/test_a.py", "test_a"]]) }],
        [{ name: "测试", verdict: "fail", output }],
        [pass("测试")],
      ])
    );
    assert.equal(
      facts.find((fact) => fact.fingerprint.test === "test_a")?.at,
      3_000,
      output.split("\n")[4] ?? output
    );
  }
  // node:test 的文件级失败：失败项名就是测试文件
  const fileLevel = deriveSessionFrictions(
    sessionOf([
      [{ name: "测试", verdict: "fail", output: nodeTests([["src/a.test.ts", "甲"]]) }],
      [
        {
          name: "测试",
          verdict: "fail",
          output: nodeTests([["src/b.test.ts", "src/b.test.ts"]]),
        },
      ],
      [pass("测试")],
    ])
  );
  assert.equal(fileLevel.find((fact) => fact.fingerprint.test === "甲")?.at, 3_000);
});

// 只含一种中断迹象的输出：V1 测试甲失败，V2 出现该迹象（清单里没有甲），V3 全过——甲只能在 V3 认定修好
function onlyAtThirdWith(output: string): number | undefined {
  const facts = deriveSessionFrictions(
    sessionOf([
      [{ name: "测试", verdict: "fail", output: pytestFailed([["tests/test_a.py", "test_a"]]) }],
      [{ name: "测试", verdict: "fail", output }],
      [pass("测试")],
    ])
  );
  return facts.find((fact) => fact.fingerprint.test === "test_a")?.at;
}

test("中断迹象之一：pytest 的 Interrupted", () => {
  const output = [
    "=========================== short test summary info ============================",
    "FAILED tests/test_c.py::test_other - assert False",
    "!!!!!!!!!!!!!!!!!!!!!!!!! Interrupted: KeyboardInterrupt !!!!!!!!!!!!!!!!!!!!!!!!!",
    "========================= 1 failed in 0.10s =========================",
  ].join("\n");
  assert.equal(onlyAtThirdWith(output), 3_000);
});

test("中断迹象之一：pytest 的 during collection", () => {
  const output = [
    "=========================== short test summary info ============================",
    "FAILED tests/test_c.py::test_other - assert False",
    "================ 1 failed, 1 error during collection in 0.12s ================",
  ].join("\n");
  assert.equal(onlyAtThirdWith(output), 3_000);
});

test("中断迹象之一：pytest 不带测试名的 ERROR（收集错误）", () => {
  const output = [
    "=========================== short test summary info ============================",
    "ERROR tests/test_b.py",
    "=============================== 1 error in 0.12s ===============================",
  ].join("\n");
  assert.equal(onlyAtThirdWith(output), 3_000);
});

test("按指纹逐个追踪：待修期间新出现的失败另行追踪；闭合一段之后同一次验证里新变红的也记", () => {
  // V1 甲失败；V2 甲、乙都失败；V3 全过 → 记甲、乙两条
  const types = deriveSessionFrictions(
    sessionOf([
      [{ name: "类型", verdict: "fail", output: tsc([["src/x.ts", "TS2304", "alpha"]]) }],
      [
        {
          name: "类型",
          verdict: "fail",
          output: tsc([
            ["src/x.ts", "TS2304", "alpha"],
            ["src/y.ts", "TS2322", "beta"],
          ]),
        },
      ],
      [pass("类型")],
    ])
  );
  assert.deepEqual(types.map((fact) => [fact.fingerprint.file, fact.redAt, fact.at]).sort(), [
    ["src/x.ts", 1_000, 3_000],
    ["src/y.ts", 2_000, 3_000],
  ]);
  // V1 测试甲失败；V2 甲过了而乙失败（同一次验证里闭合甲、乙新变红）；V3 全过 → 记甲、乙两条
  const tests = deriveSessionFrictions(
    sessionOf([
      [{ name: "测试", verdict: "fail", output: nodeTests([["src/a.test.ts", "甲"]]) }],
      [{ name: "测试", verdict: "fail", output: nodeTests([["src/b.test.ts", "乙"]]) }],
      [pass("测试")],
    ])
  );
  assert.deepEqual(tests.map((fact) => [fact.fingerprint.test, fact.redAt, fact.at]).sort(), [
    ["乙", 2_000, 3_000],
    ["甲", 1_000, 2_000],
  ]);
});

test("同一次验证里指纹键相同的多行报错合为一条事实，名字合并", () => {
  const facts = deriveSessionFrictions(
    sessionOf([
      [
        {
          name: "类型",
          verdict: "fail",
          output: tsc([
            ["src/x.ts", "TS2304", "alpha"],
            ["src/x.ts", "TS2304", "beta"],
            ["src/x.ts", "TS2304", "gamma"],
          ]),
        },
      ],
      [pass("类型")],
    ])
  );
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0]?.fingerprint.names, ["alpha", "beta", "gamma"]);
});

test("无法判断就不猜：步骤类型未知或为测试、输出又无法识别时不记红转绿；修满仍失败也不产出事实", () => {
  for (const command of ["npx jest", "./run-all.sh"]) {
    const legacy = { command };
    const facts = deriveSessionFrictions(
      sessionOf(
        [
          [{ name: "验证", verdict: "fail", output: "FAIL  some weird output ●" }],
          [{ name: "验证", verdict: "pass", output: "done" }],
        ],
        legacy
      )
    );
    assert.deepEqual(facts, [], command);
    const unresolved = deriveSessionFrictions(
      sessionOf(
        [
          [{ name: "验证", verdict: "fail", output: "FAIL  some weird output ●" }],
          [{ name: "验证", verdict: "fail", output: "FAIL  still weird ●" }],
        ],
        legacy
      )
    );
    assert.deepEqual(unresolved, [], command);
  }
});
