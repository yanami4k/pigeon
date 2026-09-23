// 测试夹具：合成仓库的出题配置与运行方式、本地"假容器"环境工厂。只供测试使用。
// 约定："测试"是 src/ 下的 *.test.sh（用 grep 断言源文件内容，缺前置时打印与 node 同形的"Cannot find module"），
// "格式化"是把连续空格压成一个，"类型错误"是源文件里的 TYPE-ERROR 标记；junit 报告由一段 sh 逐文件写出。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
  '    if sh "$t" >&3 2>&1; then echo "<testcase name=\\"case\\" file=\\"$t\\"/>";',
  '    else echo "<testcase name=\\"case\\" file=\\"$t\\"><failure message=\\"x\\"/></testcase>"; fi',
  "  done",
  '  echo "</testsuites>"',
  '} > "$out"',
].join("\n");

export const toyRuntime: StreamRepoRuntime = {
  profile: toyProfile,
  verifySteps: [{ name: "测试", command: 'for t in src/*.test.sh; do sh "$t" || exit 1; done' }],
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
  depsLinks: [],
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

// 本地"假容器"：每个作业（每次打开）一个临时目录，用本机 sh 执行同一批脚本；
// 起点由宿主的人的仓库打 bundle 送入，续跑由导出的流历史恢复（与容器实现同一条路）
export function localStreamEnvs(
  base: string,
  bundleOf: (commit: string) => Buffer
): StreamEnvFactory {
  return {
    async open(job, init) {
      const name = `${job.stream}-${job.condition}-${job.attempt}`;
      const root = join(base, "ws", `${name}-${Date.now()}`);
      mkdirSync(root, { recursive: true });
      const ws = new StreamWorkspace(localStreamShell(root));
      if (init.resume !== undefined)
        await ws.restoreFromBundle(init.resume.bundle, init.resume.head);
      else await ws.initFromBundle(bundleOf(init.startCommit), init.startCommit);
      return {
        ws,
        target: { container: "local", root },
        measureRoot: join(base, "measure", name),
        dispose: async () => {},
      };
    },
  };
}
