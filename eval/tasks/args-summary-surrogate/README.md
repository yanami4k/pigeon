# args-summary-surrogate

- 测什么能力：定位并修复字符串截断的边界缺陷（UTF-16 代理对），同时保持既有口径不变。
- 任务来源：依据本仓库 `src/application/format.ts` 的 `summarizeArgs` 源码自编。
- 许可：随本仓库。
- 参考改法要点：切点前一个码元若是高位代理（0xD800–0xDBFF），切点减一；`共 N 字符` 仍用 `json.length`。
