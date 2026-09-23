// 报错指纹（决策 131）：按工具取指纹，夹具是各工具的真实输出（本仓库的 tsc、biome、依赖巡航、node:test，
// strands 容器里的 pytest，以及本机 pytest、ruff、mypy 对仿 strands 布局的小项目的输出），原样保留颜色码。
// 无法解析的输出记为该步的"未识别"指纹，不猜。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  fingerprintKey,
  MAX_FINGERPRINTS_PER_STEP,
  parseStepOutput,
  type StepFingerprints,
} from "./verify-fingerprint.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./verify-fingerprint-fixtures/${name}`, import.meta.url), "utf8");
}

// 只比对关心的字段
function brief(parsed: StepFingerprints) {
  return parsed.fingerprints.map((entry) => ({
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    ...(entry.rule !== undefined ? { rule: entry.rule } : {}),
    ...(entry.test !== undefined ? { test: entry.test } : {}),
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    ...(entry.to !== undefined ? { to: entry.to } : {}),
    names: entry.names,
  }));
}

test("类型检查（tsc）：取错误码、涉及的名字与文件；彩色与纯文本两种输出结果相同", () => {
  const expected = [
    { code: "TS2305", file: "src/state/zz-probe.ts", names: ["formatSessionLine"] },
    { code: "TS2322", file: "src/state/zz-probe.ts", names: [] },
    { code: "TS2304", file: "src/state/zz-probe.ts", names: ["missingDigits"] },
  ];
  for (const name of ["tsc-plain.txt", "tsc-pretty.txt"]) {
    const parsed = parseStepOutput({
      name: "类型",
      command: "npm run check",
      output: fixture(name),
    });
    assert.equal(parsed.tool, "tsc", name);
    assert.equal(parsed.kind, "type", name);
    assert.equal(parsed.recognized, true, name);
    assert.deepEqual(brief(parsed), expected, name);
  }
});

test("测试（node:test）：取失败的测试名与测试文件（嵌套在 describe 里的取叶子名）", () => {
  const parsed = parseStepOutput({
    name: "测试",
    command: "npm run test",
    output: fixture("node-test.txt"),
  });
  assert.equal(parsed.tool, "node-test");
  assert.equal(parsed.kind, "test");
  assert.deepEqual(brief(parsed), [
    { test: "合取：全过才通过", file: "src/state/zz-probe.test.ts", names: ["合取：全过才通过"] },
    {
      test: "失败步骤附输出末尾",
      file: "src/state/zz-probe.test.ts",
      names: ["失败步骤附输出末尾"],
    },
  ]);
});

test("测试（pytest）：strands 容器的真实输出与本机输出都取失败的测试名与测试文件；名字取测试函数名", () => {
  const strands = parseStepOutput({
    name: "测试",
    command: "hatch test",
    output: fixture("pytest-strands.txt"),
  });
  assert.equal(strands.tool, "pytest");
  assert.equal(strands.kind, "test");
  assert.deepEqual(brief(strands), [
    {
      test: "test_receive_ends_when_stream_closed",
      file: "tests/strands/experimental/bidi/models/test_bedrock.py",
      names: ["test_receive_ends_when_stream_closed"],
    },
  ]);
  const local = parseStepOutput({
    name: "test",
    command: "pytest",
    output: fixture("pytest-local.txt"),
  });
  assert.equal(local.tool, "pytest");
  assert.deepEqual(brief(local), [
    {
      test: "test_registry_keeps_tools",
      file: "tests/strands/agent/test_demo.py",
      names: ["test_registry_keeps_tools"],
    },
    {
      test: "test_values_are_positive[2]",
      file: "tests/strands/agent/test_demo.py",
      names: ["test_values_are_positive"],
    },
    {
      test: "TestAgentLoop::test_stops_on_end_turn",
      file: "tests/strands/agent/test_demo.py",
      names: ["test_stops_on_end_turn"],
    },
  ]);
});

test("分层规则（依赖巡航）：取规则名与两端模块", () => {
  const parsed = parseStepOutput({
    name: "分层",
    command: "npm run deps",
    output: fixture("dependency-cruiser.txt"),
  });
  assert.equal(parsed.tool, "dependency-cruiser");
  assert.equal(parsed.kind, "layer");
  assert.deepEqual(brief(parsed), [
    {
      rule: "state-is-leaf",
      file: "src/state/zz-probe.ts",
      to: "src/application/format.ts",
      names: [],
    },
  ]);
});

