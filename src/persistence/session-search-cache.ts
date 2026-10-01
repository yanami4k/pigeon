// 会话检索的缓存（决策 339 ⑥）：每个会话文件抽出的可搜文本与目录信息（state/session-search-text.ts）按文件大小与修改时间
// 缓存到 .pigeon/state/search-cache/ 下，再次检索只读缓存、不读会话文件。
// - 每个会话两份缓存文件：<会话号>.json 存目录信息与对话正文，<会话号>.tools.json 存工具输出；检索不搜工具输出时只读前一份。
//   两份各自带格式版本与来源戳（会话文件路径、大小、修改时间），各自校验。
// - 来源戳在读会话文件之前取：读的过程中文件又被追加，戳就比内容旧，下次比对不符即重抽，不会把新内容当作旧戳缓存住。
// - 大小或修改时间变了、版本不符、文件损坏（不是 JSON、形状不对）都当作未命中：重抽并覆盖，不报错中断检索。
// - 写入走同目录临时文件改名（atomic-write.ts），多个会话并发检索同一会话时各写各的临时文件，目标上只会是某一份完整内容。
//   写缓存失败（目录不可写等）只是少了缓存，检索照常返回。
// 读会话文件经只读读取器，从不写会话文件。读取函数可注入（测试以计数验证命中缓存时不读会话文件）。
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import {
  extractSessionSearch,
  type SearchDoc,
  type SessionCatalogInfo,
} from "../state/session-search-text.ts";
import type { SessionView } from "../state/session-view.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { readSessionView, sessionRefTime } from "./session-catalog.ts";
import type { SessionFileRef } from "./session-reader.ts";

// 缓存格式版本：抽取口径或文件形状一变即加一，旧缓存随之整体重建
export const SESSION_SEARCH_CACHE_VERSION = 1;

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
  toolName: Type.Optional(Type.String()),
});

const MainFileSchema = Type.Object({
  version: Type.Literal(SESSION_SEARCH_CACHE_VERSION),
  source: SourceSchema,
  info: Type.Object({
    sessionId: Type.String(),
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

function writeCacheFile(cacheDir: string, name: string, value: unknown): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileAtomic(join(cacheDir, name), JSON.stringify(value));
  } catch {
    // 只是少了缓存：下次照常重抽
  }
}

export function createSessionSearchSource(
  options: SessionSearchCacheOptions = {}
): SessionSearchSource {
  const readView = options.readView ?? ((ref: SessionFileRef) => readSessionView(ref));
  const { cacheDir } = options;
  return {
    load(ref, parts) {
      let source: Source;
      try {
        const stat = statSync(ref.path);
        source = { path: ref.path, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
      const mainName = `${ref.sessionId}.json`;
      const toolsName = `${ref.sessionId}.tools.json`;
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
    },
  };
}
