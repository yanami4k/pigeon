// 命令短名（M5.5 S5，决策 048；决策 325 起为 settings.json 的 commands 一节）：可选便利——给常用命令起短名，并作 tester
// 等角色的默认允许清单；主会话不受其限制。typebox schema；三层合并与校验在 state/settings.ts 与 persistence/settings.ts，
// 短名展开与清单判定在 tools/run-command.ts。
import { type Static, Type } from "typebox";

// 短名形态：小写字母开头，小写字母数字、连字符与下划线，最长 40
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export const CommandsSectionSchema = Type.Object(
  {
    // 短名 → 完整命令串
    commands: Type.Optional(
      Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 4000 }))
    ),
    // 角色 → 允许运行的短名清单
    roles: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 })))),
  },
  { additionalProperties: false }
);
export type CommandsSection = Static<typeof CommandsSectionSchema>;

export interface CommandsConfig {
  commands: Record<string, string>;
  roles: Record<string, string[]>;
}
