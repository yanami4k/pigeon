# insert-after-diff

- 测什么能力：顺着数据流（编辑记账 → diff 渲染 → 工具报告）定位语义缺陷，修正记账并同步调整展示上下文，不影响其他编辑类型。
- 任务来源：依据本仓库 `src/tools/hashline.ts` 源码自编。
- 许可：随本仓库。
- 参考改法要点：`resolveEdit` 里 `insertAfter` 的 `removed` 置 `[]`；`buildEditDiff` 对 `insertAfter` 把上文取为 `oldLines.slice(max(0, startLine - 2), startLine)`，下文不变。
