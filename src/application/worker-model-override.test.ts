// 角色的模型接入覆盖列（M6 S0，决策 064 子裁决 ③）：角色表新增可选的模型接入覆盖（插件路径与模型标识），
// 四个角色缺省留空、继承主会话；在场时该角色的运行面改用覆盖的模型接入与标识。
// 与 050 的推理档位按角色覆盖同构，不引入新概念。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROLE_MODEL_OVERRIDES } from "../orchestration/roles.ts";
import type { WorkerRuntimeRequest } from "../orchestration/workers.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

function request(role: WorkerRuntimeRequest["role"]): WorkerRuntimeRequest {
  return {
    sessionId: newSessionId(),
    name: `${role}-1`,
    role,
    task: "做点事",
    policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
    governanceRoot: "",
    workspace: { kind: "none" },
    lineage: { parentSessionId: newSessionId() },
    approvalHandler: async () => ({ approved: true }),
  };
}

test("缺省留空：四个角色都继承主会话的模型接入与标识", () => {
  assert.deepEqual(ROLE_MODEL_OVERRIDES, {});
});

test("角色覆盖在场：该角色的运行面用覆盖的模型标识，其他角色仍用主会话的", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-role-model-"));
  try {
    const mainStream = createFakeStreamFn({ replies: [{ text: "主会话" }] });
    const reviewerStream = createFakeStreamFn({ replies: [{ text: "审阅" }] });
    const factory = createWorkerRuntimeFactory({
      streamFnFor: () => mainStream,
      provider: "custom",
      modelId: "custom",
      homeDir: root,
      roleModelOverrides: {
        reviewer: {
          streamFnSpec: "./reviewer-model.mjs",
          provider: "kimi-coding",
          modelId: "kimi-for-coding",
        },
      },
      // 覆盖列里的插件由装配层预加载（工厂同步）；此处直接给已加载的替身
      roleStreamFns: { reviewer: reviewerStream },
    });

    const reviewer = factory({ ...request("reviewer"), governanceRoot: root });
    await reviewer.run("审阅");
    assert.deepEqual(reviewerStream.calls.length, 1, "覆盖角色改用覆盖的模型接入");
    assert.equal(mainStream.calls.length, 0);
    await reviewer.dispose();

    const explorer = factory({ ...request("explorer"), governanceRoot: root });
    await explorer.run("看看");
    assert.equal(mainStream.calls.length, 1, "未覆盖的角色仍用主会话的模型接入");
    await explorer.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
