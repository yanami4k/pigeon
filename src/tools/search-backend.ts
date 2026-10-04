// grep 与 glob 的搜索后端（决策 368）：经执行端在本机或容器里运行——优先 ripgrep，没有则 git grep（工作区在 git
// 仓库里时），再退到 grep -r；glob 的文件清单同样依次用 rg --files、git ls-files、find。
// 本机只用随包附带的 ripgrep（@vscode/ripgrep：按平台拆成可选依赖，二进制直接打在包里，安装时不联网下载；MIT），
// 取其绝对路径；容器里用容器自己的。后端是 Pigeon 自己的辅助程序，经执行端的 execHelper 运行、不走 agent 的执行通道：
// 程序按系统目录解析成绝对路径，git 不读系统与全局配置、关掉 fsmonitor，ripgrep 不读配置文件、不读 .ignore 与全局
// gitignore——免审的只读工具不执行 agent 事先放好的程序或配置。
// 传给后端的参数一律是数组、不经 shell 拼接（模式里的 shell 特殊字符原样交给后端）；模式以 -e 给出、路径放在 -- 之后，
// 以 - 开头也不会被当成选项。
// 输出一律无歧义：rg 用 --json（只列文件名时用 --null），git 用 -z 并先按字面路径排除文件名含控制字符的文件；
// grep -r 降级改为先列出候选文件、按真实路径筛过，只对允许的文件逐个搜（-h，不输出文件名），归属由这里按分隔行记。
// 每条结果都按真实路径筛（禁读的、经链接落在工作区外的略去）；文件名含换行或控制字符的一律略去。
// .gitignore：rg 与 git 只在 git 仓库里遵守（rg 缺省如此，git 本就如此）；不在 git 仓库里时三种后端都不按它过滤，口径一致。
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { allowedEnv } from "./run-command.ts";
import type { HostExecResult, WorkspaceHost } from "./workspace-host.ts";

// 模型侧的错误（正则写错、path 不是目录）
export class SearchToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

// 环境问题（没有可用的搜索程序、执行端缺少所需能力、搜索超时、后端出错）
export class SearchEnvironmentError extends Error {
  readonly pigeonToolErrorKind = "environment";
}

// 单行最多给出的字符数（决策 368），超出截断并注明
export const MAX_LINE_CHARS = 2000;

// 一次最多按真实路径检查的文件数：超出的不搜、不列，计入略去
export const SCREEN_LIMIT = 20_000;

// 搜索起点：path 参数照读档的规则解析（真实路径、禁读名单、Windows 的设备前缀、UNC 与数据流写法），落在禁读名单内或
// 工作区外即拒；给出相对工作区根的写法（正斜杠，根为 "."）与它是不是文件。执行端没有读档解析即报错（失败即拒）
export async function searchStart(
  host: WorkspaceHost,
  inputPath: string,
  deny: readonly string[]
): Promise<{ rel: string; isFile: boolean }> {
  const resolveForRead = host.resolveForRead;
  if (resolveForRead === undefined) {
    throw new SearchEnvironmentError("本执行端不能按读档规则解析路径，grep、glob 不可用");
  }
  const resolve = async (input: string): Promise<string> => {
    const resolved = await resolveForRead.call(host, input, deny);
    if (resolved.outside) throw new SearchToolError(`路径越出工作区根：${input}`);
    return resolved.path;
  };
  const root = await resolve(".");
  const target = await resolve(inputPath);
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
  // GNU grep 支持 -I（跳过二进制文件）
  gnu?: boolean;
}

export interface SearchBackendOptions {
  // 本机执行端：只用随包附带的 ripgrep（绝对路径）；容器执行端不给，用容器里的 rg
  bundledRipgrep?: boolean;
  // 只用这一种后端（测试各后端结果一致）
  only?: SearchBackendKind;
  timeoutMs?: number;
}

