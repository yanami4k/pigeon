import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allPassed,
  failedStepsOf,
  gateFromSteps,
  PIGEON_FLAKY_TEST,
  PIGEON_TEST_TIMEOUT_MS,
  PIGEON_VERIFY_STEPS,
  pigeonRuntime,
  STRANDS_PYTEST_SCRIPT,
  STRANDS_VERIFY_STEPS,
  strandsProfile,
  strandsRuntime,
  verifyConfigFile,
} from "./stream-profiles.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { StreamWorkspace } from "./stream-workspace.ts";

// 假的 python -m pytest，按 pytest 对这几种情形的行为出结果（逐条 -v 进度、xunit1 报告）：
//   测试文件里有 import-error 即收集失败；不带 --continue-on-collection-errors 时整次中断、只报收集错误；
//   其余每行"用例名 pass|fail|hang|slow"，hang 即卡死、超时也打断不了（不再输出、不写报告）；slow 是会挂住、
//   但能被单条超时打断的用例：只有给了 signal 方式的超时且超时失败不重跑（--rerun-except Timeout）时，才按超时判失败、
//   接着跑下一条，否则同 hang（带 --reruns 时，超时失败的重跑里超时不再生效）；--deselect 的用例不跑。
//   收到的超时参数写进报告旁的 .args 文件，供核对各处用的超时值
const FAKE_PYTEST = `#!/bin/sh
shift 2
j=""; cont=0; des=" "; files=""; to=""; tm=""; rx=""
while [ $# -gt 0 ]; do
  case "$1" in
    --junitxml=*) j="\${1#--junitxml=}";;
    --continue-on-collection-errors) cont=1;;
    --deselect) shift; des="$des$1 ";;
    --timeout) shift; to="$1";;
    --timeout-method) shift; tm="$1";;
    --rerun-except) shift; rx="$1";;
    -o|-p|--reruns) shift;;
    -*) ;;
    *) if [ -d "$1" ]; then for x in "$1"/test_*.py; do files="$files $x"; done; else files="$files $1"; fi;;
  esac
  shift
done
echo "$to $tm $rx" > "$j.args"
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
    if [ "$outcome" = slow ]; then
      if [ -n "$to" ] && [ "$tm" = signal ] && [ "$rx" = Timeout ]; then
        echo "FAILED"
        body="$body<testcase classname=\\"$m\\" file=\\"$f\\" name=\\"$name\\"><failure message=\\"Failed: Timeout &gt;$to.0s\\"/></testcase>"
        continue
      fi
      outcome=hang
    fi
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
  // 经 PATH 调用：Linux 上要有可执行位
  writeFileSync(join(bin, "python"), FAKE_PYTEST, { mode: 0o755 });
  writeFileSync(join(bin, "ruff"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "mypy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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

test("strands 逐用例结果：挂住的用例按单条超时（signal）判失败、照常写报告，不进卡死清单也不重跑；缺省 90 秒，探针给 30 秒", async () => {
  const { base, ws } = fakeStrands({
    "test_x.py": "test_one pass\ntest_slow slow\ntest_three pass\n",
  });
  try {
    const args = async () =>
      (await ws.run(["sh", "-c", "cat .git/pigeon-cases-junit.xml.args"], 10_000)).output.trim();
    for (const [caseTimeoutSec, expected] of [
      [undefined, "90 signal Timeout"],
      [30, "30 signal Timeout"],
    ] as const) {
      const run = await strandsRuntime.runCases(ws, ["strands-py/tests/test_x.py"], {
        timeoutMs: 20_000,
        scratch: `${ws.root}/.git`,
        ...(caseTimeoutSec !== undefined ? { caseTimeoutSec } : {}),
      });
      assert.deepEqual(
        run.cases.map((c) => [c.id, c.outcome]),
        [
          ["strands-py/tests/test_x.py::test_one", "passed"],
          ["strands-py/tests/test_x.py::test_slow", "failed"],
          ["strands-py/tests/test_x.py::test_three", "passed"],
        ]
      );
      // 一次运行就写出了报告：超时失败的用例由报告给出，不是兜底路径收回的卡死
      assert.deepEqual(run.stuck, []);
      assert.equal(run.complete, true);
      assert.equal(await args(), expected);
    }
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

test("pigeon 逐用例结果：要求重跑时（探针），有失败的测试文件重跑至多两次，其间通过即算通过；恒失败的仍记失败", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-node-rerun-"));
  try {
    mkdirSync(join(base, ".git"));
    // 第一次跑时留下标记并失败，之后通过：时过时不过
    writeFileSync(
      join(base, "flaky.test.ts"),
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { test } from "node:test";',
        'test("flaky", () => {',
        '  if (!existsSync("marker")) { writeFileSync("marker", "1"); throw new Error("first time"); }',
        "});",
        'test("stable", () => {});',
        'test("later", { skip: true }, () => {});',
      ].join("\n")
    );
    writeFileSync(
      join(base, "broken.test.ts"),
      'import { test } from "node:test";\ntest("always", () => { throw new Error("no"); });\n'
    );
    const inner = localStreamShell(base);
    const ws = new StreamWorkspace({
      root: base,
      sh: (script, options) => inner.sh(`unset NODE_TEST_CONTEXT\n${script}`, options),
    });
    const tests = ["flaky.test.ts", "broken.test.ts"];
    const once = await pigeonRuntime.runCases(ws, tests, {
      timeoutMs: 60_000,
      scratch: `${base}/.git`,
    });
    const sorted = (run: { cases: { id: string; outcome: string }[] }) =>
      run.cases.map((c) => [c.id, c.outcome]).sort();
    assert.deepEqual(sorted(once), [
      ["broken.test.ts::always", "failed"],
      ["flaky.test.ts::flaky", "failed"],
      ["flaky.test.ts::later", "skipped"],
      ["flaky.test.ts::stable", "passed"],
    ]);
    rmSync(join(base, "marker"));
    const retried = await pigeonRuntime.runCases(ws, tests, {
      timeoutMs: 60_000,
      scratch: `${base}/.git`,
      rerunFailed: 2,
    });
    assert.deepEqual(sorted(retried), [
      ["broken.test.ts::always", "failed"],
      ["flaky.test.ts::flaky", "passed"],
      ["flaky.test.ts::later", "skipped"],
      ["flaky.test.ts::stable", "passed"],
    ]);
    assert.equal(retried.complete, true);
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

test("pigeon：那条时过时不过的用例（同一毫秒内的 ULID 随机部分不保证单调）在验证门测试步与全量测量里都跳过", async () => {
  assert.equal(PIGEON_FLAKY_TEST, "listSessionIds：列目录得会话清单（D1：ULID 字典序即时间序）");
  const gate = PIGEON_VERIFY_STEPS.find((s) => s.name === "测试")?.command ?? "";
  assert.ok(gate.includes(`--test-skip-pattern="${PIGEON_FLAKY_TEST}"`), gate);
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
  assert.ok(
    commands.some((c) => c[0] === "node" && c.includes(`--test-skip-pattern=${PIGEON_FLAKY_TEST}`))
  );
});

test("分步验证：本仓库流三步（类型、测试、分层；格式另计为次要指标），测试步带 120 秒单用例超时；strands 三步（ruff、mypy、pytest）都在 strands-py 下执行", () => {
  assert.deepEqual(
    PIGEON_VERIFY_STEPS.map((s) => s.name),
    ["类型", "测试", "分层"]
  );
  // 实验中验证门不含格式步（159 修订）：格式偏差用 biome check 另算，计入次要指标、不反馈给 agent
  assert.deepEqual(pigeonRuntime.quality.format?.command, [
    "node_modules/.bin/biome",
    "check",
    ".",
  ]);
  // 显式命令，不经 npm run 脚本（agent 改 package.json 就能放松验证门）；与清单范围内各提交的同名脚本逐字等价
  assert.deepEqual(
    PIGEON_VERIFY_STEPS.map((s) => s.command),
    [
      "node_modules/.bin/tsc -p tsconfig.json --noEmit",
      `node --test --test-timeout=120000 --test-skip-pattern="${PIGEON_FLAKY_TEST}" "src/**/*.test.ts"`,
      "node_modules/.bin/dependency-cruiser src",
    ]
  );
  assert.ok(PIGEON_VERIFY_STEPS.every((s) => !/\bnpm\b/.test(s.command)));
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
  // 与其 CI 一致：失败的用例重跑两次（验证门与逐用例运行——探针、判题、全量测量、人的基准——同一口径）
  assert.match(STRANDS_VERIFY_STEPS[2]?.command ?? "", /--reruns 2/);
  assert.match(STRANDS_PYTEST_SCRIPT, /--reruns 2/);
  // 单条超时用 signal 方式，超时失败的用例不重跑（带 --reruns 时重跑里超时不再生效，会挂到墙钟）：
  // 验证门 90 秒（与其仓库配置一致，也与全量测量、人的基准同一口径）；外壳的超时值由调用方给
  assert.match(
    STRANDS_VERIFY_STEPS[2]?.command ?? "",
    /--timeout 90 --timeout-method signal --rerun-except Timeout/
  );
  assert.match(
    STRANDS_PYTEST_SCRIPT,
    /--timeout "\$ct" --timeout-method signal --rerun-except Timeout/
  );
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
    assert.deepEqual(failedStepsOf(failing.output), ["二"]);
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
