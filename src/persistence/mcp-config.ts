// MCP 配置读取（M5.7 S1，决策 051）：<治理根>/.mcp.json（server 启动定义）与 <治理根>/.pigeon/mcp.json
// （风险档覆盖，也可直接定义 server）。两份都缺失 = 没有外部工具（合法）；任一存在但畸形、或合并后
// 语义不明 → 响亮失败并列出问题（风险档决定能否自动放行，语义不明绝不静默运行）。写入方只有人，本模块只读。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type DotMcpJson,
  DotMcpJsonSchema,
  type McpConfig,
  type McpConfigFile,
  McpConfigFileSchema,
  mergeMcpConfig,
} from "../state/mcp-config.ts";

export class McpConfigError extends Error {}

export function dotMcpJsonPath(governanceRoot: string): string {
  return join(governanceRoot, ".mcp.json");
}

export function pigeonMcpConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "mcp.json");
}

function readValidated<T>(path: string, schema: TSchema, label: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new McpConfigError(
      `${label} 不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(schema, raw)) {
    const problems = [...Value.Errors(schema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new McpConfigError(`${label} 校验失败：${path}：${problems}`);
  }
  return raw as T;
}

export function loadMcpConfig(governanceRoot: string): McpConfig {
  const dotMcp = readValidated<DotMcpJson>(
    dotMcpJsonPath(governanceRoot),
    DotMcpJsonSchema,
    ".mcp.json"
  );
  const pigeon = readValidated<McpConfigFile>(
    pigeonMcpConfigPath(governanceRoot),
    McpConfigFileSchema,
    ".pigeon/mcp.json"
  );
  const { config, problems } = mergeMcpConfig(dotMcp, pigeon);
  if (problems.length > 0) {
    throw new McpConfigError(`MCP 配置校验失败：${problems.join("；")}`);
  }
  return config;
}
