import assert from "node:assert/strict";
import { test } from "node:test";
import { type PytestRun, parseVerboseProgress, runPytestResilient } from "./stream-pytest.ts";

// pytest -v 的实际输出形状：一行"nodeid 结果 [进度]"；超时横幅会把卡住那条的结果挤到若干行之后
const FINISHED = [
  "============================= test session starts ==============================",
  "tests/a/test_x.py::test_one PASSED [ 25%]",
  "tests/a/test_x.py::TestK::test_two[p 1] FAILED [ 50%]",
  "tests/a/test_x.py::test_stuck +++++++++++++++++++ Timeout +++++++++++++++++++",
  "~~~~~ Stack of <unknown> ~~~~~",
  'File "x.py", line 3, in run',
  "+++++++++++++++++++ Timeout +++++++++++++++++++",
  "FAILED                                                                   [ 75%]",
  "tests/a/test_x.py::test_four SKIPPED (why) [100%]",
  "=========================== short test summary info ============================",
  "FAILED tests/a/test_x.py::TestK::test_two[p 1] - assert 1 == 2",
].join("\n");

test("-v 进度解析：逐条取结果（带空格的参数化标识、被超时横幅拆开的结果），不把汇总区的行当作进度", () => {
  const p = parseVerboseProgress(FINISHED);
  assert.deepEqual(p.completed, [
    { nodeid: "tests/a/test_x.py::test_one", outcome: "passed" },
    { nodeid: "tests/a/test_x.py::TestK::test_two[p 1]", outcome: "failed" },
    { nodeid: "tests/a/test_x.py::test_stuck", outcome: "failed" },
    { nodeid: "tests/a/test_x.py::test_four", outcome: "skipped" },
  ]);
  assert.equal(p.running, null);
});

test("-v 进度解析：被杀时最后一条只有标识没有结果，即卡住的用例", () => {
  const killed = [
    "tests/a/test_x.py::test_one PASSED [ 25%]",
    "tests/a/test_x.py::test_stuck +++++++++ Timeout +++++++++",
    "~~~~~ Stack ~~~~~",
  ].join("\n");
  const p = parseVerboseProgress(killed);
  assert.deepEqual(p.completed, [{ nodeid: "tests/a/test_x.py::test_one", outcome: "passed" }]);
  assert.equal(p.running, "tests/a/test_x.py::test_stuck");
  assert.equal(
    parseVerboseProgress("tests/a/test_y.py::test_z ").running,
    "tests/a/test_y.py::test_z"
  );
});

const junit = (cases: [string, "passed" | "failed"][]) =>
  `<testsuites><testsuite name="pytest">${cases
    .map(([name, o]) =>
      o === "passed"
        ? `<testcase classname="tests.a.test_x" file="tests/a/test_x.py" name="${name}"/>`
        : `<testcase classname="tests.a.test_x" file="tests/a/test_x.py" name="${name}"><failure message="x"/></testcase>`
    )
    .join("")}</testsuite></testsuites>`;

test("韧性运行：写出报告即以报告为准；报告写出前被杀，收回已完成的、卡住的记超时失败，排除两者续跑剩下的", async () => {
  const calls: (readonly string[])[] = [];
  const runs: PytestRun[] = [
    {
      exitCode: 137,
      timedOut: false,
      junit: null,
      output: ["tests/a/test_x.py::test_one PASSED [ 25%]", "tests/a/test_x.py::test_stuck "].join(
        "\n"
      ),
    },
    {
      exitCode: 1,
      timedOut: false,
      junit: junit([
        ["test_three", "passed"],
        ["test_four", "failed"],
      ]),
      output: "",
    },
  ];
  const out = await runPytestResilient(
    async (deselect) => {
      calls.push(deselect);
      return runs.shift() as PytestRun;
    },
    { root: "/measure", relativeBase: "strands-py" }
  );
  assert.deepEqual(calls, [[], ["tests/a/test_x.py::test_one", "tests/a/test_x.py::test_stuck"]]);
  assert.deepEqual(
    out.cases.map((c) => [c.id, c.outcome]),
    [
      ["strands-py/tests/a/test_x.py::test_one", "passed"],
      ["strands-py/tests/a/test_x.py::test_stuck", "failed"],
      ["strands-py/tests/a/test_x.py::test_three", "passed"],
      ["strands-py/tests/a/test_x.py::test_four", "failed"],
    ]
  );
  assert.deepEqual(out.stuck, ["strands-py/tests/a/test_x.py::test_stuck"]);
  assert.equal(out.complete, true);
  assert.equal(out.attempts, 2);
});

test("韧性运行：被杀且没有任何进展（例如收集阶段就被杀）即停下，记为未完成", async () => {
  let n = 0;
  const out = await runPytestResilient(
    async () => {
      n++;
      return { exitCode: 137, timedOut: false, junit: null, output: "collecting ..." };
    },
    { root: "/measure", relativeBase: "strands-py" }
  );
  assert.equal(n, 1);
  assert.equal(out.complete, false);
  assert.deepEqual(out.cases, []);
});
