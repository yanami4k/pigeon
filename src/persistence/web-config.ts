// .pigeon/web.json 读取（决策 288、289）：联网工具的项目级配置——搜索后端的选择与各后端的连接参数、抓取上限。
// 文件缺失 = 未配置（合法，全部取缺省）；存在但不是合法 JSON 或 schema 不符 → 响亮失败（配置里有 key 与后端选择，
// 语义不明绝不静默降级）。写入方只有人（手工编辑），本模块只读；形态与 verify.json / commands.json 一致。
// 校验失败的报错只列出路径与规则，不回显字段的值（值里可能是 key）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  WEB_CONFIG_VERSION,
  type WebConfigFile,
  WebConfigFileSchema,
} from "../state/web-config.ts";

export class WebConfigError extends Error {}

export function webConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "web.json");
}

// 读取并校验；缺失返回 undefined，畸形响亮失败
export function loadWebConfig(governanceRoot: string): WebConfigFile | undefined {
  const path = webConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WebConfigError(
      `web 配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(WebConfigFileSchema, raw)) {
    const problems = [...Value.Errors(WebConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new WebConfigError(
      `web 配置校验失败（当前格式版本 ${WEB_CONFIG_VERSION}）：${path}：${problems}`
    );
  }
  return raw as WebConfigFile;
}
