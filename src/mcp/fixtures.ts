// MCP 测试夹具（M5.7 S2）：sdk 低层 Server 挂在内存传输上，不起子进程。工具、prompts 逐个声明；
// 可广播工具清单变更、可模拟掉线（关闭 server 侧传输）、可读 client 广告的 roots。
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type ListRootsResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface FixtureTool {
  definition: Tool;
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

export interface FixturePrompt {
  name: string;
  description?: string;
  text: string;
  arguments?: { name: string; required?: boolean }[];
}

export interface FixtureServerOptions {
  tools: FixtureTool[];
  prompts?: FixturePrompt[];
}

export interface FixtureServer {
  server: Server;
  // 本 server 收到的工具调用（名字与参数）
  calls: { name: string; args: Record<string, unknown> }[];
  notifyToolsChanged(): Promise<void>;
  // 模拟 server 崩溃：关闭 server 侧传输（内存传输会连带关闭 client 侧）
  drop(): Promise<void>;
  listRoots(): Promise<ListRootsResult>;
}

export function createFixtureServer(options: FixtureServerOptions): {
  fixture: FixtureServer;
  clientTransport: Transport;
} {
  const prompts = options.prompts ?? [];
  const server = new Server(
    { name: "pigeon-fixture", version: "0.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        ...(prompts.length > 0 ? { prompts: { listChanged: true } } : {}),
      },
    }
  );
  const calls: FixtureServer["calls"] = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => tool.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: request.params.name, args });
    const tool = options.tools.find(
      (candidate) => candidate.definition.name === request.params.name
    );
    if (tool === undefined) {
      return {
        content: [{ type: "text", text: `unknown tool ${request.params.name}` }],
        isError: true,
      };
    }
    return tool.handler(args);
  });
  if (prompts.length > 0) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: prompts.map((prompt) => ({
        name: prompt.name,
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
        ...(prompt.arguments !== undefined ? { arguments: prompt.arguments } : {}),
      })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = prompts.find((candidate) => candidate.name === request.params.name);
      if (prompt === undefined) {
        throw new Error(`unknown prompt ${request.params.name}`);
      }
      return {
        messages: [{ role: "user", content: { type: "text", text: prompt.text } }],
      };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return {
    clientTransport,
    fixture: {
      server,
      calls,
      notifyToolsChanged: () => server.sendToolListChanged(),
      drop: () => serverTransport.close(),
      listRoots: () => server.listRoots(),
    },
  };
}

// 启动即失败的传输（模拟命令不存在、进程起不来）
export function failingTransport(message = "fixture: server 起不来"): Transport {
  return {
    start: async () => {
      throw new Error(message);
    },
    send: async () => {
      throw new Error(message);
    },
    close: async () => {},
  };
}
