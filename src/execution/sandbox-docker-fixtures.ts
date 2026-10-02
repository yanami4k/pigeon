// 测试夹具：模拟日常沙箱用到的 docker 子命令的假 docker CLI。容器的状态（名字、标签、run 参数、镜像）记在一个 JSON 文件里；
// exec 在 -w 给出的本机目录里直接运行（"容器内"路径即本机路径），git、sh 都是本机的真程序。只供测试使用。
//   version / info / image inspect / pull / build / run / exec / ps / rm / restart / volume rm / system df
// 镜像是否带 git 由状态里的 noGit 名单决定：名单里的镜像，exec git 按 OCI 运行时"找不到程序"失败（经容器内 timeout 限时的
// 按 timeout 找不到程序失败）。
// 卷：run 带 -v <名>:<路径> 时自动建卷（与真 docker 一致）；volume rm 在有容器挂着时按"volume is in use"失败；
// system df -v --format '{{json .Volumes}}' 按真 docker 的字段名（Name、Size、Links）输出卷清单。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX_DOCKER = `
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [stateFile, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
state.calls.push(args);
save();
const fail = (code, text) => { process.stderr.write(text + "\\n"); process.exit(code); };
const sub = args[0];
if (sub === "version") { process.stdout.write("fake\\n"); process.exit(0); }
if (sub === "info") {
  if (state.memTotal === null) fail(1, "Error response from daemon: info unavailable");
  process.stdout.write(String(state.memTotal) + "\\n"); process.exit(0);
}
if (sub === "image" && args[1] === "inspect") {
  const name = args[args.length - 1];
  if (!state.images.includes(name)) fail(1, "Error: No such image: " + name);
  if (args.includes("--format")) process.stdout.write((state.imageUsers[name] ?? "") + "\\n");
  process.exit(0);
}
if (sub === "pull") {
  const name = args[1];
  if (!state.pullable.includes(name)) fail(1, "Error response from daemon: pull access denied for " + name);
  state.images.push(name); save(); process.exit(0);
}
if (sub === "build") {
  const tag = args[args.indexOf("-t") + 1];
  state.builds.push(args);
  if (state.buildFails) { save(); fail(1, "ERROR: failed to resolve source metadata for docker.io/library/ubuntu:24.04"); }
  state.images.push(tag); save(); process.exit(0);
}
if (sub === "run") {
  let i = 1; let name; const labels = {};
  const valued = new Set(["--name", "--label", "--user", "-e", "--network", "--memory", "--memory-swap", "--pids-limit", "--cpus", "-v", "--mount"]);
  const volumes = [];
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "-d" || a === "--init") continue;
    if (valued.has(a)) {
      if (a === "--name") name = args[i + 1];
      if (a === "--label") { const [k, ...v] = args[i + 1].split("="); labels[k] = v.join("="); }
      if (a === "-v") volumes.push(args[i + 1].split(":")[0]);
      i++; continue;
    }
    break;
  }
  const image = args[i];
  if (state.containers[name] !== undefined) fail(125, "Error response from daemon: Conflict. The container name is already in use");
  if (!state.images.includes(image) && !state.pullable.includes(image)) fail(125, "Unable to find image " + image);
  for (const v of volumes) { if (state.volumes[v] === undefined) state.volumes[v] = { size: "0B" }; }
  state.containers[name] = { image, labels, args, state: "running", volumes };
  save(); process.stdout.write("0123456789ab\\n"); process.exit(0);
}
const volumeUsers = (v) => Object.entries(state.containers).filter(([, c]) => (c.volumes ?? []).includes(v)).map(([n]) => n);
if (sub === "volume" && args[1] === "rm") {
  const v = args[args.length - 1];
  if (state.volumes[v] === undefined) fail(1, "Error response from daemon: get " + v + ": no such volume");
  const users = volumeUsers(v);
  if (users.length > 0) fail(1, "Error response from daemon: remove " + v + ": volume is in use - [" + users.join(", ") + "]");
  delete state.volumes[v]; state.removedVolumes.push(v); save(); process.exit(0);
}
if (sub === "system" && args[1] === "df") {
  const rows = Object.entries(state.volumes).map(([v, info]) => ({ Name: v, Size: info.size, Links: String(volumeUsers(v).length), Driver: "local" }));
  process.stdout.write(JSON.stringify(rows) + "\\n"); process.exit(0);
}
if (sub === "rm") {
  const name = args[args.length - 1];
  if (state.containers[name] === undefined) fail(1, "Error response from daemon: No such container: " + name);
  delete state.containers[name]; state.removed.push(name); save(); process.exit(0);
}
if (sub === "restart") process.exit(0);
if (sub === "ps") {
  const filter = args[args.indexOf("--filter") + 1].replace(/^label=/, "");
  for (const [name, c] of Object.entries(state.containers)) {
    if (c.labels[filter] === undefined) continue;
    const l = c.labels;
    process.stdout.write([name, l["pigeon.sandbox"] ?? "", l["pigeon.sandbox.pid"] ?? "", l["pigeon.sandbox.host"] ?? "", c.state, l["pigeon.sandbox.repo"] ?? ""].join("\\t") + "\\n");
  }
  process.exit(0);
}
if (sub !== "exec") fail(1, "fake docker: unsupported " + sub);
let i = 1;
let cwd = process.cwd();
let interactive = false;
for (;;) {
  if (args[i] === "-i") { interactive = true; i++; continue; }
  if (args[i] === "-w") {
    cwd = args[i + 1];
    if (process.platform === "win32" && cwd.startsWith("/")) {
      cwd = spawnSync("sh", ["-c", 'cygpath -w "$1"', "sh", cwd]).stdout.toString().trim();
    }
    i += 2;
    continue;
  }
  if (args[i] === "-e" || args[i] === "-u") { i += 2; continue; }
  break;
}
const container = state.containers[args[i]];
if (container === undefined) fail(1, "Error response from daemon: No such container: " + args[i]);
let [program, ...rest] = args.slice(i + 1);
// 辅助命令经容器内 timeout 限时（/bin/sh -c 'exec "$0" -k …' <timeout> <命令…>）：按里面的命令判有没有 git
const wrapped = program === "/bin/sh" && /^exec "\\$0" -k /.test(rest[1] ?? "");
const inner = wrapped ? rest[3] : program;
if (inner === "git" && state.noGit.includes(container.image)) {
  if (wrapped) fail(127, "timeout: failed to run command 'git': No such file or directory");
  fail(127, 'OCI runtime exec failed: exec failed: unable to start container process: exec: "git": executable file not found in $PATH: unknown');
}
if (program === "/bin/sh" && process.platform === "win32") program = "sh";
if (process.platform === "win32" && (program === "sh" || program === "/bin/sh") && rest[0] === "-c") {
  rest[1] = 'export PATH="/usr/bin:$PATH"\\n' + rest[1];
}
const r = spawnSync(program, rest, { cwd, stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"] });
if (r.error) fail(127, "OCI runtime exec failed: exec failed: " + r.error.message + ": no such file or directory");
process.exit(r.status ?? 1);
`;

export interface FakeContainer {
  image: string;
  labels: Record<string, string>;
  args: string[];
  state: string;
  // run 时挂的卷名
  volumes?: string[];
}

export interface FakeDockerState {
  images: string[];
  imageUsers: Record<string, string>;
  pullable: string[];
  noGit: string[];
  // docker info 报的守护进程所在机器内存总量（字节）；null 表示读不到
  memTotal: number | null;
  buildFails: boolean;
  builds: string[][];
  containers: Record<string, FakeContainer>;
  removed: string[];
  // 卷：名字 → docker system df 报的占用
  volumes: Record<string, { size: string }>;
  removedVolumes: string[];
  calls: string[][];
}

export interface FakeSandboxDocker {
  docker: string[];
  // "容器内"的工作区根（本机临时目录，Windows 上取 MSYS 形式）
  containerRoot: string;
  // 该目录的本机路径
  localRoot: string;
  // "容器内"的缓存卷挂载点（本机临时目录，Windows 上取 MSYS 形式）与其本机路径
  cacheRoot: string;
  localCacheRoot: string;
  state(): FakeDockerState;
  update(change: (state: FakeDockerState) => void): void;
  cleanup(): void;
}

// 建一个假 docker；initial 覆盖初始状态（缺省只有镜像 sandbox-test:latest，带 git、以非 root 用户运行）
export function fakeSandboxDocker(initial: Partial<FakeDockerState> = {}): FakeSandboxDocker {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fake-docker-"));
  const script = join(dir, "docker.mjs");
  const stateFile = join(dir, "state.json");
  const localRoot = join(dir, "container-workspace");
  const localCacheRoot = join(dir, "container-cache");
  writeFileSync(script, SANDBOX_DOCKER);
  const state: FakeDockerState = {
    images: ["sandbox-test:latest"],
    imageUsers: { "sandbox-test:latest": "pigeon" },
    pullable: [],
    noGit: [],
    memTotal: 16 * 1024 ** 3,
    buildFails: false,
    builds: [],
    containers: {},
    removed: [],
    volumes: {},
    removedVolumes: [],
    calls: [],
    ...initial,
  };
  writeFileSync(stateFile, JSON.stringify(state));
  // Windows 上"容器内"路径取 MSYS 形式（sh 脚本里的 mkdir、git 都认）
  const insideForm = (local: string): string =>
    process.platform === "win32"
      ? execFileSync("sh", ["-c", 'mkdir -p -- "$1" && cd -- "$1" && readlink -f .', "sh", local], {
          encoding: "utf8",
        }).trim()
      : local;
  const containerRoot = insideForm(localRoot);
  const cacheRoot = insideForm(localCacheRoot);
  const read = (): FakeDockerState =>
    JSON.parse(readFileSync(stateFile, "utf8")) as FakeDockerState;
  return {
    docker: [process.execPath, script, stateFile],
    containerRoot,
    localRoot,
    cacheRoot,
    localCacheRoot,
    state: read,
    update(change) {
      const current = read();
      change(current);
      writeFileSync(stateFile, JSON.stringify(current));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
