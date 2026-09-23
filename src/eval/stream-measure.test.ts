import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countPassRate,
  parseJunitCases,
  relativeTestPath,
  type TestCaseResult,
  taskPassRate,
} from "./stream-measure.ts";

// node --test --test-reporter=junit 的实际输出形状（Node 24）：顶层用例直接挂在 testsuites 下，describe 为嵌套 testsuite，
// 加载失败的测试文件记成一条以文件名命名的失败用例
const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="a ok" time="0.004" classname="test" file="/measure/src/one.test.ts"/>
	<testcase name="b &lt;fail&gt;" time="0.0004" classname="test" file="/measure/src/one.test.ts" failure="x">
		<failure type="testCodeFailure" message="x">
[Error [ERR_TEST_FAILURE]: x]
		</failure>
	</testcase>
	<testsuite name="grp" time="0.001" disabled="0" errors="0" tests="2" failures="0" skipped="1" hostname="h">
		<testcase name="c" time="0.0004" classname="test" file="/measure/src/one.test.ts"/>
		<testcase name="d" time="0.0001" classname="test" file="/measure/src/one.test.ts">
			<skipped type="skipped" message="todo"/>
		</testcase>
	</testsuite>
	<testcase name="two.test.ts" time="0.33" classname="test" file="/measure/src/two.test.ts" failure="test failed">
		<failure type="testCodeFailure" message="test failed">[Error: test failed]</failure>
	</testcase>
	<!-- tests 4 -->
	<!-- pass 2 -->
</testsuites>`;

// pytest -o junit_family=xunit1 的输出形状：用例带相对运行目录的 file；收集失败为 classname 为空的出错用例
// （pytest 9 起也带 file，更早的版本没有）
const PYTEST_JUNIT = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4" time="1.2"><testcase classname="tests.strands.test_a" file="tests/strands/test_a.py" line="3" name="test_ok" time="0.001" /><testcase classname="tests.strands.test_a.TestX" file="tests/strands/test_a.py" line="9" name="test_fail[p-1]" time="0.002"><failure message="assert 1 == 2">E   assert 1 == 2</failure></testcase><testcase classname="tests.strands.test_a" file="tests/strands/test_a.py" line="20" name="test_skip" time="0"><skipped type="pytest.skip" message="later">skip</skipped></testcase><testcase classname="" name="tests.strands.test_broken" time="0"><error message="collection failure">ImportError: cannot import name 'X'</error></testcase><testcase classname="" name="tests.strands.test_gone" file="tests/strands/test_gone.py" time="0.000"><error message="collection failure">ModuleNotFoundError</error></testcase></testsuite></testsuites>`;

test("junit 解析（node 报告器）：路径相对工作区根、describe 进入标识、实体解码、跳过与加载失败、用例耗时", () => {
  const cases = parseJunitCases(NODE_JUNIT, "/measure");
  assert.deepEqual(cases, [
    { id: "src/one.test.ts::a ok", file: "src/one.test.ts", outcome: "passed", seconds: 0.004 },
    {
      id: "src/one.test.ts::b <fail>",
      file: "src/one.test.ts",
      outcome: "failed",
      seconds: 0.0004,
    },
    { id: "src/one.test.ts::grp::c", file: "src/one.test.ts", outcome: "passed", seconds: 0.0004 },
    { id: "src/one.test.ts::grp::d", file: "src/one.test.ts", outcome: "skipped", seconds: 0.0001 },
    {
      id: "src/two.test.ts::two.test.ts",
      file: "src/two.test.ts",
      outcome: "failed",
      seconds: 0.33,
    },
  ]);
});

test("junit 解析（pytest xunit1）：标识与 pytest 的 nodeid 一致（文件::类::用例），收集失败按模块换算出文件、记为失败", () => {
  const cases = parseJunitCases(PYTEST_JUNIT, "/measure", "strands-py", "pytest");
  assert.deepEqual(
    cases.map((c) => [c.id, c.file, c.outcome]),
    [
      [
        "strands-py/tests/strands/test_a.py::test_ok",
        "strands-py/tests/strands/test_a.py",
        "passed",
      ],
      [
        "strands-py/tests/strands/test_a.py::TestX::test_fail[p-1]",
        "strands-py/tests/strands/test_a.py",
        "failed",
      ],
      [
        "strands-py/tests/strands/test_a.py::test_skip",
        "strands-py/tests/strands/test_a.py",
        "skipped",
      ],
      [
        "strands-py/tests/strands/test_broken.py::<collection>",
        "strands-py/tests/strands/test_broken.py",
        "failed",
      ],
      // pytest 9 给收集失败的条目也写 file
      [
        "strands-py/tests/strands/test_gone.py::<collection>",
        "strands-py/tests/strands/test_gone.py",
        "failed",
      ],
    ]
  );
});

test("相对路径换算：绝对路径去根、相对路径补运行目录、根外绝对路径原样", () => {
  assert.equal(relativeTestPath("C:\\w\\src\\a.test.ts", "C:\\w"), "src/a.test.ts");
  assert.equal(relativeTestPath("./tests/a.py", "/measure", "strands-py"), "strands-py/tests/a.py");
  assert.equal(relativeTestPath("/elsewhere/a.py", "/measure", "strands-py"), "/elsewhere/a.py");
  assert.equal(relativeTestPath("tests/a.py", "/measure"), "tests/a.py");
});

function cases(list: [string, string, TestCaseResult["outcome"]][]): TestCaseResult[] {
  return list.map(([file, name, outcome]) => ({ id: `${file}::${name}`, file, outcome }));
}

test("按条数：分母为人的代码上通过的用例；agent 这边缺失或失败都算没过，多出来的用例不计", () => {
  const human = cases([
    ["a.test.ts", "1", "passed"],
    ["a.test.ts", "2", "passed"],
    ["b.test.ts", "1", "passed"],
    ["b.test.ts", "2", "failed"],
  ]);
  const humanPassing = new Set(human.filter((c) => c.outcome === "passed").map((c) => c.id));
  const agent = cases([
    ["a.test.ts", "1", "passed"],
    ["a.test.ts", "2", "failed"],
    ["b.test.ts", "2", "passed"],
    ["c.test.ts", "extra", "passed"],
  ]);
  assert.deepEqual(countPassRate(humanPassing, agent), { passed: 1, total: 3, rate: 1 / 3 });
  assert.deepEqual(countPassRate(new Set(), agent), { passed: 0, total: 0, rate: 1 });
});

test("按题：判题文件里人的代码上通过的用例须全过；人的基准里已无通过用例的题不计入分母", () => {
  const human = cases([
    ["a.test.ts", "1", "passed"],
    ["a.test.ts", "2", "passed"],
    ["b.test.ts", "1", "passed"],
    ["c.test.ts", "1", "failed"],
  ]);
  const agent = cases([
    ["a.test.ts", "1", "passed"],
    ["a.test.ts", "2", "passed"],
    ["b.test.ts", "1", "failed"],
  ]);
  const result = taskPassRate(
    [
      { seq: 1, judgeTests: ["a.test.ts"] },
      { seq: 4, judgeTests: ["a.test.ts", "b.test.ts"] },
      { seq: 6, judgeTests: ["c.test.ts"] },
      { seq: 9, judgeTests: ["gone.test.ts"] },
    ],
    human,
    agent
  );
  assert.deepEqual(result, { passed: 1, total: 2, rate: 0.5, failingSeqs: [4] });
});
