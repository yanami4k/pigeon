// 学到的记忆的文件格式（决策 332）：一行一条，编号带层前缀，〔〕里是日期、来源与会话编号；逐字往返、改坏时指出行号、
// 上限只计条目区且按码点计。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  countChars,
  entryChars,
  localDate,
  MEMORY_FILE_HEADERS,
  memoryFactsOfText,
  nextId,
  parseMemory,
  renderForWrite,
  serializeEntry,
  serializeMemory,
  usedChars,
} from "./learned.ts";

const PROJECT =
  `${MEMORY_FILE_HEADERS.project}` +
  "- [P1] 提交信息用英文祈使句，不加类型前缀 〔2026-10-01 · 终端界面 · 会话 sess_01A〕\n" +
  "- [P3] 设计文档在内部 wiki 的 Pigeon 空间 〔2026-10-02 · 命令行对话 · 会话 sess_01B〕\n" +
  "- [P4] 人手加的一条，没有来处\n";

test("逐字往返：规范写法的文件解析后序列化回去逐字相同；各条的编号、内容与来处按格式取出", () => {
  const parsed = parseMemory(PROJECT, "project");
  assert.ok(parsed.ok);
  assert.equal(serializeMemory(parsed.doc, "project"), PROJECT);
  assert.deepEqual(parsed.doc.entries, [
    {
      id: 1,
      content: "提交信息用英文祈使句，不加类型前缀",
      origin: { date: "2026-10-01", source: "终端界面", sessionId: "sess_01A" },
    },
    {
      id: 3,
      content: "设计文档在内部 wiki 的 Pigeon 空间",
      origin: { date: "2026-10-02", source: "命令行对话", sessionId: "sess_01B" },
    },
    { id: 4, content: "人手加的一条，没有来处" },
  ]);
  assert.equal(nextId(parsed.doc.entries), 5);
});

test("CRLF 文件照常解析：先规范成 LF（Windows 编辑器存的文件能读，写回即 LF）", () => {
  const crlf = PROJECT.replaceAll("\n", "\r\n");
  const parsed = parseMemory(crlf, "project");
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.doc.entries.map((entry) => entry.id),
    [1, 3, 4]
  );
  assert.equal(parsed.doc.entries[0]?.content, "提交信息用英文祈使句，不加类型前缀");
  // 写回即规范形态（与 LF 原文逐字相同）
  assert.equal(serializeMemory(parsed.doc, "project"), PROJECT);
});

test("逐字往返：末尾没有换行、末尾多余空行、文件头被人改过、没有条目，都原样保留", () => {
  const body = PROJECT.slice(PROJECT.indexOf("- [P1]"));
  for (const text of [
    PROJECT.slice(0, -1),
    `${PROJECT}\n\n`,
    `# 我自己的标题\n随便写点说明\n\n${body}`,
    MEMORY_FILE_HEADERS.project,
    "",
    "# 只有标题",
  ]) {
    const parsed = parseMemory(text, "project");
    assert.ok(parsed.ok, text);
    assert.equal(serializeMemory(parsed.doc, "project"), text);
  }
});

test("改坏时指出第一处不对的行号：层前缀不符、缺编号、编号重复、空内容、条目区里夹着别的行", () => {
  const header = MEMORY_FILE_HEADERS.project;
  const headerLines = header.split("\n").length - 1;
  const cases: Array<[string, number]> = [
    [`${header}- [U1] 用户级的编号写进了项目级\n`, headerLines + 1],
    [`${header}- [P1] 甲\n- 没有编号\n`, headerLines + 2],
    [`${header}- [P1] 甲\n- [P1] 乙\n`, headerLines + 2],
    [`${header}- [P1] 甲\n- [P2] \n`, headerLines + 2],
    [`${header}- [P1] 甲\n\n- [P2] 乙\n`, headerLines + 2],
    [`${header}- [P1] 甲\n  续行\n`, headerLines + 2],
    [`${header}- [P0] 编号从 1 起\n`, headerLines + 1],
  ];
  for (const [text, line] of cases) {
    assert.deepEqual(parseMemory(text, "project"), { ok: false, line }, text);
  }
  assert.ok(parseMemory("- [U1] 用户级\n", "user").ok);
  assert.deepEqual(parseMemory("- [P1] 项目级写进了用户级\n", "user"), { ok: false, line: 1 });
});

test("来处的写法：〔日期 · 来源 · 会话 编号〕补在行尾；内容里自带的〔〕不当作来处", () => {
  assert.equal(
    serializeEntry(
      {
        id: 2,
        content: "甲",
        origin: { date: "2026-10-01", source: "终端界面", sessionId: "sess_X" },
      },
      "user"
    ),
    "- [U2] 甲 〔2026-10-01 · 终端界面 · 会话 sess_X〕"
  );
  const parsed = parseMemory("- [U1] 〔不是来处〕的内容\n", "user");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.doc.entries, [{ id: 1, content: "〔不是来处〕的内容" }]);
});

test("已用字符：只计条目区、按码点计、每条连同结尾换行；文件头不计", () => {
  const parsed = parseMemory(PROJECT, "project");
  assert.ok(parsed.ok);
  const section = PROJECT.slice(PROJECT.indexOf("- [P1]"));
  assert.equal(usedChars(parsed.doc.entries, "project"), countChars(section));
  assert.equal(
    parsed.doc.entries.reduce((sum, entry) => sum + entryChars(entry, "project"), 0),
    countChars(section)
  );
  assert.equal(countChars("𠀀a"), 2, "按码点计：扩展区汉字算一个字符");
  assert.deepEqual(memoryFactsOfText(PROJECT), { entries: 3, entryChars: countChars(section) });
  assert.deepEqual(memoryFactsOfText(`${PROJECT}\n\n`), {
    entries: 3,
    entryChars: countChars(section),
  });
  assert.deepEqual(memoryFactsOfText(MEMORY_FILE_HEADERS.user), { entries: 0, entryChars: 0 });
});

test("写入后的原文：文件头不以换行结尾时补一个，末尾规整为一个换行", () => {
  const parsed = parseMemory("# 标题", "project");
  assert.ok(parsed.ok);
  assert.equal(
    renderForWrite({ ...parsed.doc, entries: [{ id: 1, content: "甲" }] }, "project"),
    "# 标题\n- [P1] 甲\n"
  );
  const many = parseMemory(`${PROJECT}\n\n\n`, "project");
  assert.ok(many.ok);
  assert.equal(renderForWrite(many.doc, "project"), PROJECT);
});

test("日期按本地时间写成 YYYY-MM-DD", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
