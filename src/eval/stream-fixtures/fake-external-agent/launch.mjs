// 测试用的假外部 agent 启动器（外部 agent 条件的测试夹具，不是真的 agent）：以只读方式挂进作业容器，由跑批器用
// docker exec 在工作区根运行：node launch.mjs <请求文件> <结果文件>；带 --identity 时只打印自报的版本。
// 行为由环境变量 FAKE_EXTERNAL_MODE 决定（经外部 agent 配置的附加环境变量给）：
//   work（缺省）：经网关发一次模型请求（请求体带一个未知字段），改工作区里的 src/a.txt，在排除路径 .agent-state 下写
//               文件并建一个带提交的嵌套 git 工作树，往产物目录写一个文件，结果文件带 report；
//   hang：起一个后台 sleep 后一直不退出（测墙钟到点被杀）。
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.argv[2] === "--identity") {
  console.log("fake external agent banner");
  console.log(JSON.stringify({ name: "fake-external-agent", version: "1.0.0" }));
  process.exit(0);
}

const [requestFile, resultFile] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestFile, "utf8"));
const mode = process.env.FAKE_EXTERNAL_MODE ?? "work";
const artifacts = process.env.PIGEON_AGENT_ARTIFACTS;

if (mode === "hang") {
  spawn("sleep", ["600"], { detached: true, stdio: "ignore" }).unref();
  writeFileSync(path.join(artifacts, "started.txt"), "hang\n");
  setInterval(() => {}, 1000);
} else {
  const body =
    '{"model":"' +
    request.model +
    '","max_tokens":1,"output_config":{"fake":true},"messages":[{"role":"user","content":"hi"}]}';
  let httpStatus = null;
  try {
    const res = await fetch(`${process.env.PIGEON_MODEL_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.PIGEON_MODEL_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    httpStatus = res.status;
    await res.text();
  } catch (error) {
    httpStatus = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const root = request.root;
  writeFileSync(path.join(root, "src/a.txt"), "alpha\n");
  mkdirSync(path.join(root, ".agent-state/nested"), { recursive: true });
  writeFileSync(path.join(root, ".agent-state/notes.txt"), "agent state\n");
  const nested = path.join(root, ".agent-state/nested");
  writeFileSync(path.join(nested, "inner.txt"), "inner\n");
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@invalid", ...args], {
      cwd: nested,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "nested");
  writeFileSync(
    path.join(artifacts, "trace.txt"),
    `cwd=${process.cwd()} marker=${process.env.PIGEON_STEP_MARKER}\n`
  );
  writeFileSync(
    resultFile,
    JSON.stringify({
      status: "completed",
      turns: 1,
      usage: { input: 1, output: 2, totalTokens: 3 },
      report: { fake: true, httpStatus, cwd: process.cwd(), sawRequestRoot: request.root },
    })
  );
}
