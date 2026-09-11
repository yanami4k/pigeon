// 工具错误分类（M4 S2，D7 ToolExecution 级判据）：域错误 = 业务失败，
// 环境异常 = 基础设施错误，判不出 = undefined（冷分类落「未知」默认桶，宁标不知道不贴错标签）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { EditFileError } from "./edit-file.ts";
import { classifyToolError } from "./error-kind.ts";
import { HashlineError } from "./hashline.ts";
import { WorkspacePathError } from "./paths.ts";
import { ReadFileError } from "./read-file.ts";

test("工具域错误归 domain：hashline 编辑错误 / 读文件域错误 / 路径围栏 / 参数校验", () => {
  assert.equal(classifyToolError(new EditFileError("快照过期")), "domain");
  assert.equal(classifyToolError(new HashlineError("锚点不匹配")), "domain");
  assert.equal(classifyToolError(new ReadFileError("offset 越界")), "domain");
  assert.equal(classifyToolError(new WorkspacePathError("路径越出工作区根")), "domain");
  // 参数校验失败：typebox Value.Parse 的 ParseError（模型给的参数不合 schema = 模型侧错误）
  let parseError: unknown;
  try {
    Value.Parse(Type.Object({ a: Type.String() }), { a: 1 });
  } catch (error) {
    parseError = error;
  }
  assert.equal(classifyToolError(parseError), "domain");
});

test("环境异常归 environment：文件系统调用抛出的 ErrnoException（ENOENT/EACCES 等）", () => {
  let fsError: unknown;
  try {
    readFileSync("/nonexistent/definitely-missing-file.txt", "utf8");
  } catch (error) {
    fsError = error;
  }
  assert.equal(classifyToolError(fsError), "environment");
});

test("判不出归 undefined：普通 Error / abort 信号 / 非错误值都不贴标签", () => {
  assert.equal(classifyToolError(new Error("不明错误")), undefined);
  // abort 的归类的判据在 Run 终态（stopReason=aborted），不在错误对象上
  assert.equal(
    classifyToolError(new DOMException("This operation was aborted", "AbortError")),
    undefined
  );
  assert.equal(classifyToolError("字符串不是错误"), undefined);
  assert.equal(classifyToolError(undefined), undefined);
});
