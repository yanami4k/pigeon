# tool-error-codes

- 测什么能力：按判定顺序收紧错误分类判据，区分 errno 环境异常、中止错误与 Node 内部编程错误码，同时保持标记与域错误类的优先级。
- 任务来源：依据本仓库 `src/tools/error-kind.ts` 源码自编。
- 许可：随本仓库。
- 参考改法要点：域错误类判定之后，先对 `name === "AbortError" || code === "ABORT_ERR"` 返回 `undefined`，再把 environment 条件收紧为 code 匹配 `/^E[A-Z0-9]+$/`。
