// 流清单的取事实部分（决策 127、141、153）：从人的仓库取逐提交的文件改动，在 Linux 容器里测判题探针与格式化比对，
// 再交给 stream-manifest.ts 的纯规则出清单。判题只在容器里做（Windows 上有平台差异）。
// 探针所在的参考工作区装着人的完整历史——它只用于出题，不是 agent 的工作区，看得到未来无妨。
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  type CommitFacts,
  type CommitFileChange,
  composeStreamManifest,
  type HumanFileOp,
  type StreamManifest,
  type TestProbe,
} from "./stream-manifest.ts";
import { allPassed, pinTestConfigFromTree, type StreamRepoRuntime } from "./stream-profiles.ts";
import { type StreamShell, StreamWorkspace, shellQuote } from "./stream-workspace.ts";

// 探针上失败的用例再跑几次（与 strands 的 CI 同样是两次）
export const PROBE_RERUNS = 2;
// 探针的单条用例超时（秒）：比判题、测量与人的基准的 90 秒短——人的基准里最慢的用例只有 4 秒，挂住的用例
// （例如父提交缺少本提交的改动时）早些判失败，清单更快
export const PROBE_CASE_TIMEOUT_SEC = 30;

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
  // 提交时间（提交者日期），UTC 的 RFC 3339（到秒）
  commitDate(rev: string): string;
  // 含 rev 可达历史的 bundle（单一分支）
  bundle(rev: string): Buffer;
  // 某提交里的全部文件及其 blob 哈希
  tree(sha: string): { path: string; blob: string }[];
  // 父提交到本提交在给定路径里的新增行（不含 diff 头）
  addedLines(parent: string, sha: string, paths: readonly string[]): string[];
  // 两个提交间单个文件的 unified diff（test-text 题面附测试改法用，403 修订）
  diff(parent: string, sha: string, path: string): string;
}

export function gitHumanRepo(dir: string): HumanRepo {
  // git 的标准错误收下不外漏（取人的文件时文件不存在是常态，由调用方处理）；出错时它随在抛出的错误信息里
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    diff(parent, sha, path) {
      return text(["diff", "--no-renames", parent, sha, "--", path]);
    },
    resolve: (rev) => text(["rev-parse", "--verify", `${rev}^{commit}`]).trim(),
    commitDate: (rev) =>
      new Date(text(["log", "-1", "--format=%cI", `${rev}^{commit}`]).trim())
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
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
  // 断点文件（可选）：每测完一个提交即追加一行；重来时已测的提交直接取回，不再跑探针
  checkpointFile?: string;
}

// 断点文件的一行：一个提交测得的探针结论与原始记录
interface CheckpointLine {
  sha: string;
  probe?: TestProbe;
  nextPasses?: boolean;
  formatOnly?: boolean;
  environmentError?: string;
  probes: ProbeRecord[];
}

function readCheckpoint(file: string | undefined): Map<string, CheckpointLine> {
  const out = new Map<string, CheckpointLine>();
  if (file === undefined || !existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw) as CheckpointLine;
      out.set(line.sha, line);
    } catch {
      // 进程死于写到一半的末行：该提交重测
    }
  }
  return out;
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
  passed: boolean;
  // 没拿到全部用例的结果（报告写出前被杀、续跑也没有进展）：这次探针不作判定
  environmentError: boolean;
  // 判题探针的逐用例结果（f2p 由父提交与本提交的两次对照得出）；卡死、被记为失败的用例另列
  passedCases?: string[];
  failedCases?: string[];
  stuck?: string[];
  // 格式化比对的命令退出码
  exitCode?: number | null;
  outputTail: string;
}

// 探针没拿到全部结果：该提交记为环境错误，不再做其余探针
class ProbeEnvironmentError extends Error {}

function tail(text: string, max = 2000): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

