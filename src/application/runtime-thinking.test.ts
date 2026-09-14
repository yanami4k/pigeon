// 推理档位（M5.5 S5，决策 050）：缺省不请求推理；全局值冻结进快照、随 run.started 落盘并交给上游
// （streamFn 收到 reasoning）；worker 按角色配置覆盖全局值，无覆盖时继承。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime } from "./runtime.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

// 记录上游每次请求带的推理档位
function recordingStreamFn(seen: unknown[]): StreamFn {
  const inner = createFakeStreamFn({ replies: [{ text: "好" }] });
  return (model, context, options) => {
    seen.push((options as { reasoning?: unknown } | undefined)?.reasoning);
    return inner(model, context, options);
  };
}

test("推理档位：缺省 off 不请求推理；全局值冻结进快照、落 run.started 并交给上游", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-"));
  try {
    for (const [level, expectedReasoning] of [
      [undefined, undefined],
      ["high", "high"],
    ] as const) {
      const seen: unknown[] = [];
      const sessionId = newSessionId();
      const bundle = buildRuntime({
        streamFn: recordingStreamFn(seen),
        workspaceRoot: root,
        homeDir: root,
        sessionId,
        yolo: false,
        provider: "fake-provider",
        modelId: "fake-model-1",
        createApprovalHandler: () => async () => ({ approved: false }),
        ...(level !== undefined ? { thinkingLevel: level } : {}),
      });
      try {
        await bundle.adapter.run("你好");
        assert.equal(bundle.adapter.snapshot().model.thinkingLevel, level);
      } finally {
        await bundle.adapter.dispose();
        bundle.eventLog.close();
      }
      assert.deepEqual(seen, [expectedReasoning]);
      const started = materializeSession(join(root, ".pigeon", "sessions"), sessionId)
        .runStarteds[0];
      assert.equal(started?.payload.model.thinkingLevel, level ?? "off");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("推理档位：worker 按角色配置覆盖全局值，无覆盖的角色继承全局", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-worker-"));
  try {
    const seen: unknown[] = [];
    const factory = createWorkerRuntimeFactory({
      streamFnFor: () => recordingStreamFn(seen),
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: root,
      thinkingLevel: "high",
      roleThinkingLevels: { tester: "low" },
    });
    const levels: unknown[] = [];
    for (const role of ["tester", "explorer"] as const) {
      const sessionId = newSessionId();
      const handle = factory({
        sessionId,
        name: role,
        role,
        task: "看看",
        policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
        governanceRoot: root,
        workspace: { kind: "git-worktree", path: root, branch: `pigeon/${role}` },
        lineage: { parentSessionId: newSessionId() },
        approvalHandler: async () => ({ approved: false }),
      });
      await handle.run("看看");
      await handle.dispose();
      levels.push(
        materializeSession(join(root, ".pigeon", "sessions"), sessionId).runStarteds[0]?.payload
          .model.thinkingLevel
      );
    }
    assert.deepEqual(levels, ["low", "high"]);
    assert.deepEqual(seen, ["low", "high"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
