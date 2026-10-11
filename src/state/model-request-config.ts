// 模型请求的设置（决策 420；settings.json 的 modelRequest 一节）：失败重试的次数。pi-ai 自带与官方 SDK 一致的重试规则
// （连接失败、408、409、429、5xx 重试，遵从 Retry-After、最长 60 秒，否则指数退避），次数缺省为 0；Pigeon 的每次模型请求
// （交互与无人值守的主请求、压缩摘要、网页提炼）都传这里取定的次数。纯类型与缺省，无 IO。
import { type Static, Type } from "typebox";

export const ModelRequestSectionSchema = Type.Object(
  {
    // 缺省 4；0 为不重试
    maxRetries: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);
export type ModelRequestSection = Static<typeof ModelRequestSectionSchema>;

export const DEFAULT_MODEL_REQUEST_MAX_RETRIES = 4;

export function modelRequestMaxRetries(section: ModelRequestSection | undefined): number {
  return section?.maxRetries ?? DEFAULT_MODEL_REQUEST_MAX_RETRIES;
}
