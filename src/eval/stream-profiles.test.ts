import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allPassed,
  gateFromSteps,
  PIGEON_TEST_TIMEOUT_MS,
  PIGEON_VERIFY_STEPS,
  pigeonRuntime,
  STRANDS_VERIFY_STEPS,
  strandsProfile,
  strandsRuntime,
  verifyConfigFile,
} from "./stream-profiles.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { StreamWorkspace } from "./stream-workspace.ts";

// 假的 python -m pytest，按 pytest 对这几种情形的行为出结果（逐条 -v 进度、xunit1 报告）：
//   测试文件里有 import-error 即收集失败；不带 --continue-on-collection-errors 时整次中断、只报收集错误；
//   其余每行"用例名 pass|fail|hang"，hang 即卡死（不再输出、不写报告）；--deselect 的用例不跑
const FAKE_PYTEST = `#!/bin/sh
shift 2
j=""; cont=0; des=" "; files=""
while [ $# -gt 0 ]; do
  case "$1" in
    --junitxml=*) j="\${1#--junitxml=}";;
    --continue-on-collection-errors) cont=1;;
    --deselect) shift; des="$des$1 ";;
    -o|-p) shift;;
    -*) ;;
    *) if [ -d "$1" ]; then for x in "$1"/test_*.py; do files="$files $x"; done; else files="$files $1"; fi;;
  esac
  shift
done
body=""; broken=""
for f in $files; do
  if grep -q import-error "$f"; then
    m=$(echo "\${f%.py}" | tr / .)
    broken="$broken $f"
    body="$body<testcase classname=\\"\\" name=\\"$m\\" file=\\"$f\\"><error message=\\"collection failure\\">ImportError</error></testcase>"
  fi
done
report() { echo "<testsuites><testsuite name=\\"pytest\\">$body</testsuite></testsuites>" > "$j"; }
if [ -n "$broken" ] && [ "$cont" = 0 ]; then
  for f in $broken; do echo "ERROR $f - ImportError"; done
  echo "!!! Interrupted: 1 error during collection !!!"
  report; exit 2
fi
for f in $files; do
  grep -q import-error "$f" && continue
  m=$(echo "\${f%.py}" | tr / .)
  while read -r name outcome; do
    [ -z "$name" ] && continue
    id="$f::$name"
    case "$des" in *" $id "*) continue;; esac
    printf '%s ' "$id"
    if [ "$outcome" = hang ]; then echo; exec sleep 60; fi
    if [ "$outcome" = pass ]; then
      echo "PASSED"
      body="$body<testcase classname=\\"$m\\" file=\\"$f\\" name=\\"$name\\"/>"
    else
      echo "FAILED"
      body="$body<testcase classname=\\"$m\\" file=\\"$f\\" name=\\"$name\\"><failure message=\\"x\\"/></testcase>"
    fi
  done < "$f"
done
echo "=========================== short test summary info ============================"
for f in $broken; do echo "ERROR $f - ImportError"; done
report
`;

const posix = (p: string) =>
  p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

