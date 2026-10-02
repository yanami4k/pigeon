// 日常沙箱的会话接线（决策 237、245–248）：三个入口（终端界面、命令行对话与续跑、pigeon run）开沙箱、接执行端、
// 收尾交回都经这里；容器生命周期本身在 execution/sandbox.ts。Actor（cli / tui）不直连执行层，所需的符号从这里取。
// 沙箱里暂不支持分叉（/fork、失败自动分叉重试）、派 worker 与终端界面的 /resume 换绑：它们作用在宿主的 git 工作区或
// 工作树上，会越出容器。会话验证命令经执行端在容器里运行。MCP 服务不启动（决策 252）：它们在宿主上运行，开沙箱时
// 列出已配置却不可用的服务名。
import {
  cleanResidualSandboxes,
  clearCacheVolume,
  exportNotice,
  findResidualSandboxes,
  inspectCacheVolume,
  type OpenSandboxOptions,
  openSandbox,
  residualNotice,
  SANDBOX_CACHE_COMMAND,
  SANDBOX_CLEAN_COMMAND,
  SANDBOX_CLEAR_CACHE_COMMAND,
  type Sandbox,
  type SandboxExport,
  sandboxLimitsSummary,
} from "../execution/sandbox.ts";
import type { SessionId } from "../state/ids.ts";
import { sandboxLimitSettingsOf } from "../state/sandbox-config.ts";
import {
  emptySettingsSnapshot,
  mcpConfigOf,
  type SettingsSnapshot,
  sandboxConfigOf,
} from "../state/settings.ts";
import { type HeadlessRunOptions, type HeadlessRunResult, runHeadless } from "./headless-core.ts";
import type { LaunchFlags } from "./launch-flags.ts";
import { noMcpSession } from "./mcp.ts";

export { exportNotice, SANDBOX_CLEAN_COMMAND, type Sandbox, type SandboxExport };

export const SANDBOX_FORK_UNSUPPORTED =
  "沙箱里暂不支持分叉（/fork）：分叉要在宿主的 git 工作区上打快照、到独立工作树里续跑，" +
  "而沙箱的工作区在容器里";
export const SANDBOX_WORKERS_UNSUPPORTED =
  "沙箱里暂不支持派 worker（/spawn、/cancel、/workers、/take）：worker 在宿主的 git 工作树里干活，会越出沙箱";
export const SANDBOX_RESUME_UNSUPPORTED =
  "沙箱会话里暂不支持 /resume 换绑：换绑要另开容器。请退出后用 pigeon resume <会话号> --sandbox 续跑";

// 测试注入：docker 调用前缀、镜像来源、容器内工作区根与缓存卷
export type SandboxOverrides = Pick<
  OpenSandboxOptions,
  "docker" | "image" | "containerRoot" | "cacheVolume" | "cacheRoot"
>;

export interface StartSandboxInput {
  flags: Pick<LaunchFlags, "sandbox">;
  governanceRoot: string;
  sessionId: string;
  // 续跑：从该会话交回过的分支起步
  resume?: boolean;
  // 决策 325：本会话的设置快照（镜像配置取 sandbox 一节，MCP 服务名取合并后的配置）
  settings?: SettingsSnapshot;
  log: (line: string) => void;
  // 运行中给人看的提示（命令超出沙箱内存上限等）；缺省同 log
  notice?: (line: string) => void;
  overrides?: SandboxOverrides;
}

// 按启动参数开沙箱；没给 --sandbox 返回 undefined。与沙箱不相容的参数在起容器之前报错
export async function startSandbox(input: StartSandboxInput): Promise<Sandbox | undefined> {
  const launch = input.flags.sandbox;
  if (launch === undefined) {
    return undefined;
  }
  // 决策 252：沙箱会话不启动 MCP 服务；配置了的列出来说明不可用，没配不提示
  const settings = input.settings ?? emptySettingsSnapshot(input.governanceRoot);
  const mcpServers = mcpConfigOf(settings).servers.map((server) => server.name);
  if (mcpServers.length > 0) {
    input.log(mcpUnavailableNotice(mcpServers));
  }
  const sandbox = await openSandbox({
    repoRoot: input.governanceRoot,
    sessionId: input.sessionId,
    network: launch.network,
    sandboxConfig: sandboxConfigOf(settings),
    // 决策 333：资源上限取自设置的 sandbox 一节（缺项取缺省）
    limits: sandboxLimitSettingsOf(sandboxConfigOf(settings)),
    ...(input.resume === true ? { resume: true } : {}),
    // 决策 278：--sandbox-from-head 只从最新提交开工
    ...(launch.fromHead === true ? { fromHead: true } : {}),
    log: input.log,
    ...(input.notice !== undefined ? { notice: input.notice } : {}),
    ...input.overrides,
  });
  input.log(sandboxReadyNotice(sandbox));
  return sandbox;
}

export function mcpUnavailableNotice(servers: readonly string[]): string {
  return (
    `沙箱里不启动 MCP 服务：已配置的 ${servers.join("、")} 在本会话不可用` +
    "（MCP 服务在宿主上运行，会越出容器）"
  );
}

