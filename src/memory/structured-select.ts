// 结构化记忆的挑选、用前核验与推送文字（决策 134 / 135 / 136）。只在开局与回炉两个时机由程序推送，不做模型自取的查询工具。
// - 开局挑选：只用题面直接指到的文件——题面里出现的路径，以及题面所附代码中的导入语句解析出的仓库内文件；取挂在这些文件上的
//   记忆，最多 2 条；指不到或这些文件上没有记忆就一条都不给。
// - 回炉挑选：报错指纹对上的优先（同一步、同一错误码或测试名、同一文件），其次是挂在本次报错涉及文件上的记忆，最多 2 条。
// - 两处挑选后、给出前逐条核验：锚点文件仍存在；报错里附带的名字（类型检查的标识符、测试名）仍能在报错所在的文件里以文本找到；
//   分层违规的两端模块文件仍存在。文件都按版本历史里的改名追踪。任一不过即不给。事发以来锚点文件的改动幅度只用于排序，
//   改得越少越靠前；不按"多久没被用到"淘汰。同一指纹只给一条。
// 不解析代码：导入语句按文本匹配、名字按文本查找。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { workspaceRelative } from "../state/structured-memory.ts";
import {
  describeFingerprint,
  type Fingerprint,
  fingerprintKey,
  parseStepOutput,
} from "../state/verify-fingerprint.ts";
import type { VerifyStepResult } from "../state/verify-steps.ts";
import type { MemoryEntry } from "./structured-store.ts";

// 开局与回炉各自最多给几条（决策 135）
export const STRUCTURED_MEMORY_LIMIT = 2;
// 结构化记忆段落的字符预算：与常驻 Memory 分开计（决策 129），每条另有上限
export const STRUCTURED_MEMORY_BUDGET_CHARS = 1200;
const ENTRY_TEXT_LIMIT = 400;
// 参与核验与排序的候选上限（按最近出现排序后截取），防止热门文件上的大量记忆拖慢开局
const CANDIDATE_LIMIT = 50;

export const STRUCTURED_MEMORY_DISCLAIMER = "过去发生的事实，仅供参考；与当前代码冲突时以代码为准";

// 工作区的 git 查询（改名追踪、改动幅度、仓库文件清单）；不是 git 工作区或 git 不可用时各查询按"查不到"处理
export interface WorkspaceProbe {
  root: string;
  exists(file: string): boolean;
  read(file: string): string | undefined;
  // 事发以来（毫秒时间戳）这个文件被改名成了什么（沿改名链走到底）；没改过名返回原路径
  renamedSince(file: string, since: number): string;
  // 事发以来这个文件改了多少行（已提交的加未提交的）
  changedLinesSince(file: string, since: number): number;
  // 仓库里的文件清单（相对工作区根、正斜杠）
  files(): readonly string[];
}

function runGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function sinceArg(since: number): string {
  return `--since=@${Math.max(0, Math.floor(since / 1000) - 1)}`;
}

interface RenameRecord {
  // 提交时间（秒）
  at: number;
  from: string;
  to: string;
}

export function workspaceProbe(root: string): WorkspaceProbe {
  let fileList: string[] | undefined;
  let renames: RenameRecord[] | undefined;
  // 版本历史里的全部改名（按时间正序），一次读出
  const renameLog = (): RenameRecord[] => {
    if (renames !== undefined) {
      return renames;
    }
    renames = [];
    let at = 0;
    const log = runGit(root, [
      "log",
      "--reverse",
      "--diff-filter=R",
      "-M",
      "--name-status",
      "--format=%x01%ct",
    ]);
    for (const line of (log ?? "").split(/\r?\n/)) {
      if (line.startsWith("\u0001")) {
        at = Number.parseInt(line.slice(1), 10) || 0;
        continue;
      }
      const [status, from, to] = line.split("\t");
      if (status?.startsWith("R") === true && from !== undefined && to !== undefined) {
        renames.push({ at, from, to });
      }
    }
    return renames;
  };
  const exists = (file: string): boolean => {
    const full = join(root, file);
    return existsSync(full) && statSync(full).isFile();
  };
  return {
    root,
    exists,
    read: (file) => (exists(file) ? readFileSync(join(root, file), "utf8") : undefined),
    renamedSince: (file, since) => {
      const floor = Math.floor(since / 1000) - 1;
      let current = file;
      for (const rename of renameLog()) {
        if (rename.at >= floor && rename.from === current) {
          current = rename.to;
        }
      }
      return current;
    },
    changedLinesSince: (file, since) => {
      const sum = (text: string | undefined): number =>
        (text ?? "")
          .split(/\r?\n/)
          .map((line) => line.split("\t"))
          .reduce(
            (total, [added, removed]) =>
              total +
              (Number.parseInt(added ?? "", 10) || 0) +
              (Number.parseInt(removed ?? "", 10) || 0),
            0
          );
      return (
        sum(runGit(root, ["log", sinceArg(since), "--numstat", "--format=", "--", file])) +
        sum(runGit(root, ["diff", "--numstat", "HEAD", "--", file]))
      );
    },
    files: () => {
      fileList ??= (runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "")
        .split(/\r?\n/)
        .filter((file) => file !== "" && !file.startsWith(".pigeon/"));
      return fileList;
    },
  };
}

