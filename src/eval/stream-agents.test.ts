import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { listSessionIds, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { commandStepAgent, pigeonStepAgent, STREAM_WORK_DIRECTIVE } from "./stream-agents.ts";
import type { StepAgentInput } from "./stream-runner.ts";
import { CONDITION_SPECS } from "./stream-runner.ts";

function input(workDir: string, overrides: Partial<StepAgentInput> = {}): StepAgentInput {
  return {
    job: { stream: "s1", condition: "minimal", attempt: 1 },
    step: {
      seq: 7,
      kind: "task",
      commit: "c",
      parent: "p",
      subject: "s",
      message: "m",
      prompt: "do it",
      humanFiles: [],
      judgeTests: [],
      reason: "",
    },
    prompt: "do it",
    condition: CONDITION_SPECS.minimal,
    target: { container: "box", root: "/testbed" },
    budget: { maxTurns: 150, wallClockMs: 60_000 },
    verify: { command: "true", timeoutMs: 60_000 },
    workDir,
    ...overrides,
  };
}

test("命令式 agent：请求文件带题面、工作说明、容器与预算，结果文件读回终态、轮数与用量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    const launcher = join(dir, "launcher.mjs");
    writeFileSync(
      launcher,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const [request, result] = process.argv.slice(2);",
        'const r = JSON.parse(readFileSync(request, "utf8"));',
        "writeFileSync(result, JSON.stringify({ status: 'completed', turns: r.maxTurns - 140, usage: { input: 7, output: 3, totalTokens: 10 } }));",
      ].join("\n")
    );
    const agent = commandStepAgent({ command: [process.execPath, launcher] });
    const out = await agent.run(input(dir));
    assert.deepEqual(
      [out.status, out.turns, out.usage.totalTokens, out.usage.input, out.repair],
      ["completed", 10, 10, 7, null]
    );
    const request = JSON.parse(
      readFileSync(join(dir, "minimal", "step-7", "request.json"), "utf8")
    );
    assert.deepEqual(request, {
      prompt: "do it",
      directive: STREAM_WORK_DIRECTIVE,
      container: "box",
      root: "/testbed",
      maxTurns: 150,
      wallClockMs: 60_000,
      docker: ["docker"],
      modelBaseUrl: null,
      model: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令式 agent：墙钟用满连同进程一起杀掉，记 wall-clock-limit；启动器报被打断则如实交回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    const slow = commandStepAgent({ command: [process.execPath, hang], graceMs: 0 });
    const timed = await slow.run(input(dir, { budget: { maxTurns: 1, wallClockMs: 300 } }));
    assert.equal(timed.status, "wall-clock-limit");
    const cut = join(dir, "cut.mjs");
    writeFileSync(
      cut,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[3], JSON.stringify({ status: 'failed', turns: 2, interrupted: '限额' }));",
      ].join("\n")
    );
    const interrupted = await commandStepAgent({ command: [process.execPath, cut] }).run(
      input(dir)
    );
    assert.equal(interrupted.interrupted, "限额");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令式 agent：限额暂停即杀掉启动器，记为被打断（整题作废重做）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    const limits = { state: "running" };
    const agent = commandStepAgent({ command: [process.execPath, hang], limits });
    setTimeout(() => {
      limits.state = "paused";
    }, 200);
    const out = await agent.run(input(dir));
    assert.equal(out.interrupted, "限额信号：最简 agent 已中止");
    assert.ok(out.wallMs < 30_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令式 agent：状态没变、只来了限额信号（例如并发受限只降路）也立即杀掉启动器，由订阅通知、不等轮询", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    const listeners = new Set<() => void>();
    const limits = {
      state: "running",
      signals: 0,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const agent = commandStepAgent({ command: [process.execPath, hang], limits, graceMs: 0 });
    setTimeout(() => {
      limits.signals += 1;
      for (const listener of listeners) listener();
    }, 200);
    const out = await agent.run(input(dir, { budget: { maxTurns: 1, wallClockMs: 5_000 } }));
    assert.equal(out.interrupted, "限额信号：最简 agent 已中止");
    assert.equal(listeners.size, 0, "一步结束即退订");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 容器以在本机执行命令的假 docker 代替：工作区是真实 git 仓库，a.txt 起初为 bug
function containerWorkspace(dir: string) {
  const testbed = join(dir, "testbed");
  mkdirSync(testbed);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: testbed, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.invalid");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(testbed, "a.txt"), "bug\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return { testbed, ...localDockerHost(testbed) };
}

const editTo = (from: string, to: string) => ({
  text: `把 ${from} 改成 ${to}`,
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` } },
  ],
});

test("Pigeon agent：开回炉的条件按分步验证在容器里回炉，修满轮数仍失败即撤回到这一步起点，结果带回回炉字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({
        replies: [
          editTo("bug", "w1"),
          { text: "好了" },
          editTo("w1", "w2"),
          { text: "好了" },
          editTo("w2", "w3"),
          { text: "好了" },
          editTo("w3", "w4"),
          { text: "好了" },
        ],
      }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS.full,
        target: { container: "box", root: ws.containerRoot },
        verify: { command: "grep -qx fixed a.txt", timeoutMs: 60_000 },
      })
    );
    assert.deepEqual(out.repair, {
      rounds: 3,
      finalVerdict: "fail",
      reverted: true,
      budgetExhausted: false,
    });
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "bug\n");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：不开回炉的条件不验证、不撤回，结果不带回炉字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({ replies: [editTo("bug", "w1"), { text: "好了" }] }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["no-gate"],
        target: { container: "box", root: ws.containerRoot },
        verify: { command: "grep -qx fixed a.txt", timeoutMs: 60_000 },
      })
    );
    assert.equal(out.repair, null);
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "w1\n");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：完整条件接入结构化记忆（开启、按题面与报错正常挑选），去掉记忆的条件关闭", async () => {
  const seen: Record<string, { enabled: boolean; selection: string } | undefined> = {};
  for (const condition of ["full", "no-memory"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    const ws = containerWorkspace(dir);
    try {
      const agent = pigeonStepAgent({
        streamFn: createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] }),
        yolo: true,
        docker: ws.docker,
        homeDir: join(dir, "home"),
      });
      const workDir = join(dir, "job");
      const out = await agent.run(
        input(workDir, {
          condition: CONDITION_SPECS[condition],
          target: { container: "box", root: ws.containerRoot },
          verify: { command: "grep -qx fixed a.txt", timeoutMs: 60_000 },
        })
      );
      assert.equal(out.repair?.finalVerdict, "pass");
      const sessions = join(workDir, ".pigeon", "sessions");
      const [sessionId] = listSessionIds(sessions);
      assert.ok(sessionId !== undefined);
      const memory = materializeSession(sessions, sessionId, { content: false }).runStarteds[0]
        ?.payload.structuredMemory;
      seen[condition] =
        memory === undefined ? undefined : { enabled: memory.enabled, selection: memory.selection };
    } finally {
      ws.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
  assert.deepEqual(seen.full, { enabled: true, selection: "auto" });
  assert.notEqual(seen["no-memory"]?.enabled, true);
});
