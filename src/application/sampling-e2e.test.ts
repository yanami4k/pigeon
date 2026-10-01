// 采样温度固定并冻结进快照（M9）：给了温度，每一次模型调用的选项里都带它，注入快照与会话存储的 Run 开始条目
// 记下同一个值；不给则调用选项里没有这个键、Run 开始条目里也没有这个字段——既有运行逐字不变。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { fixTemperature } from "../pi-runtime/sampling.ts";
import { runHeadless } from "./headless.ts";
import { parseLaunchFlags } from "./launch-flags.ts";

// 会话存储里本会话第一个 Run 开始条目的模型摘要
function startedModel(sessionsDir: string, sessionId: string) {
  const model = loadStoreSession(sessionsDir, sessionId)?.view.runs[0]?.start.model;
  assert.ok(model !== undefined, "会话存储里应有 Run 开始条目");
  return model;
}

function capturing(): { streamFn: StreamFn; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  const inner = createFakeStreamFn({ replies: [{ text: "完成" }] });
  return {
    seen,
    streamFn: (model, context, options) => {
      seen.push({ ...(options as Record<string, unknown> | undefined) });
      return inner(model, context, options);
    },
  };
}

test("fixTemperature：把温度写进每次调用的选项；调用方自带的其他选项原样保留", () => {
  const { streamFn, seen } = capturing();
  const fixed = fixTemperature(streamFn, 0);
  const model = { maxTokens: 0 } as Parameters<StreamFn>[0];
  void fixed(model, { messages: [] }, { maxTokens: 128 });
  assert.deepEqual(seen[0], { maxTokens: 128, temperature: 0 });
});

test("headless：给了温度，调用选项、注入快照摘要（Run 开始条目）一致记下；不给则两处都没有这个键", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-sampling-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sampling-home-"));
  try {
    const fixed = capturing();
    const withTemperature = await runHeadless({
      task: "说完成",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: fixed.streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
      temperature: 0,
    });
    assert.equal(withTemperature.status, "completed");
    assert.ok(fixed.seen.length > 0);
    assert.ok(fixed.seen.every((options) => options.temperature === 0));
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    assert.equal(startedModel(sessionsDir, withTemperature.sessionId).temperature, 0);

    const plain = capturing();
    const without = await runHeadless({
      task: "说完成",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: plain.streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
    });
    assert.ok(plain.seen.every((options) => !("temperature" in options)));
    assert.equal("temperature" in startedModel(sessionsDir, without.sessionId), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("--temperature：只有用它的入口接受（接受时 0 到 2，非法取值响亮失败；缺省不设）；其余入口当作未知参数拒绝，不静默忽略", () => {
  const usage = "用法：测试";
  const accept = { usage, env: {}, temperature: true };
  assert.equal(parseLaunchFlags(["--temperature", "0"], accept).temperature, 0);
  assert.equal(parseLaunchFlags(["--temperature", "0.7"], accept).temperature, 0.7);
  assert.equal(parseLaunchFlags([], accept).temperature, undefined);
  for (const bad of ["-0.1", "2.5", "hot", ""]) {
    assert.throws(
      () => parseLaunchFlags(["--temperature", bad], accept),
      /--temperature 需要 0 到 2 之间的数/,
      bad
    );
  }
  // 不用它的入口（cli / tui / run / eval 冒烟）：拒绝，而不是解析了却不生效
  assert.throws(
    () => parseLaunchFlags(["--temperature", "0"], { usage, env: {} }),
    /未知参数：--temperature/
  );
});

test("推理开启时温度不生效：调用选项里不带温度，Run 开始条目如实记「未生效」与请求值，不记成温度 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-sampling-reason-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sampling-reason-home-"));
  try {
    const run = capturing();
    const result = await runHeadless({
      task: "说完成",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: run.streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
      thinking: "high",
      temperature: 0,
    });
    assert.equal(result.status, "completed");
    assert.ok(run.seen.length > 0);
    assert.ok(run.seen.every((options) => !("temperature" in options)));
    const model = startedModel(join(root, ".pigeon", "state", "sessions"), result.sessionId);
    assert.equal("temperature" in model, false);
    assert.deepEqual(model.temperatureIgnored, { requested: 0, reason: "reasoning-enabled" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
