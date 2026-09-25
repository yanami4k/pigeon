// 一致性核对的 harness 代码一项（决策 156）：重跑时跑的代码须与无记忆整流时相同，只许差在定点对照自己的文件上。
// 无记忆整流的结果行记下了 harness 的提交（harnessRef）；它与当前代码之间改过的文件逐个看：
// - 定点对照自己的文件（src/eval/fixed-point-*.ts，含它的用例与夹具）、文档与只影响报告计算的文件：放行；
// - 其余 TypeScript 文件：按运行行为规整后逐字比较——去掉用"定点对照：开始 / 结束"标记包住的新增段、指向定点对照模块的
//   import、全部类型（Node 的去类型）、export 关键字、整行注释与空行，并把连续空白（含换行）压成一个空格；规整后相同即只差定点对照的
//   新增段或不改变运行行为的写法（类型、导出），放行；
// - 其余一律拒绝，列出文件名。无记忆整流时工作区有未提交的改动（dirty）或当前工作区有未提交的改动，都无从核对，一律拒绝。
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

// 核对：无记忆整流时的 harness 与当前代码之间只差定点对照自己的文件（及只影响报告的文件）
export function assertHarnessMatches(
  repoDir: string,
  recorded: HarnessRef,
  current: HarnessRef
): void {
  if (recorded.dirty) {
    throw new HarnessMismatchError(
      `无记忆整流时 harness 工作区有未提交的改动（${recorded.commit}）：无从核对重跑的代码是否相同，拒绝`
    );
  }
  if (current.dirty) {
    throw new HarnessMismatchError("当前 harness 工作区有未提交的改动：请先提交，再重跑");
  }
  const violations = harnessViolations(harnessChangesSince(repoDir, recorded.commit));
  if (violations.length > 0) {
    throw new HarnessMismatchError(
      `当前 harness 与无记忆整流时（${recorded.commit}）相比，定点对照以外的文件不同，拒绝：${violations.join("、")}`
    );
  }
}
