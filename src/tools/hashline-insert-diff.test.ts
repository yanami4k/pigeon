import assert from "node:assert/strict";
import { test } from "node:test";
import { applyHashlineEdits, buildEditDiff, HashlineError, lineTag } from "./hashline.ts";

const SIX = ["l1", "l2", "l3", "l4", "l5", "l6"];

function anchor(lines: readonly string[], line: number): string {
  return `${line}#${lineTag(lines[line - 1] as string)}`;
}

test("insertAfter 的记账：不删除任何行", () => {
  const result = applyHashlineEdits(
    ["a", "b", "c"],
    [{ op: "insertAfter", anchor: anchor(["a", "b", "c"], 1), lines: ["x", "y"] }]
  );
  assert.deepEqual(result.lines, ["a", "x", "y", "b", "c"]);
  assert.deepEqual(result.applied, [
    { kind: "insertAfter", startLine: 1, endLine: 1, removed: [], added: ["x", "y"] },
  ]);
});

test("insertAfter 的 diff：锚点行作上下文", () => {
  const { applied } = applyHashlineEdits(SIX, [
    { op: "insertAfter", anchor: anchor(SIX, 4), lines: ["new"] },
  ]);
  assert.equal(
    buildEditDiff("f.txt", SIX, applied),
    [
      "--- a/f.txt",
      "+++ b/f.txt",
      `@@ 4#${lineTag("l4")} @@`,
      " l3",
      " l4",
      "+new",
      " l5",
      " l6",
    ].join("\n")
  );
});

test("insertAfter 在首行与末行", () => {
  const lines = ["a", "b", "c"];
  const first = applyHashlineEdits(lines, [
    { op: "insertAfter", anchor: anchor(lines, 1), lines: ["x"] },
  ]);
  assert.equal(
    buildEditDiff("p", lines, first.applied),
    ["--- a/p", "+++ b/p", `@@ 1#${lineTag("a")} @@`, " a", "+x", " b", " c"].join("\n")
  );
  const last = applyHashlineEdits(lines, [
    { op: "insertAfter", anchor: anchor(lines, 3), lines: ["x", "y"] },
  ]);
  assert.equal(
    buildEditDiff("p", lines, last.applied),
    ["--- a/p", "+++ b/p", `@@ 3#${lineTag("c")} @@`, " b", " c", "+x", "+y"].join("\n")
  );
});

test("replace 与 delete 的记账和 diff 不变", () => {
  const replaced = applyHashlineEdits(SIX, [
    { op: "replace", anchor: anchor(SIX, 3), endAnchor: anchor(SIX, 4), lines: ["X"] },
  ]);
  assert.deepEqual(replaced.applied, [
    { kind: "replace", startLine: 3, endLine: 4, removed: ["l3", "l4"], added: ["X"] },
  ]);
  assert.equal(
    buildEditDiff("f", SIX, replaced.applied),
    [
      "--- a/f",
      "+++ b/f",
      `@@ 3#${lineTag("l3")} @@`,
      " l1",
      " l2",
      "-l3",
      "-l4",
      "+X",
      " l5",
      " l6",
    ].join("\n")
  );
  const lines = ["a", "b", "c"];
  const deleted = applyHashlineEdits(lines, [{ op: "delete", anchor: anchor(lines, 2) }]);
  assert.deepEqual(deleted.applied, [
    { kind: "delete", startLine: 2, endLine: 2, removed: ["b"], added: [] },
  ]);
  assert.equal(
    buildEditDiff("f", lines, deleted.applied),
    ["--- a/f", "+++ b/f", `@@ 2#${lineTag("b")} @@`, " a", "-b", " c"].join("\n")
  );
});

test("混合编辑：各 hunk 按位置升序，insertAfter 不记删除", () => {
  const { lines, applied } = applyHashlineEdits(SIX, [
    { op: "insertAfter", anchor: anchor(SIX, 6), lines: ["tail"] },
    { op: "replace", anchor: anchor(SIX, 1), lines: ["L1"] },
  ]);
  assert.deepEqual(lines, ["L1", "l2", "l3", "l4", "l5", "l6", "tail"]);
  assert.deepEqual(
    applied.map((edit) => [edit.kind, edit.removed.length, edit.added.length]),
    [
      ["replace", 1, 1],
      ["insertAfter", 0, 1],
    ]
  );
});

test("既有拒绝规则不变", () => {
  const lines = ["a", "b"];
  assert.throws(
    () =>
      applyHashlineEdits(lines, [
        { op: "replace", anchor: anchor(lines, 1), lines: ["x"] },
        { op: "insertAfter", anchor: anchor(lines, 1), lines: ["y"] },
      ]),
    HashlineError
  );
  assert.throws(
    () => applyHashlineEdits(lines, [{ op: "insertAfter", anchor: "3#0000", lines: ["y"] }]),
    HashlineError
  );
});
