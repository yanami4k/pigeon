# 会话摘要按日分组

`src/state/session-summary.ts` 定义了会话摘要 `SessionSummary`（含 `sessionId`、`createdAt`、`runCount`、`totalTokens`、`totalCost`、`pendingReconcile` 等字段）。请在同一文件中新增一个纯函数，把一组摘要按 UTC 日期分组汇总，供将来的日报视图使用。

## 对外接口

```ts
export interface SessionDayGroup {
  // UTC 日期，形如 "2026-09-14"
  day: string;
  // 当日会话，按 createdAt 升序
  sessionIds: SessionId[];
  runCount: number;
  totalTokens: number;
  totalCost: number;
  pendingReconcile: number;
}

export function groupSessionsByDay(summaries: readonly SessionSummary[]): SessionDayGroup[]
```

## 行为

1. `day` 取 `createdAt`（Unix 毫秒）对应的 **UTC** 日期，格式 `YYYY-MM-DD`（年四位、月日补零）。UTC 当天 `23:59:59.999` 与次日 `00:00:00.000` 分属两组。
2. 返回的分组按 `day` 升序排列；只包含至少有一个会话的日期，不补空日。
3. 组内 `sessionIds` 按 `createdAt` 升序排列；`createdAt` 相同时保持它们在输入里的相对顺序。
4. `runCount`、`totalTokens`、`totalCost`、`pendingReconcile` 为组内各摘要对应字段之和。
5. 输入为空数组时返回 `[]`。
6. 不修改输入数组及其元素。

## 约束

- 只改 `src/state/session-summary.ts`，已有导出与行为不变；本模块保持纯函数、无 IO。
- 可以用 `node --test <测试文件>` 自测。
