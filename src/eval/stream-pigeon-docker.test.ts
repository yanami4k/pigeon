// pigeon-docker 条件（单元层，假 docker）：容器参数（网络、只读产物挂载、按作业读写挂载治理目录且与跑批器的会话
// 布局一致）、身份段逐项设置、一步的运行契约（提示拼装、环境映射、运行命令、终态判定、产物布局、墙钟与清理）。
// 真容器行为（挂载生效、会话跨题保留）在 stream-pigeon-docker-docker.test.ts（服务器上跑）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { projectPigeonDir, sessionsDirOf } from "../state/paths.ts";
import { STREAM_WORK_DIRECTIVE } from "./stream-agents.ts";
import {
  PIGEON_BUNDLE_MOUNT,
  PIGEON_DOCKER_CONDITION,
  PIGEON_GOV_ROOT,
  PIGEON_NODE_MOUNT,
  pigeonDockerContainerArgs,
  pigeonDockerIdentity,
  pigeonDockerJobContainerArgs,
  pigeonDockerStepAgent,
} from "./stream-pigeon-docker.ts";
import { CONDITION_SPECS, jobDirName, type StepAgentInput } from "./stream-runner.ts";

const TMP = mkdtempSync(path.join(tmpdir(), "pigeon-docker-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function withTmp(fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(TMP, "case-"));
    await fn(dir);
  };
}

// 假 docker：记下每次调用（参数与 stdin）；exec 按脚本内容分流——准备（写 prompt.txt 进镜像目录）、运行
// （按控制文件写出 result.json 或挂起）、清进程（印 0）；cp 把镜像目录拷到目标。控制文件为假 docker 旁的
// next-result.json（内容原样成为 result.json；内容为 "hang" 时运行挂起）
function fakeDocker(dir: string) {
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "calls.jsonl");
  const ioMirror = path.join(dir, "io-mirror");
  const script = path.join(dir, "fake-docker.mjs");
  writeFileSync(
    script,
    `
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const log = ${JSON.stringify(log)};
const ioMirror = ${JSON.stringify(ioMirror)};
const control = ${JSON.stringify(path.join(dir, "next-result.json"))};
const args = process.argv.slice(2);
let stdin = "";
if (args[0] === "exec" && args.includes("-i")) {
  stdin = readFileSync(0, "utf8");
}
appendFileSync(log, JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "cp") {
  mkdirSync(path.dirname(args[2]), { recursive: true });
  cpSync(ioMirror, args[2], { recursive: true });
  process.exit(0);
}
if (args[0] !== "exec") process.exit(0);
const scriptText = args.join("\\0");
if (scriptText.includes("PIGEON_STEP_MARKER=$1")) {
  process.stdout.write("0\\n");
  process.exit(0);
}
if (scriptText.includes("pigeon.mjs")) {
  const env = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") {
      const [k, v] = args[i + 1].split("=");
      env[k] = v;
    }
  }
  const mode = readFileSync(control, "utf8");
  if (mode.trim() === "hang") {
    // 模拟挂起的运行（墙钟路径用）：让子进程一直活着，由跑批器的看守杀掉（不得退出）
    setInterval(() => {}, 1000);
  } else {
    if (mode.trim() !== "") {
      writeFileSync(path.join(ioMirror, "result.json"), mode);
      writeFileSync(path.join(ioMirror, "run-env.json"), JSON.stringify(env));
    }
    process.exit(0);
  }
} else if (scriptText.includes("prompt.txt")) {
  // 准备脚本：写 prompt.txt（else if：运行脚本也引用 prompt.txt，挂起模式不得落进本分支）
  mkdirSync(path.join(ioMirror, "home"), { recursive: true });
  writeFileSync(path.join(ioMirror, "prompt.txt"), stdin);
  process.exit(0);
}
`.trimStart()
  );
  return {
    docker: [process.execPath, script],
    calls: (): { args: string[]; stdin: string }[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
        : [],
  };
}