// 合成的 strands 工作区：strands-py/tests 下按给定内容建测试文件；PATH 最前放假的 python、ruff、mypy
function fakeStrands(tests: Record<string, string>): { base: string; ws: StreamWorkspace } {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-pytest-"));
  const root = join(base, "ws");
  const bin = join(base, "bin");
  mkdirSync(join(root, "strands-py", "tests"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(bin);
  writeFileSync(join(bin, "python"), FAKE_PYTEST);
  writeFileSync(join(bin, "ruff"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "mypy"), "#!/bin/sh\nexit 0\n");
  for (const [name, content] of Object.entries(tests)) {
    writeFileSync(join(root, "strands-py", "tests", name), content);
  }
  const inner = localStreamShell(root);
  const ws = new StreamWorkspace({
    root,
    sh: (script, options) => inner.sh(`export PATH="${posix(bin)}:$PATH"\n${script}`, options),
  });
  return { base, ws };
}

test("strands 逐用例结果：一个测试文件导入失败，其余文件的用例照常跑、照常计入，出错的文件记一条失败", async () => {
  const { base, ws } = fakeStrands({
    "test_ok.py": "test_a pass\ntest_b fail\n",
    "test_broken.py": "import-error\n",
    "test_zz.py": "test_c pass\n",
  });
  try {
    const run = await strandsRuntime.runCases(
      ws,
      [
        "strands-py/tests/test_broken.py",
        "strands-py/tests/test_ok.py",
        "strands-py/tests/test_zz.py",
      ],
      { timeoutMs: 60_000, scratch: `${ws.root}/.git` }
    );
    assert.deepEqual(
      run.cases.map((c) => [c.id, c.outcome]),
      [
        ["strands-py/tests/test_broken.py::<collection>", "failed"],
        ["strands-py/tests/test_ok.py::test_a", "passed"],
        ["strands-py/tests/test_ok.py::test_b", "failed"],
        ["strands-py/tests/test_zz.py::test_c", "passed"],
      ]
    );
    assert.equal(run.complete, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strands 逐用例结果：一条用例卡死到墙钟被杀，已完成的用例照收，卡死的记失败，排除两者续跑剩下的", async () => {
  const { base, ws } = fakeStrands({
    "test_x.py": "test_one pass\ntest_stuck hang\ntest_three pass\ntest_four fail\n",
  });
  try {
    const run = await strandsRuntime.runCases(ws, ["strands-py/tests/test_x.py"], {
      timeoutMs: 3_000,
      scratch: `${ws.root}/.git`,
    });
    assert.deepEqual(
      run.cases.map((c) => [c.id, c.outcome]),
      [
        ["strands-py/tests/test_x.py::test_one", "passed"],
        ["strands-py/tests/test_x.py::test_stuck", "failed"],
        ["strands-py/tests/test_x.py::test_three", "passed"],
        ["strands-py/tests/test_x.py::test_four", "failed"],
      ]
    );
    assert.deepEqual(run.stuck, ["strands-py/tests/test_x.py::test_stuck"]);
    assert.equal(run.complete, true);
    assert.equal(allPassed(run), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pigeon 逐用例结果：报告之外，输出里留有测试加载失败的报错文案（失败归因从这里取找不到的文件）", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-node-"));
  try {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, "x.test.ts"), 'import "./nope.ts";\n');
    writeFileSync(
      join(base, "y.test.ts"),
      'import { test } from "node:test";\ntest("ok", () => {});\n'
    );
    // 外层 node --test 留下的 NODE_TEST_CONTEXT 会让里面的 node --test 改走父进程协议、不写报告：清掉（容器里没有它）
    const inner = localStreamShell(base);
    const ws = new StreamWorkspace({
      root: base,
      sh: (script, options) => inner.sh(`unset NODE_TEST_CONTEXT\n${script}`, options),
    });
    const run = await pigeonRuntime.runCases(ws, ["x.test.ts", "y.test.ts"], {
      timeoutMs: 60_000,
      scratch: `${base}/.git`,
    });
    assert.deepEqual(
      run.cases.map((c) => [c.file, c.outcome]),
      [
        ["x.test.ts", "failed"],
        ["y.test.ts", "passed"],
      ]
    );
    assert.match(run.output, /Cannot find module '[^']*nope\.ts'/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pigeon 逐用例结果：单条用例带 120 秒超时，卡死的用例记失败、不拖到整次运行的墙钟", async () => {
  const commands: string[][] = [];
  const ws = {
    root: "/w",
    run: async (command: readonly string[]) => {
      commands.push([...command]);
      return { exitCode: 0, timedOut: false, output: "" };
    },
    readFile: async () => Buffer.from(""),
  } as unknown as StreamWorkspace;
  await pigeonRuntime.runCases(ws, ["src/a.test.ts"], { timeoutMs: 60_000, scratch: "/w/.git" });
  assert.equal(PIGEON_TEST_TIMEOUT_MS, 120_000);
  assert.ok(commands.some((c) => c[0] === "node" && c.includes("--test-timeout=120000")));
});

test("分步验证：本仓库四步（格式、类型、测试、分层），测试步带 120 秒单用例超时；strands 三步（ruff、mypy、pytest）都在 strands-py 下执行", () => {
  assert.deepEqual(
    PIGEON_VERIFY_STEPS.map((s) => s.name),
    ["格式", "类型", "测试", "分层"]
  );
  assert.equal(
    PIGEON_VERIFY_STEPS.find((s) => s.name === "测试")?.command,
    'node --test --test-timeout=120000 "src/**/*.test.ts"'
  );
  assert.ok(PIGEON_VERIFY_STEPS.every((s) => s.cwd === undefined));
  assert.deepEqual(
    STRANDS_VERIFY_STEPS.map((s) => [s.name, s.cwd]),
    [
      ["ruff", "strands-py"],
      ["mypy", "strands-py"],
      ["pytest", "strands-py"],
    ]
  );
  assert.match(STRANDS_VERIFY_STEPS[2]?.command ?? "", /--continue-on-collection-errors/);
  // 与其 CI 的 lint 作业一致：只做 ruff check，不做格式检查
  assert.equal(STRANDS_VERIFY_STEPS[0]?.command, "ruff check");
  // 类型测试目录在窗口中途才加入：没有它的提交上只查 ./src（写死两个目录会让人的代码也过不了验证门）
  assert.equal(
    STRANDS_VERIFY_STEPS[1]?.command,
    "mypy ./src $(test -d tests_typing && echo ./tests_typing)"
  );
  assert.deepEqual(strandsRuntime.quality.type?.command, [
    "sh",
    "-c",
    `cd strands-py && ${STRANDS_VERIFY_STEPS[1]?.command}`,
  ]);
  // 写进 .pigeon/verify.json 的形状：与分步验证配置同一形状（version、steps、timeoutMs）
  assert.deepEqual(verifyConfigFile(STRANDS_VERIFY_STEPS, 1_800_000), {
    version: 1,
    steps: STRANDS_VERIFY_STEPS,
    timeoutMs: 1_800_000,
  });
});

test("验证门由分步派生：各步全跑、各自带标题，任一步失败即不通过（失败之后的步照样跑）", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-gate-"));
  try {
    mkdirSync(join(base, "sub"));
    writeFileSync(join(base, "sub", "marker.txt"), "in-sub\n");
    const ws = new StreamWorkspace(localStreamShell(base));
    const steps = [
      { name: "一", command: "echo first-ran" },
      { name: "二", command: "exit 3" },
      { name: "三", command: "cat marker.txt", cwd: "sub" },
    ];
    const failing = await ws.run(gateFromSteps(steps), 60_000);
    assert.notEqual(failing.exitCode, 0);
    assert.match(
      failing.output,
      /== 一 ==[\s\S]*first-ran[\s\S]*== 二 ==[\s\S]*== 三 ==[\s\S]*in-sub/
    );
    const passing = await ws.run(
      gateFromSteps([steps[0], steps[2]].filter((s) => s !== undefined)),
      60_000
    );
    assert.equal(passing.exitCode, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("strands 验证门：一个测试文件导入失败时不通过，反馈里既有出错的文件，也有其余文件里失败的用例", async () => {
  const { base, ws } = fakeStrands({
    "test_broken.py": "import-error\n",
    "test_ok.py": "test_a pass\ntest_b fail\n",
  });
  try {
    const r = await ws.run([...strandsProfile.gateCommand], 60_000);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.output, /ERROR tests\/test_broken\.py/);
    assert.match(r.output, /tests\/test_ok\.py::test_b FAILED/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
