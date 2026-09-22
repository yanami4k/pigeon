// edit_file（tier: write）：hashline 锚定编辑工具，Pigeon 自建（不依赖 @oh-my-pi/hashline）。
// 最小可用语义（M3 切片 2）：
//   ① 编辑按 `N#TAG` 内容哈希锚点寻址，不用裸行号——行号漂移/内容变化导致 tag 不匹配即拒绝；
//   ② 应用前校验文件当前内容仍匹配 read_file 给出的快照标签（过期拒绝，不覆盖外部改动）；
//   ③ 多处编辑先在内存整体预检（锚点命中/范围不重叠/有实际变化），全部通过才单次整文件写回，
//      失败 = 零副作用（同上游 edit 笔记 §5.2：校验全部先于写入）；
//   ④ 产出 unified-ish diff（details.diff）供审批展示（切片 4 消费）。
// 不做：三方合并恢复（OMP session-aware recovery）、写盘原子性（env 层问题）、并发排队
// （M3 决策 2：toolExecution 写死 sequential，任何时刻最多一个执行中的 call）。
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  applyHashlineEdits,
  buildEditDiff,
  type HashlineEdit,
  joinContent,
  snapshotTag,
  splitContent,
} from "./hashline.ts";
import { asWorkspaceHost } from "./local-host.ts";
import type { WorkspaceHost } from "./workspace-host.ts";
import type {
  ContentEvidenceTool,
  PigeonAgentTool,
  PigeonToolResult,
  PreviewableTool,
} from "./wrap.ts";
export class EditFileError extends Error {}

const AnchorSchema = Type.String({ pattern: "^\\d+#[0-9a-f]{4}$" });

const HashlineEditSchema = Type.Union([
  Type.Object({
    op: Type.Literal("replace"),
    anchor: AnchorSchema,
    endAnchor: Type.Optional(AnchorSchema),
    lines: Type.Array(Type.String()),
  }),
  Type.Object({
    op: Type.Literal("insertAfter"),
    anchor: AnchorSchema,
    lines: Type.Array(Type.String(), { minItems: 1 }),
  }),
  Type.Object({
    op: Type.Literal("delete"),
    anchor: AnchorSchema,
    endAnchor: Type.Optional(AnchorSchema),
  }),
]);

export const EditFileParamsSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  // read_file 输出的全文件快照标签；文件自读取后有变化则拒绝（不覆盖未观察到的内容）
  snapshot: Type.String({ pattern: "^[0-9a-f]{16}$" }),
  edits: Type.Array(HashlineEditSchema, { minItems: 1 }),
});
export type EditFileParams = Static<typeof EditFileParamsSchema>;

export interface EditFileDetails {
  resolvedPath: string;
  beforeSnapshot: string;
  // 编辑后的新快照：链式编辑可直接复用，无需重读
  afterSnapshot: string;
  // unified-ish 展示 diff（审批展示用，非 git apply 格式）
  diff: string;
  addedLines: number;
  removedLines: number;
}