// ---- 题面指到的文件 ----

// 路径样的记号：ASCII 路径字符组成、以扩展名结尾；中文与标点天然断开记号
const PATH_TOKEN = /[\w@.\\/-]*[\w@-]\.[A-Za-z0-9]{1,8}/g;
const JS_IMPORT = [
  /\bfrom\s+["']([^"'\n]+)["']/g,
  /\bimport\s+["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const PY_FROM_IMPORT = /^\s*from\s+(\.*[\w.]*)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface Mention {
  index: number;
  file: string;
}

// 相对导入：以所附代码所在文件（题面里在它之前最近提到的那个文件）为基准；带扩展名的原样，不带的补常见扩展名与 index
function resolveRelative(
  probe: WorkspaceProbe,
  baseFile: string | undefined,
  spec: string
): string[] {
  const base = baseFile !== undefined ? posix.dirname(baseFile) : ".";
  const joined = posix.normalize(posix.join(base, spec));
  if (joined.startsWith("..")) {
    return [];
  }
  const candidates = [
    joined,
    ...JS_EXTENSIONS.map((extension) => `${joined}${extension}`),
    ...JS_EXTENSIONS.map((extension) => `${joined}/index${extension}`),
    // TS 里 .js 后缀的导入指向同名 .ts
    ...(joined.endsWith(".js") ? [`${joined.slice(0, -3)}.ts`, `${joined.slice(0, -3)}.tsx`] : []),
  ];
  return candidates.filter((file) => probe.exists(file)).slice(0, 1);
}

// Python 点号模块：a.b.c → 仓库里以 a/b/c.py 或 a/b/c/__init__.py 结尾的文件（相对导入以基准文件所在目录起算）
function resolvePython(
  probe: WorkspaceProbe,
  baseFile: string | undefined,
  spec: string
): string[] {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
  const modulePath = spec
    .slice(dots)
    .split(".")
    .filter((part) => part !== "")
    .join("/");
  if (dots > 0) {
    let dir = baseFile !== undefined ? posix.dirname(baseFile) : ".";
    for (let level = 1; level < dots; level += 1) {
      dir = posix.dirname(dir);
    }
    const target = modulePath === "" ? dir : posix.join(dir, modulePath);
    return [`${target}.py`, `${target}/__init__.py`]
      .filter((file) => probe.exists(file))
      .slice(0, 1);
  }
  if (modulePath === "") {
    return [];
  }
  const suffixes = [`${modulePath}.py`, `${modulePath}/__init__.py`];
  return probe
    .files()
    .filter((file) => suffixes.some((suffix) => file === suffix || file.endsWith(`/${suffix}`)));
}

// 题面直接指到的仓库内文件：出现的路径，加上所附代码里导入语句解析出的文件（按出现顺序、去重）
export function taskReferencedFiles(task: string, probe: WorkspaceProbe): string[] {
  const found: string[] = [];
  const add = (file: string) => {
    if (!found.includes(file)) {
      found.push(file);
    }
  };
  // 提到的路径都可作所附代码的基准（题面附的测试文件在这一步开始时可能还不在工作区里），存在的才算指到
  const mentions: Mention[] = [];
  for (const match of task.matchAll(PATH_TOKEN)) {
    const file = workspaceRelative(match[0], probe.root);
    if (file === "" || file.startsWith("../") || !file.includes("/")) {
      if (file !== "" && probe.exists(file)) {
        add(file);
      }
      continue;
    }
    mentions.push({ index: match.index ?? 0, file });
    if (probe.exists(file)) {
      add(file);
    }
  }
  const baseAt = (index: number): string | undefined =>
    mentions.filter((mention) => mention.index < index).at(-1)?.file;
  for (const pattern of JS_IMPORT) {
    for (const match of task.matchAll(pattern)) {
      const spec = match[1] ?? "";
      if (spec.startsWith(".")) {
        for (const file of resolveRelative(probe, baseAt(match.index ?? 0), spec)) {
          add(file);
        }
      } else if (probe.exists(spec)) {
        add(spec);
      }
    }
  }
  for (const match of task.matchAll(PY_FROM_IMPORT)) {
    for (const file of resolvePython(probe, baseAt(match.index ?? 0), match[1] ?? "")) {
      add(file);
    }
  }
  for (const match of task.matchAll(PY_IMPORT)) {
    for (const spec of (match[1] ?? "").split(",")) {
      for (const file of resolvePython(probe, baseAt(match.index ?? 0), spec.trim())) {
        add(file);
      }
    }
  }
  return found;
}

// ---- 用前核验 ----

export interface EntryCheck {
  ok: boolean;
  // 不过的原因（给只读命令与测试看）
  reason?: string;
  // 事发以来锚点文件的改动行数（只用于排序）
  changedLines: number;
}

// 核验一条记忆：锚点文件在；报错名字仍在报错所在文件里（改名追踪）；分层违规两端都在
export function checkEntry(entry: MemoryEntry, probe: WorkspaceProbe): EntryCheck {
  const since = entry.latest.at;
  const anchor = probe.renamedSince(entry.anchor, since);
  if (!probe.exists(anchor)) {
    return { ok: false, reason: `锚点文件已不存在：${entry.anchor}`, changedLines: 0 };
  }
  const fingerprint = entry.fingerprint;
  if (fingerprint.file !== undefined) {
    const errorFile = probe.renamedSince(fingerprint.file, since);
    const content = probe.read(errorFile);
    if (content === undefined) {
      return { ok: false, reason: `报错所在文件已不存在：${fingerprint.file}`, changedLines: 0 };
    }
    const missing = fingerprint.names.find((name) => !content.includes(name));
    if (missing !== undefined) {
      return { ok: false, reason: `名字 ${missing} 已不在 ${errorFile} 里`, changedLines: 0 };
    }
  }
  if (fingerprint.to !== undefined && !probe.exists(probe.renamedSince(fingerprint.to, since))) {
    return { ok: false, reason: `分层违规的被依赖端已不存在：${fingerprint.to}`, changedLines: 0 };
  }
  return { ok: true, changedLines: probe.changedLinesSince(anchor, since) };
}

// ---- 挑选 ----

export interface MemoryPick {
  entry: MemoryEntry;
  changedLines: number;
}

export type EntryChecker = (entry: MemoryEntry, probe: WorkspaceProbe) => EntryCheck;

// 核验、排序（改动越少越前，其次越新越前、出现越多越前）、同一指纹只留一条，取前 limit 条
function verifiedTop(
  candidates: readonly MemoryEntry[],
  probe: WorkspaceProbe,
  limit: number,
  check: EntryChecker,
  taken: Set<string>
): MemoryPick[] {
  const checked: MemoryPick[] = [];
  const recent = [...candidates]
    .sort((left, right) => right.latest.at - left.latest.at)
    .slice(0, CANDIDATE_LIMIT);
  for (const entry of recent) {
    const result = check(entry, probe);
    if (result.ok) {
      checked.push({ entry, changedLines: result.changedLines });
    }
  }
  checked.sort(
    (left, right) =>
      left.changedLines - right.changedLines ||
      right.entry.latest.at - left.entry.latest.at ||
      right.entry.count - left.entry.count ||
      left.entry.id.localeCompare(right.entry.id)
  );
  const picks: MemoryPick[] = [];
  for (const pick of checked) {
    const key = `${pick.entry.kind}\u0000${pick.entry.fingerprintKey}`;
    if (picks.length >= limit || taken.has(key)) {
      continue;
    }
    taken.add(key);
    picks.push(pick);
  }
  return picks;
}

// 锚点的当前路径：按版本历史追踪事发以来的改名
function currentAnchor(entry: MemoryEntry, probe: WorkspaceProbe): string {
  return probe.renamedSince(entry.anchor, entry.latest.at);
}

// 开局：只取挂在题面直接指到的文件上的记忆
export function selectOpening(
  entries: readonly MemoryEntry[],
  referencedFiles: readonly string[],
  probe: WorkspaceProbe,
  check: EntryChecker = checkEntry,
  limit: number = STRUCTURED_MEMORY_LIMIT
): MemoryPick[] {
  const files = new Set(referencedFiles);
  const candidates = entries.filter((entry) => files.has(currentAnchor(entry, probe)));
  return verifiedTop(candidates, probe, limit, check, new Set());
}

// 本次验证失败各步的指纹（与派生同一套解析，路径相对工作区）
export function failingFingerprints(
  steps: readonly VerifyStepResult[],
  workspace: string
): Array<{ stepName: string; fingerprint: Fingerprint }> {
  return steps
    .filter((step) => step.verdict === "fail")
    .flatMap((step) =>
      parseStepOutput({ name: step.name, output: step.output }).fingerprints.map((fingerprint) => ({
        stepName: step.name,
        fingerprint: {
          ...fingerprint,
          ...(fingerprint.file !== undefined
            ? { file: workspaceRelative(fingerprint.file, workspace) }
            : {}),
          ...(fingerprint.to !== undefined
            ? { to: workspaceRelative(fingerprint.to, workspace) }
            : {}),
        },
      }))
    );
}

// 回炉：指纹对上的优先，其次是挂在本次报错涉及文件上的记忆
export function selectRepair(
  entries: readonly MemoryEntry[],
  failing: ReadonlyArray<{ stepName: string; fingerprint: Fingerprint }>,
  probe: WorkspaceProbe,
  check: EntryChecker = checkEntry,
  limit: number = STRUCTURED_MEMORY_LIMIT
): MemoryPick[] {
  const keys = new Set(failing.map((entry) => fingerprintKey(entry.stepName, entry.fingerprint)));
  const files = new Set(
    failing.flatMap((entry) =>
      [entry.fingerprint.file, entry.fingerprint.to].filter(
        (file): file is string => file !== undefined
      )
    )
  );
  const matched = entries.filter((entry) => keys.has(entry.fingerprintKey));
  const byFile = entries.filter(
    (entry) => !keys.has(entry.fingerprintKey) && files.has(currentAnchor(entry, probe))
  );
  const taken = new Set<string>();
  const first = verifiedTop(matched, probe, limit, check, taken);
  return [...first, ...verifiedTop(byFile, probe, limit - first.length, check, taken)];
}

// 固定挑选（决策 157）：调用方指定的条目按给定顺序取出（不存在的编号略过），核验与正式挑选相同
export function selectFixed(
  entries: readonly MemoryEntry[],
  ids: readonly string[],
  probe: WorkspaceProbe,
  check: EntryChecker = checkEntry
): MemoryPick[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const picks: MemoryPick[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry === undefined) {
      continue;
    }
    const result = check(entry, probe);
    if (result.ok) {
      picks.push({ entry, changedLines: result.changedLines });
    }
  }
  return picks;
}

