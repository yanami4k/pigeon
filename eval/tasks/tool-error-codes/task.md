# 收紧工具错误的"环境异常"判据

`src/tools/error-kind.ts` 的 `classifyToolError(error: unknown): ToolErrorKind | undefined` 给工具抛出的错误归类：`"domain"`（工具域错误，归业务失败）、`"environment"`（环境异常，归基础设施错误）、`undefined`（判不出，冷分类落"未知"）。按模块注释，判不出时宁可不贴标签。

## 缺陷

现在只要是 `Error` 且带字符串 `code` 就判为 `"environment"`。这把两类并非环境异常的错误贴错了标签：

- Node 的中止错误：例如 `node:timers/promises` 的 `setTimeout` 被 `AbortSignal` 中止时抛出的错误，`name` 为 `"AbortError"`、`code` 为 `"ABORT_ERR"`。中止的归类判据在 Run 终态，不在错误对象上。
- Node 内部的编程错误码：`ERR_INVALID_ARG_TYPE`、`ERR_STREAM_DESTROYED` 等以 `ERR_` 开头的 code。

## 期望判定顺序

1. 错误对象上的归类标记（`pigeonToolErrorKind`）优先，行为不变。
2. 已有的域错误类（`EditFileError`、`HashlineError`、`ReadFileError`、`WorkspacePathError`、typebox `ParseError`）仍归 `"domain"`。
3. 中止错误：`Error` 且 `name === "AbortError"`，或 `code === "ABORT_ERR"`，一律返回 `undefined`。即使同时带着 errno 风格的 code 也返回 `undefined`。
4. 只有 errno 风格的 code 才算 `"environment"`：`Error` 且 `code` 是字符串并完整匹配 `/^E[A-Z0-9]+$/`（如 `ENOENT`、`EACCES`、`EBUSY`、`ENOSPC`）。
5. 其余情况返回 `undefined`，包括 `ERR_` 开头的 code、单独的 `"E"`、小写 code、数字 code、普通 `Error`、非错误值。

## 约束

- 只改 `src/tools/error-kind.ts`，导出与签名不变。
- 可以用 `node --test <测试文件>` 自测。
