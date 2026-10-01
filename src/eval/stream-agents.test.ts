import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { TIMEOUT_PROBE_SCRIPT } from "../execution/container-host.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { listSessionFiles } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, createGate, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { GatewayMeter } from "./model-gateway.ts";
import {
  clearMarkedProcesses,
  commandStepAgent,
  pigeonStepAgent,
  STREAM_WORK_DIRECTIVE,
  streamTemperature,
} from "./stream-agents.ts";
import { STRANDS_JUDGE_HYGIENE } from "./stream-profiles.ts";
import type { StepAgentInput } from "./stream-runner.ts";
import { CONDITION_SPECS } from "./stream-runner.ts";
import { dockerStreamShell, StreamWorkspace } from "./stream-workspace.ts";

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
    // 墙钟给宽：机器负载高时回炉几轮的用例也跑得完；要测预算的用例显式给预算
    budget: { maxTurns: 150, wallClockMs: 600_000 },
    verify: { steps: [{ name: "验证", command: "true" }], command: "true", timeoutMs: 60_000 },
    workDir,
    ...overrides,
  };
}

// 假 docker：不管参数，清理残留进程时一律回报"这一轮找到 0 个"（本机没有这些用例用的容器）
const NO_RESIDUE = [process.execPath, "-e", "process.stdout.write('0\\n')"];

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
    const agent = commandStepAgent({ command: [process.execPath, launcher], docker: NO_RESIDUE });
    const out = await agent.run(input(dir));
    assert.deepEqual(
      [out.status, out.turns, out.usage.totalTokens, out.usage.input, out.repair],
      ["completed", 10, 10, 7, null]
    );
    const { stepMarker, ...request } = JSON.parse(
      readFileSync(join(dir, "minimal", "step-7", "request.json"), "utf8")
    );
    assert.match(stepMarker, /^pigeon-step-[0-9a-f]{16}$/);
    assert.deepEqual(request, {
      prompt: "do it",
      directive: STREAM_WORK_DIRECTIVE,
      container: "box",
      root: "/testbed",
      maxTurns: 150,
      wallClockMs: 600_000,
      docker: NO_RESIDUE,
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
    const slow = commandStepAgent({
      command: [process.execPath, hang],
      graceMs: 0,
      docker: NO_RESIDUE,
    });
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
    const interrupted = await commandStepAgent({
      command: [process.execPath, cut],
      docker: NO_RESIDUE,
    }).run(input(dir));
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
    const agent = commandStepAgent({
      command: [process.execPath, hang],
      limits,
      docker: NO_RESIDUE,
    });
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

test("命令式 agent：这一步在容器里启动的进程都带本步标记，启动器结束（含被杀）后按标记清掉、确认没有残留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    // 假 docker：记下每次调用的参数；清理脚本的输出为"还剩几个"，这里恒为 0
    const log = join(dir, "docker.log");
    const fakeDocker = join(dir, "docker.mjs");
    writeFileSync(
      fakeDocker,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'process.stdout.write("0\\n");',
      ].join("\n")
    );
    const done = join(dir, "done.mjs");
    writeFileSync(
      done,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[3], JSON.stringify({ status: 'completed', turns: 1 }));",
      ].join("\n")
    );
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    const docker = [process.execPath, fakeDocker];
    const request = () =>
      JSON.parse(readFileSync(join(dir, "minimal", "step-7", "request.json"), "utf8")) as {
        stepMarker: string;
      };
    const cleanups = () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[])
        .filter((a) => a[0] === "exec");
    // 正常结束
    await commandStepAgent({ command: [process.execPath, done], docker }).run(input(dir));
    const first = request().stepMarker;
    assert.match(first, /^pigeon-step-/);
    assert.ok(cleanups().some((a) => a.includes("box") && a.includes(first)));
    // 墙钟用满被杀：同样清理，且换了新的标记
    const before = cleanups().length;
    await commandStepAgent({ command: [process.execPath, hang], docker, graceMs: 0 }).run(
      input(dir, { budget: { maxTurns: 1, wallClockMs: 300 } })
    );
    const second = request().stepMarker;
    assert.notEqual(second, first);
    assert.ok(
      cleanups()
        .slice(before)
        .some((a) => a.includes(second))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令式 agent：容器里带本步标记的进程清不净（每轮都还有，或清理命令本身失败）即报被打断，这一步作废、不交判题", async () => {
  for (const [what, script] of [
    ["每轮都还剩一个", 'process.stdout.write("1\\n");'],
    ["清理命令失败", "process.exit(1);"],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    try {
      const log = join(dir, "docker.log");
      const fakeDocker = join(dir, "docker.mjs");
      writeFileSync(
        fakeDocker,
        [
          'import { appendFileSync } from "node:fs";',
          `appendFileSync(${JSON.stringify(log)}, "x\\n");`,
          script,
        ].join("\n")
      );
      const done = join(dir, "done.mjs");
      writeFileSync(
        done,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.argv[3], JSON.stringify({ status: 'completed', turns: 1 }));",
        ].join("\n")
      );
      const out = await commandStepAgent({
        command: [process.execPath, done],
        docker: [process.execPath, fakeDocker],
      }).run(input(dir));
      assert.equal(out.status, "aborted", what);
      assert.match(out.interrupted ?? "", /清理不净/, what);
      const rounds = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "").length;
      assert.equal(rounds, what === "清理命令失败" ? 1 : 5, `${what}：清理的轮数`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("命令式 agent：启动器的环境里没有密钥类变量（真 key 只在网关里），普通变量照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const planted = {
    KIMI_API_KEY: "secret-one",
    KIMI_API_KEY_2: "secret-two",
    ANTHROPIC_API_KEY: "secret-three",
    SOME_SERVICE_TOKEN: "secret-four",
    PIGEON_TEST_PLAIN: "plain",
  };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    const dump = join(dir, "dump.mjs");
    writeFileSync(
      dump,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.argv[3], JSON.stringify({ status: 'completed', turns: 1, env: process.env }));",
      ].join("\n")
    );
    await commandStepAgent({ command: [process.execPath, dump], docker: NO_RESIDUE }).run(
      input(dir)
    );
    const seen = JSON.parse(
      readFileSync(join(dir, "minimal", "step-7", "result.json"), "utf8")
    ) as { env: Record<string, string> };
    const names = Object.keys(seen.env);
    for (const secret of [
      "KIMI_API_KEY",
      "KIMI_API_KEY_2",
      "ANTHROPIC_API_KEY",
      "SOME_SERVICE_TOKEN",
    ])
      assert.ok(!names.includes(secret), `${secret} 不应进入启动器的环境`);
    assert.ok(!JSON.stringify(seen.env).includes("secret-"), "任何变量的值里都不带密钥");
    assert.equal(seen.env.PIGEON_TEST_PLAIN, "plain");
    assert.ok(names.some((n) => n.toUpperCase() === "PATH"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("命令式 agent：状态没变、只来了限额信号（例如整批暂停后账号随即恢复，看守读到的状态仍是运行）也立即杀掉启动器，由订阅通知、不等轮询", async () => {
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
    const agent = commandStepAgent({
      command: [process.execPath, hang],
      limits,
      graceMs: 0,
      docker: NO_RESIDUE,
    });
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

test("命令式 agent：跑批器按步中止（本作业排队超时等）与限额信号同一条路径——立即杀掉启动器、清掉容器里的进程，报被打断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  try {
    const hang = join(dir, "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    const agent = commandStepAgent({
      command: [process.execPath, hang],
      limits: { state: "running", signals: 0 },
      graceMs: 0,
      docker: NO_RESIDUE,
    });
    const stepAbort = new AbortController();
    setTimeout(() => stepAbort.abort(), 200);
    const started = Date.now();
    const out = await agent.run(
      input(dir, { budget: { maxTurns: 1, wallClockMs: 30_000 }, abortSignal: stepAbort.signal })
    );
    assert.equal(out.interrupted, "跑批器按步中止（排队超时等）：最简 agent 已中止");
    assert.ok(Date.now() - started < 20_000, "不等墙钟用满");
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

// a.txt 为 fixed 才通过的一步验证
const FIXED_GATE = {
  steps: [{ name: "验证", command: "grep -qx fixed a.txt" }],
  command: "grep -qx fixed a.txt",
  timeoutMs: 60_000,
};

const editTo = (from: string, to: string) => ({
  text: `把 ${from} 改成 ${to}`,
  toolCalls: [
    { name: "edit_file", args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` } },
  ],
});

test("Pigeon agent：开回炉的条件按分步验证在容器里回炉，修满轮数仍失败即以失败收尾、容器工作区保留 agent 的改动，结果带回回炉字段", async () => {
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
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: FIXED_GATE,
      })
    );
    assert.deepEqual(out.repair, { rounds: 3, finalVerdict: "fail" });
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "w4\n");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：一步期间来了限额信号即中止在途的运行（不跑满、不验证、不回炉），报被打断交给跑批器作废重做", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const gate = createGate();
    const inner = createFakeStreamFn({
      replies: [{ text: "还在想", chunkSize: 1, chunkGate: gate }, editTo("bug", "fixed")],
    });
    let started: () => void = () => {};
    const firstCall = new Promise<void>((r) => {
      started = r;
    });
    const streamFn: StreamFn = (model, context, opts) => {
      started();
      return inner(model, context, opts);
    };
    // 假的限额控制器：只有状态、信号计数与订阅
    const listeners = new Set<() => void>();
    const limits = {
      state: "running",
      signals: 0,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const agent = pigeonStepAgent({
      streamFn,
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
      limits,
    });
    const running = agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: {
          steps: [{ name: "验证", command: "touch verified.flag; exit 1" }],
          command: "touch verified.flag; exit 1",
          timeoutMs: 60_000,
        },
      })
    );
    await firstCall;
    // 模型还在回复（被门闩卡住）时来了限额信号
    limits.signals += 1;
    for (const l of [...listeners]) l();
    gate.open();
    const out = await running;
    assert.equal(out.status, "aborted");
    assert.match(out.interrupted ?? "", /限额信号/);
    assert.equal(out.repair, null);
    assert.equal(inner.calls.length, 1, "中止后不再请求模型");
    assert.equal(existsSync(join(ws.testbed, "verified.flag")), false, "不验证");
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "bug\n");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

// 计数的模型接入：记下每次请求带给模型的工具名、同时在途的请求数峰值；每次请求至少在途 20 毫秒，并行的请求必然重叠
function countingStreamFn(inner: StreamFn) {
  const seen = { calls: 0, inFlight: 0, peak: 0, tools: new Set<string>() };
  const fn: StreamFn = async (model, context, options) => {
    seen.calls += 1;
    seen.inFlight += 1;
    seen.peak = Math.max(seen.peak, seen.inFlight);
    for (const tool of context.tools ?? []) seen.tools.add(tool.name);
    await new Promise((r) => setTimeout(r, 20));
    const stream = await inner(model, context, options);
    void stream.result().finally(() => {
      seen.inFlight -= 1;
    });
    return stream;
  };
  return { fn, seen };
}

// Pigeon 条件的工具清单（跑批不给 skill、不配 MCP）：没有派生子 agent 或 worker 的工具；能检索历史会话的格子多两件
// 检索工具（193），推送格多记忆工具（217）
const PIGEON_STREAM_TOOLS = {
  "search-push": [
    "edit_file",
    "read_file",
    "read_session_entry",
    "run_command",
    "search_sessions",
    "update_memory",
  ],
  "search-only": ["edit_file", "read_file", "read_session_entry", "run_command", "search_sessions"],
  "push-only": ["edit_file", "read_file", "run_command", "update_memory"],
  neither: ["edit_file", "read_file", "run_command"],
} as const;

for (const condition of ["search-push", "search-only", "push-only", "neither"] as const) {
  test(`Pigeon agent（${condition}）：一步之内同时在途的模型请求至多 1 个（含一轮多个工具调用与回炉），工具清单里没有派生 agent 或 worker 的工具，会话检索工具随条件的开关增减`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    const ws = containerWorkspace(dir);
    try {
      const counting = countingStreamFn(
        createFakeStreamFn({
          replies: [
            {
              text: "",
              toolCalls: [
                { name: "read_file", args: { path: "a.txt" } },
                {
                  name: "edit_file",
                  args: { path: "a.txt", old_string: "bug\n", new_string: "w1\n" },
                },
              ],
            },
            { text: "好了" },
            editTo("w1", "w2"),
            { text: "好了" },
            editTo("w2", "w3"),
            { text: "好了" },
            editTo("w3", "w4"),
            { text: "好了" },
          ],
        })
      );
      const agent = pigeonStepAgent({
        streamFn: counting.fn,
        yolo: true,
        docker: ws.docker,
        homeDir: join(dir, "home"),
      });
      await agent.run(
        input(join(dir, "job"), {
          condition: CONDITION_SPECS[condition],
          target: { container: "box", root: ws.containerRoot },
          verify: FIXED_GATE,
        })
      );
      // 四格都开回炉：修满 3 轮；推送格另有一次收尾复盘（复盘沿用同一套工具定义）
      assert.equal(
        counting.seen.calls,
        CONDITION_SPECS[condition].pushedMemory ? 9 : 8,
        "四格都开回炉：修满 3 轮"
      );
      assert.equal(counting.seen.peak, 1);
      assert.deepEqual([...counting.seen.tools].sort(), PIGEON_STREAM_TOOLS[condition]);
    } finally {
      ws.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
}

test("Pigeon agent：开工前已来了限额信号（起点记好之后、第一轮之前）即一轮都不跑；验证进行中来了信号，验证一结束即停、不再回炉", async () => {
  // 开工前：控制器已是暂停状态
  {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    const ws = containerWorkspace(dir);
    try {
      const inner = createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] });
      const agent = pigeonStepAgent({
        streamFn: inner,
        yolo: true,
        docker: ws.docker,
        homeDir: join(dir, "home"),
        limits: { state: "paused", signals: 1 },
      });
      const out = await agent.run(
        input(join(dir, "job"), {
          condition: CONDITION_SPECS["search-only"],
          target: { container: "box", root: ws.containerRoot },
          verify: FIXED_GATE,
        })
      );
      assert.equal(out.status, "aborted");
      assert.match(out.interrupted ?? "", /限额信号/);
      assert.equal(inner.calls.length, 0, "一轮都没跑");
    } finally {
      ws.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
  // 验证进行中：第 2 次验证（后面还能回炉）与第 4 次验证（修满 3 轮后的最后一次，不过即以失败收尾）
  for (const at of [2, 4]) {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    const ws = containerWorkspace(dir);
    try {
      // 每轮都改错；中止在第 at 次验证中途到达
      const inner = createFakeStreamFn({
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
      });
      const listeners = new Set<() => void>();
      const limits = {
        state: "running",
        signals: 0,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const agent = pigeonStepAgent({
        streamFn: inner,
        yolo: true,
        docker: ws.docker,
        homeDir: join(dir, "home"),
        limits,
      });
      const counter = join(ws.testbed, ".git", "verify-count");
      const running = agent.run(
        input(join(dir, "job"), {
          condition: CONDITION_SPECS["search-only"],
          target: { container: "box", root: ws.containerRoot },
          verify: {
            steps: [
              {
                name: "验证",
                command: "echo x >> .git/verify-count; sleep 2; grep -qx fixed a.txt",
              },
            ],
            command: "echo x >> .git/verify-count; sleep 2; grep -qx fixed a.txt",
            timeoutMs: 60_000,
          },
        })
      );
      const verifies = () =>
        existsSync(counter)
          ? readFileSync(counter, "utf8")
              .split("\n")
              .filter((l) => l).length
          : 0;
      while (verifies() < at) await new Promise((r) => setTimeout(r, 50));
      limits.signals += 1;
      for (const l of [...listeners]) l();
      const out = await running;
      assert.equal(out.status, "aborted");
      assert.match(out.interrupted ?? "", /限额信号/);
      assert.equal(verifies(), at, `第 ${at} 次：验证之后没有再回炉、再验证`);
      assert.equal(inner.calls.length, 2 * at, `第 ${at} 次：没有再调模型`);
      assert.equal(out.repair, null);
      assert.equal(
        readFileSync(join(ws.testbed, "a.txt"), "utf8"),
        `w${at}\n`,
        `第 ${at} 次：工作区是 agent 改到的样子（由跑批器作废）`
      );
    } finally {
      ws.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
});

test("Pigeon agent：每步开工时的树建了引用（挂在起点提交之下、含未提交的人写测试），回炉验证前按它还原受保护的文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    // 开工时有未提交的人写测试：开工时的树因此是挂在起点提交下的独立提交
    writeFileSync(join(ws.testbed, "check.sh"), "grep -qx fixed a.txt\n");
    const startCommit = git(ws.testbed, "rev-parse", "HEAD");
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: FIXED_GATE,
      })
    );
    // 开工时的树只记在引用上（Run 开始条目不再带它）：引用指向挂在起点提交之下的提交，树里有未提交的人写测试
    const ref = "refs/pigeon/step-start/s1/7";
    const recorded = git(ws.testbed, "rev-parse", ref);
    assert.equal(git(ws.testbed, "cat-file", "-t", recorded), "commit");
    assert.notEqual(recorded, startCommit);
    assert.equal(git(ws.testbed, "rev-parse", `${recorded}^`), startCommit);
    assert.equal(git(ws.testbed, "show", `${recorded}:check.sh`), "grep -qx fixed a.txt");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：每次回炉验证之前删掉 agent 放的、覆盖人写测试的 conftest——验证照样失败，修满轮数后以失败收尾", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws.testbed });
  mkdirSync(join(ws.testbed, "tests"));
  writeFileSync(join(ws.testbed, "tests", "check.sh"), "grep -qx fixed a.txt\n");
  git("add", "-A");
  git("commit", "-q", "-m", "human test");
  // agent 每轮都放一个让 sh 恒成功的 conftest（相当于把失败的用例跳过），再把代码改错
  const cheat = (from: string, to: string) => ({
    text: "放 conftest",
    toolCalls: [
      {
        name: "run_command",
        args: { command: "printf 'sh() { return 0; }\\n' > tests/conftest.sh" },
      },
      {
        name: "edit_file",
        args: { path: "a.txt", old_string: `${from}\n`, new_string: `${to}\n` },
      },
    ],
  });
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({
        replies: [
          cheat("bug", "w1"),
          { text: "好了" },
          cheat("w1", "w2"),
          { text: "好了" },
          cheat("w2", "w3"),
          { text: "好了" },
          cheat("w3", "w4"),
          { text: "好了" },
        ],
      }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    const load = "[ -f tests/conftest.sh ] && . ./tests/conftest.sh; sh tests/check.sh";
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: { steps: [{ name: "测试", command: load }], command: load, timeoutMs: 60_000 },
        humanTestFiles: new Set(["tests/check.sh"]),
        autoloadedTestHelper: "conftest.sh",
        humanTests: ["tests/check.sh"],
      })
    );
    assert.deepEqual([out.repair?.rounds, out.repair?.finalVerdict], [3, "fail"]);
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：回炉验证之前删 conftest 与判题前同一口径——人在该步树里的（例如仓库根的 conftest，不属于测试文件）不删、不改", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws.testbed });
  mkdirSync(join(ws.testbed, "tests"));
  writeFileSync(join(ws.testbed, "tests", "check.sh"), "grep -qx fixed a.txt\n");
  writeFileSync(join(ws.testbed, "conftest.sh"), "# human hooks\n");
  git("add", "-A");
  git("commit", "-q", "-m", "human files");
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    const load = "sh tests/check.sh";
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: { steps: [{ name: "测试", command: load }], command: load, timeoutMs: 60_000 },
        humanTestFiles: new Set(["tests/check.sh"]),
        autoloadedTestHelper: "conftest.sh",
        humanTests: ["tests/check.sh"],
        humanTree: ["a.txt", "conftest.sh", "tests/check.sh"],
      })
    );
    assert.equal(out.repair?.finalVerdict, "pass");
    assert.equal(
      readFileSync(join(ws.testbed, "conftest.sh"), "utf8"),
      "# human hooks\n",
      "人写的根 conftest 还在"
    );
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：验证前把人写测试还原成开工时的版本——agent 改测试断言让它在自己的代码上通过，验证照样失败，修满轮数后以失败收尾，结果记下还原次数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  // 跑批器在开工前预置的人写测试（未提交）：a.txt 须为 fixed
  const check = "grep -qx fixed a.txt\n";
  writeFileSync(join(ws.testbed, "check.sh"), check);
  const loosen = {
    path: "check.sh",
    old_string: "grep -qx fixed a.txt\n",
    new_string: "grep -qx w1 a.txt\n",
  };
  const cheat = { text: "改测试", toolCalls: [{ name: "edit_file", args: loosen }] };
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改代码也改测试",
            toolCalls: [
              {
                name: "edit_file",
                args: { path: "a.txt", old_string: "bug\n", new_string: "w1\n" },
              },
              { name: "edit_file", args: loosen },
            ],
          },
          { text: "好了" },
          cheat,
          { text: "好了" },
          cheat,
          { text: "好了" },
          cheat,
          { text: "好了" },
        ],
      }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
      humanTestFile: (file) => file === "check.sh",
    });
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: {
          steps: [{ name: "测试", command: "sh check.sh" }],
          command: "sh check.sh",
          timeoutMs: 60_000,
        },
      })
    );
    assert.deepEqual(out.repair, {
      rounds: 3,
      finalVerdict: "fail",
      humanTestRestores: 4,
    });
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "w1\n");
    assert.equal(readFileSync(join(ws.testbed, "check.sh"), "utf8"), check);
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：回炉验证前只还原并计数人在这一步的测试；agent 早先落地的自己的测试随它改，不还原、不计数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws.testbed });
  // 开工时已落地：人写的 check.sh 与 agent 早先步骤写的 agent_check.sh（按归类两者都是测试）
  writeFileSync(join(ws.testbed, "check.sh"), "grep -qx fixed a.txt\n");
  writeFileSync(join(ws.testbed, "agent_check.sh"), "grep -qx fixed a.txt\n");
  git("add", "-A");
  git("commit", "-q", "-m", "tests");
  try {
    const agent = pigeonStepAgent({
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "修代码，也改自己早先的测试",
            toolCalls: [
              {
                name: "edit_file",
                args: { path: "a.txt", old_string: "bug\n", new_string: "fixed\n" },
              },
              {
                name: "edit_file",
                args: {
                  path: "agent_check.sh",
                  old_string: "grep -qx fixed a.txt\n",
                  new_string: "grep -q fixed a.txt\n",
                },
              },
            ],
          },
          { text: "好了" },
        ],
      }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
      humanTestFile: (file) => file.endsWith("check.sh"),
    });
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: {
          steps: [{ name: "测试", command: "sh check.sh" }],
          command: "sh check.sh",
          timeoutMs: 60_000,
        },
        humanTestFiles: new Set(["check.sh"]),
      })
    );
    assert.equal(out.repair?.finalVerdict, "pass");
    assert.equal(out.repair?.humanTestRestores, 0);
    assert.equal(
      readFileSync(join(ws.testbed, "agent_check.sh"), "utf8"),
      "grep -q fixed a.txt\n",
      "agent 自己的测试保留它的改动"
    );
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：回炉轮数为 0 时不验证、不回炉，结果不带回炉字段", async () => {
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
        condition: { ...CONDITION_SPECS.neither, repairRounds: 0 },
        target: { container: "box", root: ws.containerRoot },
        verify: FIXED_GATE,
      })
    );
    assert.equal(out.repair, null);
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "w1\n");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：空回复异常结束不是模型服务故障——不报被打断（照常判题、不作废重做），也不再回炉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const streamFn = createFakeStreamFn({
      replies: [editTo("bug", "w1"), { text: "" }, { text: "" }, editTo("w1", "fixed")],
    });
    const agent = pigeonStepAgent({
      streamFn,
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: FIXED_GATE,
      })
    );
    assert.equal(out.status, "empty-reply");
    assert.equal(out.interrupted, undefined);
    assert.equal(streamFn.calls.length, 3);
    assert.deepEqual(out.repair, { rounds: 0, finalVerdict: "fail" });
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "w1\n");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：验证里检查工具自身崩溃（重跑一次仍崩溃）不判失败、不回炉，步结果带工具故障次数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const streamFn = createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] });
    const agent = pigeonStepAgent({
      streamFn,
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    });
    const steps = [
      { name: "验证", command: "grep -qx fixed a.txt" },
      { name: "mypy", command: "echo 'please use --show-traceback'; exit 2", tool: "mypy" },
    ];
    const out = await agent.run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: { steps, command: "[验证] …；[mypy] …", timeoutMs: 60_000 },
      })
    );
    assert.equal(streamFn.calls.length, 2, "不开回炉轮");
    assert.deepEqual(out.repair, { rounds: 0, finalVerdict: "pass", toolFaults: 1 });
    assert.equal(out.interrupted, undefined);
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：推送格打开推送记忆——系统提示带推送段（无人值守版）、带 update_memory，最后一次验证之后收尾复盘；复盘前后读网关计量，结果带复盘事实；不推送的格子都没有", async () => {
  for (const condition of ["search-push", "push-only", "neither"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    const ws = containerWorkspace(dir);
    try {
      const inner = createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] });
      const agent = pigeonStepAgent({
        streamFn: inner,
        yolo: true,
        docker: ws.docker,
        homeDir: join(dir, "home"),
      });
      // 假计量：请求数即模型请求次数，每次 0.01 元
      const meter = (): GatewayMeter => ({
        requests: inner.calls.length,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costCny: inner.calls.length / 100,
        upstreamFailures: 0,
        queueMs: 0,
        peakInFlight: 0,
        peakInputTokens: 0,
        accountRequests: [inner.calls.length],
      });
      const out = await agent.run(
        input(join(dir, "job"), {
          condition: CONDITION_SPECS[condition],
          target: { container: "box", root: ws.containerRoot },
          verify: FIXED_GATE,
          meter,
        })
      );
      assert.deepEqual(out.repair, { rounds: 0, finalVerdict: "pass" }, condition);
      const pushed = CONDITION_SPECS[condition].pushedMemory;
      const first = inner.calls[0];
      assert.ok(first !== undefined);
      assert.equal(
        first.context.systemPrompt?.includes("## 学到的记忆") === true,
        pushed,
        condition
      );
      assert.equal(
        first.context.systemPrompt?.includes("当前任务的要求与某条记忆冲突时") === true,
        false,
        "空记忆用没有条目的一版"
      );
      assert.equal(
        (first.context.tools ?? []).some((tool) => tool.name === "update_memory"),
        pushed,
        condition
      );
      if (pushed) {
        // 干活两次请求，收尾复盘一次
        assert.equal(inner.calls.length, 3, condition);
        assert.equal(out.review?.closing, 1);
        assert.equal(out.review?.preCompaction, 0);
        assert.deepEqual(out.review?.failures, []);
        assert.equal(out.review?.meter?.requests, 1);
        assert.equal(out.review?.meter?.costCny.toFixed(6), (0.01).toFixed(6));
      } else {
        assert.equal(inner.calls.length, 2, condition);
        assert.equal(out.review, undefined);
      }
    } finally {
      ws.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
});

// 分步验证用的小仓库：v.mjs <步名> 在本步执行目录下扫描 *.py 里每行 "# FAILS_UNLESS <文件> <标记> <测试名>"，
// <文件> 不含 <标记> 即该测试失败，只对"子测试"一步生效并按 pytest 短汇总报出；其余步一律通过
const STEPWISE_VERIFY_SCRIPT = String.raw`import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
const step = process.argv[2];
const root = process.cwd();
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".pigeon", "node_modules", "v.mjs"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(relative(root, full).split("\\").join("/"));
  }
};
walk(root);
const read = (file) => { try { return readFileSync(join(root, file), "utf8"); } catch { return ""; } };
const out = [];
if (step === "子测试") {
  const failing = [];
  for (const file of files.filter((name) => name.endsWith(".py"))) {
    for (const match of read(file).matchAll(/# FAILS_UNLESS (\S+) (\S+) (\S+)/g)) {
      if (!read(match[1]).includes(match[2])) failing.push({ file, name: match[3] });
    }
  }
  if (failing.length > 0) {
    out.push("=========================== short test summary info ============================");
    for (const test of failing) out.push("FAILED " + test.file + "::" + test.name + " - AssertionError: assert False");
    out.push("========================= " + failing.length + " failed, 1 passed in 0.10s =========================");
  }
}
process.stdout.write(out.join("\n") + (out.length > 0 ? "\n" : "一切正常\n"));
process.exit(out.length > 0 ? 1 : 0);
`;

function makeStepwiseRepo(files: Record<string, string>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-stepwise-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-stepwise-home-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pigeon@example.invalid"]);
  git(["config", "user.name", "pigeon-test"]);
  git(["config", "core.autocrlf", "false"]);
  write("v.mjs", STEPWISE_VERIFY_SCRIPT);
  write(".gitignore", ".pigeon/\n");
  for (const [file, content] of Object.entries(files)) write(file, content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

// 一次回复里的若干处替换编辑
function edits(...changes: Array<[path: string, from: string, to: string]>): FakeReply {
  return {
    text: "改一下",
    toolCalls: changes.map(([path, from, to]) => ({
      name: "edit_file",
      args: { path, old_string: from, new_string: to },
    })),
  };
}

const finished = (text = "好了"): FakeReply => ({ text });

test("Pigeon agent：分步验证原样接到 headless——三步在 strands-py 下各出结论；pytest 失败、回炉修好，回炉反馈按步列出", async () => {
  const repo = makeStepwiseRepo({
    "strands-py/src/pkg/mod.py": "VALUE = 1  # VALUE_OK\n",
    "strands-py/tests/test_mod.py":
      "# FAILS_UNLESS src/pkg/mod.py VALUE_OK test_value\ndef test_value():\n    pass\n",
  });
  const docker = localDockerHost(repo.root);
  const workDir = mkdtempSync(join(tmpdir(), "pigeon-stream-job-"));
  const node = `"${process.execPath}"`;
  const steps = ["格式", "类型", "子测试"].map((name) => ({
    name,
    command: `${node} ../v.mjs ${name}`,
    cwd: "strands-py",
  }));
  const verify = { command: "不应被用到的单条命令", steps, timeoutMs: 60_000 };
  const streamFn = createFakeStreamFn({
    replies: [
      edits(["strands-py/src/pkg/mod.py", "  # VALUE_OK", ""]),
      finished(),
      edits(["strands-py/src/pkg/mod.py", "VALUE = 1", "VALUE = 1  # VALUE_OK again"]),
      finished("修好了"),
    ],
  });
  const sessions = join(workDir, ".pigeon", "state", "sessions");
  try {
    const first = await pigeonStepAgent({
      streamFn,
      yolo: true,
      docker: docker.docker,
      homeDir: repo.home,
    }).run(
      input(workDir, {
        prompt: "以往的一步",
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: docker.containerRoot },
        verify,
      })
    );
    assert.deepEqual([first.repair?.rounds, first.repair?.finalVerdict], [1, "pass"]);
    const files = listSessionFiles(sessions);
    assert.equal(files.length, 1);
    const firstId = files[0]?.sessionId;
    assert.ok(firstId !== undefined);
    const verified = (loadStoreSession(sessions, firstId)?.view.verifications ?? []).map(
      (record) => record.data
    );
    assert.equal(verified.length, 2, "首轮与回炉一轮各一条验证记录");
    // 首轮三步各出结论，都在 strands-py 下执行
    assert.deepEqual(
      verified[0]?.steps?.map((s) => [s.name, s.cwd, s.verdict]),
      [
        ["格式", "strands-py", "pass"],
        ["类型", "strands-py", "pass"],
        ["子测试", "strands-py", "fail"],
      ]
    );
    // 回炉反馈按步列出：失败步与已通过步分开，附失败步的输出末尾，不是整条命令的输出截尾
    const feedback = JSON.stringify(streamFn.calls[2]?.context.messages.at(-1));
    assert.match(feedback, /失败的步骤：子测试/);
    assert.match(feedback, /已通过的步骤：格式、类型/);
    assert.match(feedback, /test_value/);
    assert.doesNotMatch(feedback, /验证命令：/);
  } finally {
    docker.cleanup();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    repo.cleanup();
  }
});

test("Pigeon agent：这一步在容器里执行的每条命令都带本步标记，步结束后按同一标记清理残留进程；清不净即报被打断，这一步作废", async () => {
  for (const [what, answer] of [
    ["清净了", "0"],
    ["每轮都还剩一个", "1"],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
    const ws = containerWorkspace(dir);
    try {
      // 包一层假 docker：记下每次调用的参数；清理命令固定回答 answer，其余转给本机假 docker
      const log = join(dir, "docker.log");
      const wrapper = join(dir, "docker-wrapper.mjs");
      writeFileSync(
        wrapper,
        [
          'import { appendFileSync } from "node:fs";',
          'import { spawnSync } from "node:child_process";',
          "const args = process.argv.slice(2);",
          `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
          `if (args.some((a) => a.includes("PIGEON_STEP_MARKER=$1"))) { process.stdout.write(${JSON.stringify(`${answer}\n`)}); process.exit(0); }`,
          `const r = spawnSync(${JSON.stringify(ws.docker[0])}, [${JSON.stringify(ws.docker[1])}, ...args], { stdio: "inherit" });`,
          "process.exit(r.status ?? 1);",
        ].join("\n")
      );
      const out = await pigeonStepAgent({
        streamFn: createFakeStreamFn({ replies: [editTo("bug", "fixed"), { text: "好了" }] }),
        yolo: true,
        docker: [process.execPath, wrapper],
        homeDir: join(dir, "home"),
      }).run(
        input(join(dir, "job"), {
          target: { container: "box", root: ws.containerRoot },
          verify: FIXED_GATE,
        })
      );
      const calls = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]);
      const kills = calls.filter((a) => a.some((x) => x.includes("PIGEON_STEP_MARKER=$1")));
      const marker = kills[0]?.at(-1) ?? "";
      assert.match(marker, /^pigeon-step-[0-9a-f]{16}$/, `${what}：清理按本步标记`);
      // 跑批器自己的收尾（清进程、清残留的 git 锁文件）与探测容器有无 timeout（决策 335）不算这一步执行的命令
      const work = calls.filter(
        (a) =>
          a[0] === "exec" &&
          !kills.includes(a) &&
          !a.some((x) => x.includes(".git/index.lock") || x.includes(TIMEOUT_PROBE_SCRIPT))
      );
      assert.ok(work.length > 0, `${what}：这一步在容器里执行过命令`);
      for (const a of work) {
        assert.ok(
          a.includes(`PIGEON_STEP_MARKER=${marker}`),
          `${what}：每条命令都带标记 ${a.join(" ")}`
        );
      }
      if (answer === "0") {
        assert.equal(out.status, "completed", what);
        assert.equal(out.interrupted, undefined, what);
        assert.equal(kills.length, 1, `${what}：一轮清净即停`);
      } else {
        assert.equal(out.status, "aborted", what);
        assert.match(out.interrupted ?? "", /清理不净/, what);
        assert.equal(kills.length, 5, `${what}：清理的轮数`);
      }
    } finally {
      ws.cleanup();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
});

test("Pigeon agent：每次回炉验证之前先按本步标记清一遍后台进程、删掉验证门的报告，步结束后再清一遍", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const log = join(dir, "docker.log");
    const wrapper = join(dir, "docker-wrapper.mjs");
    writeFileSync(
      wrapper,
      [
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
        'if (args.some((a) => a.includes("PIGEON_STEP_MARKER=$1"))) { process.stdout.write("0\\n"); process.exit(0); }',
        `const r = spawnSync(${JSON.stringify(ws.docker[0])}, [${JSON.stringify(ws.docker[1])}, ...args], { stdio: "inherit" });`,
        "process.exit(r.status ?? 1);",
      ].join("\n")
    );
    const out = await pigeonStepAgent({
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
      docker: [process.execPath, wrapper],
      homeDir: join(dir, "home"),
    }).run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: FIXED_GATE,
      })
    );
    assert.equal(out.repair?.rounds, 3);
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as string[]);
    const tag = (a: string[]) =>
      a.some((x) => x.includes("PIGEON_STEP_MARKER=$1"))
        ? "清"
        : a.some((x) => x.includes("grep -qx fixed a.txt"))
          ? "验"
          : a.some((x) => x.includes("/tmp/pigeon-gate-junit.xml"))
            ? "删报告"
            : null;
    const seq = calls.map(tag).filter((x) => x !== null);
    assert.deepEqual(
      seq,
      [
        "清",
        "删报告",
        "验",
        "清",
        "删报告",
        "验",
        "清",
        "删报告",
        "验",
        "清",
        "删报告",
        "验",
        "清",
      ],
      "每次验证之前先清进程、删报告，步结束后再清一遍"
    );
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：清完进程后容器里没有 git 进程在跑，就删掉残留的 .git/index.lock（agent 在途的 git 命令被杀时留下的）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const out = await pigeonStepAgent({
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "跑个命令",
            toolCalls: [{ name: "run_command", args: { command: "touch .git/index.lock" } }],
          },
          { text: "好了" },
        ],
      }),
      yolo: true,
      docker: ws.docker,
      homeDir: join(dir, "home"),
    }).run(
      input(join(dir, "job"), {
        condition: { ...CONDITION_SPECS.neither, repairRounds: 0 },
        target: { container: "box", root: ws.containerRoot },
      })
    );
    assert.equal(out.interrupted, undefined);
    assert.equal(existsSync(join(ws.testbed, ".git", "index.lock")), false);
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("Pigeon agent：回炉验证之前清进程清不净即中止这一步、一次验证都不跑，报被打断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-agent-"));
  const ws = containerWorkspace(dir);
  try {
    const log = join(dir, "docker.log");
    const wrapper = join(dir, "docker-wrapper.mjs");
    writeFileSync(
      wrapper,
      [
        'import { appendFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
        'if (args.some((a) => a.includes("PIGEON_STEP_MARKER=$1"))) { process.stdout.write("1\\n"); process.exit(0); }',
        `const r = spawnSync(${JSON.stringify(ws.docker[0])}, [${JSON.stringify(ws.docker[1])}, ...args], { stdio: "inherit" });`,
        "process.exit(r.status ?? 1);",
      ].join("\n")
    );
    const out = await pigeonStepAgent({
      streamFn: createFakeStreamFn({ replies: [editTo("bug", "w1"), { text: "好了" }] }),
      yolo: true,
      docker: [process.execPath, wrapper],
      homeDir: join(dir, "home"),
    }).run(
      input(join(dir, "job"), {
        condition: CONDITION_SPECS["search-only"],
        target: { container: "box", root: ws.containerRoot },
        verify: FIXED_GATE,
      })
    );
    assert.equal(out.status, "aborted");
    assert.match(out.interrupted ?? "", /清理不净/);
    const verified = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes("grep -qx fixed a.txt")).length;
    assert.equal(verified, 0, "一次验证都不跑");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

