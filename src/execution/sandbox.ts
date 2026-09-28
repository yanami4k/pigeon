// 日常沙箱（决策 237、245–248）：日常入口（终端界面、命令行对话、pigeon run）可选在一个一次性的 Docker 容器里工作。
// 本模块只管容器的生命周期与改动交回，工具经容器执行端（container-host.ts）读写与执行；会话文件、.pigeon/learned 等
// 仍在宿主的治理根，不进容器。
//   开工：从当前分支的 HEAD（续跑时从该会话交回过的分支）打 git bundle，经标准输入送进新容器，在容器里建仓库并检出到
//         pigeon/sandbox-<会话号>；工作目录里未提交的改动不带进去（开工时提示一行）。容器以非 root 用户运行，
//         带 pigeon.sandbox 标签（值为会话号），便于识别与清理。镜像须有 git，开工时检查。
//   交回（245）：容器内把改动提交到 pigeon/sandbox-<会话号>，打 bundle 取出，在宿主仓库 git fetch 成同名分支。不动
//         当前分支、工作目录与未提交的改动，不经网络，不自动推送。
//   收尾：交回一次后删除容器；交回失败即保留容器，改动还在里面。
//   残留：进程异常退出留下的带标签容器，开沙箱时列出并给出清理命令，不自动删除。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import {
  containerExec,
  createContainerWorkspaceHost,
  dockerOnce,
  NO_NETWORK_ARGS,
  removeWorkspaceContainer,
  startWorkspaceContainer,
} from "./container-host.ts";
import {
  ensureSandboxImage,
  loadSandboxConfig,
  resolveSandboxImage,
  type SandboxImageSpec,
} from "./sandbox-image.ts";

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
}

