// 两个被测仓库的出题配置（决策 141、152、153）：文件归类、重置点与验证门命令，开跑前写死。
import type { CommitFacts, RepoProfile, StreamFileKind } from "./stream-manifest.ts";
import { parseJunitCases, type TestCaseResult } from "./stream-measure.ts";
import { runPytestResilient } from "./stream-pytest.ts";
import type { StreamWorkspace } from "./stream-workspace.ts";

// 本仓库单条用例的超时：卡死的用例在这里记失败，不拖到整次运行的墙钟（探针、判题、全量测量、人的基准与验证门同一个）
export const PIGEON_TEST_TIMEOUT_MS = 120_000;
// 本仓库验证门测试步与全量测量都跳过的一条用例（名字前缀，按 node 的 --test-skip-pattern 匹配）：它连续生成两个会话 ID
// 并断言两者按字典序排列，而同一毫秒内生成的 ULID 随机部分不保证单调，人的代码上也时过时不过，判不出 agent 的代码好坏
export const PIGEON_FLAKY_TEST = "listSessionIds：列目录得会话清单（D1：ULID 字典序即时间序）";

// 验证的一个命名分步：一行命令（经 sh 执行），可指定在工作区根下的哪个目录执行。形状与 .pigeon/verify.json 的
// 分步验证配置一致；跑批器把它写进每个作业的治理根，回炉按它逐步验证；验证门（维护步的判定）由同一份分步派生
export interface StreamVerifyStep {
  name: string;
  command: string;
  cwd?: string;
}

// 本仓库流三步（159 修订）：与 package.json 里的同名脚本 check、test、deps 等价（清单范围内每个提交的这几个脚本逐字相同），
// 但写成显式命令、不经 npm run——验证门不能随 agent 改 package.json 而放松。工具取依赖目录里的可执行文件
// （npm run 同样是把它放进 PATH 再执行）；测试步另加单用例超时，并跳过那条时过时不过的用例。
// 实验中不含格式步（lint 脚本的 biome check）：人的代码在不少中间提交上没过格式检查，与 strands 同样处理——
// 格式偏差用 biome check 另算、计入次要指标，不进验证门、不反馈给 agent。日常使用本仓库的验证配置仍为四步
export const PIGEON_VERIFY_STEPS: readonly StreamVerifyStep[] = [
  { name: "类型", command: "node_modules/.bin/tsc -p tsconfig.json --noEmit" },
  {
    name: "测试",
    command: `node --test --test-timeout=${PIGEON_TEST_TIMEOUT_MS} --test-skip-pattern="${PIGEON_FLAKY_TEST}" "src/**/*.test.ts"`,
  },
  { name: "分层", command: "node_modules/.bin/dependency-cruiser src" },
];

// strands 三步，按其 CI 定义（python-test-lint.yml 与 pyproject 的 hatch 脚本），都在 strands-py 下执行。单测只跑 tests/，
// 需要网络的 tests_integ 不在其内；被测包以源码目录直接导入（不做可编辑安装），测量副本里跑的才是副本自己的代码。单测一步：
//   --continue-on-collection-errors：一个文件收集出错不中断整次运行，其余用例照常跑（缺省会一条都不跑）；
//   --reruns 2：与其 CI 一致，失败的用例重跑两次，其间通过即算通过（时过时不过的用例不因一次失败判错）；
//   pytest 在报告写完后若因残留线程或事件循环不退出，外壳等 5 秒后杀掉它；通过与否看报告里有没有失败或出错的用例
//   （不依赖计数属性）；简短汇总里写明超时的用例与收集出错的文件，即验证门给 agent 的反馈；
//   单条超时：其仓库配置为 90 秒、signal 方式，这里显式写死同一值（验证门、判题、全量测量与人的基准同一口径），
//   并以 --rerun-except Timeout 让超时失败的用例不再重跑——带 --reruns 时，超时失败的用例在重跑里挂住后超时不再生效，
//   会一直挂到外层上限。这是与其 CI 唯一的差别：超时失败的用例不重跑，其余失败照常重跑两次
// mypy 的检查范围随历史变化：类型测试目录 tests_typing 在窗口中途才加入（其 CI 自那时起才检查它），之前只查 ./src
const STRANDS_MYPY = "mypy ./src $(test -d tests_typing && echo ./tests_typing)";

