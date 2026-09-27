// M5 S3（决策 042，M5 完成证据）：装配根在会话开始把常驻 Memory 段追加进 system prompt 一次即
// 冻结，清单进 InjectionSnapshot v3 的 memory 字段；会话中途改 Memory 文件，当前会话发给模型的
// system prompt 与快照哈希都不变（下个会话生效）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime } from "./runtime.ts";

test("Memory 段会话开始拼进 system prompt 即冻结：中途改文件不影响当前 prompt 与快照哈希", async () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-runtime-memory-"));
  const root = join(base, "workspace");
  const home = join(base, "home");
  mkdirSync(join(root, ".pigeon", "memory"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const original = "项目约定：包管理用 pnpm";
  writeFileSync(join(root, ".pigeon", "memory", "conventions.md"), original);
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake-provider",
    modelId: "fake-model",
    createApprovalHandler: () => async () => ({ approved: false }),
    homeDir: home,
  });
  try {
    const snapshot = bundle.adapter.snapshot();
    assert.ok(snapshot.context.systemPrompt.includes(original));
    assert.deepEqual(snapshot.memory, [
      {
        path: ".pigeon/memory/conventions.md",
        hash: createHash("sha256").update(original).digest("hex"),
        bytes: Buffer.byteLength(original),
        truncated: false,
        included: true,
      },
    ]);

    // 会话中途改文件：当前会话不热替换（§2 规则 4、§8 不在当前 Session 内热替换长期 Memory）
    writeFileSync(join(root, ".pigeon", "memory", "conventions.md"), "项目约定：改用 npm");
    const result = await bundle.adapter.run("开始吧");
    assert.equal(result.status, "completed");
    const sent = streamFn.calls[0]?.context.systemPrompt ?? "";
    assert.ok(sent.includes(original), "发给模型的 system prompt 仍是会话开始时的冻结版本");
    assert.ok(!sent.includes("改用 npm"));
    assert.deepEqual(bundle.adapter.snapshot().memory, snapshot.memory);
  } finally {
    await bundle.adapter.dispose();
    bundle.eventLog.close();
    await bundle.sessionStore.close();
    rmSync(base, { recursive: true, force: true });
  }
});
