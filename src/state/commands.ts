// .pigeon/commands.json（M5.5 S5，决策 048）：可选便利——给常用命令起短名，并作 tester 等角色的默认
// 允许清单；主会话不受其限制。JSON + 版本化 typebox schema；文件读取在 persistence/commands-config.ts，
// 短名展开与清单判定在 tools/run-command.ts。
import { type Static, Type } from "typebox";

export const COMMANDS_CONFIG_VERSION = 1;

// 短名形态：小写字母开头，小写字母数字、连字符与下划线，最长 40
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export const CommandsConfigFileSchema = Type.Object({
  version: Type.Literal(COMMANDS_CONFIG_VERSION),
  // 短名 → 完整命令串
  commands: Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 4000 })),
  // 角色 → 允许运行的短名清单
  roles: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 })))),
});
export type CommandsConfigFile = Static<typeof CommandsConfigFileSchema>;

export interface CommandsConfig {
  commands: Record<string, string>;
  roles: Record<string, string[]>;
}