// 真 docker 与本仓库的流镜像：服务器上都有，本机或 CI 缺一即跳过
const REAL_IMAGE = "pigeon-stream-pigeon:v4";
function realDockerSkip(): string | false {
  try {
    execFileSync("docker", ["image", "inspect", REAL_IMAGE], { stdio: "ignore" });
    return false;
  } catch {
    return `没有 docker 或镜像 ${REAL_IMAGE}`;
  }
}

test("作业容器里清 agent 进程不看标记：用 env -u 起的后台进程照样清掉，init 与容器主命令不动、容器照常运行", {
  skip: realDockerSkip(),
}, async () => {
  const name = `pigeon-kill-test-${process.pid}`;
  const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();
  try {
    docker(
      "run",
      "-d",
      "--init",
      "--network",
      "none",
      "-e",
      "PIGEON_STREAM_CONTAINER=1",
      "--name",
      name,
      "--entrypoint",
      "tail",
      REAL_IMAGE,
      "-f",
      "/dev/null"
    );
    // 不带本步标记的后台进程
    docker("exec", "-d", name, "sh", "-c", "env -u PIGEON_STEP_MARKER sleep 1000");
    await new Promise((r) => setTimeout(r, 500));
    const sleeping = () =>
      docker("exec", name, "sh", "-c", 'for p in /proc/[0-9]*; do cat "$p/comm" 2>/dev/null; done')
        .split("\n")
        .filter((c) => c === "sleep").length;
    assert.equal(sleeping(), 1, "后台进程在跑");
    assert.equal(await clearMarkedProcesses(["docker"], name, "pigeon-step-x", "/testbed"), true);
    assert.equal(sleeping(), 0, "不带标记也清掉");
    assert.equal(docker("inspect", "-f", "{{.State.Running}}", name), "true", "容器照常运行");
  } finally {
    try {
      docker("rm", "-f", name);
    } catch {
      // 容器没起来
    }
  }
});

