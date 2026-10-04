// 每一步新开干净容器（决策 212）：用一个带状态的假 docker——记下容器在不在、状态与所用镜像，exec 在 -w 给出的本机目录里
// 直接执行，删除与新建容器时把"容器"的文件系统（本机上的工作区目录）一并清空——对着真实的 git 验证每步从人的起点新开、
// 上一步留下的东西不跨步
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { gitHumanRepo } from "./stream-facts.ts";
import { dockerStreamEnvs } from "./stream-runner.ts";
import { toyRepo } from "./stream-toy-fixtures.ts";

const FAKE_DOCKER = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [stateFile, logFile, fsRoot, ...args] = process.argv.slice(2);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state));
// 容器的文件系统随容器删除而消失、新建时为空
const wipe = () => { rmSync(fsRoot, { recursive: true, force: true }); mkdirSync(fsRoot, { recursive: true }); };
if (args[0] !== "exec") appendFileSync(logFile, args.join(" ") + "\\n");
if (args[0] === "inspect") {
  const c = state[args.at(-1)];
  if (c === undefined) { process.stderr.write("Error: No such object\\n"); process.exit(1); }
  process.stdout.write(c.status + "|" + c.image + "|" + (c.env ?? []).map((e) => e + ";").join("") + "\\n");
  process.exit(0);
}
if (args[0] === "rm") { if (state[args.at(-1)] !== undefined) wipe(); delete state[args.at(-1)]; save(); process.exit(0); }
if (args[0] === "run") { wipe(); const name = args[args.indexOf("--name") + 1]; const env = args.flatMap((a, k) => (args[k - 1] === "-e" ? [a] : [])); state[name] = { status: "running", image: "sha256:current", env }; save(); process.exit(0); }
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
let [program, ...rest] = args.slice(i + 1);
// 容器里的 /bin/sh 在 Windows 上对应 PATH 里的 sh
if (process.platform === "win32" && program === "/bin/sh") program = "sh";
// Windows 上 PATH 里的 find 会先命中系统自带的同名程序：sh -c 的脚本前把 coreutils 所在的 /usr/bin 提到最前
if (process.platform === "win32" && program === "sh" && rest[0] === "-c") rest[1] = 'export PATH="/usr/bin:$PATH"\\n' + rest[1];
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

// 人的历史 c1 → c2 → c3（未来）；返回按每步开容器的工厂与假 docker 的记录
function scenario() {
  const base = mkdtempSync(join(tmpdir(), "pigeon-stream-envs-"));
  const human = join(base, "human");
  const commit = toyRepo(human);
  const c1 = commit({ ".gitignore": "build/\n", "src/base.txt": "base\n" }, "Start");
  const c2 = commit({ "src/a.txt": "alpha\n" }, "Step 1");
  const c3 = commit({ "src/b.txt": "future\n" }, "Step 2");
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
  writeFileSync(logFile, "");
  const warnings: string[] = [];
  const envs = dockerStreamEnvs({
    image: "img",
    human: gitHumanRepo(human),
    prefix: "p",
    docker: [process.execPath, script, stateFile, logFile, root],
    root: containerRoot,
    warn: (line) => warnings.push(line),
  });
  const job = { stream: "tasks", condition: "neither" as const, attempt: 1 };
  const verbs = () =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.split(" ")[0]);
  const state = () => JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  return { base, root, envs, job, c1, c2, c3, verbs, state, warnings };
}

test("每步新开干净容器：同名的旧容器先删后建（不接管、不重启），检出人在该步之前的代码、历史只到它；上一步留下的被忽略文件与未跟踪文件都不跨步", async () => {
  const s = scenario();
  try {
    const first = await s.envs.open(s.job, { startCommit: s.c1 });
    assert.equal(await first.ws.head(), s.c1);
    // 上一步的 agent 留下：被忽略的产物、未跟踪的文件、自己的提交
    put(s.root, { "build/keep.o": "obj\n", "src/stray.txt": "x\n" });
    git(
      s.root,
      "-c",
      "user.name=a",
      "-c",
      "user.email=a@x",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "agent"
    );
    // 下一步：容器还在（没丢弃也一样），照样删掉重建
    const second = await s.envs.open(s.job, { startCommit: s.c2 });
    assert.deepEqual(
      s.verbs().filter((v) => v === "rm" || v === "run" || v === "start" || v === "restart"),
      ["rm", "run", "rm", "run"]
    );
    assert.equal(await second.ws.head(), s.c2);
    assert.equal(existsSync(join(s.root, "build", "keep.o")), false, "被忽略的产物不跨步");
    assert.equal(existsSync(join(s.root, "src", "stray.txt")), false, "未跟踪的文件不跨步");
    assert.equal(readFileSync(join(s.root, "src", "a.txt"), "utf8"), "alpha\n");
    assert.equal(git(s.root, "rev-list", "--all", "--count"), "2", "历史只到起点");
    assert.throws(() => git(s.root, "cat-file", "-e", s.c3), "看不到未来");
    await second.dispose();
    assert.deepEqual(s.state(), {}, "用完即删");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("送入起点失败（人的仓库里取不出该提交）：新起的容器随即删掉，报错交回", async () => {
  const s = scenario();
  try {
    await assert.rejects(s.envs.open(s.job, { startCommit: "0".repeat(40) }), /rev-parse/);
    assert.deepEqual(s.state(), {});
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("闸门不成立（本机假 docker 把脚本放在本机执行）：告警一次并说明后果，之后各步不再重复", async () => {
  const s = scenario();
  try {
    await s.envs.open(s.job, { startCommit: s.c1 });
    await s.envs.open(s.job, { startCommit: s.c2 });
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0] ?? "", /闸门不成立.*不清家目录下的用户级文件.*只按本步标记/);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});
