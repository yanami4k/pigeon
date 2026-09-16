// 会话只读面（022 修订）：Actor（cli / tui）读会话的唯一入口——只转导出列举、冷物化与文件路径辅助，
// 不导出会写文件的 JsonlEventLog 本体。分层规则 actors-no-event-log-direct 守住这条边界：
// 直连 event-log.ts 会让 Actor 侧能构造写入实例（构造即建目录、开追加句柄），与"只提交意图、渲染投影"相冲。
import type { SessionId } from "../state/ids.ts";
import { JsonlEventLog, listSessionIds, materializeSession } from "./event-log.ts";

export type { MaterializeSessionOptions } from "./event-log.ts";
export { listSessionIds, materializeSession };

// 会话事件文件路径（只算路径，不触碰文件系统）
export function sessionEventFilePath(sessionsDir: string, sessionId: SessionId): string {
  return JsonlEventLog.filePathFor(sessionsDir, sessionId);
}

// 会话旁置内容文件路径（正文与 thinking，037）
export function sessionContentFilePath(sessionsDir: string, sessionId: SessionId): string {
  return JsonlEventLog.contentFilePathFor(sessionsDir, sessionId);
}
