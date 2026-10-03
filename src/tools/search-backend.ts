// grep 与 glob 的搜索后端（决策 368）：经执行端在本机或容器里运行——优先 ripgrep，没有则 git grep（工作区在 git
// 仓库里时），再退到 grep -r；glob 的文件清单同样依次用 rg --files、git ls-files、find。
// 本机先用随包附带的 ripgrep（@vscode/ripgrep：按平台拆成可选依赖，二进制直接打在包里，安装时不联网下载；MIT）。
// 传给后端的参数一律是数组、不经 shell（模式里的 shell 特殊字符原样交给后端）；模式以 -e 给出、路径放在 -- 之后，
// 以 - 开头也不会被当成选项。
// .gitignore：rg 与 git 只在 git 仓库里遵守（rg 缺省如此，git 本就如此）；不在 git 仓库里时三种后端都不按它过滤，口径一致。
// 后端只负责列出候选与原始匹配；文件名模式、禁读名单与排序由调用方统一做。
import { existsSync } from "node:fs";
import path from "node:path";
import { allowedEnv } from "./run-command.ts";
import type { HostExecResult, WorkspaceHost } from "./workspace-host.ts";

// 模型侧的错误（正则写错、path 不是目录）
export class SearchToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

// 环境问题（没有可用的搜索程序、搜索超时、后端出错）
export class SearchEnvironmentError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

// 单行最多给出的字符数（决策 368），超出截断并注明
export const MAX_LINE_CHARS = 2000;

// 搜索起点：path 参数经路径围栏解析（限工作区），给出相对工作区根的写法（正斜杠，根为 "."）与它是不是文件
export async function searchStart(
  host: WorkspaceHost,
  inputPath: string
): Promise<{ rel: string; isFile: boolean }> {
  const root = await host.resolveExisting(".");
  const target = await host.resolveExisting(inputPath);
  const p = host.platform === "win32" ? path.win32 : path.posix;
  const rel = p.relative(root, target).split(p.sep).join("/");
  return { rel: rel === "" ? "." : rel, isFile: await host.isFile(target) };
}

// 结果路径相对搜索起点的写法（文件名模式按它匹配）
export function relativeToStart(relPath: string, start: { rel: string; isFile: boolean }): string {
  if (start.isFile) {
    return relPath.slice(relPath.lastIndexOf("/") + 1);
  }
  return start.rel === "." ? relPath : relPath.slice(start.rel.length + 1);
}

export type SearchBackendKind = "rg" | "git" | "grep";

export interface SearchBackend {
  kind: SearchBackendKind;
  program: string;
  // grep -r：GNU grep 支持 -Z、-I、--exclude-dir；busybox 等不支持，输出按 path:行号:内容 解析
  gnu?: boolean;
}

export interface SearchBackendOptions {
  // 本机执行端：先试随包附带的 ripgrep（容器执行端不给，用容器里的 rg）
  bundledRipgrep?: boolean;
  // 只用这一种后端（测试各后端结果一致）
  only?: SearchBackendKind;
  timeoutMs?: number;
}

// 搜索输出的上限：超出即不再统计（结果里注明"至少"）
export const SEARCH_OUTPUT_CAP = 8 * 1024 * 1024;
const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

// 随包附带的 ripgrep 的路径；当前平台没有装上返回 undefined（降级到 git grep、grep -r）
export async function bundledRipgrepPath(): Promise<string | undefined> {
  try {
    const { rgPath } = await import("@vscode/ripgrep");
    return existsSync(rgPath) ? rgPath : undefined;
  } catch {
    return undefined;
  }
}

export function runSearch(
  host: WorkspaceHost,
  program: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal | undefined; maxOutputBytes?: number } = {}
): Promise<HostExecResult> {
  return host.exec(
    { program, args, verbatim: false },
    {
      env: allowedEnv(process.env),
      timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? SEARCH_OUTPUT_CAP,
      signal: options.signal,
    }
  );
}

