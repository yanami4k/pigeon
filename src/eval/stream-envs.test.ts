// 续跑时接管已存在的流容器（进程被杀、整机重启之后）：用一个带状态的假 docker——记下容器在不在、状态与所用镜像，exec 在
// -w 给出的本机目录里直接执行——对着真实的 git 验证接管、回到上一个完成步与退回重建三种走法
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitHumanRepo } from "./stream-facts.ts";
import { dockerStreamEnvs } from "./stream-runner.ts";
import { toyRepo } from "./stream-toy-fixtures.ts";

const FAKE_DOCKER = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [stateFile, logFile, ...args] = process.argv.slice(2);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state));
if (args[0] !== "exec") appendFileSync(logFile, args.join(" ") + "\\n");
if (args[0] === "inspect") {
  const c = state[args.at(-1)];
  if (c === undefined) { process.stderr.write("Error: No such object\\n"); process.exit(1); }
  process.stdout.write(c.status + "|" + c.image + "\\n");
  process.exit(0);
}
if (args[0] === "image") { process.stdout.write("sha256:current\\n"); process.exit(0); }
if (args[0] === "start" || args[0] === "restart") { state[args.at(-1)].status = "running"; save(); process.exit(0); }
if (args[0] === "rm") { delete state[args.at(-1)]; save(); process.exit(0); }
if (args[0] === "run") { const name = args[args.indexOf("--name") + 1]; state[name] = { status: "running", image: "sha256:current" }; save(); process.exit(0); }
if (args[0] !== "exec") process.exit(0);
let i = 1; let cwd = process.cwd();
for (;;) {
  if (args[i] === "-i") { i++; continue; }
  if (args[i] === "-u" || args[i] === "-e") { i += 2; continue; }
  if (args[i] === "-w") {
    cwd = args[i + 1];
    if (process.platform === "win32" && cwd.startsWith("/")) cwd = spawnSync("sh", ["-c", 'cygpath -w "$1"', "sh", cwd]).stdout.toString().trim();
    i += 2; continue;
  }
  break;
}
const [program, ...rest] = args.slice(i + 1);
const r = spawnSync(program, rest, { cwd, stdio: ["inherit", "inherit", "inherit"] });
process.exit(r.status ?? 1);
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function put(root: string, files: Record<string, string>): void {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
}

// 起一个"容器"：新开到流起点，落地第 1 步（带 .gitignore 与一个被忽略的产物），再模拟第 2 步做到一半（多落了一个提交、
// 另有未提交的改动）。返回续跑要用的断点与流历史
async function scenario() {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-envs-"));
  const human = join(base, "human");
  const start = toyRepo(human)({ "src/base.txt": "base\n" }, "Start");
  const root = join(base, "testbed");
  mkdirSync(root);
  const containerRoot =
    process.platform === "win32"
      ? execFileSync("sh", ["-c", 'cd -- "$1" && readlink -f .', "sh", root], {
          encoding: "utf8",
        }).trim()
      : root;
  const script = join(base, "docker.mjs");
  writeFileSync(script, FAKE_DOCKER);
  const stateFile = join(base, "state.json");
  const logFile = join(base, "docker.log");
  const docker = [process.execPath, script, stateFile, logFile];
  const envs = dockerStreamEnvs({
    image: "img",
    human: gitHumanRepo(human),
    prefix: "p",
    docker,
    root: containerRoot,
  });
  const job = { stream: "s1", condition: "no-gate" as const, attempt: 1 };
  const first = await envs.open(job, { startCommit: start });
  put(root, { ".gitignore": "build/\n", "src/a.txt": "alpha\n" });
  const head1 = await first.ws.land("step 1");
  const bundle1 = await first.ws.exportBundle();
  put(root, { "build/keep.o": "obj\n" });
  // 第 2 步做到一半：agent 自己提交了一次，还有没提交的改动
  put(root, { "src/b.txt": "half\n" });
  git(root, "-c", "user.name=a", "-c", "user.email=a@x", "add", "-A");
  git(root, "-c", "user.name=a", "-c", "user.email=a@x", "commit", "-qm", "agent");
  put(root, { "src/c.txt": "dirty\n" });
  writeFileSync(logFile, "");
  const setState = (status: string, image = "sha256:current") =>
    writeFileSync(stateFile, JSON.stringify({ "p-s1-no-gate-1": { status, image } }));
  const log = () =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  const dropContainer = () => writeFileSync(stateFile, "{}");
  return { base, root, envs, job, head1, bundle1, setState, dropContainer, log };
}

test("续跑接管已存在的流容器：停止的启动、仍在运行的重启；回到上一个完成步，在途步的提交与改动作废，被忽略的产物保留，不重建", async () => {
  for (const [status, verb] of [
    ["exited", "start"],
    ["running", "restart"],
  ] as const) {
    const s = await scenario();
    try {
      s.setState(status);
      const env = await s.envs.open(s.job, {
        startCommit: "unused",
        resume: { head: s.head1, bundle: s.bundle1 },
      });
      assert.deepEqual(
        s.log().map((l) => l.split(" ")[0]),
        ["inspect", "image", verb],
        `${status}：只${verb}、不删不建`
      );
      assert.equal(await env.ws.head(), s.head1);
      assert.equal(existsSync(join(s.root, "src", "b.txt")), false, "在途步的提交作废");
      assert.equal(existsSync(join(s.root, "src", "c.txt")), false, "在途步的改动作废");
      assert.equal(existsSync(join(s.root, "build", "keep.o")), true, "被忽略的产物保留");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  }
});

test("续跑时残留容器用不上即由流历史重建：镜像不是当前的、库里没有上一个完成步的提交、容器已不在", async () => {
  const cases: [string, (s: Awaited<ReturnType<typeof scenario>>) => void][] = [
    ["镜像不同", (s) => s.setState("exited", "sha256:old")],
    [
      "库里没有上一个完成步的提交",
      (s) => {
        s.setState("exited");
        // 容器里的库换成另起的一个（没有上一个完成步的提交）
        rmSync(join(s.root, ".git"), { recursive: true, force: true });
        git(s.root, "init", "-q");
      },
    ],
    ["容器已不在", (s) => s.dropContainer()],
  ];
  for (const [what, arrange] of cases) {
    const s = await scenario();
    try {
      arrange(s);
      const env = await s.envs.open(s.job, {
        startCommit: "unused",
        resume: { head: s.head1, bundle: s.bundle1 },
      });
      const verbs = s.log().map((l) => l.split(" ")[0]);
      assert.ok(
        verbs.includes("rm") && verbs.includes("run"),
        `${what}：重建（${verbs.join(" ")}）`
      );
      assert.equal(await env.ws.head(), s.head1, `${what}：回到上一个完成步`);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  }
});