// ---- 推送文字 ----

function fileList(files: readonly string[] | undefined): string {
  const list = files ?? [];
  if (list.length === 0) {
    return "（无）";
  }
  const shown = list.slice(0, 3).join("、");
  return list.length > 3 ? `${shown} 等 ${list.length} 个文件` : shown;
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// 一条记忆的推送文字：一两句，写明是过去的事实、仅供参考、与当前代码冲突时以代码为准
export function renderEntry(entry: MemoryEntry): string {
  const fact = entry.latest;
  const what = describeFingerprint(entry.fingerprint);
  const names =
    entry.fingerprint.names.length > 0 ? `（涉及 ${entry.fingerprint.names.join("、")}）` : "";
  const repeated = entry.count > 1 ? `同类出现过 ${entry.count} 次。` : "";
  const body =
    entry.kind === "regression"
      ? `${day(fact.at)} 的一步里改动 ${fileList(fact.changedAtRed)} 后，「${entry.stepName}」检查报 ${what}${names}，` +
        `随后补改 ${fileList(fact.repairFiles)} 才通过。`
      : `${day(fact.at)} 的一步尝试改动 ${fileList(fact.attemptedFiles)}，「${entry.stepName}」检查一直报 ${what}${names}，` +
        "修到上限仍未通过、改动已撤回。";
  const text = `[${entry.id}] ${STRUCTURED_MEMORY_DISCLAIMER}：${body}${repeated}`;
  return text.length > ENTRY_TEXT_LIMIT ? `${text.slice(0, ENTRY_TEXT_LIMIT - 1)}…` : text;
}

// 开局段落（拼进系统提示，与常驻 Memory 分开计预算）；没有条目为空串
export function renderOpeningSection(picks: readonly MemoryPick[]): string {
  if (picks.length === 0) {
    return "";
  }
  return clip(
    [
      "## 结构化记忆",
      `以下是程序从本项目以往运行记录中取出的${STRUCTURED_MEMORY_DISCLAIMER}。`,
      ...picks.map((pick) => `- ${renderEntry(pick.entry)}`),
    ].join("\n")
  );
}

// 回炉附加内容（附在回炉反馈之后）；没有条目为空串
export function renderRepairAppendix(picks: readonly MemoryPick[]): string {
  if (picks.length === 0) {
    return "";
  }
  return clip(
    [
      `相关的结构化记忆（${STRUCTURED_MEMORY_DISCLAIMER}）：`,
      ...picks.map((pick) => `- ${renderEntry(pick.entry)}`),
    ].join("\n")
  );
}

function clip(text: string): string {
  return text.length > STRUCTURED_MEMORY_BUDGET_CHARS
    ? `${text.slice(0, STRUCTURED_MEMORY_BUDGET_CHARS - 1)}…`
    : text;
}
