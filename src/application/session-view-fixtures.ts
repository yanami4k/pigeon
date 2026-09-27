// 测试设施：搜索与显示读者的测试共用（只供 *.test.ts 引用，不从任何桶文件导出）。会话数据用第一段的夹具
// （session-store-fixtures.ts）经真实写者写进新会话存储；这里只补读者测试额外需要的两样：
// - 双写期间每个会话在旧账本里都有事件文件（会话根下平铺的 <会话号>.jsonl），会话检索以它筛掉被跑批器作废移走的会话，
//   夹具只写新存储，故在会话根下放一个空的同名文件代表"旧账本里有这个会话"；
// - 一次写完一个 Run 的简写。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunId } from "../state/ids.ts";
import type { FixtureSession } from "./session-store-fixtures.ts";

// 在会话根下放旧账本事件文件的占位（空文件）
export function markLegacyEventFile(sessionsDir: string, sessionId: string): void {
  writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), "");
}

// 一个 Run：任务消息、若干助手回复（纯文本）、正常收尾
export function textRun(session: FixtureSession, task: string, replies: readonly string[]): RunId {
  const runId = session.startRun({ task });
  for (const text of replies) {
    session.assistant({ text });
  }
  session.endRun();
  return runId;
}
