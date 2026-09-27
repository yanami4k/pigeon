// 判定类读者读新会话存储的入口（账本重构第二段，决策 180 / 181）：按会话号定位会话文件，用只读读取器读主分支，
// 建成 state/session-judge.ts 的原生视图。从不写文件；读正被本进程写着的会话前，调用方先让写者落盘（flush）。
import { asSessionId, type SessionId } from "../state/ids.ts";
import { type StoreSessionView, storeSessionView } from "../state/session-judge.ts";
import {
  branchEntries,
  locateSessionFile,
  readSessionFile,
  type SessionFileView,
  type StoredEntry,
} from "./session-reader.ts";

export interface LoadedStoreSession {
  path: string;
  file: SessionFileView;
  // 主分支（根到叶）的全部条目，含分支会话从来源复制过来的那一段（续跑还原上下文要用）
  main: StoredEntry[];
  view: StoreSessionView;
}

// 读一个会话文件并建视图；不是会话文件时返回 undefined
export function loadStoreSessionFile(path: string): LoadedStoreSession | undefined {
  const file = readSessionFile(path);
  if (file === undefined) {
    return undefined;
  }
  const main = branchEntries(file, file.lanes.get("main") ?? null);
  const view = storeSessionView({
    sessionId: asSessionId(file.header.id),
    ...(file.header.parentSessionId !== undefined
      ? { parentSessionId: file.header.parentSessionId }
      : {}),
    ...(file.header.metadata !== undefined ? { metadata: file.header.metadata } : {}),
    entries: main,
  });
  return { path, file, main, view };
}

// 按会话号读；会话存储里没有这个会话时返回 undefined
export function loadStoreSession(
  sessionsRoot: string,
  sessionId: SessionId | string
): LoadedStoreSession | undefined {
  const located = locateSessionFile(sessionsRoot, sessionId);
  return located !== undefined ? loadStoreSessionFile(located.path) : undefined;
}
