# session-day-groups

- 测什么能力：小型数据变换——按 UTC 日期分组、稳定排序、字段汇总，不修改输入。
- 任务来源：依据本仓库 `src/state/session-summary.ts` 源码自编。
- 许可：随本仓库。
- 参考改法要点：复制输入后按 `createdAt` 稳定排序，`new Date(createdAt).toISOString().slice(0, 10)` 取日，依次累加到当日分组（排序后日期自然升序）。
