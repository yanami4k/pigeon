// 推理档位（M5.5 S5，决策 050；决策 390 缺省开思考）：启动参数 > 设置 thinking.level > 按模型信息的缺省（支持推理的 high，
// 不支持或不知道的 off）；取定的档位冻结进快照、落 Run 开始条目并交给上游（streamFn 收到 reasoning）；worker 按角色配置覆盖，
// 无覆盖时继承全局值，没有全局值时同样按模型信息取缺省。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { gatewayStreamFn } from "../pi-runtime/gateway-stream.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { modelAccessOf, registerModelAccess } from "../pi-runtime/model-access.ts";
import { newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import type { ThinkingSection } from "../state/thinking-config.ts";
import { buildRuntime } from "./runtime.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

// Run 开始条目的 model 段里本文件关心的几项：档位、温度或"温度未生效"
type StartedModel = { thinkingLevel?: string; temperature?: number; temperatureIgnored?: unknown };

// 记录上游每次请求带的推理档位；reasoning 给了即登记模型信息里的"是否支持推理"
function recordingStreamFn(seen: unknown[], reasoning?: boolean): StreamFn {
  const inner = createFakeStreamFn({ replies: [{ text: "好" }] });
  const streamFn: StreamFn = (model, context, options) => {
    seen.push((options as { reasoning?: unknown } | undefined)?.reasoning);
    return inner(model, context, options);
  };
  return reasoning === undefined
    ? streamFn
    : registerModelAccess(streamFn, { declared: { reasoning } });
}

// 装配一次运行面、跑一次，交回 Run 开始条目的 model 段
async function runOnce(
  root: string,
  streamFn: StreamFn,
  options: { level?: ThinkingLevel; section?: ThinkingSection; temperature?: number } = {}
): Promise<StartedModel | undefined> {
  const sessionId = newSessionId();
  const settings = emptySettingsSnapshot(root);
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: root,
    homeDir: root,
    sessionId,
    yolo: false,
    provider: "fake-provider",
    modelId: "fake-model-1",
    createApprovalHandler: () => async () => ({ approved: false }),
    settings: {
      ...settings,
      merged: {
        ...settings.merged,
        ...(options.section !== undefined ? { thinking: options.section } : {}),
      },
    },
    ...(options.level !== undefined ? { thinkingLevel: options.level } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  try {
    await bundle.adapter.run("你好");
  } finally {
    await bundle.adapter.dispose();
    await bundle.sessionStore.close();
  }
  return loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId)?.view.runs[0]
    ?.start.model;
}

test("推理档位的取法：支持推理的模型缺省 high，不支持或不知道的不请求；--thinking 与设置都能改成 off 或其他档位，启动参数优先", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-"));
  try {
    const cases: Array<
      [string, boolean | undefined, { level?: ThinkingLevel; section?: ThinkingSection }, string]
    > = [
      ["不知道是否支持推理", undefined, {}, "off"],
      ["声明不支持推理", false, {}, "off"],
      ["声明支持推理", true, {}, "high"],
      ["--thinking off", true, { level: "off" }, "off"],
      ["设置 thinking.level off", true, { section: { level: "off" } }, "off"],
      ["设置 low", true, { section: { level: "low" } }, "low"],
      ["启动参数盖过设置", true, { level: "medium", section: { level: "low" } }, "medium"],
    ];
    for (const [what, reasoning, options, expected] of cases) {
      const seen: unknown[] = [];
      const recorded = await runOnce(root, recordingStreamFn(seen, reasoning), options);
      assert.equal(recorded?.thinkingLevel, expected, what);
      // off 不请求推理：交给上游的选项里没有 reasoning（pi-ai 据此对支持推理的模型发 thinking disabled，其余不发）
      assert.deepEqual(seen, [expected === "off" ? undefined : expected], what);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("经网关的 DeepSeek 接入（与自带接入同一份模型信息）：缺省请求开思考、不发温度并记「未生效」；--thinking off 时发 thinking disabled 与温度", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-wire-"));
  try {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "假" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const gateway = gatewayStreamFn("http://127.0.0.1:9/j/x");
    const access = modelAccessOf(gateway);
    assert.ok(access !== undefined);
    const streamFn = registerModelAccess(
      (model, context, options) =>
        gateway(model, context, { ...options, fetch: fakeFetch, maxRetries: 0 } as never),
      access
    );
    const byDefault = await runOnce(root, streamFn, { temperature: 0 });
    assert.equal(byDefault?.thinkingLevel, "high");
    assert.equal((bodies[0]?.thinking as { type?: string } | undefined)?.type, "enabled");
    assert.equal("temperature" in (bodies[0] ?? {}), false);
    assert.equal(byDefault?.temperature, undefined);
    assert.deepEqual(byDefault?.temperatureIgnored, { requested: 0, reason: "reasoning-enabled" });
    bodies.length = 0;
    const off = await runOnce(root, streamFn, { level: "off", temperature: 0 });
    assert.equal(off?.thinkingLevel, "off");
    assert.deepEqual(bodies[0]?.thinking, { type: "disabled" });
    assert.equal(bodies[0]?.temperature, 0);
    assert.equal(off?.temperature, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("推理档位：worker 按角色配置覆盖全局值，无覆盖的角色继承全局；没有全局值时按模型信息取缺省", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-thinking-worker-"));
  try {
    const seen: unknown[] = [];
    const levels: unknown[] = [];
    const runWorker = async (
      factory: ReturnType<typeof createWorkerRuntimeFactory>,
      role: "tester" | "explorer"
    ) => {
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
        loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId)?.view.runs[0]?.start
          .model.thinkingLevel
      );
    };
    const explicit = createWorkerRuntimeFactory({
      streamFnFor: () => recordingStreamFn(seen),
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: root,
      thinkingLevel: "high",
      roleThinkingLevels: { tester: "low" },
    });
    await runWorker(explicit, "tester");
    await runWorker(explicit, "explorer");
    const byModel = createWorkerRuntimeFactory({
      streamFnFor: () => recordingStreamFn(seen, true),
      provider: "fake-provider",
      modelId: "fake-model-1",
      homeDir: root,
    });
    await runWorker(byModel, "explorer");
    assert.deepEqual(levels, ["low", "high", "high"]);
    assert.deepEqual(seen, ["low", "high", "high"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
