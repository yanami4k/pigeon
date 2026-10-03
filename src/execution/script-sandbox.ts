// 编排脚本的隔离执行（决策 310）：每次脚本运行起一个专用容器，不挂任何工作目录、不联网（--network none），限内存、交换、
// 进程数与 CPU，只读根文件系统、去掉全部能力；容器里用 node -e 运行执行器（docker/script/executor.cjs），脚本在执行器的
// 受限上下文里跑。宿主与执行器之间只有标准输入输出一条通道，每行一个 JSON（消息形状见下）。
// 镜像用日常沙箱的通用镜像（决策 247：含 Node 24），镜像与容器的数据照现有沙箱留在 Docker 自己的存储里，不另挂目录；
// 容器以 --rm 起，脚本结束或被停即删掉。
// 测试另有本机进程版：同一个执行器以本机 node 运行（同一套受限上下文，没有容器那层隔离），用来驱动积木与续跑等用例；
// 容器参数由单独的用例钉住，服务器上另有真容器的端到端用例。
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageFileUrl } from "../state/package-paths.ts";

// 执行器（随包，源码与打包产物运行时都在包根下）
export const SCRIPT_EXECUTOR_FILE = fileURLToPath(packageFileUrl("docker/script/executor.cjs"));

// 容器的资源上限
export const SCRIPT_CONTAINER_LIMITS = {
  memory: "256m",
  pids: 64,
  cpus: "1",
  // 执行器进程的堆上限（MB），留出容器内存的余量
  heapMb: 192,
} as const;

// 容器标签：残留清理与核对用
export const SCRIPT_CONTAINER_LABEL = "pigeon.script";

// 宿主 → 执行器
export type ScriptHostMessage =
  | { t: "start"; source: string; args: unknown }
  | { t: "result"; id: number; value: unknown };

// 执行器 → 宿主
export type ScriptExecutorMessage =
  | { t: "call"; id: number; op: "agent"; payload: unknown }
  | { t: "phase"; text: string }
  | { t: "log"; text: string }
  | { t: "done"; value: unknown }
  | { t: "error"; message: string };

export interface ScriptProcess {
  send(message: ScriptHostMessage): void;
  // 执行器的每条消息；读不懂的行按 error 交出
  onMessage(listener: (message: ScriptExecutorMessage) => void): void;
  // 进程退出（退出码与标准错误输出的末尾）
  readonly exited: Promise<{ code: number | null; stderr: string }>;
  // 停掉：容器即删掉，本机进程即杀掉
  kill(): Promise<void>;
}

export type ScriptLauncher = (input: { runId: string }) => ScriptProcess;

export function executorSource(): string {
  return readFileSync(SCRIPT_EXECUTOR_FILE, "utf8");
}

// 容器名：同一运行号可能起多次（续跑），带上序号
export function scriptContainerName(runId: string, attempt: number): string {
  return `pigeon-script-${runId}-${attempt}`;
}

// docker run 的参数（不含 docker 本身）：不挂目录、断网、限资源、只读根、去能力、不提权
export function scriptContainerArgs(input: {
  image: string;
  name: string;
  source: string;
}): string[] {
  return [
    "run",
    "-i",
    "--rm",
    "--name",
    input.name,
    "--label",
    `${SCRIPT_CONTAINER_LABEL}=1`,
    "--network",
    "none",
    "--memory",
    SCRIPT_CONTAINER_LIMITS.memory,
    "--memory-swap",
    SCRIPT_CONTAINER_LIMITS.memory,
    "--pids-limit",
    String(SCRIPT_CONTAINER_LIMITS.pids),
    "--cpus",
    SCRIPT_CONTAINER_LIMITS.cpus,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    input.image,
    "node",
    `--max-old-space-size=${SCRIPT_CONTAINER_LIMITS.heapMb}`,
    "-e",
    input.source,
  ];
}

function wrap(child: ChildProcess, kill: () => Promise<void>): ScriptProcess {
  const listeners: Array<(message: ScriptExecutorMessage) => void> = [];
  const emit = (message: ScriptExecutorMessage): void => {
    for (const listener of listeners) listener(message);
  };
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() === "") continue;
      try {
        emit(JSON.parse(line) as ScriptExecutorMessage);
      } catch {
        emit({ t: "error", message: `执行器输出了读不懂的一行：${line.slice(0, 200)}` });
      }
    }
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  // 执行器提前退出时写端会报 EPIPE：以退出为准
  child.stdin?.on("error", () => {});
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (error) => {
      stderr = `${stderr}\n${error.message}`.trim();
      resolve({ code: null, stderr });
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  return {
    send: (message) => {
      if (child.stdin?.writable === true) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (listener) => {
      listeners.push(listener);
    },
    exited,
    kill,
  };
}

// 真容器：docker run -i --rm，镜像为日常沙箱的通用镜像
export function dockerScriptLauncher(options: {
  image: string;
  docker?: readonly string[];
}): ScriptLauncher {
  const [program = "docker", ...prefix] = options.docker ?? ["docker"];
  const source = executorSource();
  let attempt = 0;
  return ({ runId }) => {
    attempt += 1;
    const name = scriptContainerName(runId, attempt);
    const child = spawn(
      program,
      [...prefix, ...scriptContainerArgs({ ...options, name, source })],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    return wrap(child, async () => {
      await new Promise<void>((resolve) => {
        const remover = spawn(program, [...prefix, "rm", "-f", name], {
          stdio: "ignore",
          windowsHide: true,
        });
        remover.on("error", () => resolve());
        remover.on("close", () => resolve());
      });
      child.kill("SIGKILL");
    });
  };
}

// 本机进程：同一个执行器以本机 node 运行（测试用；没有容器那层隔离）
export function localScriptLauncher(): ScriptLauncher {
  const source = executorSource();
  return () => {
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return wrap(child, async () => {
      child.kill("SIGKILL");
    });
  };
}
