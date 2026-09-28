// .pigeon/commands.json 读取（M5.5 S5，决策 048）：文件缺失 = 没有短名与角色清单（合法）；存在但畸形、
// 短名不合法、角色名未知或清单引用未登记的短名 → 响亮失败并列出问题（清单决定 tester 能跑什么，
// 语义不明绝不静默运行）。写入方只有人（手工编辑），本模块只读。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  COMMAND_NAME_PATTERN,
  type CommandsConfig,
  type CommandsConfigFile,
  CommandsConfigFileSchema,
} from "../state/commands.ts";
import { WorkerRoleSchema } from "../state/session-payloads.ts";

export class CommandsConfigError extends Error {}

export function commandsConfigPath(governanceRoot: string): string {
  return join(governanceRoot, ".pigeon", "commands.json");
}

export function loadCommandsConfig(governanceRoot: string): CommandsConfig {
  const path = commandsConfigPath(governanceRoot);
  if (!existsSync(path)) {
    return { commands: {}, roles: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CommandsConfigError(
      `commands 配置不是合法 JSON：${path}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(CommandsConfigFileSchema, raw)) {
    const problems = [...Value.Errors(CommandsConfigFileSchema, raw)]
      .map((failure) => {
        const where = "path" in failure ? failure.path : "/";
        return `${where === "" ? "/" : where}：${failure.message}`;
      })
      .join("；");
    throw new CommandsConfigError(`commands 配置校验失败：${path}：${problems}`);
  }
  const file = raw as CommandsConfigFile;
  const problems: string[] = [];
  for (const name of Object.keys(file.commands)) {
    if (!COMMAND_NAME_PATTERN.test(name)) {
      problems.push(`短名不合法：${name}`);
    }
  }
  const roles = file.roles ?? {};
  for (const [role, names] of Object.entries(roles)) {
    if (!Value.Check(WorkerRoleSchema, role)) {
      problems.push(`未知角色：${role}`);
    }
    for (const name of names) {
      if (!Object.hasOwn(file.commands, name)) {
        problems.push(`角色 ${role} 引用了未登记的短名：${name}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new CommandsConfigError(`commands 配置校验失败：${path}：${problems.join("；")}`);
  }
  return { commands: { ...file.commands }, roles: { ...roles } };
}
