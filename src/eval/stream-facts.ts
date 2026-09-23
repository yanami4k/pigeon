// 流清单的取事实部分（决策 127、141、153）：从人的仓库取逐提交的文件改动，在 Linux 容器里测判题探针与格式化比对，
// 再交给 stream-manifest.ts 的纯规则出清单。判题只在容器里做（Windows 上有平台差异）。
// 探针所在的参考工作区装着人的完整历史——它只用于出题，不是 agent 的工作区，看得到未来无妨。
import { execFileSync } from "node:child_process";
import {
  type CommitFacts,
  type CommitFileChange,
  composeStreamManifest,
  type HumanFileOp,
  type StreamManifest,
} from "./stream-manifest.ts";
import type { StreamRepoRuntime } from "./stream-profiles.ts";
import { type StreamShell, StreamWorkspace, shellQuote } from "./stream-workspace.ts";

export interface RangeCommit {
  sha: string;
  parent: string;
  message: string;
}

// 人的仓库（宿主侧，只读）
export interface HumanRepo {
  // rangeStart 之后到 rangeEnd（含）的主线提交，按时间正序
  firstParentLog(rangeStart: string, rangeEnd: string): RangeCommit[];
  // 父提交到本提交的文件改动（关闭改名检测）
  changes(parent: string, sha: string): CommitFileChange[];
  show(sha: string, path: string): Buffer;
  resolve(rev: string): string;
  // 含 rev 可达历史的 bundle（单一分支）
  bundle(rev: string): Buffer;
  // 某提交里的全部文件及其 blob 哈希
  tree(sha: string): { path: string; blob: string }[];
  // 父提交到本提交在给定路径里的新增行（不含 diff 头）
  addedLines(parent: string, sha: string, paths: readonly string[]): string[];
}

export function gitHumanRepo(dir: string): HumanRepo {
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", dir, ...args], { maxBuffer: 1 << 30 });
  const text = (args: readonly string[]) => git(args).toString("utf8");
  return {
    firstParentLog(rangeStart, rangeEnd) {
      return text([
        "log",
        "--first-parent",
        "--reverse",
        "--format=%H%x00%P%x00%B%x1e",
        `${rangeStart}..${rangeEnd}`,
      ])
        .split("\x1e")
        .map((s) => s.replace(/^\n/, ""))
        .filter((s) => s !== "")
        .map((s) => {
          const [sha = "", parents = "", message = ""] = s.split("\x00");
          return { sha, parent: parents.split(" ")[0] ?? "", message: message.trimEnd() };
        });
    },
    changes(parent, sha) {
      // -z 输出为"状态\0路径\0"成对出现
      const status = new Map<string, string>();
      const parts = text(["diff", "--no-renames", "--name-status", "-z", parent, sha]).split(
        "\x00"
      );
      for (let i = 0; i + 1 < parts.length; i += 2)
        status.set(parts[i + 1] ?? "", (parts[i] ?? "").charAt(0));
      return text(["diff", "--no-renames", "--numstat", "-z", parent, sha])
        .split("\x00")
        .filter((l) => l !== "")
        .map((l) => {
          const [added = "0", deleted = "0", path = ""] = l.split("\t");
          const s = status.get(path);
          const st: CommitFileChange["status"] = s === "A" ? "A" : s === "D" ? "D" : "M";
          return {
            path,
            status: st,
            added: added === "-" ? 0 : Number(added),
            deleted: deleted === "-" ? 0 : Number(deleted),
          };
        });
    },
    show: (sha, path) => git(["show", `${sha}:${path}`]),
    tree(sha) {
      // -z 输出为"<mode> <type> <blob>\t<路径>\0"
      return text(["ls-tree", "-r", "-z", sha])
        .split("\x00")
        .filter((l) => l !== "")
        .map((l) => {
          const tab = l.indexOf("\t");
          const [, , blob = ""] = l.slice(0, tab).split(" ");
          return { path: l.slice(tab + 1), blob };
        });
    },
    addedLines(parent, sha, paths) {
      if (paths.length === 0) return [];
      return text(["diff", "--no-renames", "--unified=0", parent, sha, "--", ...paths])
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1));
    },
    resolve: (rev) => text(["rev-parse", "--verify", `${rev}^{commit}`]).trim(),
    bundle(rev) {
      const sha = text(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
      const ref = `refs/pigeon-stream/bundle-${sha}`;
      git(["update-ref", ref, sha]);
      try {
        return git(["bundle", "create", "-", ref]);
      } finally {
        git(["update-ref", "-d", ref]);
      }
    },
  };
}

