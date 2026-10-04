// 本机进程的认定（决策 365）：后台作业启动时记下进程号、启动时间与标记（Windows 为命令行），崩溃后下次启动据此清理。
// 进程号会被复用：清理前重新核对启动时间与标记（或命令行），不一致即当作进程号已被复用，不杀、只删记录，免得误杀
// 使用者的其他程序。
// - Linux：启动时间取 /proc/<pid>/stat 的 starttime，标记读 /proc/<pid>/environ；同组之外带标记的子孙另扫 /proc 补杀；
// - macOS：启动时间取 ps 的 lstart，标记读 ps eww 带出的环境；
// - Windows：读不到别的进程的环境变量，以 CIM 取进程的 CreationDate 与命令行，杀进程树（taskkill /T /F）。
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { type JobProcessRecord, RUN_MARKER_VAR } from "./workspace-host.ts";

type LocalRecord = Extract<JobProcessRecord, { kind: "local" }>;

const QUERY_TIMEOUT_MS = 15_000;

function run(program: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      program,
      [...args],
      { encoding: "utf8", timeout: QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : undefined)
    );
  });
}

// /proc/<pid>/stat 的 starttime（第 22 个字段；进程名可能含空格与括号，从最后一个右括号之后数）
async function linuxStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

async function linuxCarriesMarker(pid: number, marker: string): Promise<boolean> {
  try {
    const environ = await readFile(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(`${RUN_MARKER_VAR}=${marker}`);
  } catch {
    return false;
  }
}

// Windows：CreationDate（UTC，ISO 写法）与命令行，两行
async function windowsProcess(
  pid: number
): Promise<{ startTime: string; commandLine: string } | undefined> {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    "if ($p) { $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine }";
  const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (out === undefined) return undefined;
  const [startTime = "", ...rest] = out.replace(/\r/g, "").split("\n");
  if (startTime.trim() === "") return undefined;
  return { startTime: startTime.trim(), commandLine: rest.join("\n").trim() };
}

// 进程当前的认定信息（不在为 undefined）
async function observe(
  pid: number,
  marker: string,
  platform: NodeJS.Platform
): Promise<{ startTime: string; commandLine?: string; marked: boolean } | undefined> {
  if (platform === "win32") {
    const found = await windowsProcess(pid);
    return found === undefined ? undefined : { ...found, marked: false };
  }
  if (platform === "linux") {
    const startTime = await linuxStartTime(pid);
    return startTime === undefined
      ? undefined
      : { startTime, marked: await linuxCarriesMarker(pid, marker) };
  }
  const lstart = (await run("ps", ["-o", "lstart=", "-p", String(pid)]))?.trim();
  if (lstart === undefined || lstart === "") return undefined;
  const command = (await run("ps", ["eww", "-o", "command=", "-p", String(pid)])) ?? "";
  return { startTime: lstart, marked: command.includes(`${RUN_MARKER_VAR}=${marker}`) };
}

// 作业启动后记下认进程的信息；取不到（进程已结束等）为 undefined
export async function localProcessRecord(
  pid: number,
  marker: string,
  platform: NodeJS.Platform = process.platform
): Promise<LocalRecord | undefined> {
  const found = await observe(pid, marker, platform);
  if (found === undefined) return undefined;
  return {
    kind: "local",
    platform,
    pid,
    startTime: found.startTime,
    ...(found.commandLine !== undefined ? { commandLine: found.commandLine } : {}),
    marker,
  };
}

// 记录里的进程是否还是同一个：启动时间一致，且带着标记（Windows 为命令行一致）
export async function sameLocalProcess(record: LocalRecord): Promise<boolean> {
  const found = await observe(record.pid, record.marker, record.platform);
  if (found === undefined || found.startTime !== record.startTime) return false;
  return record.platform === "win32" ? found.commandLine === record.commandLine : found.marked;
}

export type OrphanCleanup = "killed" | "gone" | "reused";

// 崩溃后清理一个本机作业：核对一致才杀（Linux/macOS 杀整个进程组，Linux 另扫带标记的子孙；Windows 杀进程树）
export async function killLocalOrphan(record: LocalRecord): Promise<OrphanCleanup> {
  if (!(await sameLocalProcess(record))) {
    return (await observe(record.pid, record.marker, record.platform)) === undefined
      ? "gone"
      : "reused";
  }
  if (record.platform === "win32") {
    await run("taskkill", ["/pid", String(record.pid), "/T", "/F"]);
    return "killed";
  }
  for (const target of [-record.pid, record.pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // 组或进程已不在
    }
  }
  if (record.platform === "linux") {
    await killMarkedLinux(record.marker);
  }
  return "killed";
}

// Linux：带着标记的进程（离开了作业的进程组的子孙）逐个杀；标记每次随机，不会碰到别的程序
export async function killMarkedLinux(marker: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid || !(await linuxCarriesMarker(pid, marker))) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
}
