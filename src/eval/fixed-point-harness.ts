// 一致性核对的 harness 代码一项（决策 156）：重跑时跑的代码须与无记忆整流时相同，只许差在定点对照自己的文件上。
// 无记忆整流的结果行记下了 harness 的提交（harnessRef）；它与当前代码之间改过的文件逐个看：
// - 定点对照自己的文件（src/eval/fixed-point-*.ts，含它的用例与夹具）、文档与只影响报告计算的文件：放行；
// - 其余 TypeScript 文件：按运行行为规整后逐字比较——去掉用"定点对照：开始 / 结束"标记包住的新增段、指向定点对照模块的
//   import、全部类型（Node 的去类型）、export 关键字、整行注释与空行，并把连续空白（含换行）压成一个空格；规整后相同即只差定点对照的
//   新增段或不改变运行行为的写法（类型、导出），放行；
// - 其余一律拒绝，列出文件名。无记忆整流时工作区有未提交的改动（dirty）或当前工作区有未提交的改动，都无从核对，一律拒绝。
// 记下的提交之后、当前头之前（含）若有登记过的运行时兼容提交（见 RUNTIME_COMPATIBLE_COMMITS），它们须从记下的提交起一个接一个
// （每个的父提交即前一个，中间没有未登记的提交），且各自只改了登记的文件；这时当前代码改与其中最后一个比较，即另允许差在这些
// 提交登记的文件上。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import type { HarnessRef } from "./results.ts";

export class HarnessMismatchError extends Error {
  override name = "HarnessMismatchError";
}

// 定点对照自己的文件与文档
const OWN_FILES = [/^src\/eval\/fixed-point[-.][^/]+\.ts$/, /^docs\//];
// 只影响报告计算的文件
const REPORT_ONLY_FILES = [/^src\/eval\/stream-report\.ts$/];

const MARK_START = "// 定点对照：开始";
const MARK_END = "// 定点对照：结束";

// 按运行行为规整一份 TypeScript 源码（见文件头）
export function normalizeForBehavior(text: string): string {
  const kept: string[] = [];
  let inMarked = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === MARK_START) {
      inMarked = true;
      continue;
    }
    if (t === MARK_END) {
      inMarked = false;
      continue;
    }
    if (!inMarked) kept.push(line);
  }
  let code = kept.join("\n").replace(/import\s[^;]*?from\s*"[^"]*fixed-point[^"]*";/gs, "");
  try {
    code = stripTypeScriptTypes(code, { mode: "strip" });
  } catch {
    // 去不了类型就按原文比较（只会更严）
  }
  return code
    .replace(/^(\s*)export\s+(?=(async\s+)?function\b|const\b|let\b|class\b)/gm, "$1")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"))
    .join(" ")
    .replace(/\s+/g, " ");
}

export interface HarnessChange {
  path: string;
  // 改动前后的内容；不存在为 null
  before: string | null;
  after: string | null;
}

// 不许有的改动（文件名）
export function harnessViolations(changes: readonly HarnessChange[]): string[] {
  return changes
    .filter((c) => {
      if (OWN_FILES.some((r) => r.test(c.path)) || REPORT_ONLY_FILES.some((r) => r.test(c.path))) {
        return false;
      }
      if (c.path.endsWith(".ts") && c.before !== null && c.after !== null) {
        return normalizeForBehavior(c.before) !== normalizeForBehavior(c.after);
      }
      return true;
    })
    .map((c) => c.path)
    .sort();
}

