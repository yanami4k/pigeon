// 工具的上限类设置：settings.json 的 tools 一节，按工具分子键（小驼峰）。run_command 的输出头尾与落盘总量（决策 356）；
// 不给的取缺省。
import { type Static, Type } from "typebox";

export const DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES = 8 * 1024;
export const DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES = 24 * 1024;
export const DEFAULT_SAVED_OUTPUTS_MAX_BYTES = 200 * 1024 * 1024;

const Closed = { additionalProperties: false } as const;

export const ToolsSectionSchema = Type.Object(
  {
    runCommand: Type.Optional(
      Type.Object(
        {
          // 输出超长时保留的开头与末尾（字节）
          outputHeadBytes: Type.Optional(Type.Integer({ minimum: 1 })),
          outputTailBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          // 每个会话落盘的完整输出总量上限（字节），满了删最旧的
          savedOutputsMaxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        Closed
      )
    ),
  },
  Closed
);
export type ToolsSection = Static<typeof ToolsSectionSchema>;

export interface RunCommandOutputLimits {
  headBytes: number;
  tailBytes: number;
  savedOutputsMaxBytes: number;
}

export function runCommandOutputLimits(section: ToolsSection | undefined): RunCommandOutputLimits {
  return {
    headBytes: section?.runCommand?.outputHeadBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_HEAD_BYTES,
    tailBytes: section?.runCommand?.outputTailBytes ?? DEFAULT_RUN_COMMAND_OUTPUT_TAIL_BYTES,
    savedOutputsMaxBytes:
      section?.runCommand?.savedOutputsMaxBytes ?? DEFAULT_SAVED_OUTPUTS_MAX_BYTES,
  };
}
