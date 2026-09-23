import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
    gateCommand: ["true"],
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
    assert.equal(out.interrupted, "限额暂停：最简 agent 已中止");
    assert.ok(out.wallMs < 30_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pigeon agent：开回炉的条件在回炉合入前明确报错，不假装能跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({ replies: [{ text: "不该被调用" }] }),
      yolo: true,
    });
    await assert.rejects(
      agent.run(input(dir, { condition: CONDITION_SPECS.full })),
      /回炉尚未合入/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