// 参考工作区：装有人的完整历史，按需检出任意提交、叠上人的文件后跑命令
export class ReferenceWorkspace {
  readonly ws: StreamWorkspace;
  private readonly shell: StreamShell;

  constructor(shell: StreamShell) {
    this.shell = shell;
    this.ws = new StreamWorkspace(shell);
  }

  async init(bundle: Buffer, head: string): Promise<void> {
    await this.ws.restoreFromBundle(bundle, head);
  }

  // 检出提交，工作区复原到该提交（被忽略的依赖目录不动）
  async checkout(sha: string): Promise<void> {
    const r = await this.shell.sh('git checkout -q -f "$1" && git clean -fdq', {
      args: [sha],
      timeoutMs: 300_000,
    });
    if (r.exitCode !== 0) throw new Error(`检出 ${sha} 失败：${r.stderr.trim()}`);
  }

  // 工作区里的给定文件与某提交是否逐字一致
  async sameAs(sha: string, files: readonly string[]): Promise<boolean> {
    const r = await this.shell.sh(
      `git diff --quiet ${shellQuote(sha)} -- ${files.map(shellQuote).join(" ")}`
    );
    if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`比对失败：${r.stderr.trim()}`);
    return r.exitCode === 0;
  }
}

export interface ProbeOptions {
  // 单次判题的墙钟上限
  testTimeoutMs: number;
  // 进度回报（可选）
  log?: (line: string) => void;
}

export interface CollectedFacts {
  commits: CommitFacts[];
  // 每次探针的原始记录，随清单保存备查
  probes: ProbeRecord[];
}

export interface ProbeRecord {
  sha: string;
  kind: "parent" | "commit" | "next" | "format";
  base: string;
  tests: readonly string[];
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  outputTail: string;
}

function tail(text: string, max = 2000): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

