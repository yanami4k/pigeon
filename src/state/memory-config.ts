// 学到的记忆的设置（决策 332；settings.json 的 memory 一节）：两层各自的总量上限（字符，按 Unicode 码点计），纯类型与缺省，无 IO。
// 人手写，可缺省；不给即取缺省 4,000。
import { type Static, Type } from "typebox";

export const MemorySectionSchema = Type.Object(
  {
    // 项目级（.pigeon/state/memory.md）的上限
    projectLimitChars: Type.Optional(Type.Integer({ minimum: 1 })),
    // 用户级（~/.pigeon/state/memory.md）的上限
    userLimitChars: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false }
);
export type MemorySection = Static<typeof MemorySectionSchema>;

// 生效的两层上限
export interface MemoryLimits {
  project: number;
  user: number;
}

export const DEFAULT_MEMORY_LIMITS: Readonly<MemoryLimits> = { project: 4_000, user: 4_000 };

export function memoryLimits(section: MemorySection | undefined): MemoryLimits {
  return {
    project: section?.projectLimitChars ?? DEFAULT_MEMORY_LIMITS.project,
    user: section?.userLimitChars ?? DEFAULT_MEMORY_LIMITS.user,
  };
}
