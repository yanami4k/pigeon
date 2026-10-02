// 钩子命令的执行（决策 323 / 324）：一行命令经系统 shell 执行（POSIX /bin/sh -c、Windows cmd.exe /d /s /c），
// 事件信息以 JSON 经标准输入交给命令；stdout 与 stderr 分开取回（协议要区分：stdout 是 JSON 输出，stderr 是拦下理由）。
// 超时或取消时杀掉整棵进程树：非 Windows 以独立进程组起子进程、杀整组；Windows 用 taskkill /T /F（tools/process-tree.ts）。
// 执行位置（324）：本机会话在本机、沙箱会话在容器里（经执行端），单个钩子可指定在宿主执行——两路执行器在本文件；
// 容器内的超时先按执行端现有做法（重启容器终止），第二步合入沙箱一段后改为容器内 timeout 加客户端兜底。
import { type ChildProcess, spawn } from "node:child_process";
import { createHeadCollector } from "../tools/local-host.ts";
import {
  killProcessTree,
  processGroupSpawnOptions,
  trackChild,
  untrackChild,
} from "../tools/process-tree.ts";
import type { HostExecPlan, WorkspaceHost } from "../tools/workspace-host.ts";

// 两路输出各自取回的上限（协议：stdout 为 JSON 输出、stderr 为理由，均远小于此）
export const HOOK_STREAM_CAP = 64 * 1024;
// 终止后等 close 的宽限（同 local-host：孙进程占着管道时 close 迟迟不来）
const KILL_GRACE_MS = 5000;

export interface HookCommandInput {
  command: string;
  // 工作目录（本地：工作区根；经执行端：容器内工作区根）
  cwd: string;
  platform: NodeJS.Platform;
  // 交给命令的标准输入（事件 JSON）
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  // 追加的环境变量（PIGEON_PROJECT_DIR 等；缺省 process.env）
  env?: NodeJS.ProcessEnv;
}

export interface HookCommandOutcome {
  // 进程是否已启动（启动后超时/出错，副作用都可能已发生）
  spawned: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}

// 一行命令 → shell 启动计划（口径同 run_command：Windows cmd.exe /d /s /c 去掉首尾一对引号后逐字执行）
export function hookShellPlan(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): HostExecPlan {
  if (platform === "win32") {
    const comspec = Object.entries(env).find(([key]) => key.toUpperCase() === "COMSPEC")?.[1];
    return {
      program: comspec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      verbatim: true,
    };
  }
  return { program: "/bin/sh", args: ["-c", command], verbatim: false };
}

// 本机执行（本机会话的钩子、沙箱会话里指定 host:true 的钩子）
export function runHookCommandLocal(input: HookCommandInput): Promise<HookCommandOutcome> {
  const started = Date.now();
  const env = input.env ?? process.env;
  const plan = hookShellPlan(input.command, input.platform, env);
  const stdout = createHeadCollector(HOOK_STREAM_CAP);
  const stderr = createHeadCollector(HOOK_STREAM_CAP);
  const { promise, resolve } = Promise.withResolvers<HookCommandOutcome>();
  let timedOut = false;
  let settled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let child: ChildProcess | undefined;
  const finish = (
    partial: Pick<HookCommandOutcome, "spawned" | "exitCode"> & {
      spawnError?: NodeJS.ErrnoException;
    }
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(grace);
    if (child !== undefined) untrackChild(child);
    resolve({
      ...partial,
      timedOut,
      durationMs: Date.now() - started,
      stdout: stdout.finish().output,
      stderr: stderr.finish().output,
    });
  };
  try {
    child = spawn(plan.program, plan.args, {
      cwd: input.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      ...processGroupSpawnOptions(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
  } catch (error) {
    finish({ spawned: false, exitCode: null, spawnError: error as NodeJS.ErrnoException });
    return promise;
  }
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.on("error", () => {
    // 命令没读 stdin 就退出（EPIPE）：不是故障
  });
  child.stdin?.end(input.stdin);
  const terminate = (): void => {
    if (child !== undefined) killProcessTree(child, "SIGKILL");
    if (grace === undefined) {
      grace = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.stdin?.destroy();
        finish({ spawned: child?.pid !== undefined, exitCode: null });
      }, KILL_GRACE_MS);
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  const onAbort = (): void => terminate();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = (): void => {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  };
  child.on("error", (error: NodeJS.ErrnoException) => {
    cleanup();
    finish({ spawned: child?.pid !== undefined, exitCode: null, spawnError: error });
  });
  child.on("close", (code) => {
    cleanup();
    finish({ spawned: true, exitCode: code });
  });
  return promise;
}

// 经执行端在容器里执行（沙箱会话的钩子，324）：命令以 /bin/sh -c 在容器内的工作区根跑；
// 超时与取消沿用执行端的做法（客户端断开并重启容器，见 container-host.ts）；两路输出由执行端分开取回
export async function runHookCommandViaHost(
  host: WorkspaceHost,
  input: HookCommandInput
): Promise<HookCommandOutcome> {
  const started = Date.now();
  const env = input.env ?? process.env;
  const plan = hookShellPlan(input.command, "linux", env);
  if (input.signal?.aborted === true) {
    return {
      spawned: false,
      exitCode: null,
      timedOut: false,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: "",
    };
  }
  const result = await host.exec(plan, {
    // 宿主环境不渗进容器：只带协议要求的 PIGEON_PROJECT_DIR，值为容器内的工作区根
    env: { PIGEON_PROJECT_DIR: host.root },
    timeoutMs: input.timeoutMs,
    maxOutputBytes: HOOK_STREAM_CAP,
    signal: input.signal,
    stdin: input.stdin,
  });
  return {
    spawned: result.spawned,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
  };
}
