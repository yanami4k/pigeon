// 会话检索的缓存（决策 339 ⑥；决策 384 改进）：每个会话文件抽出的可搜文本、词频表与目录信息
//（state/session-search-text.ts）按文件大小与修改时间缓存到 .pigeon/state/search-cache/ 下，再次检索只读缓存、
// 不读会话文件。
// - 每个会话两份缓存文件：<会话号>.json 存目录信息与对话正文，<会话号>.tools.json 存工具输出；只搜对话正文时只读前一份。
//   两份各自带格式版本与来源戳（会话文件路径、大小、修改时间），各自校验。
// - 来源戳在读会话文件之前取：读的过程中文件又被追加，戳就比内容旧，下次比对不符即重抽，不会把新内容当作旧戳缓存住。
// - 大小或修改时间变了、版本不符、文件损坏（不是 JSON、形状不对）都当作未命中：重抽并覆盖，不报错中断检索。
// - 写入走同目录临时文件改名，多个会话并发检索同一会话时各写各的临时文件，目标上只会是某一份完整内容。不做 fsync：
//   缓存坏了只是丢弃重建，不需要落盘保证。写缓存失败（目录不可写等）只是少了缓存，检索照常返回。
// - 清理（pruneSessionSearchCache）：会话文件已不在会话根下的缓存、崩溃留下的超过一小时的临时文件，检索与列目录时顺手删掉。
// 读会话文件经只读读取器，从不写会话文件。读取函数可注入（测试以计数验证命中缓存时不读会话文件）。
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
  extractSessionSearch,
  type SearchDoc,
  type SessionCatalogInfo,
} from "../state/session-search-text.ts";
import type { SessionView } from "../state/session-view.ts";
import { readSessionView, sessionRefTime } from "./session-catalog.ts";
import type { SessionFileRef } from "./session-reader.ts";

// 缓存格式版本：抽取口径或文件形状一变即加一，旧缓存随之整体重建。v2 = 决策 339 的初版；v3 = 决策 384
//（每条消息加词频表与工具输出的来历）
export const SESSION_SEARCH_CACHE_VERSION = 3;

const SourceSchema = Type.Object({
  path: Type.String(),
  size: Type.Number(),
  mtimeMs: Type.Number(),
});
type Source = Static<typeof SourceSchema>;

const DocSchema = Type.Object({
  entryId: Type.String(),
  runId: Type.String(),
  runSeq: Type.Number(),
  role: Type.String(),
  timestamp: Type.Number(),
  text: Type.String(),
  tokens: Type.Record(Type.String(), Type.Number()),
  length: Type.Number(),
  toolName: Type.Optional(Type.String()),
  toolParams: Type.Optional(Type.String()),
  toolOutcome: Type.Optional(Type.String()),
});

const MainFileSchema = Type.Object({
  version: Type.Literal(SESSION_SEARCH_CACHE_VERSION),
  source: SourceSchema,
  info: Type.Object({
    sessionId: Type.String(),
    parentSessionId: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    firstUserText: Type.String(),
    changedFiles: Type.Array(Type.String()),
  }),
  conversation: Type.Array(DocSchema),
});

const ToolsFileSchema = Type.Object({
  version: Type.Literal(SESSION_SEARCH_CACHE_VERSION),
  source: SourceSchema,
  toolOutput: Type.Array(DocSchema),
});

export interface SessionSearchEntry {
  info: SessionCatalogInfo;
  conversation: SearchDoc[];
  // 只在要求工具输出时给出
  toolOutput?: SearchDoc[];
}

export interface SessionSearchCacheOptions {
  // 缓存目录；缺省不落盘（每次从会话文件抽取）
  cacheDir?: string;
  // 读会话文件并投影成原生视图（缺省经只读读取器）
  readView?: (ref: SessionFileRef) => SessionView | undefined;
}

export interface SessionSearchSource {
  // 一个会话的可搜内容；会话文件读不了或还不是会话文件（空文件、文件头写了一半）返回 undefined
  load(ref: SessionFileRef, parts: { toolOutput: boolean }): SessionSearchEntry | undefined;
}

function sameSource(a: Source, b: Source): boolean {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// 读一份缓存文件：不存在、不是 JSON、形状或版本不对、来源戳不符一律当作未命中
function readCacheFile<T extends { source: Source }>(
  path: string,
  check: (value: unknown) => value is T,
  source: Source
): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return check(value) && sameSource(value.source, source) ? value : undefined;
}

// 编译成校验函数：缓存命中时每次检索都要校验全部缓存文件，解释执行的 Value.Check 占去大半耗时
const mainFileCheck = Compile(MainFileSchema);
const toolsFileCheck = Compile(ToolsFileSchema);
const isMainFile = (value: unknown): value is Static<typeof MainFileSchema> =>
  mainFileCheck.Check(value);
const isToolsFile = (value: unknown): value is Static<typeof ToolsFileSchema> =>
  toolsFileCheck.Check(value);

const MAIN_SUFFIX = ".json";
const TOOLS_SUFFIX = ".tools.json";
const TEMP_SUFFIX = ".tmp";
// 临时文件超过这个时长仍在，视为崩溃遗留
export const STALE_TEMP_MS = 60 * 60 * 1000;