// harness 仓库里自某提交以来改过的文件（含未提交的改动与未跟踪的文件）
export function harnessChangesSince(repoDir: string, commit: string): HarnessChange[] {
  const git = (args: readonly string[]) =>
    execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const names = new Set([
    ...git(["diff", "--name-only", "--no-renames", commit]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]);
  names.delete("");
  return [...names].sort().map((p) => {
    let before: string | null;
    try {
      before = git(["show", `${commit}:${p}`]);
    } catch {
      before = null;
    }
    const full = path.join(repoDir, p);
    return { path: p, before, after: existsSync(full) ? readFileSync(full, "utf8") : null };
  });
}

// 核对：无记忆整流时的 harness（及其后登记过的运行时兼容提交）与当前代码之间只差定点对照自己的文件（及只影响报告的文件）
export function assertHarnessMatches(
  repoDir: string,
  recorded: HarnessRef,
  current: HarnessRef,
  git: HarnessGit = harnessGit(repoDir),
  registry: readonly RuntimeCompatibleCommit[] = RUNTIME_COMPATIBLE_COMMITS
): void {
  if (recorded.dirty) {
    throw new HarnessMismatchError(
      `无记忆整流时 harness 工作区有未提交的改动（${recorded.commit}）：无从核对重跑的代码是否相同，拒绝`
    );
  }
  if (current.dirty) {
    throw new HarnessMismatchError("当前 harness 工作区有未提交的改动：请先提交，再重跑");
  }
  const base = latestCompatibleSince(recorded.commit, current.commit, git, registry);
  const violations = harnessViolations(harnessChangesSince(repoDir, base));
  if (violations.length > 0) {
    const since =
      base === recorded.commit
        ? `无记忆整流时（${recorded.commit}）`
        : `无记忆整流时（${recorded.commit}）及其后的运行时兼容提交（${base}）`;
    throw new HarnessMismatchError(
      `当前 harness 与${since}相比，定点对照以外的文件不同，拒绝：${violations.join("、")}`
    );
  }
}

// 记下的提交之后、当前头之前（含）登记过的运行时兼容提交：须从记下的提交起一个接一个（每个的父提交即前一个），且各自只改了
// 登记的文件（相对它的父提交），否则拒绝。返回其中最后一个；没有即记下的提交
export function latestCompatibleSince(
  recorded: string,
  head: string,
  git: HarnessGit,
  registry: readonly RuntimeCompatibleCommit[] = RUNTIME_COMPATIBLE_COMMITS
): string {
  const same = (a: string, b: string) => git.isAncestor(a, b) && git.isAncestor(b, a);
  const between = registry
    .filter(
      (e) =>
        !same(e.commit, recorded) &&
        git.isAncestor(recorded, e.commit) &&
        git.isAncestor(e.commit, head)
    )
    .sort((a, b) => (git.isAncestor(a.commit, b.commit) ? -1 : 1));
  let previous = recorded;
  for (const entry of between) {
    const parent = git.parentOf(entry.commit);
    if (parent === null || !same(parent, previous)) {
      throw new HarnessMismatchError(
        `运行时兼容提交 ${entry.commit} 的父提交不是 ${previous}：两者之间有未登记的提交，拒绝`
      );
    }
    const outside = git.changedFiles(parent, entry.commit).filter((f) => !entry.files.includes(f));
    if (outside.length > 0) {
      throw new HarnessMismatchError(
        `运行时兼容提交 ${entry.commit} 相对它的父提交改了登记以外的文件，拒绝：${outside.sort().join("、")}`
      );
    }
    previous = entry.commit;
  }
  return previous;
}

// ---------- 运行时兼容提交 ----------

// 运行时兼容提交：无记忆整流跑到一半换上的 harness 修补，只改运行环境的处理（限额、放行等），不改一步的执行。
// 无记忆整流的结果行因此可记下两个 harness 版本 {R, C}：R 为最早的那个，C 须登记在这里、是 R 的后代，
// 且 R 到 C 之间改过的文件全部落在 C 登记的文件里
export interface RuntimeCompatibleCommit {
  // 完整提交号
  commit: string;
  // 允许改动的文件
  files: readonly string[];
  reason: string;
}

export const RUNTIME_COMPATIBLE_COMMITS: readonly RuntimeCompatibleCommit[] = [
  {
    commit: "a806573ac877b2405398fc6d4912b9f1c4c95685",
    files: [
      "src/eval/model-gateway.ts",
      "src/eval/model-gateway.test.ts",
      "src/eval/stream-runner.ts",
      "src/eval/stream-runner.test.ts",
      "docs/audits/2026-09-23-stream-repair-2d2a56d.md",
    ],
    reason:
      "额度类停用加最短停用期、排队作废单独计数（10 告警、30 停）；只改限额与作废计数，不改一步的执行",
  },
  {
    commit: "5275ca2da285cf6a92e37871697225e47cbe0bad",
    files: [
      "src/eval/model-gateway.ts",
      "src/eval/model-gateway.test.ts",
      "src/eval/step-admission.test.ts",
      "docs/audits/2026-09-23-stream-repair-2d2a56d.md",
    ],
    reason:
      "额度停用期按错误正文里的重置时刻（加 2 分钟、夹在 5 分钟至 6 小时），拿不到按封顶 60 分钟；只改限额，不改一步的执行",
  },
];

// 核对记下的版本集合要用到的 git 查询
export interface HarnessGit {
  // a 是否为 b 的祖先（或同一提交）
  isAncestor(a: string, b: string): boolean;
  // a 到 b 之间改过的文件
  changedFiles(a: string, b: string): string[];
  // 第一个父提交（完整提交号）；没有为 null
  parentOf(commit: string): string | null;
}

export function harnessGit(repoDir: string): HarnessGit {
  return {
    isAncestor(a, b) {
      try {
        execFileSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", a, b], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    changedFiles(a, b) {
      return execFileSync("git", ["-C", repoDir, "diff", "--name-only", "--no-renames", a, b], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter((l) => l !== "");
    },
    parentOf(commit) {
      try {
        return execFileSync("git", ["-C", repoDir, "rev-parse", "--verify", `${commit}^`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null;
      }
    },
  };
}

// 无记忆整流结果行记下的 harness 版本集合须为 {R} 或 {R, C}（见 RUNTIME_COMPATIBLE_COMMITS）；任何一个有未提交改动即拒绝。
// 返回其中最新的那个（有 C 即 C），重跑的代码按它与当前代码比较
export function resolveRecordedHarness(
  refs: readonly HarnessRef[],
  git: HarnessGit,
  registry: readonly RuntimeCompatibleCommit[] = RUNTIME_COMPATIBLE_COMMITS
): HarnessRef {
  const distinct = [...new Map(refs.map((r) => [`${r.commit}|${r.dirty}`, r])).values()];
  const dirty = distinct.filter((r) => r.dirty);
  if (dirty.length > 0) {
    throw new HarnessMismatchError(
      `无记忆整流时 harness 工作区有未提交的改动（${dirty.map((r) => r.commit).join("、")}）：无从核对重跑的代码是否相同，拒绝`
    );
  }
  const [first, second, ...rest] = distinct;
  if (first === undefined)
    throw new HarnessMismatchError("无记忆整流的结果行没有记下 harness 版本，拒绝");
  if (second === undefined) return first;
  if (rest.length > 0) {
    throw new HarnessMismatchError(
      `无记忆整流的结果行记下了 ${distinct.length} 个不同的 harness 版本（${distinct.map((r) => r.commit).join("、")}），至多两个，拒绝`
    );
  }
  const [base, later] = git.isAncestor(first.commit, second.commit)
    ? [first, second]
    : git.isAncestor(second.commit, first.commit)
      ? [second, first]
      : [undefined, undefined];
  if (base === undefined || later === undefined) {
    throw new HarnessMismatchError(
      `无记忆整流记下的两个 harness 版本 ${first.commit}、${second.commit} 互不为祖先，拒绝`
    );
  }
  const entry = registry.find((e) => e.commit.startsWith(later.commit));
  if (entry === undefined) {
    throw new HarnessMismatchError(
      `无记忆整流中途换上的 harness ${later.commit} 不在运行时兼容提交登记表里，拒绝`
    );
  }
  const outside = git
    .changedFiles(base.commit, later.commit)
    .filter((f) => !entry.files.includes(f));
  if (outside.length > 0) {
    throw new HarnessMismatchError(
      `运行时兼容提交 ${later.commit} 相对 ${base.commit} 改了登记以外的文件，拒绝：${outside.sort().join("、")}`
    );
  }
  return later;
}
