// 日常沙箱（决策 237、245–248）：日常入口（终端界面、命令行对话、pigeon run）可选在一个一次性的 Docker 容器里工作。
// 本模块只管容器的生命周期与改动交回，工具经容器执行端（container-host.ts）读写与执行；会话文件、.pigeon/state/learned 等
// 仍在宿主的治理根，不进容器。
//   开工（278）：缺省把工作目录里未提交的改动（含未被 .gitignore 忽略的新文件）拍成以 HEAD 为父的快照提交（workdir-snapshot.ts，
//         引用 refs/pigeon/sandbox-start/<会话号>），从它打 git bundle，经标准输入送进新容器，在容器里建仓库并检出到
//         pigeon/sandbox-<会话号>；开工时提示带入了几个未提交的文件，没有未提交改动时直接从 HEAD 起步、不提示。
//         fromHead 改为只从当前分支的最新提交开工；续跑照旧从该会话交回过的分支开工。容器以非 root 用户运行，
//         带 pigeon.sandbox 标签（值为会话号），便于识别与清理。镜像须有 git，开工时检查。
//   缓存（280）：所有项目与沙箱共用一个 Docker 卷 pigeon-sandbox-cache，挂到容器的 /pigeon-cache，npm、pnpm、yarn、pip、uv、
//         cargo、go 的下载缓存经环境变量指到卷里各自的子目录；目录由 root 建好交给运行用户。断网档照样挂，缓存里有的包能装。
//         不缓存装好的依赖目录。清空与查看占用的命令在 pigeon sandbox 下。
//   交回（245）：容器内把改动提交到 pigeon/sandbox-<会话号>，打 bundle 取出，在宿主仓库 git fetch 成同名分支。不动
//         当前分支、工作目录与未提交的改动，不经网络，不自动推送。交回的分支 = 快照提交 + agent 的提交（提示里说明）。
//   收尾：交回一次后删除容器；交回失败即保留容器，改动还在里面。快照引用在开箱（容器里建好仓库）后即删，开工中途失败也删。
//   残留：进程异常退出留下的带标签容器，开沙箱时列出并给出清理命令，不自动删除；清理时连同其快照引用一并删除。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../state/sandbox-config.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import {
  containerExec,
  createContainerWorkspaceHost,
  dockerOnce,
  NO_NETWORK_ARGS,
  removeWorkspaceContainer,
  startWorkspaceContainer,
} from "./container-host.ts";
import { ensureSandboxImage, resolveSandboxImage, type SandboxImageSpec } from "./sandbox-image.ts";
import { deleteSnapshotRef, snapshotWorkdir } from "./workdir-snapshot.ts";

// 联网档位（246）：缺省联网，可改为断网；以后可加"只放行包管理源"一档而不改用法
export const SANDBOX_NETWORKS = ["on", "off"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number];

// 容器标签：值为会话号；另记起它的进程号、主机名与宿主仓库，据此判断是不是残留
export const SANDBOX_LABEL = "pigeon.sandbox";
export const SANDBOX_PID_LABEL = "pigeon.sandbox.pid";
export const SANDBOX_HOST_LABEL = "pigeon.sandbox.host";
export const SANDBOX_REPO_LABEL = "pigeon.sandbox.repo";
// 容器内的工作区根
export const SANDBOX_ROOT = "/workspace";
// 镜像缺省以 root 运行时改用的用户
export const SANDBOX_FALLBACK_USER = "1000:1000";
// 容器内提交改动用的身份
const SANDBOX_COMMITTER = { name: "pigeon", email: "pigeon@sandbox.invalid" };
// 送入与取出 bundle、建仓库这类较重操作的超时
const HEAVY_TIMEOUT_MS = 900_000;

// 决策 278：开工快照的引用（挂在 refs/pigeon/ 下防止被 git 回收；随沙箱会话收尾或残留清理一并删除）
export const SANDBOX_START_REF_PREFIX = "refs/pigeon/sandbox-start/";

export function sandboxStartRef(sessionId: string): string {
  return `${SANDBOX_START_REF_PREFIX}${sessionId}`;
}

// 决策 280：所有项目与沙箱共用的下载缓存卷，及其在容器里的挂载点
export const SANDBOX_CACHE_VOLUME = "pigeon-sandbox-cache";
export const SANDBOX_CACHE_ROOT = "/pigeon-cache";
// 卷下各包管理器的子目录
export const SANDBOX_CACHE_DIRS = ["npm", "pnpm", "yarn", "pip", "uv", "cargo", "go"] as const;