export interface Sandbox {
  readonly sessionId: string;
  readonly container: string;
  readonly branch: string;
  readonly image: string;
  readonly network: SandboxNetwork;
  // 开工时宿主当前分支名（分离头指针时为短提交号）：查看命令以它为比较基准
  readonly baseLabel: string;
  // 起点：新开时为宿主当前分支，续跑时为交回过的沙箱分支；及其提交
  readonly startLabel: string;
  readonly startCommit: string;
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
  // 镜像来源（缺省按项目的 .pigeon/sandbox.json 与环境变量解析）
  image?: SandboxImageSpec;
  docker?: readonly string[];
  // 容器内的工作区根（缺省 /workspace；测试的假 docker 指到本机临时目录）
  containerRoot?: string;
  // 开工时给人看的提示（未提交改动、残留容器、首次构建镜像）
  log?: (line: string) => void;
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

// 清理命令：只删残留容器，在用的不动；返回删掉的容器名
export async function cleanResidualSandboxes(
  docker: readonly string[] = ["docker"],
  probe?: Parameters<typeof isResidualSandbox>[1]
): Promise<string[]> {
  const residual = await findResidualSandboxes(docker, probe);
  for (const info of residual) {
    await removeWorkspaceContainer(info.name, docker);
  }
  return residual.map((info) => info.name);
}

export const SANDBOX_CLEAN_COMMAND = "pigeon sandbox clean";

export function residualNotice(residual: readonly SandboxContainerInfo[]): string {
  const names = residual.map((info) => `${info.name}（会话 ${info.sessionId || "未知"}）`);
  return (
    `发现 ${residual.length} 个进程异常退出留下的沙箱容器：${names.join("、")}。` +
    `里面没交回的改动可用 docker exec 自取；确认不要后执行 ${SANDBOX_CLEAN_COMMAND} 清理`
  );
}

// 在容器里建仓库：bundle 从标准输入读入，取出起点引用（$1）检出到沙箱分支（$2）
const CLONE_SCRIPT = [
  "set -e",
  'b="$(mktemp)"',
  'cat > "$b"',
  "git init -q .",
  'git symbolic-ref HEAD "refs/heads/$2"',
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

export async function openSandbox(options: OpenSandboxOptions): Promise<Sandbox> {
  const docker = options.docker ?? ["docker"];
  const log = options.log ?? (() => {});
  const { sessionId, network } = options;
  const branch = sandboxBranch(sessionId);
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

  const branchLabel = hostGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim();
  const baseLabel = branchLabel !== "" ? branchLabel : head.stdout.trim().slice(0, 12);
  let startRef: string;
  let startCommit: string;
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
  } else {
    startRef = "HEAD";
    startCommit = head.stdout.trim();
    const dirty = hostGit(repo, ["status", "--porcelain"]);
    if (dirty.code === 0 && dirty.stdout.trim() !== "") {
      log(
        `工作目录有未提交的改动，这些改动不会带进沙箱（沙箱从 ${baseLabel} 的最新提交 ${startCommit.slice(0, 12)} 起步）`
      );
    }
  }

  const spec =
    options.image ?? resolveSandboxImage(options.repoRoot, loadSandboxConfig(options.repoRoot));
  const image = await ensureSandboxImage(spec, { docker, log });
  const runAsFallbackUser = await imageRunsAsRoot(image, docker, log);

  const bundleDir = mkdtempSync(path.join(os.tmpdir(), "pigeon-sandbox-"));
  let bundle: Buffer;
  try {
    const bundleFile = path.join(bundleDir, "start.bundle");
    const created = hostGit(repo, ["bundle", "create", bundleFile, startRef]);
    if (created.code !== 0) {
      throw new Error(`打包起点失败：${created.stderr.trim()}`);
    }
    bundle = readFileSync(bundleFile);
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }

  const container = sandboxContainerName(sessionId);
  const existing = await listSandboxContainers(docker);
  if (existing.some((info) => info.name === container)) {
    throw new Error(
      `已有同名沙箱容器 ${container}（上次进程异常退出留下的？）：里面可能有没交回的改动。` +
        `可用 docker exec 自取，确认不要后执行 ${SANDBOX_CLEAN_COMMAND}，再重开`
    );
  }
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
      // 以非 root 用户运行；家目录用 /tmp（任何镜像里都可写）
      ...(runAsFallbackUser ? ["--user", SANDBOX_FALLBACK_USER, "-e", "HOME=/tmp"] : []),
    ],
  });
  const discard = () => removeWorkspaceContainer(container, docker);
  try {
    // 镜像须有 git（247）：建仓库与交回都靠它
    const git = await containerExec({ container, docker, command: ["git", "--version"] });
    if (git.exitCode !== 0) {
      throw new Error(
        `镜像 ${image} 里没有可用的 git（git --version 失败：${(git.stderr || git.stdout).trim()}）：` +
          "沙箱要在容器里用 git 建仓库、把改动提交成分支交回。请换用带 git 的镜像" +
          "（.pigeon/sandbox.json 的 image 或 dockerfile），或去掉该配置用 Pigeon 自带的通用镜像"
      );
    }
    const uid = await containerExec({ container, docker, command: ["id", "-u"] });
    if (uid.exitCode !== 0) {
      throw new Error(`取容器用户失败：${uid.stderr.trim()}`);
    }
    // 工作区目录由 root 建好、交给运行用户
    const prepared = await containerExec({
      container,
      docker,
      user: "0",
      command: ["sh", "-c", 'mkdir -p "$1" && chown "$2" "$1"', "sh", cloneRoot, uid.stdout.trim()],
    });
    if (prepared.exitCode !== 0) {
      throw new Error(`准备工作区目录失败：${prepared.stderr.trim()}`);
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

  const host = createContainerWorkspaceHost({ container, root: workspaceRoot, docker });
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

// 交回后给人看的一行：分支名与查看命令
export function exportNotice(result: SandboxExport): string {
  return result.changed
    ? `沙箱改动已交回到分支 ${result.branch}（${result.commit.slice(0, 12)}）；查看：${result.viewCommand}`
    : `沙箱里没有改动；分支 ${result.branch} 指向起点 ${result.commit.slice(0, 12)}`;
}
