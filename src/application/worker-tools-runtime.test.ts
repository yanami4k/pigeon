// worker 的工具清单与作用范围在装配根落地（决策 360）：只注册委派策略里的工具（主会话有、清单里没有的也不注册），系统提示只介绍
// 有的工具并交代范围；越界调用在放手模式下照样被拒；设置里没为角色登记命令时与主会话同一规则，登记了空清单即一条都不许。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime } from "./runtime.ts";
import { statusTextOf } from "./status-fixtures.ts";
import type { WebToolsConfig } from "./web-tools.ts";

const NODE = `"${process.execPath}"`;
const RUN_NODE = `${NODE} -e "process.stdout.write('r' + 'an')"`;

const webTools: WebToolsConfig = {
  search: { unavailable: "没配", defaultMaxResults: 5 },
  fetch: { timeoutMs: 1000, maxBytes: 1000, maxChars: 1000 },
  distillMaxTokens: 100,
};

function call(name: string, args: Record<string, unknown>) {
  return { text: name, toolCalls: [{ name, args }] };
}

// 装一个委派策略为 read_file、run_command 且带范围的 tester（放手模式），跑完给定的调用，交回注册表、系统提示、
// 开工状态块（决策 363：审批与联网的说法在状态块）与各工具结果
async function runTester(options: {
  calls: ReturnType<typeof call>[];
  settings?: unknown;
}): Promise<{
  tools: string[];
  prompt: string;
  status: string;
  results: Array<{ isError: boolean; text: string }>;
}> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-worker-tools-"));
  try {
    mkdirSync(join(root, "scoped-dir"));
    writeFileSync(join(root, "scoped-dir", "a.txt"), "inside\n");
    writeFileSync(join(root, "other.txt"), "outside\n");
    if (options.settings !== undefined) {
      mkdirSync(join(root, ".pigeon"));
      writeFileSync(join(root, ".pigeon", "settings.json"), JSON.stringify(options.settings));
    }
    const streamFn = createFakeStreamFn({ replies: [...options.calls, { text: "完成" }] });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      homeDir: root,
      settings: loadSettings(root, { homeDir: root }),
      sessionId: newSessionId(),
      yolo: true,
      // 派出方有联网工具，worker 的清单里没有
      webTools,
      toolPolicy: {
        allow: ["read_file", "run_command"],
        deny: [],
        approvalMode: "yolo",
        scopes: [
          { tool: "read_file", paths: ["scoped-dir"] },
          { tool: "run_command", commandPrefixes: [`${NODE} -e`] },
        ],
      },
      commandRole: "tester",
      provider: "fake-provider",
      modelId: "fake-model-1",
    });
    try {
      const tools = [...bundle.toolTiers.keys()].sort();
      const prompt = bundle.adapter.snapshot().context.systemPrompt;
      await bundle.adapter.run("干活");
      const results = bundle.adapter.transcript().flatMap((message) =>
        message.role === "toolResult"
          ? [
              {
                isError: message.isError,
                text: message.content
                  .map((block) => (block.type === "text" ? block.text : ""))
                  .join(""),
              },
            ]
          : []
      );
      return { tools, prompt, status: statusTextOf(streamFn.calls[0]), results };
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("worker 只有给了的工具与范围：注册与提示只含它们，越界即拒，没登记命令的 tester 在放手模式下能跑命令", async () => {
  const { tools, prompt, status, results } = await runTester({
    calls: [
      call("read_file", { path: "scoped-dir/a.txt" }),
      call("read_file", { path: "other.txt" }),
      call("run_command", { command: RUN_NODE }),
      call("run_command", { command: `${NODE} -e "1" && echo hi` }),
    ],
  });
  assert.deepEqual(tools, ["read_file", "run_command"]);
  for (const present of ["read_file", "run_command", "scoped-dir", `${NODE} -e`]) {
    assert.ok(prompt.includes(present), present);
  }
  // 状态块的审批一节只说 run_command，不说写操作；联网一节不出现（worker 没给联网工具）
  assert.match(status, /name="审批"/);
  assert.ok(status.includes("run_command："), status);
  for (const absent of ["edit_file", "list_sessions", "web_search", "web_fetch", "写操作"]) {
    assert.ok(!prompt.includes(absent) && !status.includes(absent), absent);
  }
  assert.deepEqual(
    results.map((result) => result.isError),
    [false, true, false, true],
    JSON.stringify(results)
  );
  assert.ok(results[0]?.text.includes("inside"));
  assert.ok(results[2]?.text.includes("ran"), results[2]?.text);
});

test("设置里为角色登记了空清单：范围内的命令也一条都不许", async () => {
  const { results } = await runTester({
    calls: [call("run_command", { command: RUN_NODE })],
    settings: { commands: { roles: { tester: [] } } },
  });
  assert.equal(results[0]?.isError, true, JSON.stringify(results));
  assert.ok(!results[0]?.text.includes("ran"));
});