// 把各包管理器的下载缓存指到卷里各自子目录的环境变量（随 docker run 进容器，之后每次 exec 都带着）
export function sandboxCacheEnv(root: string = SANDBOX_CACHE_ROOT): Record<string, string> {
  return {
    npm_config_cache: `${root}/npm`,
    // pnpm 读 npm 风格的环境变量：内容可寻址存储放卷里（与项目不在同一文件系统时 pnpm 自行改为复制）
    npm_config_store_dir: `${root}/pnpm/store`,
    // yarn 1 的缓存目录；yarn 2+ 缺省用全局目录下的 cache
    YARN_CACHE_FOLDER: `${root}/yarn/cache`,
    YARN_GLOBAL_FOLDER: `${root}/yarn/berry`,
    PIP_CACHE_DIR: `${root}/pip`,
    UV_CACHE_DIR: `${root}/uv`,
    // cargo 没有单独的缓存目录变量：整个 CARGO_HOME（registry 与 git 缓存所在）指到卷里
    CARGO_HOME: `${root}/cargo`,
    GOMODCACHE: `${root}/go/mod`,
    GOCACHE: `${root}/go/build`,
  };
}

// docker run 的缓存参数：挂卷，加上指向卷的环境变量
export function sandboxCacheArgs(
  volume: string = SANDBOX_CACHE_VOLUME,
  root: string = SANDBOX_CACHE_ROOT
): string[] {
  return [
    "-v",
    `${volume}:${root}`,
    ...Object.entries(sandboxCacheEnv(root)).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ];
}

// 决策 333：日常沙箱容器的资源上限。缺省内存上限为 Docker 守护进程所在机器内存的一半（取 docker info 的 MemTotal：
// DOCKER_HOST 可指向远程机器，本进程的 os.totalmem() 不一定是容器所在的机器），交换区不另占（--memory-swap 取同值）；
// 进程数上限 4096；CPU 不限。三项可在设置里改，写 0 为不限（接入点：OpenSandboxOptions.limits）。去能力与禁止提权不在此列
export const SANDBOX_DEFAULT_PIDS_LIMIT = 4096;

// 设置给出的上限（缺项取缺省；0 为不限）
export interface SandboxLimitSettings {
  memoryBytes?: number;
  pids?: number;
  cpus?: number;
}

// 生效的上限（0 为不限）
export interface SandboxLimits {
  memoryBytes: number;
  pids: number;
  cpus: number;
}

