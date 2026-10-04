// 外部 agent 条件（真容器，实验设施）：用仓库里的假启动器（stream-fixtures/fake-external-agent）在实验镜像的作业容器里
// 跑完整一步——作业容器接只通网关的跑批内部网络、只读挂载工具目录；启动器经网关（假上游）发一次请求、改工作区、写结果
// 与产物；跑批器拷出产物、按网关请求数记轮数、把 report 记进结果行、提取改动时排除配置里的路径（其中的嵌套 git 工作树
// 不进 diff，别处的改动照常进），再照常判题。另测墙钟到点被杀、按超时记，以及启动命令 --identity 的自报。
// 需要真 docker 与实验镜像（服务器上都有），本机缺一即跳过。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createGatewayNetwork, removeGatewayNetwork } from "./gateway-network.ts";
import { startModelGateway } from "./model-gateway.ts";
import { LimitController } from "./model-limits.ts";
import { REAL_IMAGE, realDockerSkip } from "./real-docker-fixtures.ts";
import {
  type ExternalAgentConfig,
  externalConditionSpec,
  externalContainerArgs,
  externalStepAgent,
  selfReportOf,
} from "./stream-external.ts";
import { gitHumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { composeStreamManifest } from "./stream-manifest.ts";
import { readStreamResults } from "./stream-results.ts";
import { dockerStreamEnvs, ReferenceCases, runStreams } from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { toyRepo, toyRuntime } from "./stream-toy-fixtures.ts";

const TOOL_DIR = fileURLToPath(new URL("./stream-fixtures/fake-external-agent", import.meta.url));

const fakeConfig = (mode: string): ExternalAgentConfig => ({
  name: "fake",
  toolDir: TOOL_DIR,
  command: ["/usr/bin/env", "node", "/opt/pigeon-agent/launch.mjs"],
  excludePaths: [".agent-state"],
  env: { FAKE_EXTERNAL_MODE: mode },
});

// 一道题的人的仓库：起点只有 base；题为新建 src/a.txt（alpha）并带测试
async function oneTaskToy(base: string) {
  const dir = join(base, "human");
  const commit = toyRepo(dir);
  const start = commit(
    { "src/base.txt": "base\n", "src/base.test.sh": "grep -q base src/base.txt\n" },
    "Start"
  );
  const task = commit(
    {
      "src/a.txt": "alpha\n",
      "src/a.test.sh": `[ -f src/a.txt ] || { echo "Cannot find module 'src/a.txt'"; exit 1; }\ngrep -q alpha src/a.txt\n`,
    },
    "Add alpha\n\nCreate src/a.txt"
  );
  const human = gitHumanRepo(dir);
  const facts = human.firstParentLog(start, task).map((c) => ({
    sha: c.sha,
    parent: c.parent,
    subject: c.message.split("\n")[0] ?? "",
    message: c.message,
    files: human.changes(c.parent, c.sha),
  }));
  const manifest = composeStreamManifest({
    profile: toyRuntime.profile,
    rangeStart: start,
    commits: facts.map((f) => ({
      ...f,
      ...(f.sha === task ? { probe: { parentFails: true, commitPasses: true } } : {}),
    })),
    readHumanFile: (sha, path) => human.show(sha, path).toString("utf8"),
  });
  const refRoot = join(base, "ref");
  mkdirSync(refRoot);
  const referenceWs = new ReferenceWorkspace(localStreamShell(refRoot));
  await referenceWs.init(human.bundle(task), task);
  const reference = new ReferenceCases({
    reference: referenceWs,
    runtime: toyRuntime,
    human,
    cacheDir: join(base, "reference-cache"),
    image: "test-image",
  });
  return { human, manifest, reference };
}

// 假上游：记下收到的请求体，回一个带用量的 200
async function fakeUpstream() {
  const bodies: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"content":[],"usage":{"input_tokens":5,"output_tokens":7}}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function runOneStep(mode: string, wallClockMs: number, graceMs: number) {
  const base = mkdtempSync(join(tmpdir(), "pigeon-ext-docker-"));
  const prefix = `pigeon-ext-test-${process.pid}-${mode}`;
  const up = await fakeUpstream();
  const limits = new LimitController({
    probe: async () => true,
    slots: 2,
    sleep: () => new Promise(() => {}),
    warn: () => {},
  });
  const gateway = await startModelGateway({
    upstreamBaseUrl: up.url,
    // 本批的模型：外部条件的请求逐字转发，网关只读地核对 model（假启动器发的就是这个）
    model: "deepseek-flash",
    accounts: [{ key: "key-one", concurrency: 2 }],
    limits,
    probeRequest: { path: "/v1/messages", body: { max_tokens: 1 } },
    warn: () => {},
  });
  const network = await createGatewayNetwork(prefix);
  try {
    await gateway.listenInternal(network.hostAddress);
    const toy = await oneTaskToy(base);
    const config = fakeConfig(mode);
    const outDir = join(base, "out");
    await runStreams({
      manifest: toy.manifest,
      runtime: toyRuntime,
      human: toy.human,
      envs: dockerStreamEnvs({
        image: REAL_IMAGE,
        human: toy.human,
        prefix,
        conditionArgs: (c) =>
          c === "ext-fake" ? externalContainerArgs(config, network.name) : undefined,
        log: () => {},
      }),
      agents: { "ext-fake": externalStepAgent({ config, model: "deepseek-flash", graceMs }) },
      conditionSpecs: { "ext-fake": externalConditionSpec(config) },
      reference: toy.reference,
      outDir,
      conditions: ["ext-fake"],
      budget: { maxTurns: 5, wallClockMs },
      harnessRef: { commit: "test", dirty: false },
      gateway,
      limits,
      prefetchEnvs: false,
      log: () => {},
    });
    const rows = readStreamResults(join(outDir, "results.jsonl"));
    return { base, outDir, rows, upstreamBodies: [...up.bodies] };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  } finally {
    await removeGatewayNetwork(network.name).catch(() => {});
    await gateway.close();
    limits.close();
    await up.close();
  }
}

test.skipIf(realDockerSkip())(
  "外部 agent 条件（真容器）：完整一步——经网关发请求、写结果与产物并拷出、report 进结果行、排除路径不进 diff、照常判题",
  { timeout: 900_000 },
  async () => {
    const { base, outDir, rows, upstreamBodies } = await runOneStep("work", 120_000, 30_000);
    try {
      assert.equal(rows.length, 1, JSON.stringify(rows));
      const row = rows[0];
      assert.ok(row !== undefined);
      assert.equal(row.condition, "ext-fake");
      assert.equal(row.status, "completed");
      // 轮数取网关请求数（启动器自报的 turns 不用）
      assert.equal(row.turns, 1);
      assert.equal(row.usage.input, 5);
      assert.equal(row.agentReport?.fake, true);
      assert.equal(row.agentReport?.httpStatus, 200);
      assert.equal(row.agentReport?.cwd, "/testbed");
      // 外部条件的作业地址上请求体逐字到达上游（带 custom 工具、未知字段 output_config 与非规整空白，一字不改）
      assert.equal(upstreamBodies.length, 1);
      const sent = readFileSync(
        join(
          outDir,
          "streams",
          "tasks-ext-fake-1",
          "external",
          `step-${row.seq}`,
          "try-1",
          "io",
          "artifacts",
          "sent-body.json"
        ),
        "utf8"
      );
      assert.match(sent, /"type":"custom"/);
      assert.equal(upstreamBodies[0], sent);
      // 别处的改动照常进 diff、照常判题；排除路径（含其中的嵌套 git 工作树）不进 diff
      assert.equal(row.outcome, "passed");
      const diff = readFileSync(join(outDir, row.diff ?? ""), "utf8");
      assert.match(diff, /src\/a\.txt/);
      assert.doesNotMatch(diff, /\.agent-state/);
      // 产物按步与尝试拷出
      const tryDir = join(
        outDir,
        "streams",
        "tasks-ext-fake-1",
        "external",
        `step-${row.seq}`,
        "try-1"
      );
      // 容器里的请求目录拷到 io/ 下（不可信）；请求文件另由宿主写一份可信副本在 try 目录
      assert.ok(existsSync(join(tryDir, "io", "result.json")), "结果文件拷出");
      assert.ok(existsSync(join(tryDir, "io", "request.json")), "容器里的请求文件拷出");
      assert.match(
        readFileSync(join(tryDir, "io", "artifacts", "trace.txt"), "utf8"),
        /cwd=\/testbed marker=pigeon-step-/
      );
      const request = JSON.parse(readFileSync(join(tryDir, "request.json"), "utf8"));
      assert.deepEqual(
        request,
        JSON.parse(readFileSync(join(tryDir, "io", "request.json"), "utf8"))
      );
      assert.deepEqual(Object.keys(request).sort(), [
        "directive",
        "maxTurns",
        "model",
        "modelBaseUrl",
        "prompt",
        "root",
        "stepMarker",
        "wallClockMs",
      ]);
      assert.match(
        request.modelBaseUrl,
        /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/j\/[^/]+\/[0-9a-f]{32}$/
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test.skipIf(realDockerSkip())(
  "外部 agent 条件（真容器）：墙钟到点即杀掉 docker exec 与容器里的进程，按超时记",
  { timeout: 900_000 },
  async () => {
    const { base, outDir, rows } = await runOneStep("hang", 2_000, 2_000);
    try {
      assert.equal(rows.length, 1, JSON.stringify(rows));
      const row = rows[0];
      assert.equal(row?.status, "wall-clock-limit");
      assert.equal(row?.hitStepBudget, true);
      assert.ok((row?.agentWallMs ?? 0) >= 4_000 && (row?.agentWallMs ?? 0) < 60_000);
      const tryDir = join(
        outDir,
        "streams",
        "tasks-ext-fake-1",
        "external",
        `step-${row?.seq}`,
        "try-1"
      );
      assert.ok(
        existsSync(join(tryDir, "io", "artifacts", "started.txt")),
        "被杀之前写的产物照样拷出"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
);

test.skipIf(realDockerSkip())(
  "外部 agent 条件（真容器）：启动命令 --identity 自报的版本",
  { timeout: 300_000 },
  async () => {
    const reported = await selfReportOf(fakeConfig("work"), {
      image: REAL_IMAGE,
      container: `pigeon-ext-identity-test-${process.pid}`,
    });
    assert.deepEqual(reported, { name: "fake-external-agent", version: "1.0.0" });
  }
);