async function probe(host: WorkspaceHost, program: string, args: string[]) {
  try {
    const result = await runSearch(host, program, args, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    return result.spawned && result.spawnError === undefined ? result : undefined;
  } catch {
    return undefined;
  }
}

// 依次探测可用的后端；都没有返回 undefined
export async function detectSearchBackend(
  host: WorkspaceHost,
  options: SearchBackendOptions = {}
): Promise<SearchBackend | undefined> {
  const wants = (kind: SearchBackendKind) => options.only === undefined || options.only === kind;
  if (wants("rg")) {
    const bundled = options.bundledRipgrep === true ? await bundledRipgrepPath() : undefined;
    for (const program of [bundled, "rg"]) {
      if (program !== undefined && (await probe(host, program, ["--version"]))?.exitCode === 0) {
        return { kind: "rg", program };
      }
    }
  }
  if (wants("git")) {
    const inside = await probe(host, "git", ["rev-parse", "--is-inside-work-tree"]);
    if (inside?.exitCode === 0 && inside.stdout.trim() === "true") {
      return { kind: "git", program: "git" };
    }
  }
  if (wants("grep")) {
    const version = await probe(host, "grep", ["-V"]);
    if (version !== undefined) {
      return {
        kind: "grep",
        program: "grep",
        gnu: version.exitCode === 0 && /GNU/.test(version.output),
      };
    }
  }
  return undefined;
}

export interface GrepQuery {
  pattern: string;
  // 搜索起点：相对工作区根（正斜杠；根为 "."）
  searchPath: string;
  ignoreCase: boolean;
  context: number;
  filesOnly: boolean;
  // ripgrep 按文件名预筛（只为提速）
  prefilter?: string;
}

export function grepArgs(backend: SearchBackend, query: GrepQuery): string[] {
  const context = query.context > 0 && !query.filesOnly ? ["-C", String(query.context)] : [];
  if (backend.kind === "rg") {
    return [
      "--no-config",
      "--hidden",
      "--glob",
      "!.git",
      "--no-heading",
      "--with-filename",
      "--line-number",
      "--null",
      "--color",
      "never",
      "--no-messages",
      ...(query.ignoreCase ? ["--ignore-case"] : []),
      ...(query.filesOnly ? ["--files-with-matches"] : []),
      ...context,
      ...(query.prefilter !== undefined
        ? ["--type-add", `pigeon:${query.prefilter}`, "--type", "pigeon"]
        : []),
      "-e",
      query.pattern,
      "--",
      query.searchPath,
    ];
  }
  if (backend.kind === "git") {
    // -z 下匹配行与上下文行都以 NUL 分隔字段：带 --column 时匹配行多一个列号字段，据此区分
    return [
      "-c",
      "core.quotepath=off",
      "grep",
      "--no-color",
      "-I",
      "--untracked",
      "-E",
      "-n",
      "-z",
      ...(query.filesOnly ? ["-l"] : ["--column"]),
      ...(query.ignoreCase ? ["-i"] : []),
      ...context,
      "-e",
      query.pattern,
      "--",
      `:(literal)${query.searchPath}`,
    ];
  }
  return [
    "-r",
    "-n",
    "-H",
    "-s",
    "-E",
    ...(backend.gnu === true ? ["-I", "-Z", "--exclude-dir=.git"] : []),
    ...(query.ignoreCase ? ["-i"] : []),
    ...(query.filesOnly ? ["-l"] : []),
    ...context,
    "-e",
    query.pattern,
    "--",
    query.searchPath,
  ];
}

// 一条结果：匹配行或上下文行；separator 为不相连的两段之间的分隔
export type GrepRecord =
  | { kind: "line"; path: string; line: number; text: string; match: boolean }
  | { kind: "separator" };

// 后端给出的路径统一成相对工作区根的正斜杠写法
export function normalizeResultPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function lineRecord(path: string, line: string, text: string, match: boolean): GrepRecord {
  return {
    kind: "line",
    path: normalizeResultPath(path),
    line: Number(line),
    text: text.replace(/\r$/, ""),
    match,
  };
}

// 解析匹配输出（files_only 时另见 parseFileList）；认不出的行（警告、二进制文件提示）丢弃
export function parseGrepOutput(backend: SearchBackend, output: string): GrepRecord[] {
  const records: GrepRecord[] = [];
  for (const line of output.split("\n")) {
    if (line === "--") {
      records.push({ kind: "separator" });
      continue;
    }
    if (backend.kind === "git") {
      const fields = line.split("\0");
      if (fields.length === 4 && /^\d+$/.test(fields[1] ?? "")) {
        records.push(lineRecord(fields[0] ?? "", fields[1] ?? "", fields[3] ?? "", true));
      } else if (fields.length === 3 && /^\d+$/.test(fields[1] ?? "")) {
        records.push(lineRecord(fields[0] ?? "", fields[1] ?? "", fields[2] ?? "", false));
      }
      continue;
    }
    if (backend.kind === "rg" || backend.gnu === true) {
      const nul = line.indexOf("\0");
      const rest = /^(\d+)([:-])(.*)$/s.exec(line.slice(nul + 1));
      if (nul > 0 && rest !== null) {
        records.push(lineRecord(line.slice(0, nul), rest[1] ?? "", rest[3] ?? "", rest[2] === ":"));
      }
      continue;
    }
    // 不支持 -Z 的 grep：path:行号:内容 或 path-行号-内容，取第一处分隔（文件名里带这种片段时可能认错，只在降级时出现）
    const plain = /^(.+?)([:-])(\d+)\2(.*)$/s.exec(line);
    if (plain !== null) {
      records.push(lineRecord(plain[1] ?? "", plain[3] ?? "", plain[4] ?? "", plain[2] === ":"));
    }
  }
  return records;
}

// 只列文件名的输出与 glob 的文件清单：NUL 分隔（rg、git、GNU grep）或换行分隔（其余 grep、find）
export function parseFileList(output: string, nulSeparated: boolean): string[] {
  return output
    .split(nulSeparated ? "\0" : "\n")
    .map((entry) => (nulSeparated ? entry : entry.replace(/\r$/, "")))
    .filter((entry) => entry !== "")
    .map(normalizeResultPath);
}

// glob 的文件清单（遵守 .gitignore、跳过 .git，口径同 grep）；返回程序、参数与输出是否 NUL 分隔
export function listFilesArgs(
  backend: SearchBackend,
  searchPath: string,
  prefilter: string | undefined
): { program: string; args: string[]; nul: boolean } {
  if (backend.kind === "rg") {
    return {
      program: backend.program,
      args: [
        "--no-config",
        "--files",
        "--hidden",
        "--glob",
        "!.git",
        "--null",
        "--no-messages",
        ...(prefilter !== undefined
          ? ["--type-add", `pigeon:${prefilter}`, "--type", "pigeon"]
          : []),
        "--",
        searchPath,
      ],
      nul: true,
    };
  }
  if (backend.kind === "git") {
    return {
      program: "git",
      args: [
        "-c",
        "core.quotepath=off",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        `:(literal)${searchPath}`,
      ],
      nul: true,
    };
  }
  // 起点加 ./：以 - 开头的目录名不会被 find 当成表达式
  return {
    program: "find",
    args: [
      searchPath === "." ? "." : `./${searchPath}`,
      "-name",
      ".git",
      "-prune",
      "-o",
      "-type",
      "f",
      "-print",
    ],
    nul: false,
  };
}

// 结果末尾的说明（grep 与 glob 共用）：没有结果；超出上限给出总数并提示缩小范围；按禁读名单略去的条数
export function resultNotes(input: {
  total: number;
  shown: number;
  // 输出超过上限，没有统计完（total 为"至少"）
  incomplete: boolean;
  deniedOmitted: number;
  unit: string;
  measure: string;
  none: string;
  narrow: string;
}): string[] {
  const notes: string[] = [];
  if (input.total === 0) {
    notes.push(input.none);
  } else if (input.incomplete || input.total > input.shown) {
    const count = input.incomplete
      ? `超过 ${input.total} ${input.unit}（输出过大，未统计完）`
      : `共 ${input.total} ${input.unit}`;
    notes.push(`${count}，只列出前 ${input.shown} ${input.measure}；请缩小范围（${input.narrow}）`);
  }
  if (input.deniedOmitted > 0) {
    notes.push(`已按禁读名单略去 ${input.deniedOmitted} 条`);
  }
  return notes;
}

// 路径里有 .git 这一段（不支持 --exclude-dir 的 grep 与 find 的结果在这里再滤一次）
export function inGitDir(relPath: string): boolean {
  return relPath.split("/").includes(".git");
}
