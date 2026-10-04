// 本机进程的认定（决策 365）：后台作业启动时记下进程号、启动时间与标记（Windows 为命令行），崩溃后下次启动据此清理。
// 进程号会被复用：清理前重新核对启动时间与标记（或命令行），不一致即当作进程号已被复用，不杀组长、只删记录，免得误杀
// 使用者的其他程序；查询本身失败（ps、PowerShell 超时等）判为不确定，记录留着下次再试。不论组长在不在，带着标记的子孙
// 都另扫一遍（标记每次随机，碰不到别的程序）。平台取本进程的，不信记录里写的。
// - Linux：启动时间取 /proc/<pid>/stat 的 starttime，标记读 /proc/<pid>/environ，带标记的进程扫 /proc；
// - macOS：启动时间取 ps 的 lstart，标记读 ps eww 带出的环境，带标记的进程扫 ps eww -A；
// - Windows：读不到别的进程的环境变量，以 CIM 取进程的 CreationDate 与命令行，杀进程树（taskkill /T /F）。
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { type JobProcessRecord, RUN_MARKER_VAR } from "./workspace-host.ts";

type LocalRecord = Extract<JobProcessRecord, { kind: "local" }>;

const QUERY_TIMEOUT_MS = 15_000;

// 一次查询的结果：ok 为程序正常结束；exitCode 为它的退出码（被超时杀掉、拉不起来时没有）
interface QueryResult {
  ok: boolean;
  stdout: string;
  exitCode?: number;
}

function query(program: string, args: readonly string[]): Promise<QueryResult> {
  return new Promise((resolve) => {
    execFile(
      program,
      [...args],
      {
        encoding: "utf8",
        timeout: QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ ok: true, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        const killed = (error as { killed?: boolean }).killed === true;
        resolve({
          ok: false,
          stdout: stdout ?? "",
          ...(typeof code === "number" && !killed ? { exitCode: code } : {}),
        });
      }
    );
  });
}

// 进程当前的情形：不在、查不到（不确定）、在（启动时间、Windows 的命令行、是否带着标记）
export type ProcessObservation =
  | { state: "absent" }
  | { state: "unknown" }
  | { state: "present"; startTime: string; commandLine?: string; marked: boolean };

async function linuxObserve(pid: number, marker: string): Promise<ProcessObservation> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { state: "absent" } : { state: "unknown" };
  }
  // 进程名可能含空格与括号：从最后一个右括号之后数，starttime 是第 22 个字段
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (startTime === undefined) return { state: "unknown" };
  return { state: "present", startTime, marked: await linuxCarriesMarker(pid, marker) };
}

async function linuxCarriesMarker(pid: number, marker: string): Promise<boolean> {
  try {
    const environ = await readFile(`/proc/${pid}/environ`, "utf8");
    return environ.split("\0").includes(`${RUN_MARKER_VAR}=${marker}`);
  } catch {
    return false;
  }
}

// macOS：ps 找不到进程时以退出码 1 结束、没有输出
async function darwinObserve(pid: number, marker: string): Promise<ProcessObservation> {
  const lstart = await query("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (!lstart.ok) {
    return lstart.exitCode === 1 && lstart.stdout.trim() === ""
      ? { state: "absent" }
      : { state: "unknown" };
  }
  const startTime = lstart.stdout.trim();
  if (startTime === "") return { state: "absent" };
  const command = await query("ps", ["eww", "-o", "command=", "-p", String(pid)]);
  if (!command.ok) return { state: "unknown" };
  return {
    state: "present",
    startTime,
    marked: command.stdout.includes(`${RUN_MARKER_VAR}=${marker}`),
  };
}

// Windows：CreationDate（UTC，ISO 写法）与命令行，两行；进程不在时 PowerShell 正常结束、没有输出
async function windowsObserve(pid: number): Promise<ProcessObservation> {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    "if ($p) { $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine }";
  const out = await query("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!out.ok) return { state: "unknown" };
  const [startTime = "", ...rest] = out.stdout.replace(/\r/g, "").split("\n");
  if (startTime.trim() === "") return { state: "absent" };
  return {
    state: "present",
    startTime: startTime.trim(),
    commandLine: rest.join("\n").trim(),
    marked: false,
  };
}

export function observeProcess(
  pid: number,
  marker: string,
  platform: NodeJS.Platform = process.platform
): Promise<ProcessObservation> {
  if (platform === "win32") return windowsObserve(pid);
  if (platform === "linux") return linuxObserve(pid, marker);
  return darwinObserve(pid, marker);
}

// 作业启动后记下认进程的信息；取不到（进程已结束、查询失败）为 undefined
export async function localProcessRecord(
  pid: number,
  marker: string
): Promise<LocalRecord | undefined> {
  const found = await observeProcess(pid, marker);
  if (found.state !== "present") return undefined;
  return {
    kind: "local",
    platform: process.platform,
    pid,
    startTime: found.startTime,
    ...(found.commandLine !== undefined ? { commandLine: found.commandLine } : {}),
    marker,
  };
}

// 记录里的进程现在的认定：same 为启动时间一致且带着标记（Windows 为命令行一致）；different 为进程号已被复用
export async function compareLocalProcess(
  record: LocalRecord
): Promise<"same" | "different" | "absent" | "unknown"> {
  const found = await observeProcess(record.pid, record.marker);
  if (found.state !== "present") return found.state;
  if (found.startTime !== record.startTime) return "different";
  const marked =
    process.platform === "win32" ? found.commandLine === record.commandLine : found.marked;
  return marked ? "same" : "different";
}

export type OrphanCleanup = "killed" | "gone" | "reused" | "unknown";

// 崩溃后清理一个本机作业：组长核对一致才杀（Linux/macOS 杀整个进程组，Windows 杀进程树）；不论组长在不在，带着标记的
// 子孙另扫一遍。查询失败交回 unknown（调用方保留记录）
export async function killLocalOrphan(record: LocalRecord): Promise<OrphanCleanup> {
  const verdict = await compareLocalProcess(record);
  if (verdict === "unknown") return "unknown";
  if (verdict === "same") {
    if (process.platform === "win32") {
      await query("taskkill", ["/pid", String(record.pid), "/T", "/F"]);
    } else {
      for (const target of [-record.pid, record.pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // 组或进程已不在
        }
      }
    }
  }
  await killMarked(record.marker);
  return verdict === "same" ? "killed" : verdict === "absent" ? "gone" : "reused";
}

// 带着标记的进程逐个杀（Linux 扫 /proc，macOS 扫 ps eww -A；Windows 读不到环境变量，不扫）
export async function killMarked(marker: string): Promise<void> {
  const pids =
    process.platform === "linux"
      ? await markedLinux(marker)
      : process.platform === "win32"
        ? []
        : await markedDarwin(marker);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
}

async function markedLinux(marker: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid !== process.pid && (await linuxCarriesMarker(pid, marker))) found.push(pid);
  }
  return found;
}

async function markedDarwin(marker: string): Promise<number[]> {
  const listed = await query("ps", ["eww", "-A", "-o", "pid=,command="]);
  if (!listed.ok) return [];
  const needle = `${RUN_MARKER_VAR}=${marker}`;
  return listed.stdout
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
}