test("闸门：本机假 docker 下（不在作业容器里）清 agent 进程只清带本步标记的，不带标记的进程不动", async () => {
  if (process.env.PIGEON_STREAM_CONTAINER !== undefined) return;
  const dir = mkdtempSync(join(tmpdir(), "pigeon-stream-gate-"));
  const ws = containerWorkspace(dir);
  // 用例自己起的、不带标记的后台进程
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      await clearMarkedProcesses(ws.docker, "box", "pigeon-step-gate", ws.containerRoot),
      true
    );
    assert.equal(child.exitCode, null, "进程还在");
    assert.equal(child.signalCode, null, "没收到信号");
  } finally {
    child.kill();
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("作业容器里（真容器）：判题前删掉家目录下的用户级 site-packages 与静态检查配置；清 agent 进程时被 init 收养的孤儿进程照样清掉，主命令不动", {
  skip: realDockerSkip(),
}, async () => {
  const name = `pigeon-tmp-test-${process.pid}`;
  const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();
  try {
    docker(
      "run",
      "-d",
      "--init",
      "--network",
      "none",
      "-e",
      "PIGEON_STREAM_CONTAINER=1",
      "--name",
      name,
      "--entrypoint",
      "tail",
      REAL_IMAGE,
      "-f",
      "/dev/null"
    );
    // 家目录下 agent 放的用户级 site-packages（其中的 usercustomize 会在 Python 启动时被加载）与 mypy 用户级配置
    docker(
      "exec",
      name,
      "sh",
      "-c",
      'mkdir -p "$HOME/.local/lib/python3/site-packages" && echo x > "$HOME/.local/lib/python3/site-packages/usercustomize.py" && echo y > "$HOME/.mypy.ini"'
    );
    const ws = new StreamWorkspace(dockerStreamShell({ container: name, root: "/" }));
    await ws.clearHomePaths(STRANDS_JUDGE_HYGIENE.homePaths);
    assert.equal(
      docker(
        "exec",
        name,
        "sh",
        "-c",
        'if [ -e "$HOME/.local/lib" ] || [ -e "$HOME/.mypy.ini" ]; then echo left; else echo gone; fi'
      ),
      "gone",
      "家目录下 agent 放的用户级文件清掉"
    );
    // 孤儿进程：起它的 sh 退出后由 init 收养（父进程为 1）
    docker("exec", name, "sh", "-c", "sleep 1000 > /dev/null 2>&1 & exit 0");
    await new Promise((r) => setTimeout(r, 500));
    const sleeping = () =>
      docker("exec", name, "sh", "-c", 'for p in /proc/[0-9]*; do cat "$p/comm" 2>/dev/null; done')
        .split("\n")
        .filter((c) => c === "sleep").length;
    assert.equal(sleeping(), 1, "孤儿进程在跑");
    assert.equal(await clearMarkedProcesses(["docker"], name, "pigeon-step-x", "/"), true);
    assert.equal(sleeping(), 0, "孤儿进程清掉");
    assert.equal(docker("inspect", "-f", "{{.State.Running}}", name), "true", "主命令不动");
  } finally {
    try {
      docker("rm", "-f", name);
    } catch {
      // 容器没起来
    }
  }
});

test("Pigeon 条件的采样温度缺省固定为 0；显式给出的值原样沿用", () => {
  assert.equal(streamTemperature(undefined), 0);
  assert.equal(streamTemperature(0.4), 0.4);
});