export const STRANDS_CASE_TIMEOUT_SEC = 90;
const strandsTimeoutArgs = (seconds: string) =>
  `--timeout ${seconds} --timeout-method signal --rerun-except Timeout`;

export const STRANDS_VERIFY_STEPS: readonly StreamVerifyStep[] = [
  // 其 CI 的 lint 作业只跑 hatch fmt --linter --check（ruff check 与 mypy），不做格式检查：人的代码并非处处按
  // ruff format 排版，加上格式检查会让人的代码也过不了验证门（格式偏差另计入次要指标）
  { name: "ruff", command: "ruff check", cwd: "strands-py" },
  { name: "mypy", command: STRANDS_MYPY, cwd: "strands-py" },
  {
    name: "pytest",
    cwd: "strands-py",
    command: [
      'j=/tmp/pigeon-gate-junit.xml && rm -f "$j" &&',
      '{ PYTHONPATH="$PWD/src" python -m pytest tests -q -p no:cacheprovider --continue-on-collection-errors --reruns 2',
      strandsTimeoutArgs(String(STRANDS_CASE_TIMEOUT_SEC)),
      '-o junit_family=xunit1 --junitxml="$j" & p=$!;',
      'while kill -0 "$p" 2>/dev/null; do if [ -s "$j" ]; then sleep 5; kill -9 "$p" 2>/dev/null; break; fi; sleep 1; done;',
      'wait "$p" 2>/dev/null; true; } &&',
      '[ -s "$j" ] && ! grep -Eq \'<(failure|error)[ />]\' "$j"',
    ].join(" "),
  },
];

// .pigeon/verify.json 的内容：分步验证配置（version 1，steps 与单条 command 二选一）
export function verifyConfigFile(
  steps: readonly StreamVerifyStep[],
  timeoutMs: number
): { version: 1; steps: readonly StreamVerifyStep[]; timeoutMs: number } {
  return { version: 1, steps, timeoutMs };
}

// 由分步派生的一行验证命令（交 sh -c）：各步全跑、各带标题，没过的步另打一行"== 步名 未通过 =="，任一步失败即
// 不通过（与分步验证"各步全跑、各出结论"同一口径）。回炉的验证、维护步的验证门与开跑前置检查都用它
export function verifyScript(steps: readonly StreamVerifyStep[]): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const parts = steps.map(
    (s) =>
      `printf '== %s ==\\n' ${quote(s.name)}; ( ${s.cwd !== undefined ? `cd ${quote(s.cwd)} && ` : ""}${s.command} ) || { s=1; printf '== %s 未通过 ==\\n' ${quote(s.name)}; };`
  );
  return ["s=0;", ...parts, 'exit "$s"'].join(" ");
}

// 从验证命令的输出里取出没过的步
export function failedStepsOf(output: string): string[] {
  return [...output.matchAll(/^== (.+) 未通过 ==$/gm)].map((m) => m[1] as string);
}

export function gateFromSteps(steps: readonly StreamVerifyStep[]): string[] {
  return ["sh", "-c", verifyScript(steps)];
}

const PIGEON_ENV_FILES = new Set([
  "package.json",
  "package-lock.json",
  ".gitattributes",
  ".gitignore",
  ".nvmrc",
  ".npmrc",
]);
// 与源代码同属 agent 的活：机检配置改动随代码一起由 agent 完成，不由程序覆盖
const PIGEON_CONFIG_FILES = new Set(["tsconfig.json", ".dependency-cruiser.js", "biome.json"]);

