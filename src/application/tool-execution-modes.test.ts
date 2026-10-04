// 工具并行执行（决策 353）：读类并行、其余与未登记的串行；纯读批同时执行，混排批逐个准备、执行，连改同一文件时后一个的预览基于前一个改完的内容。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { buildRuntime, disposeRuntime } from "./runtime.ts";
import { toolExecutionModeOf } from "./tool-execution-modes.ts";

type Call = { name: string; args: Record<string, unknown> };

// 每批一次回复跑完；给了 approve 即 prompt 模式（请示时交回预览与 f.txt 当时的内容），否则 yolo 且执行端为容器形（容器工作区不接交互审批）
async function run(batches: Call[][], approve?: (preview?: string, file?: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-exec-modes-"));
  try {
    for (const name of ["a.txt", "b.txt", "f.txt"]) writeFileSync(join(root, name), "a\n");
    const events: string[] = [];
    const local = createLocalWorkspaceHost(root);
    const host: WorkspaceHost = {
      ...local,
      async readText(resolved) {
        events.push(`start ${basename(resolved)}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`end ${basename(resolved)}`);
        return local.readText(resolved);
      },
      exec(plan, options) {
        events.push("exec");
        return local.exec(plan, options);
      },
    };
    const replies = [...batches.map((toolCalls) => ({ text: "", toolCalls })), { text: "完成" }];
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies }),
      workspaceRoot: root,
      homeDir: root,
      sessionId: newSessionId(),
      yolo: approve === undefined,
      provider: "fake-provider",
      modelId: "fake-model-1",
      ...(approve === undefined
        ? { workspaceHost: host }
        : {
            createApprovalHandler: () => async (request) => {
              approve(request.diffPreview, readFileSync(join(root, "f.txt"), "utf8"));
              return { approved: true };
            },
          }),
    });
    await bundle.adapter.run("干活").finally(() => disposeRuntime(bundle));
    return { events, file: readFileSync(join(root, "f.txt"), "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("执行模式登记：读类工具并行，其余与未登记的串行", () => {
  const modes = ["read_file", "web_fetch", "edit_file", "mcp__s__t", "x"].map(toolExecutionModeOf);
  assert.deepEqual(modes, ["parallel", "parallel", "sequential", "sequential", "sequential"]);
});

test("纯读的一批同时执行；读与命令混排的一批按顺序逐个执行", async () => {
  const read = (path: string): Call => ({ name: "read_file", args: { path } });
  const command = { name: "run_command", args: { command: `"${process.execPath}" -e 0` } };
  const { events } = await run([
    [read("a.txt"), read("b.txt")],
    [read("a.txt"), command, read("b.txt")],
  ]);
  assert.deepEqual(events, [
    ...["start a.txt", "start b.txt", "end a.txt", "end b.txt"],
    ...["start a.txt", "end a.txt", "exec", "start b.txt", "end b.txt"],
  ]);
});

test("一次回复里连发两个 edit_file 改同一文件：第二个的请示在第一个改完之后，预览基于改完的内容", async () => {
  const asked: Array<[string | undefined, string | undefined]> = [];
  const edit = (from: string, to: string): Call => ({
    name: "edit_file",
    args: { path: "f.txt", old_string: from, new_string: to },
  });
  const { file } = await run([[edit("a", "b"), edit("b", "c")]], (preview, content) =>
    asked.push([preview, content])
  );
  assert.deepEqual([asked[1]?.[0] !== undefined, asked[1]?.[1], file], [true, "b\n", "c\n"]);
});
