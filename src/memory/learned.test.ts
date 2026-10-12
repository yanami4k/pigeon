// 学到的记忆的文件格式（决策 332、431）：一行一条，编号带层前缀，行末 (recorded 日期 · 来源 · session 会话号)；逐字往返、
// 改坏时指出行号、上限只计条目区且按码点计；内容里的括号与形如尾巴的文字不误判成尾巴；日常解析不认旧的〔〕尾巴。
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
  "- [P1] 提交信息用英文祈使句，不加类型前缀 (recorded 2026-10-01 · tui · session sess_01A)\n" +
  "- [P3] 设计文档在内部 wiki 的 Pigeon 空间 (recorded 2026-10-02 · cli · session sess_01B)\n" +
  "- [P4] 人手加的一条，没有来处\n";

test("逐字往返：规范写法的文件解析后序列化回去逐字相同；各条的编号、内容与来处按格式取出", () => {
  const parsed = parseMemory(PROJECT, "project");
  assert.ok(parsed.ok);
  assert.equal(serializeMemory(parsed.doc, "project"), PROJECT);
  assert.deepEqual(parsed.doc.entries, [
    {
      id: 1,
      content: "提交信息用英文祈使句，不加类型前缀",
      origin: { date: "2026-10-01", source: "tui", sessionId: "sess_01A" },
    },
    {
      id: 3,
      content: "设计文档在内部 wiki 的 Pigeon 空间",
      origin: { date: "2026-10-02", source: "cli", sessionId: "sess_01B" },
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

test("来处的写法：(recorded 日期 · 来源 · session 编号) 补在行尾；内容里自带的括号不当作来处", () => {
  assert.equal(
    serializeEntry(
      {
        id: 2,
        content: "甲",
        origin: { date: "2026-10-01", source: "tui", sessionId: "sess_X" },
      },
      "user"
    ),
    "- [U2] 甲 (recorded 2026-10-01 · tui · session sess_X)"
  );
  for (const content of [
    "〔不是来处〕的内容",
    "(不是来处) 的内容",
    "用 pnpm (不用 npm)",
    "见 (recorded 2026-10-01 · tui · session sess_X) 之前的写法",
  ]) {
    const parsed = parseMemory(`- [U1] ${content}\n`, "user");
    assert.ok(parsed.ok, content);
    assert.deepEqual(parsed.doc.entries, [{ id: 1, content }], content);
  }
});

test("日常解析只认新格式：旧的〔〕尾巴整段算内容，不取出来处", () => {
  const legacy = "- [P1] 甲 〔2026-10-01 · 终端界面 · 会话 sess_X〕";
  const parsed = parseMemory(`${legacy}\n`, "project");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.doc.entries, [
    { id: 1, content: "甲 〔2026-10-01 · 终端界面 · 会话 sess_X〕" },
  ]);
});

test("内容本身以形如尾巴的文字结尾：工具补的尾巴在最后，解析取最后一段，内容逐字取回；往返不变", () => {
  const tricky = [
    "旧写法是 (recorded 2026-09-01 · cli · session sess_OLD)",
    "(recorded 2026-09-01 · tui · session sess_OLD)",
    "括号没闭合 (recorded 2026-09-01 · tui · session",
    "多段 (a) (b) (recorded 2026-09-01 · x · session y) (c)",
    "〔2026-10-01 · 终端界面 · 会话 sess_Y〕",
  ];
  for (const content of tricky) {
    const entry = {
      id: 7,
      content,
      origin: { date: "2026-10-12", source: "tui", sessionId: "sess_NOW" },
    };
    const line = serializeEntry(entry, "project");
    assert.ok(line.endsWith(" (recorded 2026-10-12 · tui · session sess_NOW)"), line);
    const parsed = parseMemory(`${line}\n`, "project");
    assert.ok(parsed.ok, line);
    assert.deepEqual(parsed.doc.entries, [entry], line);
    assert.equal(serializeMemory(parsed.doc, "project"), `${line}\n`);
  }
});

test("没有尾巴的人手条目以形如尾巴的文字结尾：按尾巴读出，写回逐字相同（文字不变、推送不变）", () => {
  const text = "- [P2] 人手写的 (recorded 2026-10-01 · wiki · session 无)\n";
  const parsed = parseMemory(text, "project");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.doc.entries, [
    { id: 2, content: "人手写的", origin: { date: "2026-10-01", source: "wiki", sessionId: "无" } },
  ]);
  assert.equal(serializeMemory(parsed.doc, "project"), text);
  assert.equal(renderForWrite(parsed.doc, "project"), text);
});

test("文件头为英文：标题与一行注释，说明一行一条的写法", () => {
  assert.equal(
    MEMORY_FILE_HEADERS.project,
    "# Learned memory (this project)\n" +
      "<!-- Maintained by Pigeon's update_memory; you can also edit it with /memory edit project in the terminal UI. One entry per line: ID and content, followed by (recorded date · source · session ID). -->\n" +
      "\n"
  );
  assert.equal(
    MEMORY_FILE_HEADERS.user,
    "# Learned memory (all projects)\n" +
      "<!-- Maintained by Pigeon's update_memory; you can also edit it with /memory edit user in the terminal UI. One entry per line: ID and content, followed by (recorded date · source · session ID). -->\n" +
      "\n"
  );
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
