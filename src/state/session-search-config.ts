// 会话检索的设置（决策 382；settings.json 的 sessionSearch 一节）：使用者开关，缺省开。
// 关掉即不注册检索三件（search_sessions、read_session_entry、list_sessions），开局记录写明原因；
// 启动参数 --no-session-search 只对本次运行生效。跑批按条件开关，不看这一项。纯类型与缺省，无 IO。
import { type Static, Type } from "typebox";

export const SessionSearchSectionSchema = Type.Object(
  {
    // 缺省 true
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type SessionSearchSection = Static<typeof SessionSearchSectionSchema>;

export function sessionSearchEnabled(section: SessionSearchSection | undefined): boolean {
  return section?.enabled ?? true;
}