// 逐提交取事实。探针按规则需要才测：带测试改动的提交测父与本身；本身也不过的再测下一个提交（红测试对）；
// 改了源代码且不成题的测格式化比对。重置点不测。可多路并行：每路独占一个参考工作区，各提交的探针互不依赖
// （"下一提交"的探针只检出下一个提交的代码，不依赖它的判定）；结果按提交顺序放回，断点随每个提交测完写入
export async function collectStreamFacts(input: {
  human: HumanRepo;
  runtime: StreamRepoRuntime;
  references: readonly ReferenceWorkspace[];
  rangeStart: string;
  rangeEnd: string;
  options: ProbeOptions;
}): Promise<CollectedFacts> {
  const { human, runtime, options } = input;
  if (input.references.length === 0) throw new Error("至少需要一个参考工作区");
  const profile = runtime.profile;
  const log = options.log ?? (() => {});
  const range = human.firstParentLog(input.rangeStart, input.rangeEnd);
  const done = readCheckpoint(options.checkpointFile);

  const processCommit = async (
    i: number,
    reference: ReferenceWorkspace
  ): Promise<{ facts: CommitFacts; probes: ProbeRecord[] }> => {
    const c = range[i] as RangeCommit;
    const probes: ProbeRecord[] = [];
    const files = human.changes(c.parent, c.sha);
    const facts: CommitFacts = {
      sha: c.sha,
      parent: c.parent,
      subject: c.message.split("\n")[0] ?? "",
      message: c.message,
      files,
    };
    const saved = done.get(c.sha);
    if (saved !== undefined) {
      if (saved.probe !== undefined) facts.probe = saved.probe;
      if (saved.nextPasses !== undefined) facts.nextPasses = saved.nextPasses;
      if (saved.formatOnly !== undefined) facts.formatOnly = saved.formatOnly;
      if (saved.environmentError !== undefined) facts.environmentError = saved.environmentError;
      log(`[${i + 1}/${range.length}] ${c.sha.slice(0, 9)} 取自断点`);
      return { facts, probes: saved.probes };
    }
    if (profile.resetReason(facts) !== null) {
      log(`[${i + 1}/${range.length}] ${c.sha.slice(0, 9)} 重置点`);
      return { facts, probes };
    }

    const runTests = async (
      kind: ProbeRecord["kind"],
      base: string,
      overlay: readonly HumanFileOp[],
      tests: readonly string[]
    ): Promise<boolean> => {
      await reference.checkout(base);
      await reference.ws.applyHumanFiles(overlay, (p) => human.show(c.sha, p));
      if (runtime.envSyncCommand !== null) {
        const sync = await reference.ws.run(runtime.envSyncCommand, 120_000);
        if (sync.exitCode !== 0)
          throw new Error(`依赖切换失败（${base}）：${tail(sync.output, 500)}`);
      }
      await pinTestConfigFromTree(runtime, reference.ws);
      // 判定一律看逐用例结果，不看退出码（pytest 写完报告后可能不退出、被外壳杀掉）
      // 失败的用例重跑两次、其间通过即算通过：本提交上时过时不过的用例不致判成"本提交也不过"，
      // 父提交上要每次都失败才算父败（strands 的运行方式本就带 --reruns 2）
      const run = await runtime.runCases(reference.ws, tests, {
        timeoutMs: options.testTimeoutMs,
        scratch: `${reference.ws.root}/.git`,
        rerunFailed: PROBE_RERUNS,
        caseTimeoutSec: PROBE_CASE_TIMEOUT_SEC,
      });
      const passed = allPassed(run);
      probes.push({
        sha: c.sha,
        kind,
        base,
        tests,
        passed,
        environmentError: !run.complete,
        passedCases: run.cases.filter((x) => x.outcome === "passed").map((x) => x.id),
        failedCases: run.cases.filter((x) => x.outcome === "failed").map((x) => x.id),
        stuck: run.stuck,
        outputTail: tail(run.output),
      });
      if (!run.complete) {
        const label = { parent: "父提交", commit: "本提交", next: "下一提交", format: "格式化" }[
          kind
        ];
        throw new ProbeEnvironmentError(
          `${label}探针没拿到全部用例的结果（被杀且续跑没有进展），测试 ${tests.join("、")}`
        );
      }
      return passed;
    };

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
    try {
      if (tests.length > 0) {
        const parentPasses = await runTests("parent", c.parent, overlay, tests);
        const commitPasses = await runTests("commit", c.sha, [], tests);
        facts.probe = { parentFails: !parentPasses, commitPasses };
        const next = range[i + 1];
        if (!commitPasses && next !== undefined) {
          const testOps = overlay.filter((o) => o.kind === "test" || o.kind === "testaux");
          facts.nextPasses = await runTests("next", next.sha, testOps, tests);
        }
      }
      const isTask = facts.probe?.parentFails === true && facts.probe.commitPasses;
      if (touchesSource && !isTask)
        facts.formatOnly = await formatOnly(reference, runtime, c, files, probes);
    } catch (error) {
      if (!(error instanceof ProbeEnvironmentError)) throw error;
      // 环境错误的提交不留任何判定
      delete facts.probe;
      delete facts.nextPasses;
      delete facts.formatOnly;
      facts.environmentError = error.message;
    }
    log(
      `[${i + 1}/${range.length}] ${c.sha.slice(0, 9)} ${
        facts.probe === undefined
          ? "无测试"
          : `父${facts.probe.parentFails ? "败" : "过"} 本${facts.probe.commitPasses ? "过" : "败"}`
      }${facts.formatOnly === true ? " 只有格式" : ""}${
        facts.environmentError !== undefined ? ` 环境错误：${facts.environmentError}` : ""
      }  ${facts.subject.slice(0, 60)}`
    );
    if (options.checkpointFile !== undefined) {
      const line: CheckpointLine = { sha: c.sha, probes };
      if (facts.probe !== undefined) line.probe = facts.probe;
      if (facts.nextPasses !== undefined) line.nextPasses = facts.nextPasses;
      if (facts.formatOnly !== undefined) line.formatOnly = facts.formatOnly;
      if (facts.environmentError !== undefined) line.environmentError = facts.environmentError;
      appendFileSync(options.checkpointFile, `${JSON.stringify(line)}\n`);
    }
    return { facts, probes };
  };

  const results: { facts: CommitFacts; probes: ProbeRecord[] }[] = new Array(range.length);
  let next = 0;
  await Promise.all(
    input.references.map(async (reference) => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= range.length) return;
        results[i] = await processCommit(i, reference);
      }
    })
  );
  return {
    commits: results.map((r) => r.facts),
    probes: results.flatMap((r) => r.probes),
  };
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
    passed: same,
    environmentError: false,
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