export function classifyPigeonFile(path: string): StreamFileKind {
  if (path.startsWith("src/")) {
    if (path.endsWith(".test.ts")) return "test";
    // 测试辅助文件（141 ①）：测试用的假模型与夹具。本仓库的命名约定为 fixtures.ts、*-fixtures.ts、testing.ts，
    // 生产代码不引用它们
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === "fixtures.ts" || name.endsWith("-fixtures.ts") || name === "testing.ts")
      return "testaux";
    return "source";
  }
  if (PIGEON_CONFIG_FILES.has(path)) return "source";
  if (PIGEON_ENV_FILES.has(path)) return "env";
  return "other";
}

// 本仓库：逾 20 个文件（按全部文件计）的提交处重置为人的版本（141 ④）
export const PIGEON_RESET_FILE_LIMIT = 20;

export const pigeonProfile: RepoProfile = {
  name: "pigeon-harness",
  classifyFile: classifyPigeonFile,
  resetReason(commit: CommitFacts) {
    return commit.files.length > PIGEON_RESET_FILE_LIMIT
      ? `改动 ${commit.files.length} 个文件，逾 ${PIGEON_RESET_FILE_LIMIT} 个`
      : null;
  },
  gateCommand: gateFromSteps(PIGEON_VERIFY_STEPS),
};

const STRANDS_ROOT = "strands-py/";

export function classifyStrandsFile(path: string): StreamFileKind {
  if (!path.startsWith(STRANDS_ROOT)) return "other";
  const rel = path.slice(STRANDS_ROOT.length);
  if (rel === "pyproject.toml") return "env";
  // pytest 根目录下的 conftest 对全部用例生效，与 tests/ 下的同属测试辅助
  if (rel === "conftest.py") return "testaux";
  if (rel.startsWith("src/")) return rel.endsWith(".py") ? "source" : "other";
  if (rel.startsWith("tests/")) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (name.endsWith(".py") && (name.startsWith("test_") || name.endsWith("_test.py")))
      return "test";
    // conftest、夹具与测试数据
    return "testaux";
  }
  // 类型测试由 mypy 检查，属人写的测试材料，由程序覆盖
  if (rel.startsWith("tests_typing/")) return "testaux";
  // tests_integ 需要网络，不参与判题与全量测量
  return "other";
}

// strands：源代码改动逾 3,000 行处重置；其余提交在"逾 20 个文件"上只数源文件（153）
export const STRANDS_RESET_SOURCE_LINES = 3000;
export const STRANDS_RESET_SOURCE_FILES = 20;

export const strandsProfile: RepoProfile = {
  name: "strands-py",
  classifyFile: classifyStrandsFile,
  resetReason(commit: CommitFacts) {
    const source = commit.files.filter((f) => classifyStrandsFile(f.path) === "source");
    const lines = source.reduce((n, f) => n + f.added + f.deleted, 0);
    if (lines > STRANDS_RESET_SOURCE_LINES)
      return `源代码改动 ${lines} 行，逾 ${STRANDS_RESET_SOURCE_LINES} 行`;
    if (source.length > STRANDS_RESET_SOURCE_FILES) {
      return `改动 ${source.length} 个源文件，逾 ${STRANDS_RESET_SOURCE_FILES} 个`;
    }
    return null;
  },
  gateCommand: gateFromSteps(STRANDS_VERIFY_STEPS),
};

// 次要指标里的一项机检：跑命令，从输出里数出错误条数；数不出时命令成功记 0、失败记 null（未知）
export interface QualityCheck {
  command: string[];
  pattern: RegExp;
}

export function countQuality(
  check: QualityCheck,
  output: string,
  exitCode: number | null
): number | null {
  const counted = [...output.matchAll(new RegExp(check.pattern.source, "g"))];
  if (counted.length === 0) return exitCode === 0 ? 0 : null;
  // 带捕获组的写法取数字（如"Found 3 errors"），否则按出现次数计（如逐条的"error TS2345"）
  return counted[0]?.[1] !== undefined ? Number(counted[0][1]) : counted.length;
}