export function sandboxReadyNotice(sandbox: Sandbox): string {
  // 决策 278：带了快照时起点是快照提交，写明它是未提交改动的快照
  const start =
    sandbox.startSnapshot !== undefined
      ? `从 ${sandbox.startLabel} 加未提交改动的快照 ${sandbox.startCommit.slice(0, 12)} 起步`
      : `从 ${sandbox.startLabel} 的 ${sandbox.startCommit.slice(0, 12)} 起步`;
  return (
    `沙箱已就绪：容器 ${sandbox.container}（镜像 ${sandbox.image}，${sandbox.network === "on" ? "联网" : "断网"}，` +
    `下载缓存共用卷 ${sandbox.cacheVolume}；${sandboxLimitsSummary(sandbox.limits)}），${start}；改动交回到分支 ${sandbox.branch}，` +
    "会话结束时自动交回，会话中可用 /export 手动交回"
  );
}

// 收尾交回：成功给出分支与查看命令，失败给出原因（容器保留）；两者都是给人看的一行
export async function closeSandbox(
  sandbox: Sandbox
): Promise<{ notice: string; exported?: SandboxExport }> {
  try {
    const exported = await sandbox.close();
    return { notice: exportNotice(exported), exported };
  } catch (error) {
    return { notice: error instanceof Error ? error.message : String(error) };
  }
}

// /export：会话中手动交回
export async function exportSandbox(sandbox: Sandbox): Promise<string> {
  try {
    return exportNotice(await sandbox.exportChanges());
  } catch (error) {
    return `交回失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface SandboxedHeadlessResult extends HeadlessRunResult {
  // 交回的分支（交回失败时缺省，原因见 sandboxNotice）
  sandbox?: SandboxExport;
  sandboxNotice?: string;
}

// pigeon run --sandbox：开沙箱、在容器里跑完，返回前交回并删除容器
export async function runHeadlessInSandbox(
  options: Omit<HeadlessRunOptions, "workspaceHost" | "sessionId"> & { sessionId: SessionId },
  input: Omit<StartSandboxInput, "sessionId" | "governanceRoot" | "settings">
): Promise<SandboxedHeadlessResult> {
  const sandbox = await startSandbox({
    ...input,
    sessionId: options.sessionId,
    governanceRoot: options.governanceRoot,
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
  });
  if (sandbox === undefined) {
    throw new Error("runHeadlessInSandbox 需要 --sandbox");
  }
  let result: HeadlessRunResult;
  try {
    // 决策 252：不启动 MCP 服务
    result = await runHeadless({ ...options, workspaceHost: sandbox.host, startMcp: noMcpSession });
  } catch (error) {
    // 装配前就被拒（参数不相容等）：没有改动可交回，直接删容器
    await sandbox.discard().catch(() => {});
    throw error;
  }
  const closed = await closeSandbox(sandbox);
  return {
    ...result,
    ...(closed.exported !== undefined ? { sandbox: closed.exported } : {}),
    sandboxNotice: closed.notice,
  };
}

export const SANDBOX_COMMAND_USAGE =
  "用法：pigeon sandbox list | clean | cache | clear-cache（list/clean：残留的沙箱容器；cache/clear-cache：共用下载缓存的占用与清空）";

// pigeon sandbox list | clean：列出或清理进程异常退出留下的沙箱容器（在用的不动）；
// pigeon sandbox cache | clear-cache（决策 280）：查看共用下载缓存卷的占用、清空缓存
export async function runSandboxCommand(
  argv: readonly string[],
  overrides: Pick<SandboxOverrides, "docker" | "cacheVolume"> = {}
): Promise<string> {
  if (argv.length !== 1) {
    throw new Error(SANDBOX_COMMAND_USAGE);
  }
  if (argv[0] === "list") {
    const residual = await findResidualSandboxes(overrides.docker);
    return residual.length === 0 ? "没有残留的沙箱容器\n" : `${residualNotice(residual)}\n`;
  }
  if (argv[0] === "clean") {
    const removed = await cleanResidualSandboxes(overrides.docker);
    return removed.length === 0
      ? "没有残留的沙箱容器\n"
      : `已删除 ${removed.length} 个残留的沙箱容器：${removed.join("、")}\n`;
  }
  if (argv[0] === "cache") {
    const info = await inspectCacheVolume(overrides.docker, overrides.cacheVolume);
    if (!info.exists) {
      return `沙箱下载缓存卷 ${info.volume} 尚未建立（开过沙箱后自动建立）\n`;
    }
    const inUse =
      info.links !== undefined && info.links > 0 ? `，${info.links} 个沙箱容器正在使用` : "";
    return `沙箱下载缓存卷 ${info.volume}：占用 ${info.size}${inUse}；清空：${SANDBOX_CLEAR_CACHE_COMMAND}\n`;
  }
  if (argv[0] === "clear-cache") {
    const outcome = await clearCacheVolume(overrides.docker, overrides.cacheVolume);
    return outcome === "removed"
      ? "已清空沙箱下载缓存（卷已删除，下次开沙箱自动重建）\n"
      : `沙箱下载缓存本就是空的（卷不存在）；占用可用 ${SANDBOX_CACHE_COMMAND} 查看\n`;
  }
  throw new Error(SANDBOX_COMMAND_USAGE);
}
