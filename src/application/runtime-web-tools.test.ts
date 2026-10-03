// 联网工具的注册范围（决策 287–291、265 的先例）：worker 与主会话同样拿到两件工具——父策略里有且装配给了 webTools 才广告。
// 主会话给了才注册、系统提示追加一句、web_fetch 记为 network 档见 launch-flags-web.test.ts；跑批器各条件不注册见
// eval/stream-experiment.test.ts。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../tools/host-scope.ts";
import type { WebToolsConfig } from "./web-tools.ts";
import { createWorkerRuntimeFactory } from "./workers.ts";

const webTools: WebToolsConfig = {
  search: { unavailable: "没配", defaultMaxResults: 5 },
  fetch: { timeoutMs: 1000, maxBytes: 1000, maxChars: 1000 },
  distillMaxTokens: 100,
};

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
