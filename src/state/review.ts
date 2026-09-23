// 后台审阅配置（M6，决策 064 子裁决 ①）：审阅已随第一版学习闭环退役（决策 137），不再写入；
// 形状只为 run.started 与注入快照里的审阅字段而留，随两处字段一并删除（账本退役一步）。
import { type Static, Type } from "typebox";

export const ReviewConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  everyTurns: Type.Integer({ minimum: 0 }),
});
export type ReviewConfig = Static<typeof ReviewConfigSchema>;
