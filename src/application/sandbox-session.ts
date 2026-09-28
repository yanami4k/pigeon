// 日常沙箱的会话接线（决策 237、245–248）：三个入口（终端界面、命令行对话与续跑、pigeon run）开沙箱、接执行端、
// 收尾交回都经这里；容器生命周期本身在 execution/sandbox.ts。Actor（cli / tui）不直连执行层，所需的符号从这里取。
// 沙箱里暂不支持分叉（/fork、失败自动分叉重试）、派 worker 与终端界面的 /resume 换绑：它们作用在宿主的 git 工作区或
// 工作树上，会越出容器。会话验证命令经执行端在容器里运行。
import {
  cleanResidualSandboxes,
  exportNotice,
  findResidualSandboxes,
  type OpenSandboxOptions,
  openSandbox,
  residualNotice,
  SANDBOX_CLEAN_COMMAND,
  type Sandbox,
  type SandboxExport,
} from "../execution/sandbox.ts";
import type { SessionId } from "../state/ids.ts";
import { type HeadlessRetryResult, type HeadlessRunOptions, runHeadless } from "./headless.ts";
import type { LaunchFlags } from "./launch-flags.ts";

export { exportNotice, SANDBOX_CLEAN_COMMAND, type Sandbox, type SandboxExport };

export const SANDBOX_FORK_UNSUPPORTED =
  "沙箱里暂不支持分叉（/fork 与失败自动分叉重试）：分叉要在宿主的 git 工作区上打快照、到独立工作树里续跑，" +
  "而沙箱的工作区在容器里";
export const SANDBOX_WORKERS_UNSUPPORTED =
  "沙箱里暂不支持派 worker（/spawn、/cancel、/workers）：worker 在宿主的 git 工作树里干活，会越出沙箱";
export const SANDBOX_RESUME_UNSUPPORTED =
  "沙箱会话里暂不支持 /resume 换绑：换绑要另开容器。请退出后用 pigeon resume <会话号> --sandbox 续跑";

// 测试注入：docker 调用前缀、镜像来源与容器内工作区根
export type SandboxOverrides = Pick<OpenSandboxOptions, "docker" | "image" | "containerRoot">;

export interface StartSandboxInput {
  flags: Pick<LaunchFlags, "sandbox" | "retryOnFail">;
  governanceRoot: string;
  sessionId: string;
  // 续跑：从该会话交回过的分支起步
  resume?: boolean;
  log: (line: string) => void;
  overrides?: SandboxOverrides;
}

// 按启动参数开沙箱；没给 --sandbox 返回 undefined。与沙箱不相容的参数在起容器之前报错
export async function startSandbox(input: StartSandboxInput): Promise<Sandbox | undefined> {
  const launch = input.flags.sandbox;
  if (launch === undefined) {
    return undefined;
  }
  if ((input.flags.retryOnFail ?? 0) > 0) {
    throw new Error(SANDBOX_FORK_UNSUPPORTED);
  }
  const sandbox = await openSandbox({
    repoRoot: input.governanceRoot,
    sessionId: input.sessionId,
    network: launch.network,
    ...(input.resume === true ? { resume: true } : {}),
    log: input.log,
    ...input.overrides,
  });
  input.log(sandboxReadyNotice(sandbox));
  return sandbox;
}

export function sandboxReadyNotice(sandbox: Sandbox): string {
  return (
    `沙箱已就绪：容器 ${sandbox.container}（镜像 ${sandbox.image}，${sandbox.network === "on" ? "联网" : "断网"}），` +
    `从 ${sandbox.startLabel} 的 ${sandbox.startCommit.slice(0, 12)} 起步；改动交回到分支 ${sandbox.branch}，` +
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

export interface SandboxedHeadlessResult extends HeadlessRetryResult {
  // 交回的分支（交回失败时缺省，原因见 sandboxNotice）
  sandbox?: SandboxExport;
  sandboxNotice?: string;
}

// pigeon run --sandbox：开沙箱、在容器里跑完，返回前交回并删除容器
export async function runHeadlessInSandbox(
  options: Omit<HeadlessRunOptions, "workspaceHost" | "sessionId"> & { sessionId: SessionId },
  input: Omit<StartSandboxInput, "sessionId" | "governanceRoot">
): Promise<SandboxedHeadlessResult> {
  const sandbox = await startSandbox({
    ...input,
    sessionId: options.sessionId,
    governanceRoot: options.governanceRoot,
  });
  if (sandbox === undefined) {
    throw new Error("runHeadlessInSandbox 需要 --sandbox");
  }
  let result: HeadlessRetryResult;
  try {
    result = await runHeadless({ ...options, workspaceHost: sandbox.host });
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

// pigeon sandbox list | clean：列出或清理进程异常退出留下的沙箱容器（在用的不动）
export async function runSandboxCommand(
  argv: readonly string[],
  overrides: Pick<SandboxOverrides, "docker"> = {}
): Promise<string> {
  const usage = "用法：pigeon sandbox list | pigeon sandbox clean";
  if (argv.length !== 1) {
    throw new Error(usage);
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
  throw new Error(usage);
}
