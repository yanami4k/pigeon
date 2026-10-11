// 模型请求失败重试的装配（决策 420）：主请求按设置 modelRequest.maxRetries 传重试次数（缺省 4）；自带的 DeepSeek 接入声明的
// 线路接受自带 fetch，每次重试记进会话记录、挂在当时的 Run 上。HTTP 层用假的全局 fetch（不连任何真实接口）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { test, vi } from "vitest";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { deepseekModelInfo } from "../pi-runtime/deepseek-model.ts";
import { createDeepSeekStreamFn } from "../pi-runtime/deepseek-stream.ts";
import { failedReply, scriptedFetch } from "../pi-runtime/fixtures.ts";
import { registerModelAccess } from "../pi-runtime/model-access.ts";
import { newSessionId } from "../state/ids.ts";
import { emptySettingsSnapshot, modelRequestMaxRetriesOf } from "../state/settings.ts";
import { buildRuntime } from "./runtime.ts";

test("重试次数取设置（缺省 4），每次重试记进会话记录并挂在 Run 上；次数用完照原错误收尾", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-request-retry-"));
  const scripted = scriptedFetch([failedReply(429), failedReply(503), failedReply(429)]);
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(scripted.fetch);
  try {
    const settings = emptySettingsSnapshot(root);
    assert.equal(modelRequestMaxRetriesOf(settings), 4);
    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: registerModelAccess(
        createDeepSeekStreamFn({ DEEPSEEK_API_KEY: "sk-test" }, streamSimple),
        { declared: deepseekModelInfo() }
      ),
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: true,
      provider: "deepseek",
      modelId: "deepseek-flash",
      settings: { ...settings, merged: { ...settings.merged, modelRequest: { maxRetries: 2 } } },
    });
    try {
      await bundle.adapter.run("你好");
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    assert.equal(scripted.calls(), 3);
    const run = loadSessionView(join(root, ".pigeon", "state", "sessions"), sessionId)?.runs[0];
    const retries = run?.items.flatMap((item) =>
      item.kind === "request-retry" ? [[item.data.retry, item.data.status]] : []
    );
    assert.deepEqual(retries, [
      [1, 429],
      [2, 503],
    ]);
    assert.equal(run?.end?.ending, "error");
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
