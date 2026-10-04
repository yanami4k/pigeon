// 域错误标记（M5.5 S5，决策 050）：memory / skills 工具的错误对象自带归类标记，判据先读标记；
// 标记值不合法时不采信，回落原有判据。
import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionToolError } from "../memory/search-tools.ts";
import { LoadSkillError } from "../skills/load-skill-tool.ts";
import { classifyToolError, TOOL_ERROR_KIND_MARK } from "./error-kind.ts";

test("错误标记：memory 与 skills 工具的域错误归 domain；标记可声明 environment；非法标记不采信", () => {
  assert.equal(classifyToolError(new SessionToolError("未找到 entry")), "domain");
  assert.equal(classifyToolError(new LoadSkillError("未登记的 Skill")), "domain");
  const environment = Object.assign(new Error("外部命令超时"), {
    [TOOL_ERROR_KIND_MARK]: "environment",
  });
  assert.equal(classifyToolError(environment), "environment");
  const bogus = Object.assign(new Error("乱标"), { [TOOL_ERROR_KIND_MARK]: "business" });
  assert.equal(classifyToolError(bogus), undefined);
  const bogusWithCode = Object.assign(new Error("乱标但带 code"), {
    [TOOL_ERROR_KIND_MARK]: 1,
    code: "ENOENT",
  });
  assert.equal(classifyToolError(bogusWithCode), "environment");
});
