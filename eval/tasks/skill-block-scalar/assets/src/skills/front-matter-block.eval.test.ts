import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillFrontMatter } from "./catalog.ts";

function doc(lines: string[], eol = "\n"): string {
  return ["---", ...lines, "---", "正文"].join(eol);
}

test("折叠块 >：相邻行以空格连接", () => {
  const parsed = parseSkillFrontMatter(
    doc(["name: deploy", "description: >", "  部署前先跑", "  全量验证"])
  );
  assert.deepEqual(parsed, { name: "deploy", description: "部署前先跑 全量验证" });
});

test("字面块 |：保留换行与多出的缩进", () => {
  assert.deepEqual(parseSkillFrontMatter(doc(["description: |", "  第一行", "  第二行"])), {
    description: "第一行\n第二行",
  });
  assert.deepEqual(parseSkillFrontMatter(doc(["description: |", "  a", "    b", "  c"])), {
    description: "a\n  b\nc",
  });
});

test("保留指示符 - / + 被接受且不影响结果", () => {
  for (const indicator of [">-", ">+"]) {
    assert.equal(
      parseSkillFrontMatter(doc([`description: ${indicator}`, "  x", "  y", ""])).description,
      "x y",
      indicator
    );
  }
  for (const indicator of ["|-", "|+"]) {
    assert.equal(
      parseSkillFrontMatter(doc([`description: ${indicator}`, "  x", "  y", ""])).description,
      "x\ny",
      indicator
    );
  }
});

test("块在下一个不缩进的键处结束，块内行不作键值解析", () => {
  const parsed = parseSkillFrontMatter(
    doc(["description: |", "  name: 不是键", "  第二行", "name: after"])
  );
  assert.deepEqual(parsed, { description: "name: 不是键\n第二行", name: "after" });
});

test("折叠块中的空白行产生换行", () => {
  assert.equal(
    parseSkillFrontMatter(doc(["description: >", "  a", "  b", "", "  c"])).description,
    "a b\nc"
  );
  assert.equal(
    parseSkillFrontMatter(doc(["description: >", "\tx", "\ty", "", ""])).description,
    "x y"
  );
});

test("CRLF 行尾行为相同", () => {
  const parsed = parseSkillFrontMatter(
    doc(["name: deploy", "description: >", "  部署前先跑", "  全量验证"], "\r\n")
  );
  assert.deepEqual(parsed, { name: "deploy", description: "部署前先跑 全量验证" });
});

test("空块视为未提供", () => {
  const parsed = parseSkillFrontMatter(doc(["description: |", "name: x"]));
  assert.deepEqual(parsed, { name: "x" });
  assert.ok(!("description" in parsed));
  const onlyBlank = parseSkillFrontMatter(doc(["name: |", "   ", "description: d"]));
  assert.deepEqual(onlyBlank, { description: "d" });
});

test("既有行为不变", () => {
  assert.deepEqual(
    parseSkillFrontMatter(doc(['name: "quoted"', "description: 'hi: there'", "other: ignored"])),
    { name: "quoted", description: "hi: there" }
  );
  assert.deepEqual(parseSkillFrontMatter("没有前言\nname: x"), {});
  assert.deepEqual(
    parseSkillFrontMatter(
      doc(["metadata: |", "  name: fake", "  description: fake", "name: real"])
    ),
    { name: "real" }
  );
});