function stepInput(workDir: string, wallClockMs = 30_000): StepAgentInput {
  return {
    job: { stream: "tasks", condition: PIGEON_DOCKER_CONDITION, attempt: 1 },
    step: { seq: 3 } as StepAgentInput["step"],
    prompt: "把 beta 改成 BETA",
    condition: CONDITION_SPECS[PIGEON_DOCKER_CONDITION],
    target: { container: "c-1", root: "/testbed" },
    budget: { maxTurns: 150, wallClockMs },
    workDir,
    modelBaseUrl: "http://172.18.0.1:8377/j/tasks-pigeon-docker-1/abcdef",
  };
}

// 造一个最小的打包产物目录（内容决定摘要）
function fakeBundle(dir: string): string {
  const bundle = path.join(dir, "dist");
  mkdirSync(path.join(bundle, "sub"), { recursive: true });
  writeFileSync(path.join(bundle, "pigeon.mjs"), "// bundle\n");
  writeFileSync(path.join(bundle, "sub", "deepseek-stream-fn.mjs"), "// stream fn\n");
  return bundle;
}

test(
  "作业容器参数：接内部网络、只读挂载打包产物与 Node 运行时、按作业读写挂载治理目录；治理目录的宿主布局即跑批器的会话布局",
  withTmp((dir) => {
    const job = { stream: "tasks", condition: PIGEON_DOCKER_CONDITION, attempt: 2 } as const;
    const args = pigeonDockerJobContainerArgs({
      outDir: dir,
      job,
      bundleDir: "bundle-src",
      nodeRuntimeDir: "node-src",
      networkName: "net-x",
    });
    assert.deepEqual(args.slice(0, 2), ["--network", "net-x"]);
    const jobDir = path.join(dir, "streams", jobDirName(job));
    const governance = projectPigeonDir(jobDir);
    // 布局契约：挂载来源的 state/sessions 即跑批器 sessionsDirOf(作业目录) 看的目录（作废移出与续跑原样生效）
    assert.equal(sessionsDirOf(jobDir), path.join(governance, "state", "sessions"));
    assert.ok(existsSync(governance), "bind 挂载的来源目录已建好");
    const mounts = args.filter((a) => a.startsWith("type=bind"));
    assert.deepEqual(mounts, [
      `type=bind,source=${path.resolve("bundle-src")},target=${PIGEON_BUNDLE_MOUNT},readonly`,
      `type=bind,source=${path.resolve("node-src")},target=${PIGEON_NODE_MOUNT},readonly`,
      `type=bind,source=${governance},target=${PIGEON_GOV_ROOT}/.pigeon`,
    ]);
    // 程序状态落在治理目录（挂载点）而不是工作区：diff 提取无需排除路径
    assert.equal(CONDITION_SPECS[PIGEON_DOCKER_CONDITION].excludePaths, undefined);
    assert.equal(CONDITION_SPECS[PIGEON_DOCKER_CONDITION].network, "gateway-only");
  })
);

test(
  "挂载来源路径含逗号、引号或换行即拒绝（原样拼进 --mount 会改变参数含义）",
  withTmp((dir) => {
    for (const bad of [path.join(dir, "a,b"), `${dir}/a"b`, `${dir}/a\nb`]) {
      assert.throws(
        () =>
          pigeonDockerContainerArgs({
            bundleDir: bad,
            nodeRuntimeDir: dir,
            governanceDir: dir,
            networkName: "n",
          }),
        /逗号、引号或换行/
      );
      assert.throws(
        () =>
          pigeonDockerContainerArgs({
            bundleDir: dir,
            nodeRuntimeDir: dir,
            governanceDir: bad,
            networkName: "n",
          }),
        /逗号、引号或换行/
      );
    }
  })
);

