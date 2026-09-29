// .pigeon/loop-guard.json 读取（决策 308）：打转检测的项目级配置。文件缺失 = 全部取缺省；存在但不是合法 JSON、schema 不符
// 或三个轮数不递增 → 响亮失败（形态同 orchestration.json）。写入方只有人（手工编辑），本模块只读
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  LOOP_GUARD_CONFIG_VERSION,
  type LoopGuardConfigFile,
  LoopGuardConfigFileSchema,
  type LoopGuardSettings,
  loopGuardSettings,
} from "../state/loop-guard-config.ts";

export class LoopGuardConfigError extends Error {}

export function loopGuardConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "loop-guard.json");
}

export function loadLoopGuardConfig(governanceRoot: string): LoopGuardSettings {
  const path = loopGuardConfigPath(governanceRoot);
  let file: LoopGuardConfigFile | undefined;
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new LoopGuardConfigError(
        `打转检测配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!Value.Check(LoopGuardConfigFileSchema, raw)) {
      const problems = [...Value.Errors(LoopGuardConfigFileSchema, raw)]
        .map((failure) => {
          const where = "path" in failure ? failure.path : "/";
          return `${where === "" ? "/" : where}：${failure.message}`;
        })
        .join("；");
      throw new LoopGuardConfigError(
        `打转检测配置校验失败（当前格式版本 ${LOOP_GUARD_CONFIG_VERSION}）：${path}：${problems}`
      );
    }
    file = raw as LoopGuardConfigFile;
  }
  const resolved = loopGuardSettings(file);
  if ("problem" in resolved) {
    throw new LoopGuardConfigError(`打转检测配置校验失败：${path}：${resolved.problem}`);
  }
  return resolved.settings;
}