// 跑一组测试文件得到的逐用例结果
export interface CaseRun {
  cases: TestCaseResult[];
  // 卡死、被记为失败的用例
  stuck: string[];
  // 全部用例都有结果（写出了报告）；否则只拿到了部分
  complete: boolean;
  output: string;
}

export interface RunCasesOptions {
  timeoutMs: number;
  // 在哪个目录跑（缺省工作区根）；报告与中间文件放在 scratch 目录
  cwd?: string;
  scratch: string;
  // 失败的用例再跑几次、其间通过即算通过（探针用，免得时过时不过的用例把题判错）。strands 一律带 --reruns 2
  // （其 CI 的做法），不看这一项；本仓库只在给了这一项时重跑
  rerunFailed?: number;
  // 单条用例的超时秒数（strands，signal 方式，超时失败不重跑）：缺省 STRANDS_CASE_TIMEOUT_SEC，即判题、全量测量与
  // 人的基准同一口径；探针给得更短。本仓库用 node 自己的单用例超时，不看这一项
  caseTimeoutSec?: number;
}

// 这组用例是否全部通过：有结果、全有结果、没有失败（跳过不算失败）
export function allPassed(run: CaseRun): boolean {
  return run.complete && run.cases.length > 0 && run.cases.every((c) => c.outcome !== "failed");
}

// 仓库在容器里怎么跑：判题、全量测量、格式化比对、依赖目录与环境切换。命令都在工作区根执行
export interface StreamRepoRuntime {
  // 次要指标（145）：类型错误、格式错误、分层违规；仓库没有的一项为 null
  quality: {
    type: QualityCheck | null;
    format: QualityCheck | null;
    layer: QualityCheck | null;
  };
  profile: RepoProfile;
  // 分步验证：写进每个作业治理根的 .pigeon/verify.json，开回炉的条件按它逐步验证
  verifySteps: readonly StreamVerifyStep[];
  // 跑用例的方式（命令模板与单条超时等）：人的基准缓存的身份之一，改了它，已落盘的基准不再复用
  casesCommand: string;
  // 跑给定测试文件、取逐用例结果：判题、探针、全量测量与人的基准共用。判定一律看逐用例结果，不看退出码
  runCases(
    ws: StreamWorkspace,
    tests: readonly string[],
    options: RunCasesOptions
  ): Promise<CaseRun>;
  // 格式化（只做格式与 import 整理，不含 lint 自动修复），就地改写给定文件
  formatCommand(files: readonly string[]): string[];
  // 预装在工作区根、被 .gitignore 忽略的依赖目录；测量副本以链接接上
  depsLinks: readonly string[];
  // 写入人的环境文件后执行：按当前依赖声明离线切换到对应的冻结依赖组合；没有则为 null
  envSyncCommand: readonly string[] | null;
  // 按"该步人的提交"切 lint 环境（ruff、mypy 等静态检查所用）：不看 agent 改过的依赖声明。没有按提交的 lint 环境即缺省
  lintSyncCommand?: (commit: string) => readonly string[];
  // 依赖声明文件（相对工作区根）与"按给定的声明文件切运行环境"的命令：跑批器切环境时用人在该步的声明（写到工作区外的
  // 临时位置再交给它），不用 agent 改过的；两者都给了才生效，否则退回 envSyncCommand
  envDeclarationFile?: string;
  envSyncFor?: (declarationFile: string) => readonly string[];
}

