import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  edits,
  finished,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "../application/structured-memory-fixtures.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { buildMemoryEntries, loadStructuredMemory } from "../memory/structured-store.ts";
import { hostWorkspaceAccess } from "../memory/structured-workspace.ts";
import { listSessionIds, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
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
      wallClockMs: 60_000,
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
        verify: FIXED_GATE,
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

test("Pigeon agent：验证前把人写测试还原成开工时的版本——agent 改测试断言让它在自己的代码上通过，验证照样失败，修满轮数后撤回，结果记下还原次数", async () => {
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
        condition: CONDITION_SPECS.full,
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
      reverted: true,
      budgetExhausted: false,
      humanTestRestores: 4,
    });
    assert.equal(readFileSync(join(ws.testbed, "a.txt"), "utf8"), "bug\n");
    assert.equal(readFileSync(join(ws.testbed, "check.sh"), "utf8"), check);
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
          verify: FIXED_GATE,
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

test("Pigeon agent：分步验证原样接到 headless——三步在 strands-py 下各出结论；pytest 失败、回炉修好，事实锚点带 strands-py/ 前缀，下一步开局挑中并在容器里核验通过", async () => {
  const repo = makeMemoryRepo({
    "strands-py/src/pkg/mod.py": "VALUE = 1  # VALUE_OK\n",
    "strands-py/tests/test_mod.py":
      "# FAILS_UNLESS src/pkg/mod.py VALUE_OK test_value\ndef test_value():\n    pass\n",
  });
  const docker = localDockerHost(repo.root);
  const workDir = mkdtempSync(join(tmpdir(), "pigeon-stream-job-"));
  const config = memoryVerifyConfig([
    { name: "格式", cwd: "strands-py" },
    { name: "类型", cwd: "strands-py" },
    { name: "子测试", cwd: "strands-py" },
  ]);
  const verify = { command: "不应被用到的单条命令", steps: config.steps ?? [], timeoutMs: 60_000 };
  const streamFns: ReturnType<typeof createFakeStreamFn>[] = [];
  const runStep = (prompt: string, replies: FakeReply[]) => {
    const streamFn = createFakeStreamFn({ replies });
    streamFns.push(streamFn);
    return pigeonStepAgent({
      streamFn,
      yolo: true,
      docker: docker.docker,
      homeDir: repo.home,
    }).run(
      input(workDir, {
        prompt,
        condition: CONDITION_SPECS.full,
        target: { container: "box", root: docker.containerRoot },
        verify,
      })
    );
  };
  const sessions = join(workDir, ".pigeon", "sessions");
  try {
    const first = await runStep("以往的一步", [
      edits(["strands-py/src/pkg/mod.py", "  # VALUE_OK", ""]),
      finished(),
      edits(["strands-py/src/pkg/mod.py", "VALUE = 1", "VALUE = 1  # VALUE_OK again"]),
      finished("修好了"),
    ]);
    assert.deepEqual([first.repair?.rounds, first.repair?.finalVerdict], [1, "pass"]);
    const [firstId] = listSessionIds(sessions);
    assert.ok(firstId !== undefined);
    const verified = materializeSession(sessions, firstId, { content: false }).attemptVerifieds;
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
    const feedback = JSON.stringify(streamFns[0]?.calls[2]?.context.messages.at(-1));
    assert.match(feedback, /失败的步骤：子测试/);
    assert.match(feedback, /已通过的步骤：格式、类型/);
    assert.match(feedback, /test_value/);
    assert.doesNotMatch(feedback, /验证命令：/);
    repo.commit("落地");
    const { facts } = loadStructuredMemory(workDir, {
      persist: false,
      accessFor: () => hostWorkspaceAccess(docker.host),
    });
    const onModule = buildMemoryEntries(facts).find(
      (entry) => entry.anchor === "strands-py/src/pkg/mod.py"
    );
    assert.ok(onModule !== undefined, "锚点带 strands-py/ 前缀");
    await runStep("修改 strands-py/src/pkg/mod.py", [finished("看过了")]);
    const nextId = listSessionIds(sessions).find((id) => id !== firstId);
    assert.ok(nextId !== undefined);
    const opening = materializeSession(sessions, nextId, { content: false }).runStarteds[0]?.payload
      .structuredMemory;
    assert.deepEqual(opening?.opening, [onModule.id]);
    assert.equal(opening?.openingBlocked, undefined);
  } finally {
    docker.cleanup();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    repo.cleanup();
  }
});
