// 提炼器的两个只读工具（M7 S4，决策 074；与 Reviewer 的 review_snapshot / review_entry 同构）：
//   - distill_snapshot：读这组尝试的冻结对比快照（任务描述、共享前缀、成败两侧、Run 内局部对）；
//   - distill_entry：按侧与条目号回查原文（快照里被截断或省略的内容由此回查）。
// 作用域在装配时绑定为一组尝试：参数里没有会话或 Run 入口，范围外的条目与未纳入的会话一律读不到。
// 两者都是 read 档：不触碰工作区文件、不写任何东西；其他治理根下的会话只读读取。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { renderBlocks } from "../review/snapshot.ts";
import { DISTILL_ENTRY_TOOL, DISTILL_SNAPSHOT_TOOL, type DistillTarget } from "../state/distill.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { buildDistillSnapshot, renderDistillSnapshot, runContentRecords } from "./snapshot.ts";

// 域错误（侧不存在、条目号超出范围）：带归类标记，tools/error-kind.ts 读标记归 domain
export class DistillToolError extends Error {
  readonly pigeonToolErrorKind = "domain";
}

export const DistillSnapshotParamsSchema = Type.Object({}, { additionalProperties: false });
export const DistillEntryParamsSchema = Type.Object(
  {
    side: Type.Union([
      Type.Literal("successful"),
      Type.Literal("failed"),
      Type.Literal("prefix"),
      Type.Literal("task"),
    ]),
    runSeq: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);
export type DistillEntryParams = Static<typeof DistillEntryParamsSchema>;

const SIDE_LABEL: Readonly<Record<DistillEntryParams["side"], string>> = {
  successful: "成功侧",
  failed: "失败侧",
  prefix: "共享前缀",
  task: "任务描述",
};

function textOf(parts: readonly string[]): PigeonToolResult<undefined> {
  return { content: [{ type: "text", text: parts.join("\n") }], details: undefined };
}

// 某侧的读取范围；任务描述只有第 1 条
function scopeOf(target: DistillTarget, side: DistillEntryParams["side"]) {
  switch (side) {
    case "successful":
      return target.successful;
    case "failed":
      return target.failed;
    case "prefix":
      return target.sharedPrefix;
    case "task":
      return { ...target.task, from: 1, to: 1 };
  }
}

export function createDistillTools(
  target: DistillTarget
): Array<
  PigeonAgentTool<typeof DistillSnapshotParamsSchema | typeof DistillEntryParamsSchema, undefined>
> {
  let frozen: string | undefined;
  const snapshotTool: PigeonAgentTool<typeof DistillSnapshotParamsSchema, undefined> = {
    name: DISTILL_SNAPSHOT_TOOL,
    label: DISTILL_SNAPSHOT_TOOL,
    description:
      "读取这组尝试的冻结对比快照：任务描述、分叉共享前缀、成功侧与失败侧的对话（带条目号）、Run 内局部对。" +
      "被截断或省略的内容用 distill_entry 按侧与条目号回查原文。",
    parameters: DistillSnapshotParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<undefined>> {
      Value.Parse(DistillSnapshotParamsSchema, params ?? {});
      frozen ??= renderDistillSnapshot(buildDistillSnapshot(target));
      return textOf([frozen]);
    },
  };
  const entryTool: PigeonAgentTool<typeof DistillEntryParamsSchema, undefined> = {
    name: DISTILL_ENTRY_TOOL,
    label: DISTILL_ENTRY_TOOL,
    description:
      "按侧（successful / failed / prefix / task）与条目号读取一条消息的完整原文。只能读这组尝试范围内的条目。",
    parameters: DistillEntryParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params): Promise<PigeonToolResult<undefined>> {
      const { side, runSeq } = Value.Parse(DistillEntryParamsSchema, params);
      const scope = scopeOf(target, side);
      if (scope === undefined) {
        throw new DistillToolError(`这组尝试没有${SIDE_LABEL[side]}`);
      }
      if (runSeq < scope.from || runSeq > scope.to) {
        throw new DistillToolError(
          `${SIDE_LABEL[side]}的条目号范围是第 ${scope.from}–${scope.to} 条，第 ${runSeq} 条不在范围内`
        );
      }
      const record = runContentRecords(scope.governanceRoot, scope.sessionId, scope.runId).find(
        (item) => item.runSeq === runSeq
      );
      if (record === undefined) {
        throw new DistillToolError(`${SIDE_LABEL[side]}里没有第 ${runSeq} 条的正文`);
      }
      const tool = record.toolName !== undefined ? `（${record.toolName}）` : "";
      return textOf([
        `[${SIDE_LABEL[side]} 第 ${record.runSeq} 条 ${record.role}${tool}]`,
        renderBlocks(record).text,
      ]);
    },
  };
  return [snapshotTool, entryTool] as Array<
    PigeonAgentTool<typeof DistillSnapshotParamsSchema | typeof DistillEntryParamsSchema, undefined>
  >;
}

// 装配根注册用的元数据：两个工具都是 read 档，不触碰文件系统路径参数
export function distillToolRegistrations(): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "none" as const },
    executionMode: "parallel" as const,
  };
  return [
    {
      name: DISTILL_SNAPSHOT_TOOL,
      description: "读取这组尝试的冻结对比快照",
      parameters: DistillSnapshotParamsSchema,
      ...base,
    },
    {
      name: DISTILL_ENTRY_TOOL,
      description: "按侧与条目号回查这组尝试的原文",
      parameters: DistillEntryParamsSchema,
      ...base,
    },
  ];
}
