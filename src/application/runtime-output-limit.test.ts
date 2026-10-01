// 单轮输出上限装配（决策 063 第 1 件）：装配层包装 streamFn——缺省时模型调用收到 maxTokens 16,384，
// headless 的 maxOutputTokens 覆盖生效；上限值写进注入快照 model 段与会话存储 Run 开始条目的 model 摘要。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { runHeadless } from "./headless.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

function recording() {
  const seen: unknown[] = [];
  const fake = createFakeStreamFn({ replies: [{ text: "好" }] });
  const streamFn: StreamFn = (model, context, options) => {
    seen.push(options?.maxTokens);
    return fake(model, context, options);
  };
  return { seen, streamFn };
}

for (const [label, maxOutputTokens, expected] of [
  ["缺省", undefined, 16_384],
  ["配置 4096", 4096, 4096],
] as const) {
  test(`输出上限装配（${label}）：模型调用收到 maxTokens ${expected}，Run 开始条目的 model 摘要记下该值`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pigeon-output-limit-"));
    const home = mkdtempSync(join(tmpdir(), "pigeon-output-limit-home-"));
    try {
      const { seen, streamFn } = recording();
      const result = await runHeadless({
        task: "你好",
        governanceRoot: root,
        workspaceRoot: root,
        streamFn,
        yolo: true,
        homeDir: home,
        skillRoots: [],
        agentsMd: false,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      });
      assert.deepEqual(seen, [expected]);
      const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), result.sessionId);
      assert.ok(loaded !== undefined, "会话存储里应有本会话");
      assert.equal(loaded.view.runs.length, 1);
      assert.equal(loaded.view.runs[0]?.start.model.maxOutputTokens, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("输出上限装配：注入快照 model 段写入 maxOutputTokens（缺省 16,384，配置值覆盖）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-output-limit-snapshot-"));
  try {
    for (const [maxOutputTokens, expected] of [
      [undefined, 16_384],
      [2048, 2048],
    ] as const) {
      const bundle = buildRuntime({
        streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
        workspaceRoot: root,
        sessionId: newSessionId(),
        yolo: true,
        provider: "fake-provider",
        modelId: "fake-model-1",
        homeDir: root,
        skillRoots: [],
        agentsMd: false,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      });
      try {
        assert.equal(bundle.adapter.snapshot().model.maxOutputTokens, expected);
      } finally {
        await disposeRuntime(bundle);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
