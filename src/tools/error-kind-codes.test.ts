import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { classifyToolError } from "./error-kind.ts";
import { HashlineError } from "./hashline.ts";
import { WorkspacePathError } from "./paths.ts";

function withCode(code: unknown, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("synthetic"), { code, ...extra });
}

test("errno 风格 code 归 environment", () => {
  let fsError: unknown;
  try {
    readFileSync("/nonexistent/pigeon-eval-missing-file.txt", "utf8");
  } catch (error) {
    fsError = error;
  }
  assert.equal(classifyToolError(fsError), "environment");
  for (const code of ["EACCES", "EBUSY", "ENOSPC", "EMFILE", "E2BIG"]) {
    assert.equal(classifyToolError(withCode(code)), "environment", code);
  }
});

test("Node 中止错误不贴标签", async () => {
  let abortError: unknown;
  try {
    await delay(5, null, { signal: AbortSignal.abort() });
  } catch (error) {
    abortError = error;
  }
  assert.ok(abortError instanceof Error);
  assert.equal(classifyToolError(abortError), undefined);
  assert.equal(classifyToolError(withCode("ABORT_ERR")), undefined);
  assert.equal(classifyToolError(Object.assign(new Error("x"), { name: "AbortError" })), undefined);
  assert.equal(classifyToolError(withCode("ECONNRESET", { name: "AbortError" })), undefined);
});

test("ERR_ 编程错误码与其他非 errno code 不贴标签", () => {
  let argError: unknown;
  try {
    Buffer.alloc("x" as unknown as number);
  } catch (error) {
    argError = error;
  }
  assert.ok(argError instanceof Error);
  assert.equal(classifyToolError(argError), undefined);
  for (const code of ["ERR_STREAM_DESTROYED", "ERR_X", "E", "enoent", "Enoent", 13]) {
    assert.equal(classifyToolError(withCode(code)), undefined, String(code));
  }
});

test("标记与域错误类优先级不变", () => {
  assert.equal(
    classifyToolError(withCode("ABORT_ERR", { pigeonToolErrorKind: "environment" })),
    "environment"
  );
  assert.equal(classifyToolError(withCode("ENOENT", { pigeonToolErrorKind: "domain" })), "domain");
  assert.equal(classifyToolError(new HashlineError("锚点不匹配")), "domain");
  assert.equal(classifyToolError(new WorkspacePathError("越界")), "domain");
  assert.equal(classifyToolError(new Error("普通")), undefined);
  assert.equal(classifyToolError("not an error"), undefined);
});
