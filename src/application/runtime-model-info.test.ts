// 模型信息通路的装配（决策 362）：接入模块可具名导出 modelInfo，加载时取出（不合规即报错）；运行面按设置 > 声明 > 目录
// 逐项取值，写进 Run 开始条目（每一项带来源）。自带的 DeepSeek 接入声明官方人民币价，模型对象的价格仍为 0。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { locateSessionFile } from "../persistence/session-reader.ts";
import { loadStoreSessionFile } from "../persistence/session-view.ts";
import { deepseekModel, deepseekModelInfo } from "../pi-runtime/deepseek-model.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { gatewayStreamFn } from "../pi-runtime/gateway-stream.ts";
import { modelAccessOf, registerModelAccess } from "../pi-runtime/model-access.ts";
import { PRICE_CNY_PER_MTOK } from "../state/model-pricing.ts";
import { type RunStartData, SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { runHeadless } from "./headless-core.ts";
import { loadStreamFn } from "./runtime.ts";

function withRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("接入模块的 modelInfo：加载时随 StreamFn 取出；不导出照常可用；不合规即报错并指出字段", () =>
  withRoot("pigeon-model-info-load-", async (dir) => {
    const body = "export default async function streamFn() {}\n";
    writeFileSync(
      join(dir, "declared.mjs"),
      `${body}export const modelInfo = { provider: "acme", id: "m1", contextWindow: 1000, maxTokens: 10, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, currency: "EUR" } };\n`
    );
    writeFileSync(join(dir, "plain.mjs"), body);
    writeFileSync(
      join(dir, "bad.mjs"),
      `${body}export const modelInfo = { contextWindow: "1M" };\n`
    );
    const declared = modelAccessOf(await loadStreamFn(join(dir, "declared.mjs")));
    assert.equal(declared?.declared?.cost?.currency, "EUR");
    assert.equal(declared?.catalog, undefined);
    const plain = modelAccessOf(await loadStreamFn(join(dir, "plain.mjs")));
    assert.equal(plain?.declared, undefined);
    assert.equal(typeof plain?.catalog, "function");
    await assert.rejects(() => loadStreamFn(join(dir, "bad.mjs")), /modelInfo.*contextWindow/);
  }));

test("Run 开始条目记下本次的模型信息与每一项的来源（设置盖过声明，没人给的记未知）", () =>
  withRoot("pigeon-model-info-run-", async (root) => {
    const streamFn = registerModelAccess(createFakeStreamFn({ replies: [{ text: "好" }] }), {
      declared: { provider: "acme", id: "m1", contextWindow: 500_000 },
    });
    const settings = emptySettingsSnapshot(root);
    const result = await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: root,
      skillRoots: [],
      agentsMd: false,
      settings: {
        ...settings,
        merged: { ...settings.merged, modelInfo: { models: { "acme/m1": { maxTokens: 8192 } } } },
      },
    });
    const located = locateSessionFile(join(root, ".pigeon", "state", "sessions"), result.sessionId);
    assert.ok(located !== undefined);
    const loaded = loadStoreSessionFile(located.path);
    assert.ok(loaded !== undefined);
    const start = (
      loaded.main as unknown as Array<{
        type: string;
        customType?: string;
        data?: RunStartData;
      }>
    ).find((entry) => entry.type === "custom" && entry.customType === SessionEntryType.RunStart);
    assert.deepEqual(start?.data?.modelInfo, {
      provider: "acme",
      id: "m1",
      identity: "declared",
      cost: { source: "unknown" },
      contextWindow: { source: "declared", value: 500_000 },
      maxTokens: { source: "settings", value: 8192 },
      cacheRule: { servedBy: "acme", overridden: false },
    });
  }));

test("自带的 DeepSeek 接入：声明官方人民币非高峰价，模型对象价格仍为 0；网关接入登记同一份声明并带上输出上限的替换", () => {
  const info = deepseekModelInfo();
  assert.deepEqual(info.cost, {
    input: PRICE_CNY_PER_MTOK.cacheMiss,
    output: PRICE_CNY_PER_MTOK.output,
    cacheRead: PRICE_CNY_PER_MTOK.cacheHit,
    cacheWrite: PRICE_CNY_PER_MTOK.cacheMiss,
    currency: "CNY",
  });
  assert.deepEqual(deepseekModel().cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const gateway = modelAccessOf(gatewayStreamFn("http://gateway.test/j/1", "deepseek-flash", 4096));
  assert.deepEqual(gateway?.declared, { ...info, maxTokens: 4096 });
});
