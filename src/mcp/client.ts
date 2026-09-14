// MCP 客户端（M5.7 S2，决策 041 / 051）：每个 server 一条连接，经 sdk Client 走 stdio 或 streamable HTTP
// （传输由装配根按人写的启动定义创建，测试注入内存传输）。会话开始时连接并拉取工具与 prompts 清单，
// 清单此后冻结——tools/list_changed 只记录，不改本会话已暴露的工具集（快照冻结，§2 规则 4）。
// 掉线按退避重启，重启次数有上限；超过上限或启动失败 = 该 server 不可用，其工具调用一律报环境错误、
// 不再触达 server（fail-closed）。client 广告 roots 为给定工作区路径（决策 054）。
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  ErrorCode,
  type GetPromptResult,
  ListRootsRequestSchema,
  McpError,
  PromptListChangedNotificationSchema,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpLaunch, McpServerConfig } from "../state/mcp-config.ts";

export const DEFAULT_MCP_MAX_RESTARTS = 3;
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;
// 清单分页上限：防 server 无限给 nextCursor
const MAX_LIST_PAGES = 100;

export const MCP_CLIENT_INFO = { name: "pigeon-harness", version: "0.0.0" };

// server 不可用（启动失败、重启中、超过重启上限、已关闭、调用中断线）——环境类
export class McpServerUnavailableError extends Error {
  readonly pigeonToolErrorKind = "environment";
  readonly server: string;

  constructor(server: string, detail: string) {
    super(`MCP server ${server} 不可用：${detail}`);
    this.server = server;
  }
}

// server 注解（只当线索，风险档以配置为准，决策 052）
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  // 原生 JSON Schema，原样透传
  inputSchema: Readonly<Record<string, unknown>>;
  annotations?: McpToolAnnotations;
}

export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpListChange {
  list: "tools" | "prompts";
  at: number;
}

export type McpServerState = "idle" | "connected" | "restarting" | "unavailable" | "closed";

export interface McpConnectionOptions {
  server: McpServerConfig;
  // 广告给 server 的 roots（绝对路径）
  roots: readonly string[];
  createTransport: (launch: McpLaunch) => Transport;
  // 本会话内重启总次数上限（缺省 3）
  maxRestarts?: number;
  // 第 n 次重启前的等待（缺省 500ms 起翻倍、封顶 8 秒）
  backoffMs?: (attempt: number) => number;
  connectTimeoutMs?: number;
  now?: () => number;
}

// prompt 消息渲染为正文（M5.7 S4）：文本块原文，其余内容块只留类型占位；多条消息空行分隔
export function renderPromptText(result: GetPromptResult): string {
  return result.messages
    .map((message) =>
      message.content.type === "text" ? message.content.text : `[${message.content.type}]`
    )
    .join("\n\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function annotationsOf(tool: Tool): McpToolAnnotations | undefined {
  const source = tool.annotations;
  if (source === undefined) {
    return undefined;
  }
  const annotations: McpToolAnnotations = {};
  if (typeof source.title === "string") {
    annotations.title = source.title;
  }
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    const value = source[key];
    if (typeof value === "boolean") {
      annotations[key] = value;
    }
  }
  return annotations;
}

