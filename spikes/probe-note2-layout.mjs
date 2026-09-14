// 一次性探针（note-2 红测试布局取证）：工具调用轮（无 text_delta）与文本轮在
// MockTerminal + VirtualScreen 下的逐行布局。探完即删。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEventKind } from "../src/state/runtime-events.ts";
import { EVENT_ENVELOPE_VERSION } from "../src/state/events.ts";
import { newEntryId, newRunId, newSessionId } from "../src/state/ids.ts";
import { PigeonTuiShell } from "../src/tui/shell.ts";
import { MockTerminal, settle } from "../src/tui/testing.ts";

const sessionId = newSessionId();
const runId = newRunId();
const logDir = mkdtempSync(join(tmpdir(), "pigeon-probe-"));
const term = new MockTerminal(80, 24);
const listeners = new Set();
const streamListeners = new Set();
const runtime = {
  runs: [],
  run(input) {
    this.runs.push(input);
    return Promise.resolve({
      runId, status: "completed", stopReason: "stop", syntheticFailure: false,
      failure: null, advertisedTools: [], toolExecutions: [],
    });
  },
  interrupt: () => Promise.resolve(),
  listenerErrors: () => [],
  subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  subscribeStream(l) { streamListeners.add(l); return () => streamListeners.delete(l); },
};
const emit = (kind, payload) => {
  for (const l of listeners)
    l({ version: EVENT_ENVELOPE_VERSION, id: newEntryId(), sessionId, runId, timestamp: 1, kind, payload });
};

const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
shell.start();
await settle();
term.input("改一下文件");
term.input("\r");
await settle();

// 轮 1：纯工具调用，无 text_delta
emit(RuntimeEventKind.TurnStarted, {});
emit(RuntimeEventKind.ToolProposed, { toolCallId: "tc-1", toolName: "read_file", args: { path: "src/甲.ts" } });
emit(RuntimeEventKind.ToolSettled, { toolCallId: "tc-1", toolName: "read_file", isError: false });
emit(RuntimeEventKind.TurnCompleted, { stopReason: "toolUse", syntheticFailure: false });
await settle();

// 轮 2：有文本
emit(RuntimeEventKind.TurnStarted, {});
for (const l of streamListeners) l({ runId, delta: "好的，已读取。" });
emit(RuntimeEventKind.TurnCompleted, { stopReason: "stop", syntheticFailure: false });
emit(RuntimeEventKind.RunEnded, { messageCount: 4 });
await settle();

console.log("=== contentLines ===");
term.screen.contentLines().forEach((l, i) => console.log(`${String(i).padStart(2)}|${l}`));

shell.stop();
rmSync(logDir, { recursive: true, force: true });
