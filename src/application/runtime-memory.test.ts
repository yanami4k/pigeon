// 人写的说明的装配（决策 330、363）：AGENTS.md 一段随开工状态块发出（不在系统提示里），清单进注入快照的 memory 字段；会话中途改
// 文件，下一次请求前以状态追加整段取代，系统提示与清单不变。本地会话从工作区根往上读；沙箱会话（注入执行端）读宿主
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
import { statusTextOf } from "./status-fixtures.ts";

function withBase(body: (base: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-runtime-agents-"));
  return body(base).finally(() => rmSync(base, { recursive: true, force: true }));
}

test("AGENTS.md 一段随开工状态块发出、不在系统提示里；中途改文件以状态追加整段取代，系统提示与清单不变；旧的常驻 Memory 位置不再读", () =>
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
      assert.ok(!snapshot.context.systemPrompt.includes(original), "系统提示里没有人写的说明");
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
      const result = await bundle.adapter.run("开始吧");
      assert.equal(result.status, "completed");
      const first = statusTextOf(streamFn.calls[0]);
      assert.ok(first.includes(`### AGENTS.md\n${original}`), "开工状态块带人写的说明");
      assert.ok(!first.includes("旧的项目级 Memory"));
      assert.ok(!first.includes("旧的用户偏好"));
      // 会话中途改文件：下一次请求前整段追加
      writeFileSync(join(root, "AGENTS.md"), "项目约定：改用 npm");
      await bundle.adapter.run("再来");
      const second = streamFn.calls[1];
      const update = statusTextOf(second).split("<pigeon-status-update>").at(-1) ?? "";
      assert.match(update, /以下整段取代此前的「项目说明」/);
      assert.ok(update.includes("改用 npm"));
      assert.equal(second?.context.systemPrompt, streamFn.calls[0]?.context.systemPrompt);
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
    const sandboxed = createFakeStreamFn({ replies: [{ text: "好" }] });
    const bundle = buildRuntime({
      streamFn: sandboxed,
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
      await bundle.adapter.run("开始吧");
      const sent = statusTextOf(sandboxed.calls[0]);
      assert.ok(sent.includes("宿主工作区的说明"));
      assert.ok(!sent.includes("占位目录里的"));
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

test("agentsMd 关掉（跑批器与只测装配的用例）：不读任何说明", () =>
  withBase(async (base) => {
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, "AGENTS.md"), "说明");
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: base,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model",
      homeDir: join(base, "home"),
      agentsMd: false,
    });
    try {
      await bundle.adapter.run("开始吧");
      assert.doesNotMatch(statusTextOf(streamFn.calls[0]), /name="项目说明"/);
      assert.deepEqual(bundle.adapter.snapshot().memory, []);
    } finally {
      await disposeRuntime(bundle);
    }
  }));
