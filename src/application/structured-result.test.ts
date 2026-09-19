// 收尾结果的结构化解析（M6 决策 064 起；M7 真实模型验收暴露的稳健性缺口）：模型常在结果前写一段分析文字、
// 再用 ```json 围栏给出结果。解析取最后一个能解析成对象的 json 围栏块；没有围栏时取整段或首个 { 到末个 } 之间；
// 都解析不了视为没有结构化结果，不抛。
import assert from "node:assert/strict";
import { test } from "node:test";
import { structuredResultOf } from "./workers.ts";

test("整段 JSON 与只有围栏的回复照旧解析", () => {
  assert.deepEqual(structuredResultOf('{"candidates":[]}'), { candidates: [] });
  assert.deepEqual(structuredResultOf('```json\n{"candidates":[]}\n```'), { candidates: [] });
});

test("分析文字在前、json 围栏在后：取最后一个能解析的围栏块", () => {
  const text = [
    "差异已明确：失败侧没有去掉变音符号。",
    "```json",
    '{"candidates":[{"name":"a"}]}',
    "```",
  ].join("\n");
  assert.deepEqual(structuredResultOf(text), { candidates: [{ name: "a" }] });
  const twoBlocks = `先看\n\`\`\`json\n{"draft":true}\n\`\`\`\n最终：\n\`\`\`json\n{"candidates":[]}\n\`\`\``;
  assert.deepEqual(structuredResultOf(twoBlocks), { candidates: [] });
});

test("没有围栏但对象前后有文字：取首个 { 到末个 } 之间；解析不了视为没有", () => {
  assert.deepEqual(structuredResultOf('结果如下 {"candidates":[]} 完'), { candidates: [] });
  assert.equal(structuredResultOf("没有结果"), undefined);
  assert.equal(structuredResultOf("```json\n{坏的\n```"), undefined);
  assert.equal(structuredResultOf("[1,2]"), undefined, "数组不是结构化结果");
});
