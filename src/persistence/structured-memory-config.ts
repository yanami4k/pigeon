// .pigeon/structured-memory.json 读取（决策 134）：文件缺失 = 未配置（合法，按缺省开启）；存在但不是合法 JSON 或
// schema 不符 → 响亮失败——开关决定这次运行是不是"去掉记忆"条件，语义不明绝不静默降级。写入方只有人，本模块只读。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  STRUCTURED_MEMORY_CONFIG_VERSION,
  StructuredMemoryConfigFileSchema,
} from "../state/structured-memory-config.ts";

export class StructuredMemoryConfigError extends Error {}

export function structuredMemoryConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "structured-memory.json");
}

// 项目级开关；未配置返回 undefined
export function loadStructuredMemoryEnabled(governanceRoot: string): boolean | undefined {
  const path = structuredMemoryConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new StructuredMemoryConfigError(
      `structured-memory 配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(StructuredMemoryConfigFileSchema, raw)) {
    const problems = [...Value.Errors(StructuredMemoryConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new StructuredMemoryConfigError(
      `structured-memory 配置校验失败（当前格式版本 ${STRUCTURED_MEMORY_CONFIG_VERSION}）：${path}：${problems}`
    );
  }
  return (raw as { enabled: boolean }).enabled;
}
