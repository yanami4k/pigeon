// 推理档位的取法（决策 390；settings.json 的 thinking 一节）：缺省开思考——模型信息表明支持推理的模型缺省 high，
// 不支持或不知道的缺省 off（不请求推理，上游也就不发思考参数，与之前一致）。
// 优先级：启动参数 --thinking（worker 的角色覆盖、跑批显式给的同属这一层）> 设置 thinking.level > 按模型信息的缺省。
// 各入口（终端界面、--line、pigeon run、pigeon resume、worker、跑批）都在装配运行面时经这里取一次，结果冻结进注入快照。
// 纯 schema 与取值，无 IO。
import { type Static, Type } from "typebox";
import { type ThinkingLevel, ThinkingLevelSchema } from "./runtime-events.ts";

export const ThinkingSectionSchema = Type.Object(
  {
    // 缺省不设（按模型信息定）；写 off 即关掉思考
    level: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false }
);
export type ThinkingSection = Static<typeof ThinkingSectionSchema>;

// 支持推理的模型的缺省档位
export const REASONING_DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

export function resolveThinkingLevel(input: {
  // 启动参数或调用方显式给的
  requested?: ThinkingLevel | undefined;
  section?: ThinkingSection | undefined;
  // 模型信息里的"是否支持推理"；undefined 为不知道
  reasoning: boolean | undefined;
}): ThinkingLevel {
  return (
    input.requested ??
    input.section?.level ??
    (input.reasoning === true ? REASONING_DEFAULT_THINKING_LEVEL : "off")
  );
}
