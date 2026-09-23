// 两个被测仓库的出题配置（决策 141、152、153）：文件归类、重置点与验证门命令，开跑前写死。
import type { CommitFacts, RepoProfile, StreamFileKind } from "./stream-manifest.ts";

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
  gateCommand: ["npm", "run", "verify"],
};

const STRANDS_ROOT = "strands-py/";

export function classifyStrandsFile(path: string): StreamFileKind {
  if (!path.startsWith(STRANDS_ROOT)) return "other";
  const rel = path.slice(STRANDS_ROOT.length);
  if (rel === "pyproject.toml") return "env";
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
  // 按其 CI 定义（python-test-lint.yml 与 pyproject 的 hatch 脚本）：格式检查、ruff、mypy、单测；
  // 单测只跑 tests/，需要网络的 tests_integ 不在其内。被测包以源码目录直接导入（不做可编辑安装），
  // 测量副本里跑的才是副本自己的代码。仓库给 pytest 设了每条 90 秒的单测超时，这里只把超时的结束方式改为 thread：
  // 缺省的信号方式打断不了异步循环里失控的用例（窗口内有一条在父提交上失控、4 分钟内吃满 4 GB）
  gateCommand: [
    "sh",
    "-c",
    'cd strands-py && ruff format --check && ruff check && mypy ./src ./tests_typing && PYTHONPATH="$PWD/src" python -m pytest tests -q -p no:cacheprovider -o timeout_method=thread',
  ],
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

// 仓库在容器里怎么跑：判题、全量测量、格式化比对、依赖目录与环境切换。命令都在工作区根执行
export interface StreamRepoRuntime {
  // 次要指标（145）：类型错误、格式错误、分层违规；仓库没有的一项为 null
  quality: {
    type: QualityCheck | null;
    format: QualityCheck | null;
    layer: QualityCheck | null;
  };
  profile: RepoProfile;
  // 只要退出码：给定测试文件全部通过即 0
  testCommand(tests: readonly string[]): string[];
  // 全量测量：同上，另把 junit 报告写到 junitPath
  junitTestCommand(tests: readonly string[], junitPath: string): string[];
  // junit 报告里相对路径的起算目录（相对仓库根）
  junitRelativeBase: string;
  // 格式化（只做格式与 import 整理，不含 lint 自动修复），就地改写给定文件
  formatCommand(files: readonly string[]): string[];
  // 预装在工作区根、被 .gitignore 忽略的依赖目录；测量副本以链接接上
  depsLinks: readonly string[];
  // 写入人的环境文件后执行：按当前依赖声明离线切换到对应的冻结依赖组合；没有则为 null
  envSyncCommand: readonly string[] | null;
}

export const pigeonRuntime: StreamRepoRuntime = {
  profile: pigeonProfile,
  quality: {
    type: { command: ["node_modules/.bin/tsc", "--noEmit", "-p", "."], pattern: /error TS\d+/ },
    format: { command: ["node_modules/.bin/biome", "format", "."], pattern: /Found (\d+) errors?/ },
    layer: {
      command: ["node_modules/.bin/depcruise", "src"],
      pattern: /(\d+) dependency violations?/,
    },
  },
  testCommand: (tests) => ["node", "--test", ...tests],
  junitTestCommand: (tests, junitPath) => [
    "node",
    "--test",
    "--test-reporter=junit",
    `--test-reporter-destination=${junitPath}`,
    ...tests,
  ],
  junitRelativeBase: "",
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

export const strandsRuntime: StreamRepoRuntime = {
  profile: strandsProfile,
  quality: {
    type: {
      command: ["sh", "-c", "cd strands-py && mypy ./src ./tests_typing"],
      pattern: /Found (\d+) errors?/,
    },
    format: {
      command: ["sh", "-c", "cd strands-py && ruff format --check ."],
      pattern: /(\d+) files? would be reformatted/,
    },
    layer: null,
  },
  testCommand: (tests) => [
    "sh",
    "-c",
    'cd strands-py && PYTHONPATH="$PWD/src" python -m pytest -q -p no:cacheprovider -o timeout_method=thread "$@"',
    "sh",
    ...inStrands(tests),
  ],
  junitTestCommand: (tests, junitPath) => [
    "sh",
    "-c",
    'cd strands-py && j="$1"; shift; PYTHONPATH="$PWD/src" python -m pytest -q -p no:cacheprovider -o timeout_method=thread -o junit_family=xunit1 --junitxml="$j" "$@"',
    "sh",
    junitPath,
    ...inStrands(tests),
  ],
  junitRelativeBase: "strands-py",
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
};