// 同目录临时文件写满后改名覆盖目标（不 fsync）
function writeCacheFile(cacheDir: string, name: string, value: unknown): void {
  const target = join(cacheDir, name);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`;
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, target);
  } catch {
    // 只是少了缓存：下次照常重抽
    try {
      rmSync(temp, { force: true });
    } catch {
      // 目录本身不可用：没有临时文件可删
    }
  }
}

// 缓存文件名 → 会话号；临时文件与不认识的文件返回 undefined
function cacheSessionIdOf(name: string): string | undefined {
  if (name.endsWith(TEMP_SUFFIX)) {
    return undefined;
  }
  if (name.endsWith(TOOLS_SUFFIX)) {
    return name.slice(0, -TOOLS_SUFFIX.length);
  }
  return name.endsWith(MAIN_SUFFIX) ? name.slice(0, -MAIN_SUFFIX.length) : undefined;
}

// 清理缓存目录：会话文件已不在会话根下的缓存（liveSessionIds 列出会话根下现有的会话号；先列一次找出孤儿，删前再列一次，
// 只删两次都不在的），以及修改时间早于 now − STALE_TEMP_MS 的临时文件。任何失败都忽略
export function pruneSessionSearchCache(
  cacheDir: string,
  liveSessionIds: () => ReadonlySet<string>,
  now: number = Date.now()
): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  const remove = (name: string) => rmSync(join(cacheDir, name), { force: true });
  const orphans: Array<{ name: string; sessionId: string }> = [];
  let live: ReadonlySet<string>;
  try {
    live = liveSessionIds();
  } catch {
    // 列会话根失败（子目录正好消失等）：这次不清理
    return;
  }
  for (const name of names) {
    try {
      if (name.endsWith(TEMP_SUFFIX)) {
        if (statSync(join(cacheDir, name)).mtimeMs < now - STALE_TEMP_MS) {
          remove(name);
        }
        continue;
      }
      const sessionId = cacheSessionIdOf(name);
      if (sessionId !== undefined && !live.has(sessionId)) {
        orphans.push({ name, sessionId });
      }
    } catch {
      // 并发删除等：跳过
    }
  }
  if (orphans.length === 0) {
    return;
  }
  let confirmed: ReadonlySet<string>;
  try {
    confirmed = liveSessionIds();
  } catch {
    return;
  }
  for (const orphan of orphans) {
    if (!confirmed.has(orphan.sessionId)) {
      try {
        remove(orphan.name);
      } catch {
        // 跳过
      }
    }
  }
}

export function createSessionSearchSource(
  options: SessionSearchCacheOptions = {}
): SessionSearchSource {
  const readView = options.readView ?? ((ref: SessionFileRef) => readSessionView(ref));
  const { cacheDir } = options;
  // 进程内容忘录：戳（路径、大小、修改时间）相同的会话内容直接复用对象，不再读盘、解析与校验。
  // 检索与目录都不改这些对象；同一进程的反复检索（决策 339 ⑥ 的磁盘缓存管的是跨进程）因此只花打分的时间
  const memo = new Map<string, SessionSearchEntry | undefined>();
  return {
    load(ref, parts) {
      let source: Source;
      try {
        const stat = statSync(ref.path);
        source = { path: ref.path, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
      const memoKey = `${ref.path} ${source.size}:${source.mtimeMs}:${parts.toolOutput ? "tools" : "main"}`;
      const remembered = memo.get(memoKey);
      if (remembered !== undefined || memo.has(memoKey)) {
        return remembered;
      }
      const entry = loadUncached(ref, parts, source);
      memo.set(memoKey, entry);
      return entry;
    },
  };

  function loadUncached(
    ref: SessionFileRef,
    parts: { toolOutput: boolean },
    source: Source
  ): SessionSearchEntry | undefined {
    const mainName = `${ref.sessionId}${MAIN_SUFFIX}`;
    const toolsName = `${ref.sessionId}${TOOLS_SUFFIX}`;
    if (cacheDir !== undefined) {
      const main = readCacheFile(join(cacheDir, mainName), isMainFile, source);
      const tools = parts.toolOutput
        ? readCacheFile(join(cacheDir, toolsName), isToolsFile, source)
        : undefined;
      if (main !== undefined && (!parts.toolOutput || tools !== undefined)) {
        return {
          info: main.info,
          conversation: main.conversation,
          ...(tools !== undefined ? { toolOutput: tools.toolOutput } : {}),
        };
      }
    }
    let view: SessionView | undefined;
    try {
      view = readView(ref);
    } catch {
      return undefined;
    }
    if (view === undefined) {
      return undefined;
    }
    const extract = extractSessionSearch(view, sessionRefTime(ref));
    if (cacheDir !== undefined) {
      const version = SESSION_SEARCH_CACHE_VERSION;
      writeCacheFile(cacheDir, mainName, {
        version,
        source,
        info: extract.info,
        conversation: extract.conversation,
      });
      writeCacheFile(cacheDir, toolsName, { version, source, toolOutput: extract.toolOutput });
    }
    return {
      info: extract.info,
      conversation: extract.conversation,
      ...(parts.toolOutput ? { toolOutput: extract.toolOutput } : {}),
    };
  }
}
