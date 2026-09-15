# 修复参数摘要截断劈开代理对

`src/application/format.ts` 里的 `summarizeArgs(args: unknown): string` 把模型给的工具参数序列化成单行 JSON 摘要，超过 160 个 UTF-16 码元时截断，并追加 `…（共 N 字符）`。

## 缺陷

截断直接按码元下标切片。当第 160 个码元恰好是一个代理对（例如 emoji）的高位代理时，摘要末尾会留下一个孤立的高位代理，得到不合法的 UTF-16 字符串（在终端和日志里显示为乱码，`String.prototype.isWellFormed()` 返回 false）。

## 期望行为

- 截断时如果切点会把一个代理对劈成两半，就少取一个码元，让被劈开的那个字符整个落到截断部分之外。也就是说，保留前缀是"长度不超过 160 个码元、且不以孤立高位代理结尾"的最长前缀。
- 后缀 `…（共 N 字符）` 的 N 仍是完整 JSON 字符串的 `length`（UTF-16 码元数），口径不变。
- JSON 长度不超过 160 时原样返回，不截断（即使其中含 emoji）。
- 其余行为不变：不可序列化的参数仍返回 `<不可序列化参数>`；`JSON.stringify` 返回 `undefined` 时仍按字符串 `"undefined"` 处理。

## 约束

- 只改 `src/application/format.ts`，函数签名不变。
- 可以用 `node --test <测试文件>` 自测。
