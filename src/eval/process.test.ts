// 单次运行的过程指标（决策 061 S0）：从会话账本（事件日志加内容文件）汇总各工具调用数与报错数、撞输出上限的轮数、
// 编辑报错分类计数；编辑报错按报错文案的稳定前缀分类，hashline 与 replace 各一套类目。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventLog } from "../persistence/event-log.ts";
import { newEntryId, newRunId, newSessionId } from "../state/ids.ts";
import { EDIT_NO_CHANGE_PREFIX } from "../tools/edit-mode.ts";
import { HASHLINE_ANCHOR_MISS_MARK, HASHLINE_OUT_OF_RANGE_MARK } from "../tools/hashline.ts";
import { REPLACE_NOT_FOUND_PREFIX, REPLACE_NOT_UNIQUE_PREFIX } from "../tools/replace-edit.ts";
import { classifyEditError, summarizeProcess } from "./process.ts";

const OUTPUT_LIMIT =
  'Tool call "edit_file" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';

test("过程指标：构造的会话账本上各工具调用与报错、撞输出上限轮数、hashline 编辑报错分类计数精确；只计指定 Run", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-process-"));
  try {
    const sessionsDir = join(dir, "sessions");
    const sessionId = newSessionId();
    const runId = newRunId();
    const otherRun = newRunId();
    const log = new JsonlEventLog(sessionsDir, sessionId);
    let timestamp = 1;
    let runSeq = 0;
    const event = (run: typeof runId, kind: string, payload: unknown) =>
      log.appendRuntimeEvent({
        version: 1,
        id: newEntryId(),
        sessionId,
        runId: run,
        timestamp: timestamp++,
        kind,
        payload,
      });
    const call = (
      run: typeof runId,
      toolCallId: string,
      toolName: string,
      isError: boolean,
      text: string
    ) => {
      event(run, "tool.proposed", { toolCallId, toolName, args: {} });
      log.appendEntry({
        runId: run,
        runSeq: ++runSeq,
        role: "toolResult",
        message: {
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text }],
          isError,
        },
      });
      event(run, "tool.settled", { toolCallId, toolName, isError });
    };

    event(runId, "turn.started", {});
    call(runId, "tc-1", "read_file", false, "[a.ts#0123456789abcdef] 共 3 行（窗口 1-3）");
    call(
      runId,
      "tc-2",
      "edit_file",
      true,
      'Validation failed for tool "edit_file":\n  - edits.0.anchor: must match pattern "^\\d+#[0-9a-f]{4}$"'
    );
    call(
      runId,
      "tc-3",
      "edit_file",
      true,
      `edits[0] 的 endAnchor ${HASHLINE_ANCHOR_MISS_MARK}：第 48 行当前标签为 737d，锚点是 c4f8——文件可能已变化，请重新 read_file 获取最新锚点`
    );
    call(
      runId,
      "tc-4",
      "edit_file",
      true,
      `edits[1] 的 anchor ${HASHLINE_OUT_OF_RANGE_MARK}：第 1694 行不存在（共 214 行）`
    );
    call(runId, "tc-5", "edit_file", true, EDIT_NO_CHANGE_PREFIX);
    event(runId, "turn.completed", { stopReason: "toolUse", syntheticFailure: false });
    event(runId, "turn.started", {});
    call(runId, "tc-6", "edit_file", true, OUTPUT_LIMIT);
    event(runId, "turn.completed", { stopReason: "length", syntheticFailure: false });
    event(runId, "turn.started", {});
    call(
      runId,
      "tc-7",
      "edit_file",
      true,
      "快照过期：文件自读取后已变化（期望 a，实际 b）。请重新 read_file"
    );
    call(
      runId,
      "tc-8",
      "edit_file",
      false,
      "已在 a.ts 应用 1 处编辑（+1 −1 行）。新快照 [a.ts#0123456789abcdef]"
    );
    call(runId, "tc-9", "run_command", true, "命令退出码 1");
    event(runId, "turn.completed", { stopReason: "stop", syntheticFailure: false });
    event(runId, "run.ended", { messageCount: 12 });
    // 同一会话里的另一个 Run 不计入
    call(otherRun, "tc-x", "edit_file", true, EDIT_NO_CHANGE_PREFIX);
    event(otherRun, "turn.completed", { stopReason: "length", syntheticFailure: false });
    log.close();

    const metrics = summarizeProcess({ sessionsDir, sessionId, runId, editMode: "hashline" });
    assert.deepEqual(metrics, {
      tools: {
        edit_file: { calls: 7, errors: 6 },
        read_file: { calls: 1, errors: 0 },
        run_command: { calls: 1, errors: 1 },
      },
      outputLimitTurns: 1,
      editErrors: {
        schema: 1,
        "anchor-miss": 1,
        "line-out-of-range": 1,
        "no-change": 1,
        "output-limit": 1,
        other: 1,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("编辑报错分类：replace 侧按原文未找到、原文不唯一、无变化、输出上限截断、其他分类；hashline 文案在 replace 侧归其他", () => {
  assert.equal(
    classifyEditError(
      "replace",
      `${REPLACE_NOT_FOUND_PREFIX}：请重新 read_file 核对原文，含缩进与空白，不要带行号前缀`
    ),
    "not-found"
  );
  assert.equal(
    classifyEditError(
      "replace",
      `${REPLACE_NOT_UNIQUE_PREFIX}：在 a.ts 中出现 2 次（起始行 3、9），请加上下文使其唯一`
    ),
    "not-unique"
  );
  assert.equal(
    classifyEditError("replace", `${EDIT_NO_CHANGE_PREFIX}：old_string 与 new_string 相同`),
    "no-change"
  );
  assert.equal(classifyEditError("replace", OUTPUT_LIMIT), "output-limit");
  assert.equal(
    classifyEditError("replace", `edits[0] 的 anchor ${HASHLINE_ANCHOR_MISS_MARK}：第 1 行`),
    "other"
  );
  assert.equal(classifyEditError("replace", 'Validation failed for tool "edit_file":'), "other");
  assert.equal(
    classifyEditError("hashline", `${REPLACE_NOT_FOUND_PREFIX}：请重新 read_file`),
    "other"
  );
});
