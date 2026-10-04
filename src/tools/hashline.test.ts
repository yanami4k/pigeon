import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyHashlineEdits,
  HashlineError,
  joinContent,
  lineTag,
  parseAnchor,
  snapshotTag,
  splitContent,
} from "./hashline.ts";

test("lineTag / snapshotTag：稳定、定长小写 hex、内容敏感", () => {
  assert.match(lineTag("const x = 1;"), /^[0-9a-f]{4}$/);
  assert.equal(lineTag("const x = 1;"), lineTag("const x = 1;"));
  assert.notEqual(lineTag("const x = 1;"), lineTag("const x = 2;"));
  assert.match(snapshotTag("a\nb\n"), /^[0-9a-f]{16}$/);
  assert.notEqual(snapshotTag("a\nb\n"), snapshotTag("a\nb \n"));
});

test("parseAnchor：合法锚点拆出行号与标签，畸形一律拒绝", () => {
  assert.deepEqual(parseAnchor("12#a1b2"), { line: 12, tag: "a1b2" });
  for (const bad of ["", "12", "#a1b2", "12#A1B2", "12#a1b", "12#a1b23", "x12#a1b2", "0#a1b2"]) {
    assert.throws(() => parseAnchor(bad), HashlineError, bad);
  }
});

test("splitContent/joinContent 往返：LF / CRLF / BOM / 无末尾换行 / 空文件", () => {
  for (const raw of ["a\nb\n", "a\nb", "a\r\nb\r\n", "\uFEFFa\nb\n", "", "\n", "单行无换行"]) {
    const split = splitContent(raw);
    assert.equal(joinContent(split.lines, split), raw);
  }
  // CRLF 归一化后行内容不带 \r
  assert.deepEqual(splitContent("a\r\nb\r\n").lines, ["a", "b"]);
});

test("replace 单锚点命中：换掉该行", () => {
  const lines = ["alpha", "beta", "gamma"];
  const anchor = `2#${lineTag("beta")}`;
  const result = applyHashlineEdits(lines, [{ op: "replace", anchor, lines: ["BETA"] }]);
  assert.deepEqual(result.lines, ["alpha", "BETA", "gamma"]);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0]?.removed, ["beta"]);
  assert.deepEqual(result.applied[0]?.added, ["BETA"]);
});

test("replace 范围锚点（endAnchor）：换掉连续多行", () => {
  const lines = ["a", "b", "c", "d"];
  const result = applyHashlineEdits(lines, [
    { op: "replace", anchor: `2#${lineTag("b")}`, endAnchor: `3#${lineTag("c")}`, lines: ["x"] },
  ]);
  assert.deepEqual(result.lines, ["a", "x", "d"]);
});

test("insertAfter / delete", () => {
  const lines = ["a", "b", "c"];
  const inserted = applyHashlineEdits(lines, [
    { op: "insertAfter", anchor: `1#${lineTag("a")}`, lines: ["x", "y"] },
  ]);
  assert.deepEqual(inserted.lines, ["a", "x", "y", "b", "c"]);

  const deleted = applyHashlineEdits(lines, [
    { op: "delete", anchor: `2#${lineTag("b")}`, endAnchor: `3#${lineTag("c")}` },
  ]);
  assert.deepEqual(deleted.lines, ["a"]);
});

test("多处编辑一次应用：按位置从后往前落，互不错位", () => {
  const lines = ["a", "b", "c", "d", "e"];
  const result = applyHashlineEdits(lines, [
    { op: "replace", anchor: `1#${lineTag("a")}`, lines: ["A"] },
    { op: "delete", anchor: `4#${lineTag("d")}` },
    { op: "insertAfter", anchor: `5#${lineTag("e")}`, lines: ["tail"] },
  ]);
  assert.deepEqual(result.lines, ["A", "b", "c", "e", "tail"]);
});

test("锚点 tag 不匹配（行号漂移/内容已变）拒绝", () => {
  const lines = ["alpha", "beta"];
  // "beta" 在第二行，却用第一行的锚点
  assert.throws(
    () =>
      applyHashlineEdits(lines, [{ op: "replace", anchor: `1#${lineTag("beta")}`, lines: ["x"] }]),
    HashlineError
  );
});

test("锚点行号越界拒绝", () => {
  assert.throws(
    () => applyHashlineEdits(["a"], [{ op: "delete", anchor: `9#${lineTag("a")}` }]),
    HashlineError
  );
});

test("多处编辑范围重叠拒绝（保守：insertAfter 与被覆盖行同址也算重叠）", () => {
  const lines = ["a", "b", "c"];
  assert.throws(
    () =>
      applyHashlineEdits(lines, [
        {
          op: "replace",
          anchor: `1#${lineTag("a")}`,
          endAnchor: `2#${lineTag("b")}`,
          lines: ["x"],
        },
        { op: "delete", anchor: `2#${lineTag("b")}` },
      ]),
    HashlineError
  );
  assert.throws(
    () =>
      applyHashlineEdits(lines, [
        { op: "replace", anchor: `1#${lineTag("a")}`, lines: ["x"] },
        { op: "insertAfter", anchor: `1#${lineTag("a")}`, lines: ["y"] },
      ]),
    HashlineError
  );
});

test("无实际变化的编辑拒绝", () => {
  const lines = ["a", "b"];
  assert.throws(
    () => applyHashlineEdits(lines, [{ op: "replace", anchor: `1#${lineTag("a")}`, lines: ["a"] }]),
    (error) => error instanceof HashlineError && /没有产生任何实际变化/.test(error.message)
  );
});
