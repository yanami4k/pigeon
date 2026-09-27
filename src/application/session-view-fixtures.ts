// 测试设施：搜索与显示读者的测试共用（只供 *.test.ts 引用，不从任何桶文件导出）。会话数据用第一段的夹具
// （session-store-fixtures.ts）经真实写者写进新会话存储；这里只补读者测试额外需要的两样：
// - 旧格式会话：迁移之前创建的会话在会话根下是平铺的 sess_<ULID>.jsonl 文件，读者只按文件名认出它并给出提示，不读内容；
// - 一次写完一个 Run 的简写。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { FixtureSession } from "./session-store-fixtures.ts";

// 在会话根下放一个旧格式会话文件（平铺的 <会话号>.jsonl；读者不读内容，写一行占位）；返回会话号
export function writeLegacySessionFile(sessionsDir: string, sessionId?: SessionId): SessionId {
  const id = sessionId ?? newSessionId();
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${id}.jsonl`), '{"legacy":true}\n');
  return id;
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
