// MCP 配置读取（M5.7 S1，决策 051）：<治理根>/.mcp.json（server 启动定义，格式不变）。风险档覆盖与在设置里直接定义的 server
// 在 settings.json 的 mcp 一节（决策 325），两份的合并在 state/mcp-config.ts，读取与冻结在 persistence/settings.ts。
// 文件缺失 = 没有 .mcp.json（合法）；存在但畸形 → 响亮失败并列出问题。写入方只有人，本模块只读。
import { existsSync, readFileSync } from "node:fs";
import { Value } from "typebox/value";
import { type DotMcpJson, DotMcpJsonSchema } from "../state/mcp-config.ts";

export class McpConfigError extends Error {}

export function readDotMcpJson(path: string): DotMcpJson | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new McpConfigError(
      `.mcp.json 不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(DotMcpJsonSchema, raw)) {
    const problems = [...Value.Errors(DotMcpJsonSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new McpConfigError(`.mcp.json 校验失败：${path}：${problems}`);
  }
  return raw as DotMcpJson;
}
