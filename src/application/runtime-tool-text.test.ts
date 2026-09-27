// 工具说明与系统提示按实际执行端与审批状态生成（170 ④）：模型实际看到的系统提示与 run_command 说明，
// 在容器执行端且自动批准时不再声称"不经 shell""每条命令都要人工批准"；本地有人工审批时照实说要批准；
// 无人值守又没放权时说明未放行的会被拒绝
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import { runCommandTexts } from "../tools/run-command.ts";
import { runHeadless } from "./headless.ts";
import { buildRuntime } from "./runtime.ts";

interface AdvertisedTool {
  name: string;
  description: string;
}

function seen(streamFn: ReturnType<typeof createFakeStreamFn>) {
  const context = streamFn.calls[0]?.context;
  const tools = (context?.tools ?? []) as unknown as AdvertisedTool[];
  return {
    systemPrompt: context?.systemPrompt ?? "",
    runCommand: tools.find((tool) => tool.name === "run_command")?.description,
  };
}

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tool-text-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-tool-text-home-"));
  writeFileSync(join(root, "a.txt"), "alpha\n");
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("容器执行端（linux）且自动批准：系统提示与 run_command 说明写经 /bin/sh -c、自动批准，不提人工批准", async () => {
  const d = dirs();
  try {
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    await runHeadless({
      task: "你好",
      governanceRoot: d.root,
      workspaceRoot: d.root,
      workspaceHost: createLocalWorkspaceHost(d.root, { platform: "linux" }),
      streamFn,
      yolo: true,
      homeDir: d.home,
      skillRoots: [],
      memoryRoots: [],
    });
    const { systemPrompt, runCommand } = seen(streamFn);
    const texts = runCommandTexts({ platform: "linux", approval: "yolo" });
    assert.ok(systemPrompt.includes(`写操作自动批准。${texts.prompt}`), systemPrompt);
    assert.equal(runCommand, texts.tool);
    assert.doesNotMatch(systemPrompt, /人工批准|不经 shell/);
  } finally {
    d.cleanup();
  }
});

test("本地无人值守且未放权（没有审批通道）：系统提示写明未被放权规则放行的写操作与命令会被拒绝", async () => {
  const d = dirs();
  try {
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    await runHeadless({
      task: "你好",
      governanceRoot: d.root,
      workspaceRoot: d.root,
      streamFn,
      yolo: false,
      homeDir: d.home,
      skillRoots: [],
      memoryRoots: [],
    });
    const { systemPrompt, runCommand } = seen(streamFn);
    const texts = runCommandTexts({ platform: process.platform, approval: "none" });
    assert.ok(
      systemPrompt.includes(`需要批准的写操作会被拒绝（本会话没有人工审批通道）。${texts.prompt}`),
      systemPrompt
    );
    assert.equal(runCommand, texts.tool);
  } finally {
    d.cleanup();
  }
});

test("本地有人工审批通道：系统提示与 run_command 说明照实写要人工批准", async () => {
  const d = dirs();
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: d.root,
    sessionId: newSessionId(),
    yolo: false,
    provider: "fake-provider",
    modelId: "fake-model-1",
    homeDir: d.home,
    skillRoots: [],
    memoryRoots: [],
    createApprovalHandler: () => async () => ({ approved: false }),
  });
  try {
    await bundle.adapter.run("你好");
    const { systemPrompt, runCommand } = seen(streamFn);
    const texts = runCommandTexts({ platform: process.platform, approval: "prompt" });
    assert.ok(systemPrompt.includes(`写操作可能需要人工批准。${texts.prompt}`), systemPrompt);
    assert.equal(runCommand, texts.tool);
  } finally {
    await bundle.adapter.dispose();
    bundle.eventLog.close();
    await bundle.sessionStore.close();
    d.cleanup();
  }
});
