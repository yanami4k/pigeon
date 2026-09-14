// 测试设施（M5 S2）：历史投影、TUI /resume 历史渲染与 cli 带正文视图共用的会话夹具。
// 仅供 *.test.ts 引用（同 pi-runtime/fixtures.ts 先例：放在非测试文件里，避免测试文件互相
// 导入时重复登记用例）。
import { JsonlEventLog } from "../persistence/event-log.ts";
import { EVENT_ENVELOPE_VERSION } from "../state/events.ts";
import { newEntryId, newRunId, type RunId, type SessionId } from "../state/ids.ts";
import type { ContentSourceMessage } from "../state/message-content.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";

type SeedMessage = ContentSourceMessage & { role: "user" | "assistant" | "toolResult" };

// 一个完整的工具调用 Run：user → assistant(thinking + text + toolCall) → 工具提议与落定 →
// toolResult → assistant。落盘顺序与真实 Adapter 一致：entry 先于同一事件的归一化记录
export function seedToolRun(
  sessionsDir: string,
  sessionId: SessionId,
  options: { withContent?: boolean } = {}
): RunId {
  const withContent = options.withContent ?? true;
  const log = new JsonlEventLog(sessionsDir, sessionId);
  const runId = newRunId();
  const event = (kind: string, payload: unknown): void => {
    log.appendRuntimeEvent({
      version: EVENT_ENVELOPE_VERSION,
      id: newEntryId(),
      sessionId,
      runId,
      timestamp: 1_757_000_000_000,
      kind,
      payload,
    });
  };
  const entry = (runSeq: number, message: SeedMessage): void => {
    log.appendEntry({ runSeq, role: message.role, runId, ...(withContent ? { message } : {}) });
  };
  entry(1, { role: "user", content: "把 beta 改成大写" });
  event(RuntimeEventKind.TurnStarted, {});
  entry(2, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先确认锚点" },
      { type: "text", text: "我来改" },
      { type: "toolCall", id: "tc-1", name: "edit_file", arguments: { path: "a.ts" } },
    ],
  });
  event(RuntimeEventKind.TurnCompleted, { stopReason: "toolUse", syntheticFailure: false });
  event(RuntimeEventKind.ToolProposed, {
    toolCallId: "tc-1",
    toolName: "edit_file",
    args: { path: "a.ts" },
  });
  event(RuntimeEventKind.ToolSettled, {
    toolCallId: "tc-1",
    toolName: "edit_file",
    isError: false,
  });
  entry(3, {
    role: "toolResult",
    toolName: "edit_file",
    toolCallId: "tc-1",
    isError: false,
    content: [{ type: "text", text: "已写入 3 行" }],
  });
  event(RuntimeEventKind.TurnStarted, {});
  entry(4, { role: "assistant", content: [{ type: "text", text: "改好了" }] });
  event(RuntimeEventKind.TurnCompleted, { stopReason: "stop", syntheticFailure: false });
  event(RuntimeEventKind.RunEnded, { messageCount: 4 });
  log.close();
  return runId;
}
