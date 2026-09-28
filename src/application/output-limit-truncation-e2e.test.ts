// 截断与熔断核实（决策 063 施工口径）：模型回复以 length 停止且带工具调用时——
// a. 工具不执行，文件不变；b. 被截断的调用计入上游拦截熔断，同一工具连续 3 次被截断后 Run 以熔断结束；
// c. 撞输出上限的轮数与被截断的调用在会话存储里如实记下。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { toolResultMark } from "../state/session-judge.ts";
import { runHeadless } from "./headless.ts";

const ORIGINAL = "alpha\nbeta\ngamma\n";

test("截断与熔断：length 停止的工具调用不执行、文件不变；同一工具连续 3 次被截断后 Run 以熔断结束；撞输出上限轮数计 3", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-truncation-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-truncation-home-"));
  try {
    writeFileSync(join(root, "a.ts"), ORIGINAL);
    // 每轮都以 length 停止并带一条会成功的编辑调用（回复耗尽后重复最后一条）
    const streamFn = createFakeStreamFn({
      replies: [
        {
          text: "",
          stopReason: "length",
          toolCalls: [
            { name: "edit_file", args: { path: "a.ts", old_string: "beta", new_string: "BETA" } },
          ],
        },
      ],
    });
    const result = await runHeadless({
      task: "把 beta 改成 BETA",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      memoryRoots: [],
      editMode: "replace",
      maxTurns: 10,
    });

    // a. 工具不执行，文件不变
    assert.equal(readFileSync(join(root, "a.ts"), "utf8"), ORIGINAL);
    const sessionsDir = join(root, ".pigeon", "sessions");
    const loaded = loadStoreSession(sessionsDir, result.sessionId);
    assert.ok(loaded !== undefined, "会话存储里应有本会话");
    assert.equal(loaded.view.runs.length, 1);
    const run = loaded.view.runs[0];
    assert.ok(run !== undefined);
    const messages = run.messages.map((ref) => ref.message);
    const toolResults = messages.filter((message) => message.role === "toolResult");
    // 被截断的调用由上游拦截，审批闸没跑过：工具结果上没有审批闸决定、错误归类为域错误
    for (const message of toolResults) {
      assert.equal(toolResultMark(message)?.gate, undefined);
      assert.equal(toolResultMark(message)?.errorKind, "domain");
    }

    // b. 计入上游拦截熔断：连续 3 次后中止，Run 收尾条目的结束方式是熔断
    assert.equal(result.status, "aborted");
    // 熔断在第 3 次 settle 时发中止信号；上游循环此时已发起下一次模型调用，该调用随中止收尾、不带工具调用
    const stopReasons = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.stopReason);
    assert.deepEqual(stopReasons, ["length", "length", "length", "aborted"]);
    assert.equal(streamFn.calls.length, 4);
    assert.equal(toolResults.length, 3);
    assert.equal(run.end?.ending, "breaker");
    assert.deepEqual(result.failure, { category: "cancelled", breaker: true });

    // c. 撞输出上限的轮数与被截断的调用：3 轮以 length 收尾，edit_file 3 次调用全部落定为出错
    assert.equal(stopReasons.filter((reason) => reason === "length").length, 3);
    assert.deepEqual(
      toolResults.map((message) => [message.toolName, message.isError]),
      [
        ["edit_file", true],
        ["edit_file", true],
        ["edit_file", true],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
