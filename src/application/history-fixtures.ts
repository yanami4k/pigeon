// 测试设施（M5 S2）：历史投影、TUI /resume 历史渲染与 cli 带正文视图共用的会话夹具。
// 仅供 *.test.ts 引用（同 pi-runtime/fixtures.ts 先例：放在非测试文件里，避免测试文件互相
// 导入时重复登记用例）。经第一段的夹具写进新会话存储；消息内容与迁移前的同名夹具逐条相同，
// 旧断言里的期望行因此可以原样用来核对新读法。
import type { RunId, SessionId } from "../state/ids.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { markLegacyEventFile } from "./session-view-fixtures.ts";

// 一个完整的工具调用 Run：user → assistant(thinking + text + toolCall) → toolResult → assistant → 正常收尾
export async function seedToolRun(sessionsDir: string, sessionId: SessionId): Promise<RunId> {
  const session = createFixtureSession({ sessionsDir, sessionId });
  const runId = session.startRun({ task: "把 beta 改成大写" });
  session.assistant({
    thinking: "先确认锚点",
    text: "我来改",
    toolCalls: [{ name: "edit_file", args: { path: "a.ts" }, id: "tc-1" }],
  });
  session.toolResult({ toolCallId: "tc-1", toolName: "edit_file", text: "已写入 3 行" });
  session.assistant({ text: "改好了" });
  session.endRun();
  await session.close();
  markLegacyEventFile(sessionsDir, sessionId);
  return runId;
}
