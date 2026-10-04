// 测试夹具：合成仓库的出题配置与运行方式、本地"假容器"环境工厂。只供测试使用。
// 约定："测试"是 src/ 下的 *.test.sh（用 grep 断言源文件内容，缺前置时打印与 node 同形的"Cannot find module"），
// "格式化"是把连续空格压成一个，"类型错误"是源文件里的 TYPE-ERROR 标记；junit 报告由一段 sh 逐文件写出，
// 测试以退出码 5 结束即记为该文件整文件收集失败（"文件::<collection>"，与 pytest 收集失败的伪用例同形）。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoProfile, StreamFileKind } from "./stream-manifest.ts";
import { runJunitOnce, type StreamRepoRuntime } from "./stream-profiles.ts";
import type { StreamEnvFactory } from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { StreamWorkspace } from "./stream-workspace.ts";

export const toyProfile: RepoProfile = {
  name: "toy",
  classifyFile(path): StreamFileKind {
    if (!path.startsWith("src/")) return "other";
    return path.endsWith(".test.sh") ? "test" : "source";
  },
  resetReason: (c) => (c.files.length > 5 ? "大提交" : null),
  gateCommand: ["sh", "-c", 'for t in src/*.test.sh; do sh "$t" || exit 1; done'],
};

const JUNIT_SCRIPT = [
  'out="$1"; shift; exec 3>&1',
  "{",
  '  echo "<testsuites>"',
  "  for t; do",
  '    sh "$t" >&3 2>&1; rc=$?',
  '    if [ "$rc" = 0 ]; then echo "<testcase name=\\"case\\" file=\\"$t\\"/>";',
  '    elif [ "$rc" = 5 ]; then echo "<testcase name=\\"&lt;collection&gt;\\" file=\\"$t\\"><failure message=\\"x\\"/></testcase>";',
  '    else echo "<testcase name=\\"case\\" file=\\"$t\\"><failure message=\\"x\\"/></testcase>"; fi',
  "  done",
  '  echo "</testsuites>"',
  '} > "$out"',
].join("\n");

export const toyRuntime: StreamRepoRuntime = {
  profile: toyProfile,
  verifySteps: [{ name: "测试", command: 'for t in src/*.test.sh; do sh "$t" || exit 1; done' }],
  casesCommand: JUNIT_SCRIPT,
  quality: {
    type: { command: ["sh", "-c", "grep -rh TYPE-ERROR src || true"], pattern: /TYPE-ERROR/ },
    format: null,
    layer: null,
  },
  runCases: (ws, tests, options) =>
    runJunitOnce(ws, (junit) => ["sh", "-c", JUNIT_SCRIPT, "sh", junit, ...tests], options),
  formatCommand: (files) => [
    "sh",
    "-c",
    'for f; do tr -s " " < "$f" > "$f.fmt" && mv "$f.fmt" "$f"; done',
    "sh",
    ...files,
  ],
  envSyncCommand: null,
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// 建一个人的仓库，返回按顺序的提交函数
export function toyRepo(
  dir: string
): (files: Record<string, string | null>, message: string) => string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "human");
  git(dir, "config", "user.email", "human@example.invalid");
  git(dir, "config", "core.autocrlf", "false");
  return (files, message) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        git(dir, "rm", "-q", path);
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
}

// 起点模板：同一提交的起点在本进程里只经 bundle 建一次（与容器实现同一条路），之后每次打开复制一份。复制出的目录与
// 重新建的相同（干净检出、历史已清理）；按提交号区分，提交号即内容，不同测试的仓库之间共用也不会串。
// 用到它的测试文件在 afterAll 里调 removeStartTemplates()：同一个 worker 先后跑多个文件，不能等进程退出才删
const templates = new Map<string, Promise<string>>();
let templateRoot: string | undefined;

function startTemplate(commit: string, bundleOf: (commit: string) => Buffer): Promise<string> {
  let made = templates.get(commit);
  if (made === undefined) {
    if (templateRoot === undefined) {
      const root = mkdtempSync(join(tmpdir(), "pigeon-stream-start-"));
      templateRoot = root;
    }
    const dir = join(templateRoot, commit);
    made = (async () => {
      mkdirSync(dir, { recursive: true });
      await new StreamWorkspace(localStreamShell(dir)).initFromBundle(bundleOf(commit), commit);
      return dir;
    })();
    templates.set(commit, made);
  }
  return made;
}

// 删掉已建的起点模板并清空缓存（之后再用会重新建）
export function removeStartTemplates(): void {
  if (templateRoot !== undefined) rmSync(templateRoot, { recursive: true, force: true });
  templates.clear();
  templateRoot = undefined;
}

// 本地"假容器"：每次打开（每一步、每次重做）一个全新的临时目录，用本机 sh 执行同一批脚本；起点由宿主的人的仓库打
// bundle 送入（与容器实现同一条路，同一提交只建一次、之后复制），用完删掉目录（与丢弃容器同一口径：被忽略的文件不跨步）
export function localStreamEnvs(
  base: string,
  bundleOf: (commit: string) => Buffer
): StreamEnvFactory {
  let opened = 0;
  return {
    async open(job, init) {
      opened += 1;
      const root = join(base, "ws", `${job.stream}-${job.condition}-${job.attempt}-${opened}`);
      const template = await startTemplate(init.startCommit, bundleOf);
      mkdirSync(dirname(root), { recursive: true });
      cpSync(template, root, { recursive: true });
      const ws = new StreamWorkspace(localStreamShell(root));
      return {
        ws,
        target: { container: "local", root },
        dispose: async () => rmSync(root, { recursive: true, force: true }),
      };
    },
  };
}