// Docker 守护进程所在机器的内存总量（字节）；读不到为 undefined
export async function dockerMemTotal(
  docker: readonly string[] = ["docker"]
): Promise<number | undefined> {
  try {
    const result = await dockerOnce(docker, ["info", "--format", "{{.MemTotal}}"], 30_000);
    const text = result.stdout.toString("utf8").trim();
    const bytes = Number(text);
    return result.exitCode === 0 && /^\d+$/.test(text) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

// 缺省内存上限取 memTotal 的一半（向下取整到 MiB）；memTotal 读不到时为 0（不限）
export function resolveSandboxLimits(
  settings: SandboxLimitSettings | undefined,
  memTotal: number | undefined
): SandboxLimits {
  const mib = 1024 * 1024;
  const defaultMemory = memTotal === undefined ? 0 : Math.floor(memTotal / 2 / mib) * mib;
  return {
    memoryBytes: settings?.memoryBytes ?? defaultMemory,
    pids: settings?.pids ?? SANDBOX_DEFAULT_PIDS_LIMIT,
    cpus: settings?.cpus ?? 0,
  };
}

// docker run 的上限参数：0 的那项不带（不限）
export function sandboxLimitArgs(limits: SandboxLimits): string[] {
  return [
    ...(limits.memoryBytes > 0
      ? ["--memory", String(limits.memoryBytes), "--memory-swap", String(limits.memoryBytes)]
      : []),
    ...(limits.pids > 0 ? ["--pids-limit", String(limits.pids)] : []),
    ...(limits.cpus > 0 ? ["--cpus", String(limits.cpus)] : []),
  ];
}

// 字节数的可读写法：整 GiB / MiB 不带小数，其余保留一位
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

// 给人看的上限摘要（就绪提示用）
export function sandboxLimitsSummary(limits: SandboxLimits): string {
  return [
    `内存上限 ${limits.memoryBytes > 0 ? formatBytes(limits.memoryBytes) : "不限"}`,
    `进程数上限 ${limits.pids > 0 ? limits.pids : "不限"}`,
    `CPU ${limits.cpus > 0 ? `上限 ${limits.cpus} 核` : "不限"}`,
  ].join("、");
}

export function sandboxBranch(sessionId: string): string {
  return `pigeon/sandbox-${sessionId}`;
}

export function sandboxContainerName(sessionId: string): string {
  return `pigeon-sandbox-${sessionId}`;
}

// 断网档复用跑批器工作区容器的断网参数
export function sandboxNetworkArgs(network: SandboxNetwork): string[] {
  return network === "off" ? [...NO_NETWORK_ARGS] : [];
}

export interface SandboxExport {
  branch: string;
  commit: string;
  // 相对这次开工的起点有没有改动
  changed: boolean;
  // 查看改动的命令
  viewCommand: string;
  // 决策 278：分支第一条提交是开箱时未提交改动的快照时在场（该快照提交号）
  snapshotCommit?: string;
}

// 决策 278：开工时带入的未提交改动
export interface SandboxStartSnapshot {
  commit: string;
  // 带入的未提交文件（仓库相对路径，含新建与删除的）
  files: string[];
}

export interface Sandbox {
  readonly sessionId: string;
  readonly container: string;
  readonly branch: string;
  readonly image: string;
  readonly network: SandboxNetwork;
  // 开工时宿主当前分支名（分离头指针时为短提交号）：查看命令以它为比较基准
  readonly baseLabel: string;
  // 起点：新开时为宿主当前分支，续跑时为交回过的沙箱分支；及其提交（带了快照时为快照提交）
  readonly startLabel: string;
  readonly startCommit: string;
  // 决策 278：开工时带入的未提交改动的快照；没有未提交改动、fromHead 或续跑时缺省
  readonly startSnapshot?: SandboxStartSnapshot;
  // 决策 280：挂进容器的共用下载缓存卷
  readonly cacheVolume: string;
  // 决策 333：容器的资源上限（0 为不限）
  readonly limits: SandboxLimits;
  // 工具经它读写容器里的工作区
  readonly host: WorkspaceHost;
  // 把改动交回成宿主仓库里的 pigeon/sandbox-<会话号>（会话中可多次调用）
  exportChanges(): Promise<SandboxExport>;
  // 收尾：交回一次后删除容器；交回失败即保留容器并报错。重复调用返回第一次的结果
  close(): Promise<SandboxExport>;
  // 不交回、直接删除容器（开工中途失败时用）
  discard(): Promise<void>;
}

export interface OpenSandboxOptions {
  // 宿主上的项目根（治理根）
  repoRoot: string;
  sessionId: string;
  network: SandboxNetwork;
  // 续跑：从该会话交回过的 pigeon/sandbox-<会话号> 起步
  resume?: boolean;
  // 决策 278：只从当前分支的最新提交开工，不带未提交的改动（缺省带）；续跑不看这一项
  fromHead?: boolean;
  // 镜像来源（缺省按 sandboxConfig 与环境变量解析）
  image?: SandboxImageSpec;
  // 决策 325：本会话设置快照的 sandbox 一节（缺省空配置，即通用镜像）
  sandboxConfig?: SandboxConfig;
  docker?: readonly string[];
  // 容器内的工作区根（缺省 /workspace；测试的假 docker 指到本机临时目录）
  containerRoot?: string;
  // 决策 280：共用下载缓存卷的名字与容器里的挂载点（缺省 pigeon-sandbox-cache 与 /pigeon-cache；测试改到别处）
  cacheVolume?: string;
  cacheRoot?: string;
  // 开工时给人看的提示（带入的未提交改动、残留容器、首次构建镜像）
  log?: (line: string) => void;
  // 运行中给人看的提示（命令超出内存上限等）；缺省同 log
  notice?: (line: string) => void;
  // 决策 333：资源上限的设置（缺项取缺省）
  limits?: SandboxLimitSettings;
  // 决策 333：容器里 oom_kill 计数所在的文件（缺省按 cgroup v2、v1 的位置；测试改到别处）
  oomCounterFiles?: readonly string[];
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function hostGit(repo: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined) {
    return { code: null, stdout: "", stderr: result.error.message };
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Docker 可用：客户端拉得起来、守护进程连得上
export async function assertDockerAvailable(docker: readonly string[] = ["docker"]): Promise<void> {
  let detail: string;
  try {
    const result = await dockerOnce(docker, ["version", "--format", "{{.Server.Version}}"], 30_000);
    if (result.exitCode === 0) {
      return;
    }
    detail = result.stderr.trim() || `退出码 ${result.exitCode}`;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `Docker 不可用：${detail}。沙箱模式在 Docker 容器里工作，请先安装并启动 Docker，且当前用户能执行 docker 命令`
  );
}

// 残留容器的判定信息
export interface SandboxContainerInfo {
  name: string;
  sessionId: string;
  pid?: number;
  hostname?: string;
  repo?: string;
  running: boolean;
}

// 列出全部带沙箱标签的容器（含已停止的）
export async function listSandboxContainers(
  docker: readonly string[] = ["docker"]
): Promise<SandboxContainerInfo[]> {
  const format = [
    "{{.Names}}",
    `{{.Label "${SANDBOX_LABEL}"}}`,
    `{{.Label "${SANDBOX_PID_LABEL}"}}`,
    `{{.Label "${SANDBOX_HOST_LABEL}"}}`,
    "{{.State}}",
    `{{.Label "${SANDBOX_REPO_LABEL}"}}`,
  ].join("\t");
  const result = await dockerOnce(
    docker,
    ["ps", "-a", "--filter", `label=${SANDBOX_LABEL}`, "--format", format],
    60_000
  );
  if (result.exitCode !== 0) {
    throw new Error(`列出沙箱容器失败：${result.stderr.trim()}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name = "", sessionId = "", pid = "", hostname = "", state = "", repo = ""] =
        line.split("\t");
      const pidNumber = Number(pid);
      return {
        name: name.trim(),
        sessionId,
        ...(Number.isInteger(pidNumber) && pidNumber > 0 ? { pid: pidNumber } : {}),
        ...(hostname !== "" ? { hostname } : {}),
        ...(repo.trim() !== "" ? { repo: repo.trim() } : {}),
        running: state.trim() === "running",
      };
    });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 进程在、只是无权发信号
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 残留：容器已停，或起它的进程在本机已不在。别的主机起的容器无从判断，不算残留
export function isResidualSandbox(
  info: SandboxContainerInfo,
  probe: { hostname: string; alive: (pid: number) => boolean } = {
    hostname: os.hostname(),
    alive: processAlive,
  }
): boolean {
  if (!info.running) {
    return true;
  }
  if (info.hostname !== undefined && info.hostname !== probe.hostname) {
    return false;
  }
  return info.pid === undefined || !probe.alive(info.pid);
}

export async function findResidualSandboxes(
  docker: readonly string[] = ["docker"],
  probe?: Parameters<typeof isResidualSandbox>[1]
): Promise<SandboxContainerInfo[]> {
  return (await listSandboxContainers(docker)).filter((info) => isResidualSandbox(info, probe));
}

// 清理命令：只删残留容器，在用的不动；返回删掉的容器名。决策 278：连同该会话在宿主仓库里的开工快照引用一并删除
//（仓库路径取自容器标签；仓库已不在或引用本就没有都不算错）
export async function cleanResidualSandboxes(
  docker: readonly string[] = ["docker"],
  probe?: Parameters<typeof isResidualSandbox>[1]
): Promise<string[]> {
  const residual = await findResidualSandboxes(docker, probe);
  for (const info of residual) {
    await removeWorkspaceContainer(info.name, docker);
    if (info.repo !== undefined && info.sessionId !== "") {
      try {
        deleteSnapshotRef(info.repo, sandboxStartRef(info.sessionId));
      } catch {
        // 仓库已不在或不是 git 仓库：没有引用可删
      }
    }
  }
  return residual.map((info) => info.name);
}

export const SANDBOX_CLEAN_COMMAND = "pigeon sandbox clean";
// 决策 280：查看与清空共用下载缓存的命令
export const SANDBOX_CACHE_COMMAND = "pigeon sandbox cache";
export const SANDBOX_CLEAR_CACHE_COMMAND = "pigeon sandbox clear-cache";

export interface CacheVolumeInfo {
  volume: string;
  exists: boolean;
  // docker 报的占用（如 1.2GB）与正在使用它的容器数；卷不存在时缺省
  size?: string;
  links?: number;
}

// 查看缓存卷的占用：docker system df -v 的卷清单里找这一个
export async function inspectCacheVolume(
  docker: readonly string[] = ["docker"],
  volume: string = SANDBOX_CACHE_VOLUME
): Promise<CacheVolumeInfo> {
  const result = await dockerOnce(
    docker,
    ["system", "df", "-v", "--format", "{{json .Volumes}}"],
    120_000
  );
  if (result.exitCode !== 0) {
    throw new Error(`查看缓存卷失败：${result.stderr.trim()}`);
  }
  let entries: unknown;
  try {
    entries = JSON.parse(result.stdout.toString("utf8").trim() || "[]");
  } catch (error) {
    throw new Error(
      `读不懂 docker system df 的输出：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const found = Array.isArray(entries)
    ? (entries as Array<Record<string, unknown>>).find((entry) => entry.Name === volume)
    : undefined;
  if (found === undefined) {
    return { volume, exists: false };
  }
  const links = Number(found.Links);
  return {
    volume,
    exists: true,
    size: typeof found.Size === "string" ? found.Size : String(found.Size ?? ""),
    ...(Number.isInteger(links) ? { links } : {}),
  };
}

// 清空缓存：删掉整个卷（下次开沙箱自动重建）；卷不存在视为本就是空的；有容器在用时报错说明
export async function clearCacheVolume(
  docker: readonly string[] = ["docker"],
  volume: string = SANDBOX_CACHE_VOLUME
): Promise<"removed" | "absent"> {
  const result = await dockerOnce(docker, ["volume", "rm", volume], 120_000);
  if (result.exitCode === 0) {
    return "removed";
  }
  if (/no such volume/i.test(result.stderr)) {
    return "absent";
  }
  if (/volume is in use/i.test(result.stderr)) {
    throw new Error(
      `缓存卷 ${volume} 正被沙箱容器使用，不能清空：请先结束在跑的沙箱会话（残留的用 ${SANDBOX_CLEAN_COMMAND} 清理）再试`
    );
  }
  throw new Error(`清空缓存卷 ${volume} 失败：${result.stderr.trim()}`);
}

export function residualNotice(residual: readonly SandboxContainerInfo[]): string {
  const names = residual.map((info) => `${info.name}（会话 ${info.sessionId || "未知"}）`);
  return (
    `发现 ${residual.length} 个进程异常退出留下的沙箱容器：${names.join("、")}。` +
    `里面没交回的改动可用 docker exec 自取；确认不要后执行 ${SANDBOX_CLEAN_COMMAND} 清理`
  );
}

// 在容器里建仓库：bundle 从标准输入读入，取出起点引用（$1）检出到沙箱分支（$2）。
// core.autocrlf 关掉：容器里的仓库不套用宿主全局配置的换行转换，工作区内容与快照逐字节一致
const CLONE_SCRIPT = [
  "set -e",
  'b="$(mktemp)"',
  'cat > "$b"',
  "git init -q .",
  "git config core.autocrlf false",
  'git symbolic-ref HEAD "refs/heads/$2"',
  // 行尾按字节保真：宿主侧（含本机测试的假 docker）系统配置可能是 autocrlf=true，检出会被转成 CRLF
  "git config core.autocrlf false",
  'git fetch -q "$b" "$1"',
  'git update-ref "refs/heads/$2" FETCH_HEAD',
  'git reset -q --hard "refs/heads/$2"',
  'rm -f "$b" .git/FETCH_HEAD',
  `git config user.name ${SANDBOX_COMMITTER.name}`,
  `git config user.email ${SANDBOX_COMMITTER.email}`,
  "git rev-parse HEAD",
].join("\n");

// 交回第一步：把工作区的改动提交到当前 HEAD，沙箱分支（$1）指向它；打印提交号。不执行仓库里的钩子
const COMMIT_SCRIPT = [
  "set -e",
  'g() { git -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }',
  "g add -A",
  'if ! g diff --cached --quiet; then g commit -q --no-verify -m "$2"; fi',
  'g update-ref "refs/heads/$1" HEAD',
  "g rev-parse HEAD",
].join("\n");

// 交回第二步：沙箱分支（$1）相对起点（$2）打 bundle，写到标准输出
const BUNDLE_SCRIPT = [
  "set -e",
  'b="$(mktemp)"',
  'git bundle create "$b" "refs/heads/$1" "^$2" >&2',
  'cat "$b"',
  'rm -f "$b"',
].join("\n");

// 由 root 准备目录：工作区目录（$1）建好交给运行用户（$2）；缓存卷（$3）下各包管理器的子目录建好，卷的属主不是运行用户时
// （新建的卷由 root 所有，或上次以别的 uid 运行过）整卷交给运行用户
const PREPARE_SCRIPT = [
  "set -e",
  'mkdir -p "$1" && chown "$2" "$1"',
  'root="$3"; shift 3',
  'for d in "$@"; do mkdir -p "$root/$d"; done',
  'if [ "$(stat -c %u "$root")" != "$2" ]; then chown -R "$2" "$root"; fi',
]
  .join("\n")
  // $2 在 shift 之后已经不是 uid：把 uid 先存起来
  .replace('root="$3"; shift 3', 'uid="$2"; root="$3"; shift 3')
  .replace('!= "$2" ]; then chown -R "$2"', '!= "$uid" ]; then chown -R "$uid"');

export async function openSandbox(options: OpenSandboxOptions): Promise<Sandbox> {
  const docker = options.docker ?? ["docker"];
  const log = options.log ?? (() => {});
  const { sessionId, network } = options;
  const branch = sandboxBranch(sessionId);
  const cacheVolume = options.cacheVolume ?? SANDBOX_CACHE_VOLUME;
  const cacheRoot = options.cacheRoot ?? SANDBOX_CACHE_ROOT;
  await assertDockerAvailable(docker);

  // 项目须是有提交的 git 仓库（245）：改动以分支交回，没有仓库就无处交回
  const top = hostGit(options.repoRoot, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    throw new Error(
      `沙箱模式要求项目是 git 仓库：${options.repoRoot} 不是 git 仓库。` +
        `沙箱里的改动以新分支（${branch}）交回，没有仓库就无处交回；可先 git init 并提交一次`
    );
  }
  const repo = realpathSync(top.stdout.trim());
  const head = hostGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.code !== 0) {
    throw new Error("沙箱模式要求仓库至少有一个提交：沙箱从当前分支的最新提交起步");
  }
  // 治理根在仓库的子目录里时，容器里的工作区根对应到同一个子目录
  const relative = path.relative(repo, realpathSync(options.repoRoot)).split(path.sep).join("/");
  const cloneRoot = options.containerRoot ?? SANDBOX_ROOT;
  const workspaceRoot = relative === "" ? cloneRoot : path.posix.join(cloneRoot, relative);

  // 残留容器：列出并提示清理命令，不自动删除
  const residual = (await listSandboxContainers(docker)).filter(
    (info) => info.sessionId !== sessionId && isResidualSandbox(info)
  );
  if (residual.length > 0) {
    log(residualNotice(residual));
  }

  // 镜像先就位（首次构建可能要几分钟）：之后再拍快照，快照引用不会因镜像构建或拉取失败而留下
  const spec = options.image ?? resolveSandboxImage(options.repoRoot, options.sandboxConfig ?? {});
  const image = await ensureSandboxImage(spec, { docker, log });
  const runAsFallbackUser = await imageRunsAsRoot(image, docker, log);
  // 决策 333：资源上限；内存未设时按守护进程所在机器内存的一半，读不到即不设并说明
  const memTotal =
    options.limits?.memoryBytes === undefined ? await dockerMemTotal(docker) : undefined;
  const limits = resolveSandboxLimits(options.limits, memTotal);
  if (options.limits?.memoryBytes === undefined && memTotal === undefined) {
    log("读不到 Docker 所在机器的内存总量（docker info 的 MemTotal），本次沙箱不设内存上限");
  }

  const branchLabel = hostGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim();
  const baseLabel = branchLabel !== "" ? branchLabel : head.stdout.trim().slice(0, 12);
  const startRefName = sandboxStartRef(sessionId);
  let startRef: string;
  let startCommit: string;
  let startSnapshot: SandboxStartSnapshot | undefined;
  if (options.resume === true) {
    // 续跑：从该会话交回过的分支接着干
    const tip = hostGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`]);
    if (tip.code !== 0) {
      throw new Error(
        `会话 ${sessionId} 没有交回过沙箱分支 ${branch}：续跑沙箱会话要从它交回的分支接着干。` +
          "它若不是沙箱会话，去掉 --sandbox 续跑"
      );
    }
    startRef = `refs/heads/${branch}`;
    startCommit = tip.stdout.trim();
    // 上次进程异常退出留下的开工快照引用已无用（快照在交回的分支里）
    try {
      deleteSnapshotRef(repo, startRefName);
    } catch {
      // 引用删不掉不挡续跑
    }
  } else if (options.fromHead === true) {
    startRef = "HEAD";
    startCommit = head.stdout.trim();
    const dirty = hostGit(repo, ["status", "--porcelain"]);
    if (dirty.code === 0 && dirty.stdout.trim() !== "") {
      log(
        `工作目录有未提交的改动，按参数不带进沙箱（沙箱从 ${baseLabel} 的最新提交 ${startCommit.slice(0, 12)} 起步）`
      );
    }
  } else {
    // 决策 278：把工作目录里未提交的改动（含未被忽略的新文件）拍成快照，容器从它起步
    let snap: ReturnType<typeof snapshotWorkdir>;
    try {
      snap = snapshotWorkdir({ repoRoot: repo, ref: startRefName });
    } catch (error) {
      throw new Error(
        `拍工作目录快照失败，沙箱没有开：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (snap.snapshot && snap.ref !== undefined) {
      startRef = snap.ref;
      startCommit = snap.commit;
      startSnapshot = { commit: snap.commit, files: snap.files };
      log(`已带入 ${snap.files.length} 个未提交的文件（含新建文件）`);
    } else {
      startRef = "HEAD";
      startCommit = head.stdout.trim();
    }
  }
  // 开工中途失败时把快照引用删掉（快照提交没有别的引用，留着只是垃圾）
  const dropStartRef = (): void => {
    if (startSnapshot !== undefined) {
      try {
        deleteSnapshotRef(repo, startRefName);
      } catch {
        // 引用删不掉不影响结果
      }
    }
  };

  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "pigeon-sandbox-"));
  let bundle: Buffer;
  try {
    const bundleFile = path.join(bundleDir, "start.bundle");
    const created = hostGit(repo, ["bundle", "create", bundleFile, startRef]);
    if (created.code !== 0) {
      throw new Error(`打包起点失败：${created.stderr.trim()}`);
    }
    bundle = readFileSync(bundleFile);
  } catch (error) {
    dropStartRef();
    throw error;
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }

  const container = sandboxContainerName(sessionId);
  const existing = await listSandboxContainers(docker);
  if (existing.some((info) => info.name === container)) {
    dropStartRef();
    throw new Error(
      `已有同名沙箱容器 ${container}（上次进程异常退出留下的？）：里面可能有没交回的改动。` +
        `可用 docker exec 自取，确认不要后执行 ${SANDBOX_CLEAN_COMMAND}，再重开`
    );
  }
  try {
    await startWorkspaceContainer({
      image,
      name: container,
      docker,
      runArgs: [
        ...sandboxNetworkArgs(network),
        "--label",
        `${SANDBOX_LABEL}=${sessionId}`,
        "--label",
        `${SANDBOX_PID_LABEL}=${process.pid}`,
        "--label",
        `${SANDBOX_HOST_LABEL}=${os.hostname()}`,
        "--label",
        `${SANDBOX_REPO_LABEL}=${repo}`,
        // 决策 280：共用下载缓存卷（断网档照样挂）
        ...sandboxCacheArgs(cacheVolume, cacheRoot),
        // 以非 root 用户运行；家目录用 /tmp（任何镜像里都可写）
        ...(runAsFallbackUser ? ["--user", SANDBOX_FALLBACK_USER, "-e", "HOME=/tmp"] : []),
        // 决策 333：内存（交换区不另占）、进程数、CPU 上限
        ...sandboxLimitArgs(limits),
      ],
    });
  } catch (error) {
    dropStartRef();
    throw error;
  }
  const discard = async (): Promise<void> => {
    await removeWorkspaceContainer(container, docker);
    dropStartRef();
  };
  try {
    // 镜像须有 git（247）：建仓库与交回都靠它
    const git = await containerExec({ container, docker, command: ["git", "--version"] });
    if (git.exitCode !== 0) {
      throw new Error(
        `镜像 ${image} 里没有可用的 git（git --version 失败：${(git.stderr || git.stdout).trim()}）：` +
          "沙箱要在容器里用 git 建仓库、把改动提交成分支交回。请换用带 git 的镜像" +
          "（设置 sandbox 一节的 image 或 dockerfile），或去掉该配置用 Pigeon 自带的通用镜像"
      );
    }
    const uid = await containerExec({ container, docker, command: ["id", "-u"] });
    if (uid.exitCode !== 0) {
      throw new Error(`取容器用户失败：${uid.stderr.trim()}`);
    }
    // 工作区目录与缓存卷下的各子目录由 root 建好、交给运行用户
    const prepared = await containerExec({
      container,
      docker,
      user: "0",
      command: [
        "sh",
        "-c",
        PREPARE_SCRIPT,
        "sh",
        cloneRoot,
        uid.stdout.trim(),
        cacheRoot,
        ...SANDBOX_CACHE_DIRS,
      ],
    });
    if (prepared.exitCode !== 0) {
      throw new Error(`准备工作区与缓存目录失败：${prepared.stderr.trim()}`);
    }
    const cloned = await containerExec({
      container,
      docker,
      workdir: cloneRoot,
      command: ["sh", "-c", CLONE_SCRIPT, "sh", startRef, branch],
      stdin: bundle,
      timeoutMs: HEAVY_TIMEOUT_MS,
    });
    if (cloned.exitCode !== 0 || cloned.stdout.trim() !== startCommit) {
      throw new Error(
        `在容器里建仓库失败：${cloned.stderr.trim() || `HEAD 为 ${cloned.stdout.trim()}，应为 ${startCommit}`}`
      );
    }
  } catch (error) {
    await discard().catch(() => {});
    throw error;
  }
  // 开箱即删快照引用（决策 278 修订）：快照提交已进容器的仓库，交回的分支含它；引用只护住拍快照到开箱这一段
  dropStartRef();

  // 决策 333：设了内存上限时，执行端判定命令是否因超出上限被杀，并给人报一行
  const host = createContainerWorkspaceHost({
    container,
    root: workspaceRoot,
    docker,
    ...(limits.memoryBytes > 0
      ? {
          memoryLimit: {
            label: formatBytes(limits.memoryBytes),
            ...(options.oomCounterFiles !== undefined
              ? { counterFiles: options.oomCounterFiles }
              : {}),
          },
        }
      : {}),
    onNotice: options.notice ?? log,
  });
  let closed: SandboxExport | undefined;

  const exportChanges = async (): Promise<SandboxExport> => {
    // 宿主当前检出的就是沙箱分支时不更新：不动当前分支
    const current = hostGit(repo, ["symbolic-ref", "-q", "HEAD"]).stdout.trim();
    if (current === `refs/heads/${branch}`) {
      throw new Error(`宿主仓库当前检出的就是 ${branch}：交回不动当前分支，请先切到别的分支再交回`);
    }
    const committed = await containerExec({
      container,
      docker,
      workdir: cloneRoot,
      command: ["sh", "-c", COMMIT_SCRIPT, "sh", branch, `Pigeon sandbox changes (${sessionId})`],
      timeoutMs: HEAVY_TIMEOUT_MS,
    });
    const commit = committed.stdout.trim().split("\n").pop() ?? "";
    if (committed.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new Error(`在容器里提交改动失败：${committed.stderr.trim()}`);
    }
    // 宿主已有这个提交（没有新提交，或容器里退回了旧提交）：不必打 bundle，直接建分支
    const known = hostGit(repo, ["cat-file", "-e", `${commit}^{commit}`]).code === 0;
    if (known) {
      const updated = hostGit(repo, ["update-ref", `refs/heads/${branch}`, commit]);
      if (updated.code !== 0) {
        throw new Error(`在宿主仓库建分支 ${branch} 失败：${updated.stderr.trim()}`);
      }
    } else {
      const bundled = await containerExec({
        container,
        docker,
        workdir: cloneRoot,
        command: ["sh", "-c", BUNDLE_SCRIPT, "sh", branch, startCommit],
        timeoutMs: HEAVY_TIMEOUT_MS,
      });
      if (bundled.exitCode !== 0) {
        throw new Error(`在容器里打包改动失败：${bundled.stderr.trim()}`);
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), "pigeon-sandbox-"));
      try {
        const file = path.join(dir, "export.bundle");
        writeFileSync(file, bundled.stdoutBytes);
        // 只更新沙箱分支这一条引用：git 不会动当前分支与工作目录；沙箱分支允许被改写（容器里改过历史时）
        const fetched = hostGit(repo, [
          "fetch",
          "-q",
          file,
          `+refs/heads/${branch}:refs/heads/${branch}`,
        ]);
        if (fetched.code !== 0) {
          throw new Error(`宿主仓库取回沙箱分支失败：${fetched.stderr.trim()}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return {
      branch,
      commit,
      changed: commit !== startCommit,
      viewCommand: `git diff ${baseLabel}..${branch}`,
      ...(startSnapshot !== undefined ? { snapshotCommit: startSnapshot.commit } : {}),
    };
  };

  return {
    sessionId,
    container,
    branch,
    image,
    network,
    baseLabel,
    startLabel: options.resume === true ? branch : baseLabel,
    startCommit,
    ...(startSnapshot !== undefined ? { startSnapshot } : {}),
    cacheVolume,
    limits,
    host,
    exportChanges,
    async close() {
      if (closed !== undefined) {
        return closed;
      }
      let result: SandboxExport;
      try {
        result = await exportChanges();
      } catch (error) {
        throw new Error(
          `交回失败，容器 ${container} 保留未删（改动还在里面，可用 docker exec 自取）：` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
      await discard();
      closed = result;
      return result;
    },
    discard,
  };
}

// 镜像缺省以 root 运行时改用非 root 用户；本地没有的镜像先拉取
async function imageRunsAsRoot(
  image: string,
  docker: readonly string[],
  log: (line: string) => void
): Promise<boolean> {
  const inspect = () =>
    dockerOnce(docker, ["image", "inspect", "--format", "{{.Config.User}}", image], 60_000);
  let result = await inspect();
  if (result.exitCode !== 0) {
    log(`本地没有镜像 ${image}，正在拉取`);
    const pulled = await dockerOnce(docker, ["pull", image], HEAVY_TIMEOUT_MS);
    if (pulled.exitCode !== 0) {
      throw new Error(`沙箱镜像 ${image} 本地没有，也拉取不到：${pulled.stderr.trim()}`);
    }
    result = await inspect();
    if (result.exitCode !== 0) {
      throw new Error(`读不到镜像 ${image} 的配置：${result.stderr.trim()}`);
    }
  }
  const user = result.stdout.toString("utf8").trim();
  return user === "" || /^(root|0)(:(root|0))?$/.test(user);
}

// 交回后给人看的一行：分支名与查看命令。决策 278：分支第一条提交是开箱时的未提交改动时加一句，提醒合并前先收起本地的这份改动
export function exportNotice(result: SandboxExport): string {
  const main = result.changed
    ? `沙箱改动已交回到分支 ${result.branch}（${result.commit.slice(0, 12)}）；查看：${result.viewCommand}`
    : `沙箱里没有改动；分支 ${result.branch} 指向起点 ${result.commit.slice(0, 12)}`;
  return result.snapshotCommit !== undefined
    ? `${main}。分支第一条提交（${result.snapshotCommit.slice(0, 12)}）是开箱时的未提交改动；合并前先把本地这份未提交改动收起（stash 或丢弃）`
    : main;
}
