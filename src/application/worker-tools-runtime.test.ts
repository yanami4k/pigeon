// worker 的工具清单与作用范围在装配根落地（决策 360）：只注册委派策略里的工具，系统提示只介绍有的工具并交代范围；
// 越界调用在放手模式下照样被拒；tester 在设置里没登记命令时与主会话同一规则，放手模式下能跑命令。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { buildRuntime } from "./runtime.ts";

const NODE = `"${process.execPath}"`;

function call(name: string, args: Record<string, unknown>) {
  return { text: name, toolCalls: [{ name, args }] };
}

test("worker 只有给了的工具与范围：注册与提示只含它们，越界即拒，tester 在放手模式下能跑命令", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-worker-tools-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.txt"), "inside\n");
    writeFileSync(join(root, "other.txt"), "outside\n");
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          call("read_file", { path: "src/a.txt" }),
          call("read_file", { path: "other.txt" }),
          call("run_command", { command: `${NODE} -e "process.stdout.write('ran')"` }),
          call("run_command", { command: `${NODE} -e "1" && echo hi` }),
          { text: "完成" },
        ],
      }),
      workspaceRoot: root,
      homeDir: root,
      settings: loadSettings(root, { homeDir: root }),
      sessionId: newSessionId(),
      yolo: true,
      toolPolicy: {
        allow: ["read_file", "run_command"],
        deny: [],
        approvalMode: "yolo",
        scopes: [
          { tool: "read_file", paths: ["src"] },
          { tool: "run_command", commandPrefixes: [`${NODE} -e`] },
        ],
      },
      commandRole: "tester",
      provider: "fake-provider",
      modelId: "fake-model-1",
    });
    let results: Array<{ isError: boolean; text: string }>;
    try {
      assert.deepEqual([...bundle.toolTiers.keys()].sort(), ["read_file", "run_command"]);
      const prompt = bundle.adapter.snapshot().context.systemPrompt;
      assert.ok(prompt.includes("用 read_file 读取文件"), prompt);
      assert.ok(prompt.includes("用 run_command 运行命令"), prompt);
      for (const absent of ["edit_file", "list_sessions", "web_search"]) {
        assert.ok(!prompt.includes(absent), absent);
      }
      assert.ok(prompt.includes("read_file 只能用于 src 之内的路径"), prompt);
      await bundle.adapter.run("干活");
      results = bundle.adapter.transcript().flatMap((message) =>
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
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    assert.deepEqual(
      results.map((result) => result.isError),
      [false, true, false, true],
      JSON.stringify(results)
    );
    assert.ok(results[0]?.text.includes("inside"));
    assert.ok(results[2]?.text.includes("ran"), results[2]?.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
