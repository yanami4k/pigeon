// MCP 会话装配（M5.7 S3，决策 041 / 051 / 052 / 054）：application 负责装配，src/mcp 只管协议与映射。
// 会话开始时读两份配置（畸形响亮失败）、为每个 server 建连接并并发启动（单个 server 起不来不挡会话，
// 其工具不暴露并记问题）、把工具映射进注册表形态；roots 广告为本会话的工作区根（worker 即其工作树）。
// summary 在每个 Run 开始时取一次，写进 Run 开始条目：工具集的注解 / 配置 / 实际档位与冲突，server 当前状态。
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServerConnection, renderPromptText } from "../mcp/client.ts";
import { bridgeMcpServer, type McpBridgedTool, mcpToolName } from "../mcp/registry-bridge.ts";
import { createMcpTransport } from "../mcp/transport.ts";
import { loadMcpConfig } from "../persistence/mcp-config.ts";
import type { McpConfig, McpLaunch, McpServerConfig } from "../state/mcp-config.ts";
import type { McpServerStatus, McpToolsetEntry } from "../state/mcp-toolset.ts";

export interface McpSessionOptions {
  // .mcp.json 与 .pigeon/mcp.json 所在（主仓库根）
  governanceRoot: string;
  // server 进程工作目录与 roots（worker 即其工作树）
  workspaceRoot: string;
  // 缺省从治理根读取
  config?: McpConfig;
  // 缺省按启动定义创建真实传输；测试注入内存传输
  createTransport?: (launch: McpLaunch, server: McpServerConfig) => Transport;
  maxRestarts?: number;
  backoffMs?: (attempt: number) => number;
  connectTimeoutMs?: number;
}

export interface McpSummary {
  mcpTools: McpToolsetEntry[];
  mcpServers: McpServerStatus[];
}

// M5.7 S4：进 Skill Catalog 的 server prompt（skills/catalog.ts 的 SkillPromptInput 同形）
export interface McpPromptSkill {
  name: string;
  description?: string;
  server: string;
  prompt: string;
  // 会话开始时取到的正文（哈希清单依据）
  text: string;
  load(): Promise<string>;
}

export interface McpSession {
  readonly tools: readonly McpBridgedTool[];
  // 会话开始时取到正文的 prompts（需要参数或取不到的不登记，记进 problems）
  readonly prompts: readonly McpPromptSkill[];
  // 启动失败、映射跳过等问题，如实交给 Actor 呈现
  readonly problems: readonly string[];
  readonly connections: readonly McpServerConnection[];
  summary(): McpSummary;
  close(): Promise<void>;
}

// 启动提示（决策 052：冲突除记进 Run 开始条目 外，启动时进程内同时警告）：先列启动问题，再逐项列注解与配置冲突；
// Actor 只负责打出去
export function describeMcpStartup(session: Pick<McpSession, "problems" | "summary">): string[] {
  const conflicts = session.summary().mcpTools.filter((tool) => tool.conflict === true);
  return [
    ...session.problems,
    ...conflicts.map((tool) => {
      const declared =
        tool.declaredHint?.destructiveHint === true && tool.configuredTier === "read"
          ? "声明 destructive"
          : "声明只读";
      return `MCP 注解与配置冲突：${tool.name} ${declared}，配置 ${tool.configuredTier}，按 ${tool.effectiveTier} 执行`;
    }),
  ];
}

export async function startMcpSession(options: McpSessionOptions): Promise<McpSession> {
  const config = options.config ?? loadMcpConfig(options.governanceRoot);
  const connections = config.servers.map(
    (server) =>
      new McpServerConnection({
        server,
        roots: [options.workspaceRoot],
        createTransport: (launch) =>
          options.createTransport !== undefined
            ? options.createTransport(launch, server)
            : createMcpTransport(launch, { cwd: options.workspaceRoot }),
        ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
        ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
        ...(options.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: options.connectTimeoutMs }
          : {}),
      })
  );
  await Promise.all(connections.map((connection) => connection.start()));
  const tools: McpBridgedTool[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();
  config.servers.forEach((server, index) => {
    const connection = connections[index];
    if (connection === undefined) {
      return;
    }
    if (connection.state !== "connected") {
      problems.push(
        `MCP server ${server.name} 启动失败：${connection.lastError ?? "未知原因"}（本会话不暴露其工具）`
      );
      return;
    }
    const bridged = bridgeMcpServer({ server, source: connection });
    problems.push(...bridged.problems);
    for (const tool of bridged.tools) {
      // 不同 server 名归一后可能撞名（a-b 与 a_b）：先到先得，后到的如实记问题
      if (taken.has(tool.name)) {
        problems.push(
          `MCP 工具名 ${tool.name} 与其他 server 的工具重名，已跳过（server ${server.name}）`
        );
        continue;
      }
      taken.add(tool.name);
      tools.push(tool);
    }
  });
  // 会话开始时取 prompt 正文（043 口径：哈希清单开会话时算定）；需要参数的 prompt 无法无参取正文，不登记
  const prompts: McpPromptSkill[] = [];
  for (const [index, server] of config.servers.entries()) {
    const connection = connections[index];
    if (connection === undefined || connection.state !== "connected") {
      continue;
    }
    for (const descriptor of connection.prompts()) {
      if (descriptor.arguments?.some((argument) => argument.required === true) === true) {
        problems.push(
          `MCP server ${server.name} 的 prompt ${descriptor.name} 需要参数，未登记进 Skill 目录`
        );
        continue;
      }
      const load = async () => renderPromptText(await connection.getPrompt(descriptor.name));
      try {
        const text = await load();
        const description = descriptor.description ?? descriptor.title;
        prompts.push({
          name: mcpToolName(server.name, descriptor.name),
          ...(description !== undefined ? { description } : {}),
          server: server.name,
          prompt: descriptor.name,
          text,
          load,
        });
      } catch (error) {
        problems.push(
          `MCP server ${server.name} 的 prompt ${descriptor.name} 取不到正文，未登记：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  return {
    tools,
    prompts,
    problems,
    connections,
    summary: () => ({
      mcpTools: tools.map((tool) => ({
        name: tool.name,
        server: tool.server,
        tool: tool.mcpName,
        configuredTier: tool.configuredTier,
        effectiveTier: tool.effectiveTier,
        ...(tool.declaredHint !== undefined ? { declaredHint: tool.declaredHint } : {}),
        ...(tool.conflict ? { conflict: true as const } : {}),
      })),
      mcpServers: connections.map((connection) => {
        const listChanges = connection.listChanges();
        return {
          name: connection.name,
          state: connection.state,
          restarts: connection.restarts,
          ...(connection.state !== "connected" && connection.lastError !== undefined
            ? { error: connection.lastError }
            : {}),
          ...(listChanges.length > 0 ? { listChanges } : {}),
        };
      }),
    }),
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  };
}
