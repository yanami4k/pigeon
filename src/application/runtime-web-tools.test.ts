// 联网工具的注册范围（决策 287–291、265 的先例）：装配根收到 webTools 才注册两件工具、系统提示追加一句、web_fetch 记为
// network 档；没收到即一件都不注册（跑批器各条件、沙箱断网档由入口不给）；worker 与主会话同样拿到；复盘的执行闸不放行它们。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STREAM_SPAWN_WORKERS, STREAM_WEB_TOOLS } from "../eval/stream-agents.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import { buildRuntime, WEB_TOOLS_SENTENCE } from "./runtime.ts";
import { statusTextOf } from "./status-fixtures.ts";
import type { WebToolsConfig } from "./web-tools.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const webTools: WebToolsConfig = {
  search: { unavailable: "没配", defaultMaxResults: 5 },
  fetch: { timeoutMs: 1000, maxBytes: 1000, maxChars: 1000 },
  distillMaxTokens: 100,
};

test("给了 webTools 才注册两件工具并追加系统提示句；web_fetch 为 network 档；没给一件都不注册、提示不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-web-runtime-"));
  try {
    for (const on of [true, false]) {
      const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
      const bundle = buildRuntime({
        streamFn,
        workspaceRoot: root,
        homeDir: root,
        sessionId: newSessionId(),
        yolo: false,
        provider: "fake-provider",
        modelId: "fake-model-1",
        createApprovalHandler: () => async () => ({ approved: false }),
        ...(on ? { webTools } : {}),
      });
      try {
        const snapshot = bundle.adapter.snapshot();
        // 决策 363：联网那句提示在开工状态块（联网一节），不在系统提示
        await bundle.adapter.run("你好");
        const status = statusTextOf(streamFn.calls[0]);
        assert.ok(!snapshot.context.systemPrompt.includes(WEB_TOOLS_SENTENCE));
        const advertised = snapshot.tools.advertised;
        assert.equal(advertised.includes(WEB_SEARCH_TOOL), on);
        assert.equal(advertised.includes(WEB_FETCH_TOOL), on);
        assert.equal(status.includes(WEB_TOOLS_SENTENCE), on);
        assert.equal(bundle.toolTiers.get(WEB_FETCH_TOOL), on ? "network" : undefined);
        assert.equal(bundle.toolTiers.get(WEB_SEARCH_TOOL), on ? "read" : undefined);
      } finally {
        await bundle.adapter.dispose();
        await bundle.sessionStore.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker 与主会话同样拿到两件工具：父策略里有且装配给了 webTools 才广告", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-web-worker-"));
  try {
    const seen: string[][] = [];
    for (const allow of [["read_file", WEB_SEARCH_TOOL, WEB_FETCH_TOOL], ["read_file"]]) {
      const factory = createWorkerRuntimeFactory({
        streamFnFor: () => createFakeStreamFn({ replies: [{ text: "好" }] }),
        provider: "fake-provider",
        modelId: "fake-model-1",
        homeDir: root,
        webTools,
      });
      const sessionId = newSessionId();
      const handle = factory({
        sessionId,
        name: "explorer-1",
        role: "explorer",
        task: "看看",
        policy: { allow, deny: [], approvalMode: "prompt" },
        governanceRoot: root,
        workspace: { kind: "git-worktree", path: root, branch: "pigeon/explorer-1" },
        lineage: { parentSessionId: newSessionId() },
        approvalHandler: async () => ({ approved: false }),
      });
      await handle.run("看看");
      await handle.dispose();
      seen.push(
        loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId)?.view.runs[0]?.start
          .advertisedTools ?? []
      );
    }
    assert.deepEqual(seen, [["read_file", WEB_SEARCH_TOOL, WEB_FETCH_TOOL], ["read_file"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("跑批器各条件不注册联网工具（身份头照记）", () => {
  assert.equal(STREAM_WEB_TOOLS, false);
  assert.equal(STREAM_SPAWN_WORKERS, false);
});