// 决策 098：workspace 给目录即本地工作区，给执行端实现即由它承接读写
export function createEditFileTool(
  workspace: string | WorkspaceHost
): PigeonAgentTool<typeof EditFileParamsSchema, EditFileDetails> &
  PreviewableTool &
  ContentEvidenceTool {
  const host = asWorkspaceHost(workspace);
  return {
    name: "edit_file",
    label: "edit_file",
    description:
      "编辑工作区内已存在的文本文件。必须先用 read_file 读取：edits 按 N#TAG 锚点寻址" +
      "（read 输出的行前缀），snapshot 填 read 输出的 [PATH#TAG] 中的快照标签。" +
      "操作：replace（换 anchor 到 endAnchor 的行）/ insertAfter（anchor 后插入）/ delete（删行）。" +
      "多处编辑全部预检通过才落盘；文件读后已变化（快照过期）会被拒绝，需重新 read_file。",
    parameters: EditFileParamsSchema,
    // 写工具强制串行执行器（对齐上游 executionMode 语义 + M3 决策 2）
    executionMode: "sequential",
    // 执行前预览（审批展示用）：与 execute 共享同一 planEdits 预检，但零副作用。
    // 注意 TOCTOU：预览与执行是两次独立读取，快照预检在执行时仍会兜底。
    async preview(params) {
      const plan = await planEdits(host, Value.Parse(EditFileParamsSchema, params));
      return buildEditDiff(plan.args.path, plan.split.lines, plan.applied);
    },
    // M4 S2 内容证据探针（D5 哈希自动确证）：与 execute/preview 共享同一 planEdits 预检，
    // 「探针所见 = 执行所得」；零副作用。探针失败（快照过期/文件缺失/参数畸形）返回 null——
    // 治理层凭 intent 哈希缺省把悬账降级为人工对账，不阻断审批流
    async probeContentEvidence(params) {
      try {
        const plan = await planEdits(host, Value.Parse(EditFileParamsSchema, params));
        return {
          path: plan.args.path,
          beforeHash: plan.beforeSnapshot,
          expectedAfterHash: snapshotTag(joinContent(plan.newLines, plan.split)),
        };
      } catch {
        return null;
      }
    },
    // 执行后实测目标现状内容哈希（receipt 的 contentAfterHash）；目标不可读返回 null
    hashContentTarget(params) {
      try {
        const args = Value.Parse(EditFileParamsSchema, params);
        return snapshotTag(host.readTextSync(args.path));
      } catch {
        return null;
      }
    },
    async execute(_toolCallId, params, signal): Promise<PigeonToolResult<EditFileDetails>> {
      const args = Value.Parse(EditFileParamsSchema, params);
      const plan = await planEdits(host, args);
      const newRaw = joinContent(plan.newLines, plan.split);
      // 唯一的副作用落盘点（写前最后查一次 abort；写后不可回滚，见上游 edit 笔记 §6.3）
      signal?.throwIfAborted();
      await host.writeText(plan.resolvedPath, newRaw);

      const afterSnapshot = snapshotTag(newRaw);
      const diff = buildEditDiff(args.path, plan.split.lines, plan.applied);
      const addedLines = plan.applied.reduce((total, edit) => total + edit.added.length, 0);
      const removedLines = plan.applied.reduce((total, edit) => total + edit.removed.length, 0);
      return {
        content: [
          {
            type: "text",
            text:
              `已在 ${args.path} 应用 ${plan.applied.length} 处编辑（+${addedLines} −${removedLines} 行）。` +
              `新快照 [${args.path}#${afterSnapshot}]`,
          },
        ],
        details: {
          resolvedPath: plan.resolvedPath,
          beforeSnapshot: plan.beforeSnapshot,
          afterSnapshot,
          diff,
          addedLines,
          removedLines,
        },
      };
    },
  };
}

// 读 + 围栏 + 快照预检 + 内存落地（零写副作用）；任一编辑失败整单抛错，文件零改动。
// execute 与 preview 共享同一预检路径，保证"预览所见 = 执行所得"。
async function planEdits(host: WorkspaceHost, args: EditFileParams) {
  const resolvedPath = await host.resolveExisting(args.path);
  if (!(await host.isFile(resolvedPath))) {
    throw new EditFileError(`不是常规文件：${args.path}`);
  }
  const raw = await host.readText(resolvedPath);
  const beforeSnapshot = snapshotTag(raw);
  if (beforeSnapshot !== args.snapshot) {
    throw new EditFileError(
      `快照过期：文件自读取后已变化（期望 ${args.snapshot}，实际 ${beforeSnapshot}）。` +
        `请重新 read_file 获取最新锚点与快照后再编辑`
    );
  }
  const split = splitContent(raw);
  const { lines: newLines, applied } = applyHashlineEdits(
    split.lines,
    args.edits as HashlineEdit[]
  );
  return { args, resolvedPath, beforeSnapshot, split, newLines, applied };
}
