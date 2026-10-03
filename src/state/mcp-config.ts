// MCP 配置（M5.7 S1，决策 051）：server 启动定义沿用 .mcp.json 的 mcpServers 形状；风险档覆盖旁置在
// settings.json 的 mcp 一节（决策 325，原 .pigeon/mcp.json；无 .mcp.json 时也可在此直接定义 server）。两份合并冲突以
// 设置为准；未列出的工具落 server 的 defaultTier，缺省 write——外部工具默认要审批。
// 本模块只放 schema 与纯合并判据；文件读取在 persistence/mcp-config.ts 与 persistence/settings.ts。
import { type Static, Type } from "typebox";

// 风险档：与 tools/registry.ts 的 ToolRiskTier 同一组字面量（state 是叶子，不反向依赖 tools）
export const McpToolTierSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("exec"),
]);
export type McpToolTier = Static<typeof McpToolTierSchema>;

// 未列出工具的缺省风险档：write——永不因漏配而自动放行
export const MCP_DEFAULT_TIER: McpToolTier = "write";

// 路径约束：与 tools/registry.ts 的 PathConfinement 同形，只允许挂在 read 工具上
export const McpPathConfinementSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }),
  Type.Object({ kind: Type.Literal("workspace") }),
  Type.Object({
    kind: Type.Literal("roots"),
    roots: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
]);
export type McpPathConfinement = Static<typeof McpPathConfinementSchema>;

// server 名要能嵌进工具名前缀（映射到注册表时再归一成小写蛇形）
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// 启动定义：stdio（command / args / env，type 可省）或 streamable HTTP（type http + url）
export const McpStdioLaunchSchema = Type.Object({
  type: Type.Optional(Type.Literal("stdio")),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export const McpHttpLaunchSchema = Type.Object({
  type: Type.Literal("http"),
  url: Type.String({ minLength: 1 }),
});
export const McpLaunchSchema = Type.Union([McpStdioLaunchSchema, McpHttpLaunchSchema]);
export type McpStdioLaunch = Static<typeof McpStdioLaunchSchema>;
export type McpHttpLaunch = Static<typeof McpHttpLaunchSchema>;
export type McpLaunch = Static<typeof McpLaunchSchema>;

// .mcp.json：只取 mcpServers；其余字段不解释
export const DotMcpJsonSchema = Type.Object({
  mcpServers: Type.Record(Type.String(), McpLaunchSchema),
});
export type DotMcpJson = Static<typeof DotMcpJsonSchema>;

export const McpToolOverrideSchema = Type.Object(
  {
    tier: McpToolTierSchema,
    pathConfinement: Type.Optional(McpPathConfinementSchema),
  },
  { additionalProperties: false }
);
export type McpToolOverride = Static<typeof McpToolOverrideSchema>;

export const McpServerEntrySchema = Type.Object(
  {
    defaultTier: Type.Optional(McpToolTierSchema),
    tools: Type.Optional(Type.Record(Type.String({ minLength: 1 }), McpToolOverrideSchema)),
    launch: Type.Optional(McpLaunchSchema),
  },
  { additionalProperties: false }
);

// settings.json 的 mcp 一节
export const McpSectionSchema = Type.Object(
  {
    servers: Type.Optional(Type.Record(Type.String(), McpServerEntrySchema)),
  },
  { additionalProperties: false }
);
export type McpSection = Static<typeof McpSectionSchema>;

// 启动定义的来处：项目根 .mcp.json，或设置的 mcp 一节
export type McpLaunchSource = ".mcp.json" | "settings";

// 合并后的单个 server：启动定义已定、风险档覆盖已定
export interface McpServerConfig {
  name: string;
  launch: McpLaunch;
  launchSource: McpLaunchSource;
  defaultTier: McpToolTier;
  tools: Record<string, McpToolOverride>;
}

export interface McpConfig {
  // 按名排序，装配顺序稳定
  servers: McpServerConfig[];
}

export interface McpToolTierResolution {
  tier: McpToolTier;
  pathConfinement?: McpPathConfinement;
  // 是否在配置里逐工具列出（未列出 = 落 defaultTier）
  configured: boolean;
}

// 两份配置合并：server 名取并集；启动定义设置优先，其次 .mcp.json；风险档只来自设置。
// 语义不明（无启动定义、路径约束挂在非 read 工具上、名字不合法）一律列进 problems，由读取方响亮失败
export function mergeMcpConfig(
  dotMcp: DotMcpJson | undefined,
  pigeon: McpSection | undefined
): { config: McpConfig; problems: string[] } {
  const problems: string[] = [];
  const fromDotMcp = dotMcp?.mcpServers ?? {};
  const fromPigeon = pigeon?.servers ?? {};
  const names = [...new Set([...Object.keys(fromDotMcp), ...Object.keys(fromPigeon)])].sort();
  const servers: McpServerConfig[] = [];
  for (const name of names) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      problems.push(`server 名不合法：${name}`);
      continue;
    }
    const entry = Object.hasOwn(fromPigeon, name) ? fromPigeon[name] : undefined;
    const dotLaunch = Object.hasOwn(fromDotMcp, name) ? fromDotMcp[name] : undefined;
    let launch: McpLaunch;
    let launchSource: McpLaunchSource;
    if (entry?.launch !== undefined) {
      launch = entry.launch;
      launchSource = "settings";
    } else if (dotLaunch !== undefined) {
      launch = dotLaunch;
      launchSource = ".mcp.json";
    } else {
      problems.push(
        `server ${name} 没有启动定义（设置的 mcp 一节未给 launch，.mcp.json 也没有同名 server）`
      );
      continue;
    }
    const tools = { ...(entry?.tools ?? {}) };
    for (const [toolName, override] of Object.entries(tools)) {
      if (override.pathConfinement !== undefined && override.tier !== "read") {
        problems.push(`server ${name} 的工具 ${toolName} 不是 read 档，不能带 pathConfinement`);
      }
    }
    servers.push({
      name,
      launch,
      launchSource,
      defaultTier: entry?.defaultTier ?? MCP_DEFAULT_TIER,
      tools,
    });
  }
  return { config: { servers }, problems };
}

// 单个工具的配置风险档：逐工具列出的按列出值；未列出落 defaultTier
export function resolveMcpToolTier(
  server: Pick<McpServerConfig, "defaultTier" | "tools">,
  toolName: string
): McpToolTierResolution {
  const override = Object.hasOwn(server.tools, toolName) ? server.tools[toolName] : undefined;
  if (override === undefined) {
    return { tier: server.defaultTier, configured: false };
  }
  return {
    tier: override.tier,
    ...(override.pathConfinement !== undefined
      ? { pathConfinement: override.pathConfinement }
      : {}),
    configured: true,
  };
}
