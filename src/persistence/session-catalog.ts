// 会话目录（决策 181 / 210）：搜索与各显示读者按会话号定位、列举新存储里的会话并投影成原生视图的入口。
// 一律经只读读取器读，从不写文件——读的可能是别的进程正在追加的会话。
// 双写之前就存在的旧会话在新存储里没有文件：新读法不读旧格式（187），这里只按文件名数出它们，供显示读者提示。
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
// 旧账本的会话事件文件：会话根下平铺的 <会话号>.jsonl（旁置正文 .messages.jsonl 与锁文件不算）
const LEGACY_EVENT_FILE = /^(sess_[0-9A-HJKMNP-TV-Z]{26})\.jsonl$/;

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

// 只在旧账本里的会话号（双写之前创建、新存储里没有文件），从旧到新。只看文件名，不读旧格式
export function listLegacyOnlySessionIds(sessionsRoot: string): string[] {
  if (!existsSync(sessionsRoot)) {
    return [];
  }
  const current = new Set(listSessionFiles(sessionsRoot).map((file) => file.sessionId));
  const legacy: string[] = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    const match = entry.isFile() ? LEGACY_EVENT_FILE.exec(entry.name) : null;
    if (match?.[1] !== undefined && !current.has(match[1])) {
      legacy.push(match[1]);
    }
  }
  return legacy.sort();
}

// 双写期间旧账本里仍有这个会话的事件文件（会话根下平铺的 <会话号>.jsonl）。
// 跑批器作废重做时只把旧格式文件移出会话根（它的文件操作尚未改读新存储），会话检索据此把被作废的会话排除在外；
// 停写旧账本之前，跑批器的文件操作须先改为移动新存储的会话文件，届时去掉这道筛选
export function hasLegacyEventFile(sessionsRoot: string, sessionId: string): boolean {
  return existsSync(join(sessionsRoot, `${sessionId}.jsonl`));
}
