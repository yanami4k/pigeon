// 人写的说明的装配（决策 330）：会话开始把 AGENTS.md 一段拼进 system prompt 即冻结，清单进注入快照的 memory 字段；会话中途改
// 文件，当前会话发给模型的 system prompt 与清单都不变（下个会话生效）。本地会话从工作区根往上读；沙箱会话（注入执行端）读宿主
// 上的工作区（治理根），与本机会话内容一致。超出上限的提示经运行面交给入口；不再读 .pigeon/memory/*.md 与 ~/.pigeon/preferences.md。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";

function withBase(body: (base: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-runtime-agents-"));
  return body(base).finally(() => rmSync(base, { recursive: true, force: true }));
}

test("AGENTS.md 一段会话开始拼进 system prompt 即冻结：中途改文件不影响当前 prompt 与清单；旧的常驻 Memory 位置不再读", () =>
  withBase(async (base) => {
    const root = join(base, "workspace");
    const home = join(base, "home");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".pigeon", "memory"), { recursive: true });
    mkdirSync(join(home, ".pigeon"), { recursive: true });
    const original = "项目约定：包管理用 pnpm";
    writeFileSync(join(root, "AGENTS.md"), original);
    writeFileSync(join(root, ".pigeon", "memory", "old.md"), "旧的项目级 Memory");
    writeFileSync(join(home, ".pigeon", "preferences.md"), "旧的用户偏好");
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model",
      homeDir: home,
    });
    try {
      const snapshot = bundle.adapter.snapshot();
      assert.ok(snapshot.context.systemPrompt.includes(`### AGENTS.md\n${original}`));
      assert.ok(!snapshot.context.systemPrompt.includes("旧的项目级 Memory"));
      assert.ok(!snapshot.context.systemPrompt.includes("旧的用户偏好"));
      assert.ok(!snapshot.context.systemPrompt.includes("常驻 Memory"));
      assert.deepEqual(snapshot.memory, [
        {
          path: "AGENTS.md",
          hash: createHash("sha256").update(original).digest("hex"),
          bytes: Buffer.byteLength(original),
          truncated: false,
          included: true,
        },
      ]);
      assert.equal(bundle.instructionsNotice, undefined);
      // 会话中途改文件：当前会话不热替换
      writeFileSync(join(root, "AGENTS.md"), "项目约定：改用 npm");
      const result = await bundle.adapter.run("开始吧");
      assert.equal(result.status, "completed");
      const sent = streamFn.calls[0]?.context.systemPrompt ?? "";
      assert.ok(sent.includes(original), "发给模型的 system prompt 仍是会话开始时的冻结版本");
      assert.ok(!sent.includes("改用 npm"));
      assert.deepEqual(bundle.adapter.snapshot().memory, snapshot.memory);
    } finally {
      await disposeRuntime(bundle);
    }
  }));

test("沙箱会话（注入执行端）读宿主上的工作区（治理根）的 AGENTS.md；超出上限的提示交给入口", () =>
  withBase(async (base) => {
    const host = join(base, "host");
    const placeholder = join(base, "placeholder");
    mkdirSync(join(host, ".git"), { recursive: true });
    mkdirSync(placeholder, { recursive: true });
    writeFileSync(join(host, "AGENTS.md"), "宿主工作区的说明");
    writeFileSync(join(placeholder, "AGENTS.md"), "占位目录里的（不读）");
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      workspaceRoot: placeholder,
      governanceRoot: host,
      workspaceHost: createLocalWorkspaceHost(placeholder),
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model",
      homeDir: join(base, "home"),
    });
    try {
      const prompt = bundle.adapter.snapshot().context.systemPrompt;
      assert.ok(prompt.includes("宿主工作区的说明"));
      assert.ok(!prompt.includes("占位目录里的"));
    } finally {
      await disposeRuntime(bundle);
    }
    writeFileSync(join(host, "AGENTS.md"), "长".repeat(12_000));
    const truncated = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      workspaceRoot: host,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model",
      homeDir: join(base, "home"),
    });
    try {
      assert.match(
        truncated.instructionsNotice ?? "",
        /^\[说明\] AGENTS\.md 等人写的说明合计超出 32 KiB 上限/
      );
    } finally {
      await disposeRuntime(truncated);
    }
  }));
