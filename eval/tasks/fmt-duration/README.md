# fmt-duration

- 测什么能力：按规格新增一个纯函数，覆盖分档阈值、截断与四舍五入的区别、输入校验等边界。
- 任务来源：依据本仓库 `src/application/format.ts` 源码自编。
- 许可：随本仓库。
- 参考改法要点：在 `format.ts` 新增 `formatDuration`，先校验再 `Math.round`，按毫秒 / 秒（十分位 `Math.floor(t / 100)` 拆整数与小数）/ 分秒 / 时分四档拼串。