// 逐提交取事实。探针按规则需要才测：带测试改动的提交测父与本身；本身也不过的再测下一个提交（红测试对）；
// 改了源代码且不成题的测格式化比对。重置点不测
export async function collectStreamFacts(input: {
  human: HumanRepo;
  runtime: StreamRepoRuntime;
  reference: ReferenceWorkspace;
  rangeStart: string;
  rangeEnd: string;
  options: ProbeOptions;
}): Promise<CollectedFacts> {
  const { human, runtime, reference, options } = input;
  const profile = runtime.profile;
  const log = options.log ?? (() => {});
  const range = human.firstParentLog(input.rangeStart, input.rangeEnd);
  const probes: ProbeRecord[] = [];
  const commits: CommitFacts[] = [];

  const runTests = async (
    sha: string,
    kind: ProbeRecord["kind"],
    base: string,
    overlayFrom: string,
    overlay: readonly HumanFileOp[],
    tests: readonly string[]
  ): Promise<boolean> => {
    await reference.checkout(base);
    await reference.ws.applyHumanFiles(overlay, (p) => human.show(overlayFrom, p));
    if (runtime.envSyncCommand !== null) {
      const sync = await reference.ws.run(runtime.envSyncCommand, 120_000);
      if (sync.exitCode !== 0)
        throw new Error(`依赖切换失败（${base}）：${tail(sync.output, 500)}`);
    }
    const r = await reference.ws.run(runtime.testCommand(tests), options.testTimeoutMs);
    const passed = r.exitCode === 0 && !r.timedOut;
    probes.push({
      sha,
      kind,
      base,
      tests,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      passed,
      outputTail: tail(r.output),
    });
    return passed;
  };

  for (let i = 0; i < range.length; i++) {
    const c = range[i] as RangeCommit;
    const files = human.changes(c.parent, c.sha);
    const facts: CommitFacts = {
      sha: c.sha,
      parent: c.parent,
      subject: c.message.split("\n")[0] ?? "",
      message: c.message,
      files,
    };
    commits.push(facts);
    if (profile.resetReason(facts) !== null) {
      log(`[${i + 1}/${range.length}] ${c.sha.slice(0, 9)} 重置点`);
      continue;
    }
    const kinds = new Map(files.map((f) => [f.path, profile.classifyFile(f.path)]));
    const overlay: HumanFileOp[] = files
      .filter((f) => {
        const k = kinds.get(f.path);
        return k === "test" || k === "testaux" || k === "env";
      })
      .map((f) => ({
        path: f.path,
        op: f.status === "D" ? "delete" : "write",
        kind: kinds.get(f.path) ?? "other",
      }));
    const tests = files
      .filter((f) => kinds.get(f.path) === "test" && f.status !== "D")
      .map((f) => f.path);
    const touchesSource = files.some((f) => kinds.get(f.path) === "source");
    if (tests.length > 0) {
      const parentPasses = await runTests(c.sha, "parent", c.parent, c.sha, overlay, tests);
      const commitPasses = await runTests(c.sha, "commit", c.sha, c.sha, [], tests);
      facts.probe = { parentFails: !parentPasses, commitPasses };
      const next = range[i + 1];
      if (!commitPasses && next !== undefined) {
        const testOps = overlay.filter((o) => o.kind === "test" || o.kind === "testaux");
        facts.nextPasses = await runTests(c.sha, "next", next.sha, c.sha, testOps, tests);
      }
    }
    const isTask = facts.probe?.parentFails === true && facts.probe.commitPasses;
    if (touchesSource && !isTask)
      facts.formatOnly = await formatOnly(reference, runtime, c, files, probes);
    log(
      `[${i + 1}/${range.length}] ${c.sha.slice(0, 9)} ${
        facts.probe === undefined
          ? "无测试"
          : `父${facts.probe.parentFails ? "败" : "过"} 本${facts.probe.commitPasses ? "过" : "败"}`
      }${facts.formatOnly === true ? " 只有格式" : ""}  ${facts.subject.slice(0, 60)}`
    );
  }
  return { commits, probes };
}

async function formatOnly(
  reference: ReferenceWorkspace,
  runtime: StreamRepoRuntime,
  c: RangeCommit,
  files: readonly CommitFileChange[],
  probes: ProbeRecord[]
): Promise<boolean> {
  // 增删文件不是格式变化
  if (files.some((f) => f.status !== "M")) return false;
  const paths = files.map((f) => f.path);
  await reference.checkout(c.parent);
  const r = await reference.ws.run(runtime.formatCommand(paths), 300_000);
  // 格式化工具对个别文件报错（例如语法它不认）也照常比对：没改成就不一致
  const same = await reference.sameAs(c.sha, paths);
  probes.push({
    sha: c.sha,
    kind: "format",
    base: c.parent,
    tests: paths,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    passed: same,
    outputTail: tail(r.output),
  });
  return same;
}

// 出清单：取事实加纯规则
export function manifestFromFacts(input: {
  human: HumanRepo;
  runtime: StreamRepoRuntime;
  rangeStart: string;
  facts: CollectedFacts;
}): StreamManifest {
  return composeStreamManifest({
    profile: input.runtime.profile,
    rangeStart: input.human.resolve(input.rangeStart),
    commits: input.facts.commits,
    readHumanFile: (sha, path) => input.human.show(sha, path).toString("utf8"),
  });
}
