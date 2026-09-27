// MCP 工具映射进注册表（M5.7 S2，决策 041 / 051 / 052）：工具名 = mcp__<server>__<工具>，两段各自归一为
// 小写蛇形（注册表工具名形态，provider 工具名长度上限 64）；配置档位取配置、未列出落 defaultTier，再按注解冲突的
// 更严规则得出实际档位并以它注册（决策 052）；inputSchema 原样透传。
// 执行转发给 server 并把内容块映射为模型可见内容：文本、图片原样，其余类型给文字占位。
// server 返回 isError = 工具域错误；server 不可用 = 环境错误（client 抛出，原样上抛）。
import type { TSchema } from "typebox";
import {
  type McpPathConfinement,
  type McpServerConfig,
  type McpToolTier,
  resolveMcpToolTier,
} from "../state/mcp-config.ts";
import { effectiveMcpTier, type McpDeclaredHint } from "../state/mcp-toolset.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import type { McpToolDescriptor } from "./client.ts";

export const MCP_TOOL_PREFIX = "mcp";
// 主流 provider 的工具名长度上限
export const MCP_TOOL_NAME_MAX = 64;

export function mcpNameSegment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}__${mcpNameSegment(server)}__${mcpNameSegment(tool)}`;
}

export interface McpToolCallDetails {
  server: string;
  tool: string;
  isError: boolean;
  structuredContent?: unknown;
}

// 工具来源：连接（McpServerConnection 满足它）；测试注入假实现
export interface McpToolSource {
  tools(): McpToolDescriptor[];
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface McpBridgedTool {
  // 注册表与模型可见的工具名
  name: string;
  server: string;
  // server 侧工具名
  mcpName: string;
  registration: ToolRegistration;
  tool: PigeonAgentTool<TSchema, McpToolCallDetails>;
  // server 注解里的行为线索（title 不是线索，不收）
  declaredHint?: McpDeclaredHint;
  configuredTier: McpToolTier;
  // 注册所用的实际档位（冲突按更严执行）
  effectiveTier: McpToolTier;
  conflict: boolean;
  // 是否在配置里逐工具列出
  configured: boolean;
}

// server 返回 isError：工具自身的域错误
export class McpToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

type ModelContent = PigeonToolResult<McpToolCallDetails>["content"][number];

function declaredHintOf(descriptor: McpToolDescriptor): McpDeclaredHint | undefined {
  const source = descriptor.annotations;
  if (source === undefined) {
    return undefined;
  }
  const hint: McpDeclaredHint = {};
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    const value = source[key];
    if (value !== undefined) {
      hint[key] = value;
    }
  }
  return Object.keys(hint).length > 0 ? hint : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// 单个 MCP 内容块 → 模型可见内容
function mapContentBlock(block: unknown): ModelContent {
  const item = record(block);
  const type = typeof item?.type === "string" ? item.type : "unknown";
  if (item !== undefined && type === "text" && typeof item.text === "string") {
    return { type: "text", text: item.text };
  }
  if (
    item !== undefined &&
    type === "image" &&
    typeof item.data === "string" &&
    typeof item.mimeType === "string"
  ) {
    return { type: "image", data: item.data, mimeType: item.mimeType };
  }
  if (item !== undefined && type === "audio") {
    return { type: "text", text: `[音频内容 ${String(item.mimeType ?? "")}，未转交模型]` };
  }
  if (item !== undefined && type === "resource") {
    const resource = record(item.resource);
    if (typeof resource?.text === "string") {
      return { type: "text", text: resource.text };
    }
    return { type: "text", text: `[资源 ${String(resource?.uri ?? "")}，二进制内容未转交模型]` };
  }
  if (item !== undefined && type === "resource_link") {
    return {
      type: "text",
      text: `[资源链接 ${String(item.name ?? "")}：${String(item.uri ?? "")}]`,
    };
  }
  return { type: "text", text: `[未识别的内容块 ${type}]` };
}

function createBridgedTool(
  server: McpServerConfig,
  source: McpToolSource,
  descriptor: McpToolDescriptor,
  name: string,
  description: string
): PigeonAgentTool<TSchema, McpToolCallDetails> {
  return {
    name,
    label: name,
    description,
    parameters: descriptor.inputSchema as unknown as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<McpToolCallDetails>> {
      const args = params ?? {};
      const raw = record(await source.callTool(descriptor.name, args, signal));
      if (raw === undefined || !Array.isArray(raw.content)) {
        throw new Error(`MCP 工具 ${server.name}/${descriptor.name} 返回形状不合法`);
      }
      const content = raw.content.map(mapContentBlock);
      if (raw.isError === true) {
        const text = content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        throw new McpToolError(
          `MCP 工具 ${server.name}/${descriptor.name} 返回错误：${text === "" ? "（无说明）" : text}`
        );
      }
      return {
        content: content.length > 0 ? content : [{ type: "text", text: "（工具没有返回内容）" }],
        details: {
          server: server.name,
          tool: descriptor.name,
          isError: false,
          ...(raw.structuredContent !== undefined
            ? { structuredContent: raw.structuredContent }
            : {}),
        },
      };
    },
  };
}

// 一个 server 的工具清单 → 注册表项与执行体；重名与超长的跳过并列出问题
export function bridgeMcpServer(input: { server: McpServerConfig; source: McpToolSource }): {
  tools: McpBridgedTool[];
  problems: string[];
} {
  const { server, source } = input;
  const tools: McpBridgedTool[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();
  for (const descriptor of source.tools()) {
    const name = mcpToolName(server.name, descriptor.name);
    if (name.length > MCP_TOOL_NAME_MAX) {
      problems.push(
        `server ${server.name} 的工具 ${descriptor.name} 映射后的名字 ${name} 超出长度上限 ${MCP_TOOL_NAME_MAX}，已跳过`
      );
      continue;
    }
    if (taken.has(name)) {
      problems.push(
        `server ${server.name} 的工具 ${descriptor.name} 归一后与已映射的工具重名：${name}，已跳过`
      );
      continue;
    }
    taken.add(name);
    const resolution = resolveMcpToolTier(server, descriptor.name);
    const declaredHint = declaredHintOf(descriptor);
    const { effectiveTier, conflict } = effectiveMcpTier(resolution.tier, declaredHint);
    const summary = descriptor.description ?? descriptor.title ?? descriptor.annotations?.title;
    const description = `${summary !== undefined && summary !== "" ? summary : "（无描述）"}（MCP server ${server.name} 的工具 ${descriptor.name}）`;
    // 路径活动范围 Pigeon 看不见：只有实际为 read 档时沿用人在配置里的声明；其余登记为 none
    const pathConfinement: McpPathConfinement =
      effectiveTier === "read" && resolution.pathConfinement !== undefined
        ? resolution.pathConfinement
        : { kind: "none" };
    tools.push({
      name,
      server: server.name,
      mcpName: descriptor.name,
      registration: {
        name,
        description,
        parameters: descriptor.inputSchema as unknown as TSchema,
        tier: effectiveTier,
        pathConfinement,
        executionMode: "sequential",
      },
      tool: createBridgedTool(server, source, descriptor, name, description),
      ...(declaredHint !== undefined ? { declaredHint } : {}),
      configuredTier: resolution.tier,
      effectiveTier,
      conflict,
      configured: resolution.configured,
    });
  }
  return { tools, problems };
}
