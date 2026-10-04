// 工具并行执行（决策 353，按上游的逐工具模式）：登记的读类工具并行，其余与未登记的串行；Agent 各环境恒为并行模式——
// 纯读的一批同时执行，读写混排的一批按顺序逐个准备、执行（容器执行端同样）；连发两个 edit_file 改同一文件时，
// 第二个的审批与预览发生在第一个改完之后。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { buildRuntime } from "./runtime.ts";
import { toolExecutionModeOf } from "./tool-execution-modes.ts";

function call(name: string, args: Record<string, unknown>) {
  return { name, args };
}

test("执行模式登记：读类工具并行，改文件、跑命令、MCP、编排类与未登记的一律串行", () => {
  for (const name of ["read_file", "search_sessions", "read_session_entry", "list_sessions"]) {
    assert.equal(toolExecutionModeOf(name), "parallel", name);
  }
  for (const name of ["web_search", "web_fetch"]) {
    assert.equal(toolExecutionModeOf(name), "parallel", name);
  }
  for (const name of ["edit_file", "run_command", "mcp__srv__read", "spawn_worker", "unknown"]) {
    assert.equal(toolExecutionModeOf(name), "sequential", name);
  }
});

test("容器执行端：纯读的一批同时执行；读与命令混排的一批按顺序逐个执行", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-exec-modes-"));
  try {
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    const events: string[] = [];
    const local = createLocalWorkspaceHost(root);
    // 当作容器执行端交给装配根：读文件慢一点并记下起止，命令不真起进程
    const host: WorkspaceHost = {
      ...local,
      platform: "linux",
      findLauncherScript: () => undefined,
      async readText(resolved) {
        events.push(`start ${basename(resolved)}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`end ${basename(resolved)}`);
        return local.readText(resolved);
      },
      async exec() {
        events.push("exec");
        return {
          spawned: true,
          exitCode: 0,
          timedOut: false,
          outputBytes: 0,
          outputHash: "",
          stdout: "",
          stderr: "",
          output: "",
        };
      },
    };
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "读两个",
            toolCalls: [call("read_file", { path: "a.txt" }), call("read_file", { path: "b.txt" })],
          },
          {
            text: "混排",
            toolCalls: [
              call("read_file", { path: "a.txt" }),
              call("run_command", { command: "true" }),
              call("read_file", { path: "b.txt" }),
            ],
          },
          { text: "完成" },
        ],
      }),
      workspaceRoot: root,
      workspaceHost: host,
      homeDir: root,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
    });
    try {
      await bundle.adapter.run("干活");
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    assert.deepEqual(events.slice(0, 4), ["start a.txt", "start b.txt", "end a.txt", "end b.txt"]);
    assert.deepEqual(events.slice(4), [
      "start a.txt",
      "end a.txt",
      "exec",
      "start b.txt",
      "end b.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("连发两个 edit_file 改同一文件：第二个的审批在第一个改完之后，预览基于改完的内容", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-exec-modes-edit-"));
  try {
    const file = join(root, "f.txt");
    writeFileSync(file, "a\n");
    const asked: Array<{ content: string; preview: string | undefined }> = [];
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "连改两次",
            toolCalls: [
              call("edit_file", { path: "f.txt", old_string: "a", new_string: "b" }),
              call("edit_file", { path: "f.txt", old_string: "b", new_string: "c" }),
            ],
          },
          { text: "完成" },
        ],
      }),
      workspaceRoot: root,
      homeDir: root,
      sessionId: newSessionId(),
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      createApprovalHandler: () => async (request) => {
        asked.push({ content: readFileSync(file, "utf8"), preview: request.diffPreview });
        return { approved: true };
      },
    });
    try {
      await bundle.adapter.run("改文件");
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    assert.equal(asked.length, 2);
    assert.equal(asked[1]?.content, "b\n");
    assert.ok(asked[1]?.preview !== undefined);
    assert.equal(readFileSync(file, "utf8"), "c\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