function toolDescriptor(tool: Tool): McpToolDescriptor {
  const annotations = annotationsOf(tool);
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

export class McpServerConnection {
  readonly name: string;
  readonly #options: McpConnectionOptions;
  readonly #now: () => number;
  #client: Client | undefined;
  #state: McpServerState = "idle";
  #tools: McpToolDescriptor[] = [];
  #prompts: McpPromptDescriptor[] = [];
  readonly #listChanges: McpListChange[] = [];
  #restarts = 0;
  #lastError: string | undefined;
  #startFailed = false;
  #restarting: Promise<void> | undefined;
  #closing = false;

  constructor(options: McpConnectionOptions) {
    this.#options = options;
    this.name = options.server.name;
    this.#now = options.now ?? Date.now;
  }

  get state(): McpServerState {
    return this.#state;
  }

  get restarts(): number {
    return this.#restarts;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  // 会话开始时拉取的工具清单（冻结）
  tools(): McpToolDescriptor[] {
    return [...this.#tools];
  }

  prompts(): McpPromptDescriptor[] {
    return [...this.#prompts];
  }

  listChanges(): McpListChange[] {
    return this.#listChanges.map((change) => ({ ...change }));
  }

  // 连接并拉清单；失败不抛，状态记 unavailable（核心 Run 不因外部 server 起不来而中止）
  async start(): Promise<void> {
    if (this.#state !== "idle") {
      return;
    }
    try {
      const client = await this.#connect();
      this.#tools = await this.#listTools(client);
      this.#prompts =
        client.getServerCapabilities()?.prompts !== undefined
          ? await this.#listPrompts(client)
          : [];
      if (this.#closing) {
        return;
      }
      this.#state = "connected";
    } catch (error) {
      this.#lastError = errorMessage(error);
      this.#startFailed = true;
      const client = this.#client;
      this.#client = undefined;
      await client?.close().catch(() => {});
      if (!this.#closing) {
        this.#state = "unavailable";
      }
    }
  }

  // 等待进行中的重启收尾
  async idle(): Promise<void> {
    while (this.#restarting !== undefined) {
      await this.#restarting;
    }
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const client = this.#client;
    if (this.#state !== "connected" || client === undefined) {
      throw new McpServerUnavailableError(this.name, this.#unavailableDetail());
    }
    try {
      return (await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        signal !== undefined ? { signal } : undefined
      )) as CallToolResult;
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
        throw new McpServerUnavailableError(this.name, `调用中连接断开：${error.message}`);
      }
      throw error;
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const client = this.#client;
    if (this.#state !== "connected" || client === undefined) {
      throw new McpServerUnavailableError(this.name, this.#unavailableDetail());
    }
    return client.getPrompt({ name, ...(args !== undefined ? { arguments: args } : {}) });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#state = "closed";
    const client = this.#client;
    this.#client = undefined;
    await client?.close().catch(() => {});
    await this.idle();
  }

  async #connect(): Promise<Client> {
    const client = new Client(MCP_CLIENT_INFO, { capabilities: { roots: { listChanged: false } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: this.#options.roots.map((root) => ({
        uri: pathToFileURL(root).href,
        name: basename(root),
      })),
    }));
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      this.#listChanges.push({ list: "tools", at: this.#now() });
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      this.#listChanges.push({ list: "prompts", at: this.#now() });
    });
    client.onclose = () => this.#onClosed(client);
    const transport = this.#options.createTransport(this.#options.server.launch);
    try {
      await client.connect(transport, {
        timeout: this.#options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
      });
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    this.#client = client;
    return client;
  }

  async #listTools(client: Client): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await client.listTools(cursor !== undefined ? { cursor } : undefined);
      tools.push(...result.tools.map(toolDescriptor));
      cursor = result.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }
    return tools;
  }

  async #listPrompts(client: Client): Promise<McpPromptDescriptor[]> {
    const prompts: McpPromptDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await client.listPrompts(cursor !== undefined ? { cursor } : undefined);
      for (const prompt of result.prompts) {
        prompts.push({
          name: prompt.name,
          ...(prompt.title !== undefined ? { title: prompt.title } : {}),
          ...(prompt.description !== undefined ? { description: prompt.description } : {}),
          ...(prompt.arguments !== undefined
            ? {
                arguments: prompt.arguments.map((argument) => ({
                  name: argument.name,
                  ...(argument.description !== undefined
                    ? { description: argument.description }
                    : {}),
                  ...(argument.required !== undefined ? { required: argument.required } : {}),
                })),
              }
            : {}),
        });
      }
      cursor = result.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }
    return prompts;
  }

  // 只处理"已连接的当前 client 意外断开"：启动中、重启中、主动关闭时的断开由各自路径收尾
  #onClosed(client: Client): void {
    if (client !== this.#client || this.#closing || this.#state !== "connected") {
      return;
    }
    this.#client = undefined;
    this.#state = "restarting";
    this.#lastError = "连接断开";
    this.#restarting = this.#restartLoop().finally(() => {
      this.#restarting = undefined;
    });
  }

  async #restartLoop(): Promise<void> {
    const max = this.#options.maxRestarts ?? DEFAULT_MCP_MAX_RESTARTS;
    const backoff =
      this.#options.backoffMs ?? ((attempt: number) => Math.min(500 * 2 ** (attempt - 1), 8000));
    while (this.#restarts < max) {
      this.#restarts += 1;
      await new Promise((resolve) => setTimeout(resolve, backoff(this.#restarts)));
      if (this.#closing) {
        return;
      }
      try {
        const client = await this.#connect();
        if (this.#closing) {
          this.#client = undefined;
          await client.close().catch(() => {});
          return;
        }
        this.#state = "connected";
        return;
      } catch (error) {
        this.#lastError = errorMessage(error);
      }
    }
    if (!this.#closing) {
      this.#state = "unavailable";
    }
  }

  #unavailableDetail(): string {
    switch (this.#state) {
      case "idle":
        return "尚未启动";
      case "restarting":
        return `连接断开，正在重启（第 ${this.#restarts} 次）`;
      case "closed":
        return "已关闭";
      default:
        return this.#startFailed
          ? `启动失败：${this.#lastError ?? "未知原因"}`
          : `已超过重启上限（${this.#options.maxRestarts ?? DEFAULT_MCP_MAX_RESTARTS} 次）：${this.#lastError ?? "未知原因"}`;
    }
  }
}
