// 审阅只读工具的名字（M6 S1，决策 064 子裁决 ⑤）：常量放在 state 叶子层，
// orchestration 的角色表与 review 层的工具实现共用同一批名字，不引入反向依赖。
// 两个工具的作用域都只限"被审的那一次 Run 的冻结快照"：不做跨会话检索（整棵会话树归 M7）。
import { type Static, Type } from "typebox";
import type { RunId, SessionId } from "./ids.ts";

export const REVIEW_SNAPSHOT_TOOL = "review_snapshot";
export const REVIEW_ENTRY_TOOL = "review_entry";

// 后台审阅配置（子裁决 ①）：开关与轮次间隔（0 = 只在 Run 结束审），会话开始时冻结进注入快照并随 run.started 落盘
export const ReviewConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  everyTurns: Type.Integer({ minimum: 0 }),
});
export type ReviewConfig = Static<typeof ReviewConfigSchema>;

// 审阅目标：被审的那一次 Run 与增量起点（上次审阅覆盖到的条目号）。随派出请求交给 Reviewer 运行面，
// 两个只读工具的作用域据此绑定
export interface ReviewTarget {
  sessionId: SessionId;
  runId: RunId;
  sinceRunSeq?: number;
}
