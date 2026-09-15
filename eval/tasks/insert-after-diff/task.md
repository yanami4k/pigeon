# 修复 insertAfter 编辑的删除记账与 diff 展示

`src/tools/hashline.ts` 是按行锚点编辑的算法层：

- `applyHashlineEdits(lines, edits)` 应用一批编辑（`replace` / `insertAfter` / `delete`），返回新行数组与每处编辑的 `AppliedEdit`（`kind`、1-based 闭区间 `startLine`/`endLine`、`removed` 删了哪些行、`added` 加了哪些行）；
- `buildEditDiff(path, oldLines, applied)` 据此生成审批时展示的 diff：头两行 `--- a/<path>`、`+++ b/<path>`，每处编辑一个 hunk，hunk 头为 `@@ <startLine>#<该行 lineTag> @@`，上下各带最多 2 行上下文（上下文行前缀一个空格，删行前缀 `-`，加行前缀 `+`）。

`edit_file` 工具用 `removed.length` 统计删除行数，用 `buildEditDiff` 给人看改动。

## 缺陷

`insertAfter` 只在锚点行之后插入，并不删除任何行，行数组的结果是对的；但它的 `AppliedEdit.removed` 却记成了 `[锚点行]`。于是 diff 里锚点行显示为 `-` 删行，`edit_file` 也报告"删了 1 行"，给审批人错误的信息。

## 期望行为

1. `insertAfter` 的 `AppliedEdit`：`kind` 为 `"insertAfter"`，`startLine` 与 `endLine` 都是锚点行号（与现在一致），`removed` 为 `[]`，`added` 为插入的行。
2. `buildEditDiff` 对 `insertAfter` 的 hunk：
   - 头部仍是 `@@ <锚点行号>#<锚点行 lineTag> @@`；
   - 上文为锚点行及其之前最多 1 行（共最多 2 行，**包含锚点行本身**），作为上下文行；
   - 然后是 `+` 行；
   - 下文为锚点行之后最多 2 行。
   - 例：旧行 `l1..l6`，在第 4 行后插入 `new`，hunk 体依次为 ` l3`、` l4`、`+new`、` l5`、` l6`。在第 1 行后插入时上文只有锚点行；在最后一行后插入时没有下文。
3. `replace` 与 `delete` 的记账和 diff 保持不变；`applyHashlineEdits` 的锚点校验、重叠检测、"无实际变化"拒绝等行为都不变。

## 约束

- 只改 `src/tools/hashline.ts`，导出与签名不变。
- 可以用 `node --test <测试文件>` 自测。