test("格式与代码检查（biome、ruff）：取规则名与文件；路径统一为正斜杠", () => {
  const biome = parseStepOutput({
    name: "格式",
    command: "npm run lint",
    output: fixture("biome.txt"),
  });
  assert.equal(biome.tool, "biome");
  assert.equal(biome.kind, "format");
  assert.deepEqual(brief(biome), [
    { rule: "lint/style/useConst", file: "src/state/zz-probe.ts", names: [] },
    { rule: "lint/correctness/noUnusedVariables", file: "src/state/zz-probe.ts", names: [] },
    { rule: "assist/source/organizeImports", file: "src/state/zz-probe.ts", names: [] },
    { rule: "format", file: "src/state/zz-probe.ts", names: [] },
  ]);
  for (const name of ["ruff.txt", "ruff-concise.txt"]) {
    const ruff = parseStepOutput({
      name: "lint",
      command: "hatch fmt --linter",
      output: fixture(name),
    });
    assert.equal(ruff.tool, "ruff", name);
    assert.equal(ruff.kind, "lint", name);
    assert.deepEqual(
      brief(ruff),
      [{ rule: "F401", file: "src/strands/agent/demo.py", names: [] }],
      name
    );
  }
});

test("类型检查（mypy）：取错误码与文件；内置类型名不算涉及的名字", () => {
  const parsed = parseStepOutput({
    name: "types",
    command: "mypy src",
    output: fixture("mypy.txt"),
  });
  assert.equal(parsed.tool, "mypy");
  assert.equal(parsed.kind, "type");
  assert.deepEqual(brief(parsed), [
    { code: "assignment", file: "src/strands/agent/demo.py", names: [] },
    { code: "operator", file: "src/strands/agent/demo.py", names: [] },
  ]);
  const named = parseStepOutput({
    name: "types",
    command: "mypy src",
    output:
      'src/strands/agent/demo.py:9: error: Name "build_prmpt" is not defined  [name-defined]\nFound 1 error in 1 file (checked 1 source file)\n',
  });
  assert.deepEqual(brief(named), [
    { code: "name-defined", file: "src/strands/agent/demo.py", names: ["build_prmpt"] },
  ]);
});

test("无法解析的输出：记为该步的未识别指纹、不猜；步骤类型按步名与命令里的关键字推断", () => {
  const unknownTest = parseStepOutput({
    name: "测试",
    command: "npm run test",
    output: "Segmentation fault (core dumped)\n",
  });
  assert.equal(unknownTest.recognized, false);
  assert.equal(unknownTest.tool, undefined);
  assert.equal(unknownTest.kind, "test");
  assert.deepEqual(unknownTest.fingerprints, [{ tool: "unrecognized", names: [] }]);
  const unknownOther = parseStepOutput({
    name: "构建",
    command: "make all",
    output: "make: *** [all] Error 2\n",
  });
  assert.equal(unknownOther.kind, "unknown");
  assert.equal(unknownOther.recognized, false);
  assert.equal(
    parseStepOutput({ name: "check", command: "pytest -x", output: "boom" }).kind,
    "test"
  );
});

test("指纹键：同一步名、同一工具、同一错误码或规则或测试名、同一文件即同一指纹；行号与报错措辞不进键", () => {
  const first = parseStepOutput({ name: "类型", command: "tsc", output: fixture("tsc-plain.txt") });
  const again = parseStepOutput({
    name: "类型",
    command: "tsc",
    output: fixture("tsc-plain.txt").replace("(2,6)", "(40,1)").replace("'number'", "'boolean'"),
  });
  const keys = first.fingerprints.map((entry) => fingerprintKey("类型", entry));
  assert.deepEqual(
    again.fingerprints.map((entry) => fingerprintKey("类型", entry)),
    keys
  );
  assert.equal(new Set(keys).size, 3);
  assert.notEqual(
    fingerprintKey("类型", first.fingerprints[0] ?? assert.fail()),
    fingerprintKey("格式", first.fingerprints[0] ?? assert.fail())
  );
});

test("同键先去重、再截断：同一文件同一错误码的多行报错合为一个指纹（名字合并），不占上限、不算清单不全", () => {
  const lines = Array.from(
    { length: MAX_FINGERPRINTS_PER_STEP + 5 },
    (_, index) => `src/a.ts(${index + 1},1): error TS2304: Cannot find name 'x${index}'.`
  ).join("\n");
  const parsed = parseStepOutput({ name: "类型", command: "tsc", output: lines });
  assert.equal(parsed.fingerprints.length, 1);
  assert.equal(parsed.fingerprints[0]?.names.length, MAX_FINGERPRINTS_PER_STEP + 5);
  assert.equal(parsed.incomplete, false);
});

test("同一步的指纹数有上限：超出的只保留前若干个（防止一处断链带出成百上千条）", () => {
  const lines = Array.from(
    { length: MAX_FINGERPRINTS_PER_STEP + 15 },
    (_, index) => `src/a${index}.ts(1,1): error TS2304: Cannot find name 'x${index}'.`
  ).join("\n");
  const parsed = parseStepOutput({ name: "类型", command: "tsc", output: lines });
  assert.equal(parsed.fingerprints.length, MAX_FINGERPRINTS_PER_STEP);
  assert.equal(parsed.incomplete, true, "截掉了不同键的指纹：清单不全");
});
