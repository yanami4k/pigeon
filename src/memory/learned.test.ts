// 学到的记忆的文件格式（决策 190、229）：逐字往返、改坏时指出行号、上限只计条目区且按码点计。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countChars,
  entriesSection,
  MEMORY_FILE_HEADER,
  memoryFactsOfText,
  parseMemory,
  renderForWrite,
  serializeMemory,
  usedChars,
} from "./learned.ts";

// B 第 5 节的文件头与示例（原文）
const EXAMPLE =
  "# 学到的记忆\n" +
  "<!-- 由 Pigeon 的 update_memory 维护，也可以直接查看、修改、删除。每条三行：事实 / 引用 / 理由；编号只用于定位，不表示先后或重要性。 -->\n" +
  "\n" +
  "- [L1] 事实：配置文件里的超时单位是秒，读取时在 load_settings 里统一换算成毫秒，调用方拿到的都是毫秒。\n" +
  "  引用：app/config.py::load_settings\n" +
  "  理由：两处调用方曾按秒再换算一次，导致超时放大一千倍；改超时相关逻辑前应先看换算发生在哪里。\n" +
  "- [L2] 事实：数据库迁移脚本按文件名排序执行，新脚本的编号必须大于目录里现有的最大编号。\n" +
  "  引用：migrations/runner.py::collect_scripts, migrations/\n" +
  "  理由：编号重复时后一个脚本会被静默跳过，测试环境不报错但线上缺表。\n" +
  "- [L3] 事实：本项目的提交信息用英文祈使句，不加类型前缀。\n" +
  "  引用：用户要求（会话 sess_01EXAMPLE）\n" +
  "  理由：用户在该会话中明确纠正过带前缀的写法。\n";

test("文件头与 B 第 5 节原文逐字一致", () => {
  assert.equal(
    MEMORY_FILE_HEADER,
    "# 学到的记忆\n<!-- 由 Pigeon 的 update_memory 维护，也可以直接查看、修改、删除。每条三行：事实 / 引用 / 理由；编号只用于定位，不表示先后或重要性。 -->\n\n"
  );
});

test("逐字往返：B 第 5 节示例解析后序列化回去逐字相同，三条的字段按格式取出", () => {
  const parsed = parseMemory(EXAMPLE);
  assert.ok(parsed.ok);
  assert.equal(serializeMemory(parsed.doc), EXAMPLE);
  assert.deepEqual(
    parsed.doc.entries.map((entry) => [entry.id, entry.refs]),
    [
      [1, ["app/config.py::load_settings"]],
      [2, ["migrations/runner.py::collect_scripts", "migrations/"]],
      [3, ["用户要求（会话 sess_01EXAMPLE）"]],
    ]
  );
});

test("逐字往返：末尾没有换行、文件头被人改过、没有条目，都原样保留", () => {
  for (const text of [
    EXAMPLE.slice(0, -1),
    `# 我自己的标题\n随便写点说明\n\n${EXAMPLE.slice(EXAMPLE.indexOf("- [L1]"))}`,
    MEMORY_FILE_HEADER,
    "",
    "# 只有标题",
  ]) {
    const parsed = parseMemory(text);
    assert.ok(parsed.ok, text);
    assert.equal(serializeMemory(parsed.doc), text);
  }
});

test("改坏格式：报出第一处不对的行号（从 1 起，文件头计入行号）", () => {
  const lines = EXAMPLE.split("\n");
  const broken = (index: number, replacement: string) =>
    [...lines.slice(0, index), replacement, ...lines.slice(index + 1)].join("\n");
  // 第 5 行（L1 的引用行）少了缩进
  assert.deepEqual(parseMemory(broken(4, "引用：app/config.py")), { ok: false, line: 5 });
  // 第 7 行（L2 的事实行）编号写成了 X
  assert.deepEqual(parseMemory(broken(6, "- [LX] 事实：什么")), { ok: false, line: 7 });
  // 条目之间多了空行：空行那一行不对
  assert.deepEqual(parseMemory(broken(6, `\n${lines[6]}`)), { ok: false, line: 7 });
  // 编号重复
  assert.deepEqual(parseMemory(broken(6, "- [L1] 事实：重复的编号")), { ok: false, line: 7 });
  // 最后一条缺理由行
  assert.deepEqual(parseMemory(EXAMPLE.split("\n").slice(0, 11).join("\n")), {
    ok: false,
    line: 12,
  });
  // 文件末尾多出一行
  assert.deepEqual(parseMemory(`${EXAMPLE}多出来的一行\n`), { ok: false, line: 13 });
});

test("上限只计条目区、不计文件头，按 Unicode 码点计（代理对算一个字符）", () => {
  const parsed = parseMemory(EXAMPLE);
  assert.ok(parsed.ok);
  const section = EXAMPLE.slice(EXAMPLE.indexOf("- [L1]"));
  assert.equal(entriesSection(EXAMPLE), section);
  assert.equal(usedChars(parsed.doc.entries), [...section].length);
  assert.equal(memoryFactsOfText(EXAMPLE).entryChars, [...section].length);
  assert.equal(memoryFactsOfText(EXAMPLE).entries, 3);
  assert.equal(countChars("a😀b"), 3);
  assert.notEqual("a😀b".length, 3);
  // 文件头再长也不计
  assert.equal(
    memoryFactsOfText(`# 标题\n${"说明".repeat(500)}\n\n${section}`).entryChars,
    [...section].length
  );
});

test("写入时文件头不以换行结尾即补一个，末尾一律带换行", () => {
  const parsed = parseMemory("# 只有标题");
  assert.ok(parsed.ok);
  const text = renderForWrite({
    ...parsed.doc,
    entries: [{ id: 1, fact: "事实", refs: ["a.py"], reason: "理由" }],
  });
  assert.equal(text, "# 只有标题\n- [L1] 事实：事实\n  引用：a.py\n  理由：理由\n");
  assert.ok(parseMemory(text).ok);
});
