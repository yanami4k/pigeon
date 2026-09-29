// .pigeon/orchestration.json 读取（决策 297–303）：编排的项目级配置。文件缺失 = 全部取缺省；存在但不是合法 JSON 或 schema 不符
// → 响亮失败（形态同 web.json、memory-review.json）。写入方只有人（手工编辑），本模块只读
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  ORCHESTRATION_CONFIG_VERSION,
  type OrchestrationConfigFile,
  OrchestrationConfigFileSchema,
  type OrchestrationSettings,
  orchestrationSettings,
} from "../state/orchestration-config.ts";

export class OrchestrationConfigError extends Error {}

export function orchestrationConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "orchestration.json");
}

export function loadOrchestrationConfig(governanceRoot: string): OrchestrationSettings {
  const path = orchestrationConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return orchestrationSettings(undefined);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new OrchestrationConfigError(
      `编排配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(OrchestrationConfigFileSchema, raw)) {
    const problems = [...Value.Errors(OrchestrationConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new OrchestrationConfigError(
      `编排配置校验失败（当前格式版本 ${ORCHESTRATION_CONFIG_VERSION}）：${path}：${problems}`
    );
  }
  return orchestrationSettings(raw as OrchestrationConfigFile);
}
