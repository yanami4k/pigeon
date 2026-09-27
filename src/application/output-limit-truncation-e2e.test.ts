// 截断与熔断核实（决策 063 施工口径）：模型回复以 length 停止且带工具调用时——
// a. 工具不执行，文件不变；b. 被截断的调用计入上游拦截熔断，同一工具连续 3 次被截断后 Run 中止并留下熔断记录；
// c. 撞输出上限的轮数与被截断的调用在账本里如实记下。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { runHeadless } from "./headless.ts";

const ORIGINAL = "alpha\nbeta\ngamma\n";

test("截断与熔断：length 停止的工具调用不执行、文件不变；同一工具连续 3 次被截断后 Run 中止并留下上游拦截熔断记录；撞输出上限轮数计 3", async () => {
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
    const session = materializeSession(sessionsDir, result.sessionId);
    assert.equal(session.intents.length, 0);
    assert.equal(session.receipts.length, 0);

    // b. 计入上游拦截熔断：连续 3 次后中止，留下 intercepted 熔断记录
    assert.equal(result.status, "aborted");
    // 熔断在第 3 次 settle 时发中止信号；上游循环此时已发起下一次模型调用，该调用随中止收尾、不带工具调用
    const stopReasons = session.runtimeEvents
      .filter((record) => record.kind === "turn.completed")
      .map((record) => record.payload.stopReason);
    assert.deepEqual(stopReasons, ["length", "length", "length", "aborted"]);
    assert.equal(streamFn.calls.length, 4);
    assert.equal(
      session.runtimeEvents.filter((record) => record.kind === "tool.settled").length,
      3
    );
    assert.equal(session.breakers.length, 1);
    assert.equal(session.breakers[0]?.scope, "intercepted");
    assert.equal(session.breakers[0]?.toolName, "edit_file");
    assert.equal(session.breakers[0]?.count, 3);
    assert.deepEqual(result.failure, { category: "cancelled", breaker: true });

    // c. 撞输出上限的轮数与被截断的调用：3 轮以 length 收尾，edit_file 3 次调用全部落定为出错
    assert.equal(stopReasons.filter((reason) => reason === "length").length, 3);
    const settled = session.runtimeEvents.flatMap((record) =>
      record.kind === "tool.settled" ? [record.payload] : []
    );
    assert.deepEqual(
      settled.map((payload) => [payload.toolName, payload.isError]),
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
