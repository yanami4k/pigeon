// 本机子进程的整树终止（决策 098：执行端"超时或中止后必须保证该命令起的进程不残留"）。
// 现象：子进程常再起孙进程（/bin/sh -c 里的 node、npm test 起的 node --test、pytest 等），
// 只对直接子进程发信号时孙进程成为孤儿继续跑。本模块把"以独立进程组拉起、终止时对整组发信号"
// 收成一处，供 check-command、local-host、mcp/transport 三处共用。容器执行端另有整树终止，不经此处。
import { type ChildProcess, execFile } from "node:child_process";

// 非 Windows 才以独立进程组拉起（detached）：子进程成为进程组组长（pgid = pid），终止时对整组发信号即可覆盖孙进程。
// Windows 上 detached 会另开控制台窗口，且整树终止走 taskkill /T，不需要独立进程组，故只在非 Windows 设。
export const useProcessGroup = process.platform !== "win32";

// spawn 选项片段：展开进 spawn 的 options。只在非 Windows 设 detached。
export function processGroupSpawnOptions(): { detached: boolean } {
  return { detached: useProcessGroup };
}

// 整树终止：
// - 非 Windows：以负 pid 对整个进程组发信号；组已不在（都退了）或无权时回退到直接子进程，仍无进程则忽略。
// - Windows：taskkill /pid <pid> /T /F 递归终止整棵树；拉不起 taskkill 时回退到直接子进程。
// signal 由调用方按各自语义选择（超时/中止用 SIGKILL，MCP 关闭先礼后兵用 SIGTERM）。
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    // 还没拿到 pid（未成功 spawn）：尽力对直接子进程发信号
    tryKill(child, signal);
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error !== null) {
        tryKill(child, signal);
      }
    });
    return;
  }
  try {
    // 负 pid = 对进程组发信号（子进程以 detached 拉起，是组长）
    process.kill(-pid, signal);
  } catch {
    // 组已不在或无权：回退到直接子进程
    tryKill(child, signal);
  }
}

function tryKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // 进程已退出：无需处理
  }
}

// 进程正常退出时的兜底（尽力而为，决策 098）：独立进程组不随 Pigeon 一同被终端信号带走，
// Pigeon 进程退出时仍在跑的子进程组要一并终止，不留孤儿。各处在 spawn 后 track、决议后 untrack。
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

export function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // exit 处理器只能做同步收尾：process.kill 是同步的；Windows 上无法在此同步跑 taskkill，退回直接子进程。
    process.once("exit", killTrackedChildren);
  }
}

export function untrackChild(child: ChildProcess): void {
  liveChildren.delete(child);
}

// 导出供测试直接触发（真的让进程退出无法在测试里断言）
export function killTrackedChildren(): void {
  for (const child of liveChildren) {
    const pid = child.pid;
    if (pid === undefined) {
      continue;
    }
    try {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      // 已退出或组已不在：忽略
    }
  }
  liveChildren.clear();
}
