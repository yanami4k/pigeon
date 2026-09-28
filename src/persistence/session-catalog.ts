// 会话目录（决策 181 / 210）：搜索与各显示读者按会话号定位、列举新存储里的会话并投影成原生视图的入口。
// 一律经只读读取器读，从不写文件——读的可能是别的进程正在追加的会话。
// 迁移之前的旧格式会话（会话根下平铺的 sess_*.jsonl）：新代码不读旧格式（187），这里只按文件名认出它们，
// 列表、检索与各显示读者跳过它们并给一句提示，指向只读的旧版代码（211），不报错中断。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionId } from "../state/ids.ts";
import { sessionCreatedAt } from "../state/session-summary.ts";
import { buildSessionView, type SessionView } from "../state/session-view.ts";
import {
  branchEntries,
  listSessionFiles,
  readSessionFile,
  type SessionFileRef,
} from "./session-reader.ts";

const PIGEON_SESSION_ID = /^sess_[0-9A-HJKMNP-TV-Z]{26}$/;
// 旧格式的会话文件：会话根下平铺的 <会话号>.jsonl（旁置正文 .messages.jsonl 与锁文件不算）
const LEGACY_SESSION_FILE = /^(sess_[0-9A-HJKMNP-TV-Z]{26})\.jsonl$/;

// 读旧格式会话用的只读旧版代码（决策 211）
export const LEGACY_READER_COMMIT = "455d88d";
export const LEGACY_READER_HINT = `旧格式会话请用只读的旧版代码 ${LEGACY_READER_COMMIT} 读取`;

// 会话的创建时间：Pigeon 会话号取 ULID 时间分量（与旧会话列表同一口径），其余取文件名里的创建时间
export function sessionRefTime(file: SessionFileRef): number {
  return PIGEON_SESSION_ID.test(file.sessionId)
    ? sessionCreatedAt(file.sessionId as SessionId)
    : file.createdAt;
}

// 新存储里的全部会话文件，从旧到新（同一时刻按会话号）
export function listSessionRefs(sessionsRoot: string): SessionFileRef[] {
  return listSessionFiles(sessionsRoot).sort(
    (a, b) => sessionRefTime(a) - sessionRefTime(b) || a.sessionId.localeCompare(b.sessionId)
  );
}

// 读一个会话文件并投影成原生视图（主分支）；不是会话文件（空文件、文件头不完整）返回 undefined
export function readSessionView(ref: Pick<SessionFileRef, "path">): SessionView | undefined {
  const file = readSessionFile(ref.path);
  if (file === undefined) {
    return undefined;
  }
  const view = buildSessionView({
    header: file.header,
    entries: branchEntries(file, file.lanes.get("main") ?? null),
  });
  view.warnings.unshift(...file.warnings);
  return view;
}

// 按会话号读原生视图；新存储里没有该会话返回 undefined
export function loadSessionView(sessionsRoot: string, sessionId: string): SessionView | undefined {
  const ref = listSessionFiles(sessionsRoot).find((file) => file.sessionId === sessionId);
  return ref === undefined ? undefined : readSessionView(ref);
}

// 会话根下旧格式会话文件的会话号（新存储里有同号文件的不算），从旧到新。只看文件名，不读旧格式
export function listLegacySessionIds(sessionsRoot: string): string[] {
  if (!existsSync(sessionsRoot)) {
    return [];
  }
  const current = new Set(listSessionFiles(sessionsRoot).map((file) => file.sessionId));
  const legacy: string[] = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    const match = entry.isFile() ? LEGACY_SESSION_FILE.exec(entry.name) : null;
    if (match?.[1] !== undefined && !current.has(match[1])) {
      legacy.push(match[1]);
    }
  }
  return legacy.sort();
}

// 这个会话号在会话根下有旧格式会话文件（只看文件是否存在，不读内容）
export function hasLegacySessionFile(sessionsRoot: string, sessionId: string): boolean {
  return existsSync(join(sessionsRoot, `${sessionId}.jsonl`));
}

// 列表与检索末尾的一行提示：有旧格式会话被跳过时给出，没有时为 undefined
export function legacySessionsNote(sessionsRoot: string): string | undefined {
  const count = listLegacySessionIds(sessionsRoot).length;
  return count > 0
    ? `另有 ${count} 个旧格式会话（迁移之前创建）未列出；${LEGACY_READER_HINT}`
    : undefined;
}