// 搜索输出的上限：超出即不再统计（结果里注明"超过"）
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
  options: {
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    maxOutputBytes?: number;
    stdin?: string;
  } = {}
): Promise<HostExecResult> {
  if (host.execHelper === undefined) {
    throw new SearchEnvironmentError("本执行端不支持 grep、glob");
  }
  return host.execHelper(program, args, {
    env: allowedEnv(process.env),
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? SEARCH_OUTPUT_CAP,
    signal: options.signal,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
}

async function probe(host: WorkspaceHost, program: string, args: string[]) {
  try {
    const result = await runSearch(host, program, args, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    // 容器里经 shell 包装执行：程序不存在为 127、不可执行为 126
    return result.spawned &&
      result.spawnError === undefined &&
      result.exitCode !== 126 &&
      result.exitCode !== 127
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

// 依次探测可用的后端；都没有返回 undefined。grep -r 降级要 /bin/sh，Windows 本机不用
export async function detectSearchBackend(
  host: WorkspaceHost,
  options: SearchBackendOptions = {}
): Promise<SearchBackend | undefined> {
  const wants = (kind: SearchBackendKind) => options.only === undefined || options.only === kind;
  if (wants("rg")) {
    const program = options.bundledRipgrep === true ? await bundledRipgrepPath() : "rg";
    if (program !== undefined && (await probe(host, program, ["--version"]))?.exitCode === 0) {
      return { kind: "rg", program };
    }
  }
  if (wants("git")) {
    const inside = await probe(host, "git", [...GIT_SAFE, "rev-parse", "--is-inside-work-tree"]);
    if (inside?.exitCode === 0 && inside.stdout.trim() === "true") {
      return { kind: "git", program: "git" };
    }
  }
  if (wants("grep") && host.platform !== "win32") {
    const version = await probe(host, "grep", ["-V"]);
    if (version !== undefined) {
      return {
        kind: "grep",
        program: "grep",
        gnu: version.exitCode === 0 && /\(GNU grep\)/.test(version.output),
      };
    }
  }
  return undefined;
}

// git 的每次调用都关掉 fsmonitor（仓库配置里的 fsmonitor 会执行程序），系统与全局配置由 execHelper 屏蔽
const GIT_SAFE = ["-c", "core.fsmonitor=", "-c", "core.quotepath=off"];

// ripgrep 的共同参数：不读配置文件；不读 .ignore、.rgignore 与全局 gitignore（与 git 的口径一致）；含隐藏文件、跳过 .git
const RG_COMMON = [
  "--no-config",
  "--no-ignore-dot",
  "--no-ignore-global",
  "--hidden",
  "--glob",
  "!.git",
  "--no-messages",
];

// grep -r 降级：标准输入逐行给出允许的文件（文件名已确认不含换行与控制字符），对每个文件先打一行分隔（\x01、本次的
// 随机数、空格与文件名），再以 -h 搜它；第一个参数为随机数，其后为 grep 的选项与模式。文件内容无从伪造分隔行
const GREP_EACH_SCRIPT = [
  "nonce=$1; shift",
  "while IFS= read -r f; do",
  `  printf '\\001%s %s\\n' "$nonce" "$f"`,
  '  grep "$@" -- "$f"',
  "done",
  "exit 0",
].join("\n");

// 一条结果：匹配行或上下文行
export interface GrepRecord {
  path: string;
  line: number;
  text: string;
  match: boolean;
}

// 略去的文件数：禁读的、经链接落在工作区外的、文件名含换行或控制字符的、超出检查上限或检查超时而未经检查的
export interface Omitted {
  denied: number;
  outside: number;
  unsafe: number;
  unchecked: number;
}

export function noneOmitted(): Omitted {
  return { denied: 0, outside: 0, unsafe: 0, unchecked: 0 };
}

// 文件名含换行或其他控制字符
export function unsafeName(name: string): boolean {
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// 后端给出的路径统一成相对工作区根的正斜杠写法（反斜杠只在 Windows 上是分隔符）
export function normalizeResultPath(raw: string, platform: NodeJS.Platform): string {
  return (platform === "win32" ? raw.replace(/\\/g, "/") : raw).replace(/^(\.\/)+/, "");
}

function nulList(output: string, platform: NodeJS.Platform): string[] {
  return output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => normalizeResultPath(entry, platform));
}

// 路径里有 .git 这一段（find 的结果在这里再滤一次）
export function inGitDir(relPath: string): boolean {
  return relPath.split("/").includes(".git");
}

// 后端出错（退出码不是 0 或 1）且没有任何结果：正则写错等归模型侧，其余归环境
export function backendFailure(stderr: string, exitCode: number | null): Error {
  const message = stderr.trim().slice(0, 1000) || `退出码 ${exitCode}`;
  return /regex|regular expression|parse error|Unmatched|Invalid|unmatched|invalid/.test(message)
    ? new SearchToolError(`模式有误：${message}`)
    : new SearchEnvironmentError(`搜索出错：${message}`);
}

// 逐个文件按真实路径筛（决策 355 / 368，三种后端一律如此）：文件名含换行或控制字符的略去；超出 SCREEN_LIMIT 的不查、
// 略去；其余交执行端按真实路径分类，可读的留下，禁读的与经链接落在工作区外的略去；检查超时或中止而没查到的略去；
// 取不到真实路径的（列出之后被删）略去不计。执行端没有分类能力即报错（失败即拒）
export async function screenFiles(
  host: WorkspaceHost,
  relPaths: readonly string[],
  deny: readonly string[],
  omitted: Omitted,
  signal: AbortSignal | undefined
): Promise<Set<string>> {
  if (host.classifyReadPaths === undefined) {
    throw new SearchEnvironmentError("本执行端不能按真实路径检查结果，grep、glob 不可用");
  }
  const safe: string[] = [];
  for (const rel of new Set(relPaths)) {
    if (unsafeName(rel)) omitted.unsafe += 1;
    else safe.push(rel);
  }
  const checked = safe.slice(0, SCREEN_LIMIT);
  omitted.unchecked += safe.length - checked.length;
  const allowed = new Set<string>();
  if (checked.length === 0) return allowed;
  const { classes, incomplete } = await host.classifyReadPaths(checked, deny, signal);
  for (const rel of checked) {
    const kind = classes.get(rel);
    if (kind === "ok") allowed.add(rel);
    else if (kind === "denied") omitted.denied += 1;
    else if (kind === "outside") omitted.outside += 1;
    else if (incomplete) omitted.unchecked += 1;
  }
  return allowed;
}

export interface GrepQuery {
  pattern: string;
  start: { rel: string; isFile: boolean };
  ignoreCase: boolean;
  context: number;
  filesOnly: boolean;
  // ripgrep 按文件名预筛（只为提速）
  prefilter?: string;
  // 文件名模式与 .git 的过滤（相对工作区根的路径）
  keep: (relPath: string) => boolean;
}

export interface GrepRun {
  // 内容模式：已筛过的匹配行与上下文行
  records: GrepRecord[];
  // 只列文件名：已筛过的文件
  files: string[];
  omitted: Omitted;
  // 输出超过上限，没有统计完
  incomplete: boolean;
}

interface RunContext {
  deny: readonly string[];
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
}

// 执行一次后端并检查超时
async function exec(
  host: WorkspaceHost,
  program: string,
  args: string[],
  context: RunContext,
  stdin?: string
): Promise<HostExecResult> {
  const result = await runSearch(host, program, args, {
    timeoutMs: context.timeoutMs,
    signal: context.signal,
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (result.timedOut) {
    throw new SearchEnvironmentError("搜索超时；请缩小范围（更具体的 path 或 glob）");
  }
  return result;
}

const failedExit = (result: HostExecResult) => result.exitCode !== 0 && result.exitCode !== 1;

// rg --json 的匹配行与上下文行；非 UTF-8 的文件名记作不安全的名字（以 \x00 开头的占位，交给筛选计数）
function parseRgJson(stdout: string, platform: NodeJS.Platform): GrepRecord[] {
  const records: GrepRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let message: {
      type?: string;
      data?: {
        path?: { text?: string; bytes?: string };
        lines?: { text?: string; bytes?: string };
        line_number?: number | null;
      };
    };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type !== "match" && message.type !== "context") continue;
    const data = message.data;
    if (typeof data?.line_number !== "number") continue;
    const rawPath =
      typeof data.path?.text === "string" ? data.path.text : `\0${data.path?.bytes ?? ""}`;
    const text =
      typeof data.lines?.text === "string"
        ? data.lines.text
        : Buffer.from(data.lines?.bytes ?? "", "base64").toString("utf8");
    records.push({
      path: normalizeResultPath(rawPath, platform),
      line: data.line_number,
      text: text.replace(/\r?\n$/, ""),
      match: message.type === "match",
    });
  }
  return records;
}

// git grep -z 的匹配行（路径、行号、列号、内容）与上下文行（路径、行号、内容）；文件名含控制字符的已事先排除
function parseGitZ(stdout: string, platform: NodeJS.Platform): GrepRecord[] {
  const records: GrepRecord[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.split("\0");
    if (fields.length !== 3 && fields.length !== 4) continue;
    if (!/^\d+$/.test(fields[1] ?? "")) continue;
    records.push({
      path: normalizeResultPath(fields[0] ?? "", platform),
      line: Number(fields[1]),
      text: (fields[fields.length - 1] ?? "").replace(/\r$/, ""),
      match: fields.length === 4,
    });
  }
  return records;
}

// 先搜后筛（rg、git）：结果按文件名模式过滤，再逐个文件按真实路径筛
async function screenRecords(
  host: WorkspaceHost,
  records: GrepRecord[],
  files: string[],
  query: GrepQuery,
  context: RunContext,
  omitted: Omitted
): Promise<{ records: GrepRecord[]; files: string[] }> {
  const kept = records.filter((record) => query.keep(record.path));
  const keptFiles = files.filter(query.keep);
  const allowed = await screenFiles(
    host,
    query.filesOnly ? keptFiles : kept.map((record) => record.path),
    context.deny,
    omitted,
    context.signal
  );
  return {
    records: kept.filter((record) => allowed.has(record.path)),
    files: keptFiles.filter((file) => allowed.has(file)),
  };
}

// 执行一次 grep：三种后端各自无歧义地取结果，并都经真实路径筛选
export async function runGrep(
  host: WorkspaceHost,
  backend: SearchBackend,
  query: GrepQuery,
  options: { deny: readonly string[]; signal: AbortSignal | undefined; timeoutMs?: number }
): Promise<GrepRun> {
  const context: RunContext = {
    deny: options.deny,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
  const omitted = noneOmitted();
  const platform = host.platform;
  const contextArgs = query.context > 0 && !query.filesOnly ? ["-C", String(query.context)] : [];
  const ignoreCase = query.ignoreCase ? ["-i"] : [];
  if (backend.kind === "rg") {
    const result = await exec(
      host,
      backend.program,
      [
        ...RG_COMMON,
        ...(query.filesOnly ? ["--files-with-matches", "--null"] : ["--json"]),
        ...ignoreCase,
        ...contextArgs,
        ...(query.prefilter !== undefined
          ? ["--type-add", `pigeon:${query.prefilter}`, "--type", "pigeon"]
          : []),
        "-e",
        query.pattern,
        "--",
        query.start.rel,
      ],
      context
    );
    const records = query.filesOnly ? [] : parseRgJson(result.stdout, platform);
    const files = query.filesOnly ? nulList(result.stdout, platform) : [];
    if (failedExit(result) && records.length === 0 && files.length === 0) {
      throw backendFailure(result.stderr, result.exitCode);
    }
    const screened = await screenRecords(host, records, files, query, context, omitted);
    return { ...screened, omitted, incomplete: result.outputBytes > SEARCH_OUTPUT_CAP };
  }
  if (backend.kind === "git") {
    // 先列出范围内的文件：名字含控制字符的按字面路径排除在搜索之外（输出因此无歧义），计入略去
    const listed = await exec(
      host,
      "git",
      [...GIT_SAFE, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"].concat(
        `:(literal)${query.start.rel}`
      ),
      context
    );
    const unsafe = [...new Set(listed.stdout.split("\0").filter((name) => name !== ""))].filter(
      unsafeName
    );
    omitted.unsafe += unsafe.length;
    const result = await exec(
      host,
      "git",
      [
        ...GIT_SAFE,
        "grep",
        "--no-color",
        "-I",
        "--untracked",
        "-E",
        "-n",
        "-z",
        ...(query.filesOnly ? ["-l"] : ["--column"]),
        ...ignoreCase,
        ...contextArgs,
        "-e",
        query.pattern,
        "--",
        `:(literal)${query.start.rel}`,
        ...unsafe.map((name) => `:(exclude,literal)${name}`),
      ],
      context
    );
    const records = query.filesOnly ? [] : parseGitZ(result.stdout, platform);
    const files = query.filesOnly ? nulList(result.stdout, platform) : [];
    if (failedExit(result) && records.length === 0 && files.length === 0) {
      throw backendFailure(result.stderr, result.exitCode);
    }
    const screened = await screenRecords(host, records, files, query, context, omitted);
    return { ...screened, omitted, incomplete: result.outputBytes > SEARCH_OUTPUT_CAP };
  }
  // grep -r 降级：先列候选、按真实路径筛，只对允许的文件逐个搜
  const candidates = query.start.isFile
    ? [query.start.rel]
    : nulList((await exec(host, "find", findArgs(query.start.rel), context)).stdout, platform);
  const allowed = [
    ...(await screenFiles(
      host,
      candidates.filter(query.keep),
      context.deny,
      omitted,
      context.signal
    )),
  ];
  if (allowed.length === 0) {
    return { records: [], files: [], omitted, incomplete: false };
  }
  const nonce = randomBytes(8).toString("hex");
  const flags = [
    ...(query.filesOnly ? ["-l"] : ["-n", "-h"]),
    "-s",
    "-E",
    ...(backend.gnu === true ? ["-I"] : []),
    ...ignoreCase,
    ...contextArgs,
    "-e",
    query.pattern,
  ];
  const result = await exec(
    host,
    "/bin/sh",
    ["-c", GREP_EACH_SCRIPT, "sh", nonce, ...flags],
    context,
    `${allowed.join("\n")}\n`
  );
  const marker = `\u0001${nonce} `;
  const records: GrepRecord[] = [];
  const matched = new Set<string>();
  let current: string | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith(marker)) {
      current = line.slice(marker.length);
      continue;
    }
    if (current === undefined || line === "") continue;
    if (query.filesOnly) {
      matched.add(current);
      continue;
    }
    const parsed = /^(\d+)([:-])(.*)$/s.exec(line);
    if (parsed !== null) {
      records.push({
        path: current,
        line: Number(parsed[1]),
        text: (parsed[3] ?? "").replace(/\r$/, ""),
        match: parsed[2] === ":",
      });
    }
  }
  if (records.length === 0 && matched.size === 0 && result.stderr.trim() !== "") {
    const failure = backendFailure(result.stderr, result.exitCode);
    if (failure instanceof SearchToolError) throw failure;
  }
  return {
    records,
    files: allowed.filter((file) => matched.has(file)),
    omitted,
    incomplete: result.outputBytes > SEARCH_OUTPUT_CAP,
  };
}

// find 列出起点下的普通文件（跳过 .git，NUL 分隔）；起点加 ./：以 - 开头的目录名不会被 find 当成表达式
function findArgs(searchPath: string): string[] {
  return [
    searchPath === "." ? "." : `./${searchPath}`,
    "-name",
    ".git",
    "-prune",
    "-o",
    "-type",
    "f",
    "-print0",
  ];
}

// glob 的文件清单（遵守 .gitignore、跳过 .git，口径同 grep），按文件名模式过滤后逐个文件按真实路径筛
export async function runListing(
  host: WorkspaceHost,
  backend: SearchBackend,
  start: { rel: string },
  options: {
    prefilter: string | undefined;
    keep: (relPath: string) => boolean;
    deny: readonly string[];
    signal: AbortSignal | undefined;
    timeoutMs?: number;
  }
): Promise<{ files: string[]; omitted: Omitted; incomplete: boolean }> {
  const context: RunContext = {
    deny: options.deny,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
  const [program, args] =
    backend.kind === "rg"
      ? [
          backend.program,
          [
            ...RG_COMMON,
            "--files",
            "--null",
            ...(options.prefilter !== undefined
              ? ["--type-add", `pigeon:${options.prefilter}`, "--type", "pigeon"]
              : []),
            "--",
            start.rel,
          ],
        ]
      : backend.kind === "git"
        ? [
            "git",
            [
              ...GIT_SAFE,
              "ls-files",
              "-z",
              "--cached",
              "--others",
              "--exclude-standard",
              "--",
              `:(literal)${start.rel}`,
            ],
          ]
        : ["find", findArgs(start.rel)];
  const result = await exec(host, program, args, context);
  const listed = nulList(result.stdout, host.platform).filter(
    (file) => !inGitDir(file) && options.keep(file)
  );
  if (failedExit(result) && listed.length === 0) {
    throw backendFailure(result.stderr, result.exitCode);
  }
  const omitted = noneOmitted();
  const allowed = await screenFiles(host, listed, options.deny, omitted, options.signal);
  return {
    files: [...new Set(listed)].filter((file) => allowed.has(file)),
    omitted,
    incomplete: result.outputBytes > SEARCH_OUTPUT_CAP,
  };
}

// 结果末尾的说明（grep 与 glob 共用）：没有结果；超出上限给出总数并提示缩小范围；略去的文件数
export function resultNotes(input: {
  total: number;
  shown: number;
  // 输出超过上限，没有统计完（total 为"超过"）
  incomplete: boolean;
  omitted: Omitted;
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
  const { denied, outside, unsafe, unchecked } = input.omitted;
  if (denied > 0) notes.push(`已按禁读名单略去 ${denied} 个文件`);
  if (outside > 0) notes.push(`已略去经链接指向工作区以外的 ${outside} 个文件`);
  if (unsafe > 0) notes.push(`已略去文件名含换行或控制字符的 ${unsafe} 个文件`);
  if (unchecked > 0) {
    notes.push(`${unchecked} 个文件未及按真实路径检查（文件过多或检查超时），已略去，结果不完整`);
  }
  return notes;
}
