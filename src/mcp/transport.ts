// MCP 传输创建（M5.7 S2，决策 041 / 055）：启动定义来自人写的配置。streamable HTTP 直接用 sdk 传输；
// stdio 用自有传输——sdk 的 StdioClientTransport 以 shell:false 直接 spawn 且不支持逐字命令行，Windows 上
// 拉不起 npx 这类 .cmd；这里按 048 的启动计划（直接 / cmd.exe 启动器 / shell）spawn。
// 子进程环境 = 048 白名单透传的运行所需变量 + 配置里显式给的 env（密钥只经人写的配置显式传入）。
import { type ChildProcess, spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpLaunch } from "../state/mcp-config.ts";
import {
  killProcessTree,
  processGroupSpawnOptions,
  trackChild,
  untrackChild,
} from "../tools/process-tree.ts";
import { allowedEnv, type McpLaunchPlan, planMcpLaunch } from "../tools/run-command.ts";

// stderr 只留尾部供诊断，不入账
const STDERR_TAIL_CHARS = 4000;
// 关闭时等 server 自行退出的时间，超时强制结束进程树
const CLOSE_GRACE_MS = 2000;

export interface McpTransportContext {
  // server 进程的工作目录（worker 工作树或主仓库根）
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function createMcpTransport(launch: McpLaunch, context: McpTransportContext): Transport {
  if (launch.type === "http") {
    return new LazyHttpTransport(new URL(launch.url));
  }
  const env = { ...allowedEnv(context.env ?? process.env), ...(launch.env ?? {}) };
  const plan = planMcpLaunch({
    command: launch.command,
    args: launch.args ?? [],
    cwd: context.cwd,
    env,
    ...(context.platform !== undefined ? { platform: context.platform } : {}),
  });
  return new PigeonStdioTransport(plan, {
    cwd: context.cwd,
    env,
    platform: context.platform ?? process.platform,
  });
}

// sdk 1.30.0 的 streamableHttp.d.ts 在 exactOptionalPropertyTypes 下与 Transport 接口不自洽，本仓库不跳过库检查、
// 不升级不改 sdk：经非字面量说明符在 start 时动态加载，类型检查不触达该声明文件，运行时行为不变
const STREAMABLE_HTTP_MODULE: string = "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface HttpTransportModule {
  StreamableHTTPClientTransport: new (
    url: URL
  ) => Transport & {
    setProtocolVersion?: (version: string) => void;
  };
}

class LazyHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #url: URL;
  #inner: (Transport & { setProtocolVersion?: (version: string) => void }) | undefined;

  constructor(url: URL) {
    this.#url = url;
  }

  async start(): Promise<void> {
    // 动态 import 的合理例外：见 STREAMABLE_HTTP_MODULE 注释
    const module = (await import(STREAMABLE_HTTP_MODULE)) as HttpTransportModule;
    const inner = new module.StreamableHTTPClientTransport(this.#url);
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message) => this.onmessage?.(message);
    this.#inner = inner;
    await inner.start();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.#inner === undefined) {
      return Promise.reject(new Error("Not connected"));
    }
    return this.#inner.send(message);
  }

  setProtocolVersion(version: string): void {
    this.#inner?.setProtocolVersion?.(version);
  }

  async close(): Promise<void> {
    await this.#inner?.close();
  }
}

export class PigeonStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly plan: McpLaunchPlan;
  readonly #options: { cwd: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform };
  readonly #readBuffer = new ReadBuffer();
  #process: ChildProcess | undefined;
  #exited: Promise<void> | undefined;
  #stderrTail = "";

  constructor(
    plan: McpLaunchPlan,
    options: { cwd: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }
  ) {
    this.plan = plan;
    this.#options = options;
  }

  stderrTail(): string {
    return this.#stderrTail;
  }

  start(): Promise<void> {
    if (this.#process !== undefined) {
      return Promise.reject(new Error("MCP stdio 传输已启动"));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.plan.program, this.plan.args, {
        cwd: this.#options.cwd,
        env: this.#options.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: this.plan.verbatim,
        // 以独立进程组拉起：关闭时对整组发信号，覆盖经 npx 等启动器再起的 node MCP server
        ...processGroupSpawnOptions(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#process = child;
      trackChild(child);
      this.#exited = new Promise((done) => {
        child.once("close", () => {
          this.#process = undefined;
          untrackChild(child);
          done();
          this.onclose?.();
        });
      });
      child.once("spawn", () => resolve());
      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.#readBuffer.append(chunk);
        this.#drain();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.#stderrTail = `${this.#stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_CHARS);
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.#process?.stdin;
      if (stdin === undefined || stdin === null) {
        reject(new Error("Not connected"));
        return;
      }
      if (stdin.write(serializeMessage(message))) {
        resolve();
      } else {
        stdin.once("drain", () => resolve());
      }
    });
  }

  // 先关 stdin 让 server 自行退出；超时强制结束进程树（Windows 上启动器 cmd.exe 之下还有 node）
  async close(): Promise<void> {
    const child = this.#process;
    const exited = this.#exited;
    if (child === undefined || exited === undefined) {
      return;
    }
    child.stdin?.end();
    // 先关 stdin 让 server 自行退出（先礼）；宽限内不退就对整组发 SIGTERM（后兵），覆盖启动器之下的 node
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
    }, CLOSE_GRACE_MS);
    await exited;
    clearTimeout(timer);
    this.#readBuffer.clear();
  }

  #drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) {
        return;
      }
      this.onmessage?.(message);
    }
  }
}