async function readOrNull(ws: StreamWorkspace, file: string): Promise<string | null> {
  try {
    const text = (await ws.readFile(file)).toString("utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

// 跑一次、读 node 形式的 junit 报告（本仓库与测试用的合成仓库）
export async function runJunitOnce(
  ws: StreamWorkspace,
  command: (junitPath: string) => string[],
  options: RunCasesOptions
): Promise<CaseRun> {
  const junit = `${options.scratch}/pigeon-cases-junit.xml`;
  await ws.run(["rm", "-f", junit], 30_000, options.cwd);
  const r = await ws.run(command(junit), options.timeoutMs, options.cwd);
  const xml = await readOrNull(ws, junit);
  // 报告写完才算完整：进程在写报告途中被杀会留下没有结尾的文件
  const complete = xml?.includes("</testsuites>") === true && !r.timedOut;
  return {
    cases: xml === null ? [] : parseJunitCases(xml, options.cwd ?? ws.root, "", "node"),
    stuck: [],
    complete,
    output: r.output,
  };
}

export const pigeonRuntime: StreamRepoRuntime = {
  profile: pigeonProfile,
  verifySteps: PIGEON_VERIFY_STEPS,
  casesCommand: `node --test --test-timeout=${PIGEON_TEST_TIMEOUT_MS} --test-skip-pattern=${PIGEON_FLAKY_TEST} --test-reporter=junit --test-reporter=spec <测试文件…>`,
  quality: {
    type: { command: ["node_modules/.bin/tsc", "--noEmit", "-p", "."], pattern: /error TS\d+/ },
    // 格式偏差：与原先验证门里的格式步同一条命令（biome check），只计入次要指标
    format: { command: ["node_modules/.bin/biome", "check", "."], pattern: /Found (\d+) errors?/ },
    layer: {
      command: ["node_modules/.bin/depcruise", "src"],
      pattern: /(\d+) dependency violations?/,
    },
  },
  async runCases(ws, tests, options) {
    const once = (files: readonly string[]) =>
      runJunitOnce(
        ws,
        (junit) => [
          "node",
          "--test",
          `--test-timeout=${PIGEON_TEST_TIMEOUT_MS}`,
          `--test-skip-pattern=${PIGEON_FLAKY_TEST}`,
          "--test-reporter=junit",
          `--test-reporter-destination=${junit}`,
          // 标准输出另留一份逐条报告：失败归因要从报错文案里取找不到的文件与名字
          "--test-reporter=spec",
          "--test-reporter-destination=stdout",
          ...files,
        ],
        options
      );
    const run = await once(tests);
    // 要求重跑时（探针）：有失败用例的测试文件再跑，其间通过的用例改记通过；其余用例的结果不动
    for (let k = 0; k < (options.rerunFailed ?? 0); k++) {
      const failedFiles = [
        ...new Set(run.cases.filter((c) => c.outcome === "failed").map((c) => c.file)),
      ].filter((f): f is string => f !== null);
      if (failedFiles.length === 0) break;
      const again = await once(failedFiles);
      const passed = new Set(again.cases.filter((c) => c.outcome === "passed").map((c) => c.id));
      run.cases = run.cases.map((c) =>
        c.outcome === "failed" && passed.has(c.id) ? { ...c, outcome: "passed" } : c
      );
      run.output = `${run.output}\n${again.output}`;
    }
    return run;
  },
  formatCommand: (files) => [
    "node_modules/.bin/biome",
    "check",
    "--write",
    "--linter-enabled=false",
    ...files,
  ],
  depsLinks: ["node_modules"],
  envSyncCommand: null,
};

// strands 的五套冻结依赖组合与各自的起始提交（产率测量时按窗口内依赖声明的变化冻结）；镜像按偏好顺序装齐，
// 每步由 envSyncCommand 按当前 pyproject 选第一套满足约束的
export const STRANDS_ENV_VARIANTS: readonly { name: string; commit: string }[] = [
  { name: "end", commit: "381ab48ab" },
  { name: "V3", commit: "2acc97487" },
  { name: "V2", commit: "8cd82e63a" },
  { name: "V1", commit: "d12b7b8c2" },
  { name: "V0", commit: "3547e8884" },
];

const inStrands = (tests: readonly string[]) =>
  tests.map((t) => (t.startsWith(STRANDS_ROOT) ? t.slice(STRANDS_ROOT.length) : t));

// strands 跑一组测试的外壳：pytest 在后台跑，外壳每秒看一次——报告写出后等 5 秒杀掉（残留线程或事件循环会让它不退出），
// 到墙钟也杀掉（外层的 timeout 只杀得到外壳，杀不到后台的 pytest）。-v 的逐行进度供被杀时收回已完成的用例
// （兜底：卡在超时打断不了的地方时）。参数：报告路径、墙钟秒数、单条超时秒数，其后为测试文件与 --deselect
export const STRANDS_PYTEST_SCRIPT = [
  'cd strands-py && j="$1"; lim="$2"; ct="$3"; shift 3; rm -f "$j";',
  'PYTHONPATH="$PWD/src" python -m pytest -v -p no:cacheprovider --continue-on-collection-errors --reruns 2',
  strandsTimeoutArgs('"$ct"'),
  '-o junit_family=xunit1 --junitxml="$j" "$@" & p=$!; t=0;',
  'while kill -0 "$p" 2>/dev/null; do',
  'if [ -s "$j" ]; then sleep 5; kill -9 "$p" 2>/dev/null; break; fi;',
  'if [ "$t" -ge "$lim" ]; then kill -9 "$p" 2>/dev/null; break; fi;',
  'sleep 1; t=$((t + 1)); done; wait "$p" 2>/dev/null',
].join(" ");

export const strandsRuntime: StreamRepoRuntime = {
  profile: strandsProfile,
  verifySteps: STRANDS_VERIFY_STEPS,
  casesCommand: `${STRANDS_PYTEST_SCRIPT} [单条超时缺省 ${STRANDS_CASE_TIMEOUT_SEC} 秒]`,
  quality: {
    type: {
      command: ["sh", "-c", `cd strands-py && ${STRANDS_MYPY}`],
      pattern: /Found (\d+) errors?/,
    },
    format: {
      command: ["sh", "-c", "cd strands-py && ruff format --check ."],
      pattern: /(\d+) files? would be reformatted/,
    },
    layer: null,
  },
  async runCases(ws, tests, options) {
    const junit = `${options.scratch}/pigeon-cases-junit.xml`;
    const limitSec = Math.max(1, Math.floor(options.timeoutMs / 1000));
    const out = await runPytestResilient(
      async (attempt) => {
        const r = await ws.run(
          [
            "sh",
            "-c",
            STRANDS_PYTEST_SCRIPT,
            "sh",
            junit,
            String(limitSec),
            String(options.caseTimeoutSec ?? STRANDS_CASE_TIMEOUT_SEC),
            ...attempt.tests,
            ...attempt.deselect.flatMap((d) => ["--deselect", d]),
          ],
          options.timeoutMs + 60_000,
          options.cwd
        );
        return {
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          junit: await readOrNull(ws, junit),
          output: r.output,
        };
      },
      { root: options.cwd ?? ws.root, relativeBase: "strands-py", tests: inStrands(tests) }
    );
    return {
      cases: out.cases,
      stuck: out.stuck,
      complete: out.complete,
      output: out.outputs.join("\n"),
    };
  },
  formatCommand: (files) => [
    "sh",
    "-c",
    'cd strands-py && ruff format -q "$@" && ruff check -q --select I --fix "$@"',
    "sh",
    ...inStrands(files),
  ],
  depsLinks: [],
  // 镜像里的选择脚本：按 strands-py/pyproject.toml 选第一套满足约束的冻结依赖，切换 /opt/venv 链接
  envSyncCommand: ["/opt/stream/select-env", "strands-py/pyproject.toml"],
  // 应修 8：跑批器切环境按人在该步的依赖声明，不按 agent 改过的 pyproject
  envDeclarationFile: "strands-py/pyproject.toml",
  envSyncFor: (file) => ["/opt/stream/select-env", file],
  // v5 镜像起：lint 环境按每个提交自己的提交时间解析，这里按该步人的提交切换（148 修订）
  lintSyncCommand: (commit) => ["/opt/stream/select-lint", commit],
};