test(
  "身份段：记产物摘要、自报与逐项设置（思考档位、输出上限、跨题保留会话等）；设置不同则身份不同（判为不同条件的素材）",
  withTmp((dir) => {
    const identity = pigeonDockerIdentity(fakeBundle(dir), "1.2.3");
    assert.equal(identity.bundleMount, PIGEON_BUNDLE_MOUNT);
    assert.equal(identity.network, "gateway-only");
    assert.equal(identity.selfReported, "1.2.3");
    assert.match(String(identity.bundleDigest), /^sha256:/);
    const settings = identity.settings as Record<string, unknown>;
    assert.equal(settings.thinking, "high");
    assert.equal(settings.maxOutputTokens, null);
    assert.equal(settings.sessionRetention, "per-job");
    assert.equal(settings.projectSettings, "ignored");
    // 产物内容一变摘要即变
    const other = fakeBundle(dir);
    writeFileSync(path.join(other, "pigeon.mjs"), "// changed\n");
    assert.notEqual(pigeonDockerIdentity(other, "1.2.3").bundleDigest, identity.bundleDigest);
  })
);

test(
  "一步的运行契约：提示为指令与题面拼装（指令在前、空行相接）；运行命令为产品缺省加 --thinking high；环境经网关",
  withTmp(async (dir) => {
    const fake = fakeDocker(dir);
    writeFileSync(
      path.join(dir, "next-result.json"),
      JSON.stringify({
        status: "completed",
        turns: 7,
        usage: { input: 5, output: 9, totalTokens: 14 },
        report: { fake: true },
      })
    );
    const agent = pigeonDockerStepAgent({ bundleDir: dir, docker: fake.docker });
    const result = await agent.run(stepInput(dir));
    assert.equal(result.status, "completed");
    assert.equal(result.turns, 7);
    assert.deepEqual(result.usage, {
      input: 5,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    assert.deepEqual(result.report, { fake: true }, "启动器写的 report 原样进结果");
    const calls = fake.calls();
    const prepare = calls.find((c) => c.args.join("\0").includes("prompt.txt"));
    assert.equal(
      prepare?.stdin,
      `${STREAM_WORK_DIRECTIVE}\n\n把 beta 改成 BETA`,
      "工作方式指令与题面拼成任务文本"
    );
    const run = calls.find((c) => c.args.join("\0").includes("pigeon.mjs"));
    assert.ok(run !== undefined);
    const script = run.args.join(" ");
    for (const flag of ["--yolo", "--no-web", "--json", "--thinking high"]) {
      assert.ok(script.includes(flag), `运行命令带 ${flag}`);
    }
    assert.ok(script.includes('--governance-root "$2"'), "治理根与工作区分开");
    assert.ok(script.includes(`${PIGEON_BUNDLE_MOUNT}/deepseek-stream-fn.mjs`));
    // 位置参数：$1 工作区根、$2 治理根
    assert.deepEqual(run.args.slice(-2), ["/testbed", PIGEON_GOV_ROOT]);
    // 环境：模型地址指到网关、占位 key、用户级目录隔离、本步标记
    const runEnv = JSON.parse(
      readFileSync(path.join(dir, "io-mirror", "run-env.json"), "utf8")
    ) as Record<string, string>;
    assert.equal(runEnv.DEEPSEEK_BASE_URL, "http://172.18.0.1:8377/j/tasks-pigeon-docker-1/abcdef");
    assert.equal(runEnv.DEEPSEEK_API_KEY, "pigeon-gateway");
    assert.equal(runEnv.HOME, "/tmp/pigeon-run-io/home");
    assert.match(runEnv.PIGEON_STEP_MARKER ?? "", /^pigeon-step-[0-9a-f]{16}$/);
    // 产物：可信提示副本 + 拷出的运行目录
    const artifacts = path.join(dir, "pigeon-docker", "step-3", "try-1");
    assert.equal(readFileSync(path.join(artifacts, "prompt.txt"), "utf8"), prepare?.stdin);
    assert.ok(existsSync(path.join(artifacts, "io", "result.json")));
  })
);

// 终态判定（与进程内条件同一口径）的几个分支
const OUTCOMES: [string, string, string, boolean][] = [
  // [名字, result.json 内容, 期望 status, 期望 interrupted]
  ["completed 照常判题", JSON.stringify({ status: "completed", turns: 2 }), "completed", false],
  [
    "空回复异常结束照常判题（决策 170 ②）",
    JSON.stringify({ status: "empty-reply" }),
    "empty-reply",
    false,
  ],
  [
    "内容审核拒答照常判分",
    JSON.stringify({ status: "failed", errorMessage: "Error: 400 Content policy violation" }),
    "failed",
    false,
  ],
  [
    "模型服务故障作废重做（infrastructure）",
    JSON.stringify({
      status: "failed",
      failure: { category: "infrastructure" },
      errorMessage: "连接重置",
    }),
    "failed",
    true,
  ],
  [
    "其余 failed（非拒答非确定性错误）作废重做",
    JSON.stringify({ status: "failed", errorMessage: "HTTP 500 内部错误" }),
    "failed",
    true,
  ],
];

for (const [name, payload, status, interrupted] of OUTCOMES) {
  test(
    `终态判定：${name}`,
    withTmp(async (dir) => {
      const fake = fakeDocker(dir);
      writeFileSync(path.join(dir, "next-result.json"), payload);
      const agent = pigeonDockerStepAgent({ bundleDir: dir, docker: fake.docker });
      const result = await agent.run(stepInput(dir));
      assert.equal(result.status, status);
      assert.equal(result.interrupted !== undefined, interrupted);
    })
  );
}

test(
  "没有结果 JSON（装配或启动失败）：作废重做；墙钟到点杀掉记 wall-clock-limit；两者都先清容器里的进程",
  withTmp(async (dir) => {
    // 装配失败：运行结束但没写 result.json
    let fake = fakeDocker(path.join(dir, "a"));
    writeFileSync(path.join(dir, "a", "next-result.json"), "");
    let agent = pigeonDockerStepAgent({ bundleDir: dir, docker: fake.docker });
    let result = await agent.run(stepInput(dir));
    assert.equal(result.status, "aborted");
    assert.match(result.interrupted ?? "", /没有写出结果 JSON/);
    assert.ok(
      fake.calls().some((c) => c.args.join("\0").includes("PIGEON_STEP_MARKER=$1")),
      "结束后清掉容器里的进程"
    );
    // 墙钟：运行挂起，到点杀掉（预算 150ms + 余量 50ms），记 wall-clock-limit
    fake = fakeDocker(path.join(dir, "b"));
    writeFileSync(path.join(dir, "b", "next-result.json"), "hang");
    agent = pigeonDockerStepAgent({ bundleDir: dir, docker: fake.docker, graceMs: 50 });
    result = await agent.run(stepInput(dir, 150));
    assert.equal(result.status, "wall-clock-limit");
    assert.ok(
      fake.calls().some((c) => c.args.join("\0").includes("PIGEON_STEP_MARKER=$1")),
      "被杀后清掉容器里的进程"
    );
  })
);

test(
  "重做不覆盖：同一作业目录再跑一步，产物落到 try-2",
  withTmp(async (dir) => {
    const fake = fakeDocker(dir);
    writeFileSync(path.join(dir, "next-result.json"), JSON.stringify({ status: "completed" }));
    const agent = pigeonDockerStepAgent({ bundleDir: dir, docker: fake.docker });
    await agent.run(stepInput(dir));
    await agent.run(stepInput(dir));
    assert.ok(existsSync(path.join(dir, "pigeon-docker", "step-3", "try-1", "prompt.txt")));
    assert.ok(existsSync(path.join(dir, "pigeon-docker", "step-3", "try-2", "prompt.txt")));
  })
);
