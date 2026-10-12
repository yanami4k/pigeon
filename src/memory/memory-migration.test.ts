// 学到的记忆旧格式的一次性迁移（决策 431）：判定旧格式（旧文件头或任何一行带旧尾巴）、整份转换成新格式（文件头换新、
// 尾巴换写法、来源映射、认不出的来源原样、编号内容日期会话号不变、没有尾巴的照旧没有）、转换幂等；落盘时先备份再在锁内
// 改写，已是新格式不碰不备份；拿不到锁或出错时这一次在内存里转换后读出、不写文件、告警，下次再试。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { MEMORY_FILE_HEADERS, type MemoryLayer, parseMemory } from "./learned.ts";
import { type MemoryLocation, memoryLocation } from "./learned-store.ts";
import {
  convertLegacyMemoryText,
  isLegacyMemoryText,
  migrateMemoryFileLocked,
  readMemoryLayer,
} from "./memory-migration.ts";

const OLD_HEADERS: Readonly<Record<MemoryLayer, string>> = {
  project:
    "# 学到的记忆（本项目）\n" +
    "<!-- 由 Pigeon 的 update_memory 维护，也可以用终端界面的 /memory edit project 修改。一行一条：编号、内容，〔〕里是记下的日期、来源与会话编号。 -->\n" +
    "\n",
  user:
    "# 学到的记忆（所有项目）\n" +
    "<!-- 由 Pigeon 的 update_memory 维护，也可以用终端界面的 /memory edit user 修改。一行一条：编号、内容，〔〕里是记下的日期、来源与会话编号。 -->\n" +
    "\n",
};

const OLD_ENTRIES =
  "- [P1] 提交信息用英文祈使句，不加类型前缀 〔2026-10-01 · 终端界面 · 会话 sess_01A〕\n" +
  "- [P3] 设计文档在内部 wiki（Pigeon 空间） 〔2026-10-02 · 命令行对话 · 会话 sess_01B〕\n" +
  "- [P4] 人手加的一条，没有来处\n" +
  "- [P7] 别处来的 〔2026-10-03 · 手机 · 会话 abc-9〕\n";

const NEW_ENTRIES =
  "- [P1] 提交信息用英文祈使句，不加类型前缀 (recorded 2026-10-01 · tui · session sess_01A)\n" +
  "- [P3] 设计文档在内部 wiki（Pigeon 空间） (recorded 2026-10-02 · cli · session sess_01B)\n" +
  "- [P4] 人手加的一条，没有来处\n" +
  "- [P7] 别处来的 (recorded 2026-10-03 · 手机 · session abc-9)\n";

const LEGACY = OLD_HEADERS.project + OLD_ENTRIES;
const CONVERTED = MEMORY_FILE_HEADERS.project + NEW_ENTRIES;

test("判定：旧文件头、任何一行带旧尾巴即为旧格式；新格式与内容里夹着旧尾巴样子的文字不算", () => {
  assert.equal(isLegacyMemoryText(LEGACY), true);
  // 只有旧文件头、没有条目
  assert.equal(isLegacyMemoryText(OLD_HEADERS.user), true);
  // 文件头被人换掉、只剩条目带旧尾巴
  assert.equal(isLegacyMemoryText(`# 我的标题\n\n${OLD_ENTRIES}`), true);
  // 新格式里只有一行旧尾巴（人手贴进来的）
  assert.equal(
    isLegacyMemoryText(`${CONVERTED}- [P8] 贴进来的 〔2026-10-04 · 终端界面 · 会话 x〕\n`),
    true
  );
  assert.equal(isLegacyMemoryText(CONVERTED), false);
  assert.equal(isLegacyMemoryText(""), false);
  assert.equal(isLegacyMemoryText(MEMORY_FILE_HEADERS.user), false);
  // 工具写的条目内容以旧尾巴样子的文字结尾：行末是新尾巴，不算旧格式
  assert.equal(
    isLegacyMemoryText(
      `${MEMORY_FILE_HEADERS.project}- [P1] 〔2026-10-01 · 终端界面 · 会话 a〕 (recorded 2026-10-12 · tui · session b)\n`
    ),
    false
  );
  // 文件头里的旧尾巴样子的文字不算（只看条目区）
  assert.equal(isLegacyMemoryText("说明 〔2026-10-01 · 终端界面 · 会话 a〕\n- [P1] 甲\n"), false);
});

test("转换：文件头换新、尾巴换写法、来源映射（认不出的原样）；编号、内容、日期、会话号不变，没有尾巴的照旧没有", () => {
  assert.equal(convertLegacyMemoryText(LEGACY), CONVERTED);
  assert.equal(
    convertLegacyMemoryText(
      `${OLD_HEADERS.user}- [U1] 回复用中文 〔2026-09-30 · 终端界面 · 会话 s〕\n`
    ),
    `${MEMORY_FILE_HEADERS.user}- [U1] 回复用中文 (recorded 2026-09-30 · tui · session s)\n`
  );
  const before = parseMemory(convertLegacyMemoryText(LEGACY), "project");
  assert.ok(before.ok);
  assert.deepEqual(before.doc.entries, [
    {
      id: 1,
      content: "提交信息用英文祈使句，不加类型前缀",
      origin: { date: "2026-10-01", source: "tui", sessionId: "sess_01A" },
    },
    {
      id: 3,
      content: "设计文档在内部 wiki（Pigeon 空间）",
      origin: { date: "2026-10-02", source: "cli", sessionId: "sess_01B" },
    },
    { id: 4, content: "人手加的一条，没有来处" },
    {
      id: 7,
      content: "别处来的",
      origin: { date: "2026-10-03", source: "手机", sessionId: "abc-9" },
    },
  ]);
});

test("转换：文件头里人加的行原样，只换旧标题行与注释行；CRLF 规范成 LF；格式坏的行原样留着", () => {
  const header = `${OLD_HEADERS.project.trimEnd()}\n我自己加的一行说明\n\n`;
  assert.equal(
    convertLegacyMemoryText(`${header}${OLD_ENTRIES}`),
    `${MEMORY_FILE_HEADERS.project.trimEnd()}\n我自己加的一行说明\n\n${NEW_ENTRIES}`
  );
  assert.equal(convertLegacyMemoryText(LEGACY.replaceAll("\n", "\r\n")), CONVERTED);
  const broken = `${OLD_HEADERS.project}- [P1] 甲 〔2026-10-01 · 终端界面 · 会话 a〕\n不是条目\n`;
  assert.equal(
    convertLegacyMemoryText(broken),
    `${MEMORY_FILE_HEADERS.project}- [P1] 甲 (recorded 2026-10-01 · tui · session a)\n不是条目\n`
  );
});

test("转换幂等：转换结果不再是旧格式，再转换即原样", () => {
  for (const text of [LEGACY, OLD_HEADERS.user, `# 我的标题\n\n${OLD_ENTRIES}`]) {
    const once = convertLegacyMemoryText(text);
    assert.equal(isLegacyMemoryText(once), false, text);
    assert.equal(convertLegacyMemoryText(once), once, text);
  }
});

interface Dirs {
  root: string;
  home: string;
  location: MemoryLocation;
  backup: string;
  reports: string[];
  read(): ReturnType<typeof readMemoryLayer>;
}

function withDirs(layer: MemoryLayer, body: (dirs: Dirs) => void): void {
  const base = mkdtempSync(join(tmpdir(), "pigeon-memory-migration-"));
  try {
    const root = join(base, "proj");
    const home = join(base, "home");
    mkdirSync(root);
    mkdirSync(home);
    const location = memoryLocation(layer, { governanceRoot: root, homeDir: home });
    mkdirSync(dirname(location.file), { recursive: true });
    const reports: string[] = [];
    body({
      root,
      home,
      location,
      backup: join(location.backupDir, "state", "memory.md"),
      reports,
      read: () => readMemoryLayer(location, (line) => reports.push(line)),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("读到旧格式：先备份原文（逐字节）、再改写成新格式并按新格式读出；第二次读不再备份、不再改写", () =>
  withDirs("project", (dirs) => {
    writeFileSync(dirs.location.file, LEGACY);
    const read = dirs.read();
    assert.equal(read.text, CONVERTED);
    assert.equal(readFileSync(dirs.location.file, "utf8"), CONVERTED);
    assert.equal(readFileSync(dirs.backup, "utf8"), LEGACY);
    assert.ok(dirs.location.backupDir.startsWith(join(dirs.home, ".pigeon", "state")));
    assert.ok(
      !existsSync(join(dirs.root, ".pigeon", "state", "migration-backup")),
      "仓库里不留备份"
    );
    assert.deepEqual(dirs.reports, [
      `[记忆] .pigeon/state/memory.md 是旧格式，已一次性改写成新格式；原文件备份在 ${dirs.backup}`,
    ]);
    const mtime = statSync(dirs.location.file).mtimeMs;
    const again = dirs.read();
    assert.equal(again.text, CONVERTED);
    assert.equal(again.hash, read.hash);
    assert.equal(statSync(dirs.location.file).mtimeMs, mtime, "不再改写");
    assert.deepEqual(readdirSync(dirname(dirs.backup)), ["memory.md"], "不再备份");
    assert.equal(dirs.reports.length, 1);
  }));

test("用户级同样迁移，备份进 user/ 目录", () =>
  withDirs("user", (dirs) => {
    const legacy = `${OLD_HEADERS.user}- [U1] 回复用中文 〔2026-09-30 · 命令行对话 · 会话 s〕\n`;
    writeFileSync(dirs.location.file, legacy);
    assert.equal(
      dirs.read().text,
      `${MEMORY_FILE_HEADERS.user}- [U1] 回复用中文 (recorded 2026-09-30 · cli · session s)\n`
    );
    assert.equal(
      dirs.backup,
      join(dirs.home, ".pigeon", "state", "migration-backup", "user", "state", "memory.md")
    );
    assert.equal(readFileSync(dirs.backup, "utf8"), legacy);
  }));

test("已是新格式、文件不在：不碰、不备份、不说", () =>
  withDirs("project", (dirs) => {
    assert.equal(dirs.read().exists, false);
    writeFileSync(dirs.location.file, CONVERTED);
    assert.equal(dirs.read().text, CONVERTED);
    assert.equal(existsSync(dirs.location.backupDir), false);
    assert.deepEqual(dirs.reports, []);
  }));

test("备份位置已有别的内容：不覆盖，另取 memory.1.md；已有备份与原文相同即沿用", () =>
  withDirs("project", (dirs) => {
    mkdirSync(dirname(dirs.backup), { recursive: true });
    writeFileSync(dirs.backup, "更早的备份");
    writeFileSync(dirs.location.file, LEGACY);
    dirs.read();
    assert.equal(readFileSync(dirs.backup, "utf8"), "更早的备份");
    const second = join(dirname(dirs.backup), "memory.1.md");
    assert.equal(readFileSync(second, "utf8"), LEGACY);
    // 人把原文件还原成旧格式再读：与已有备份相同，沿用，不多留副本
    writeFileSync(dirs.location.file, LEGACY);
    dirs.read();
    assert.deepEqual(readdirSync(dirname(dirs.backup)).sort(), ["memory.1.md", "memory.md"]);
    assert.ok((dirs.reports[1] ?? "").endsWith(second), dirs.reports[1]);
  }));

test("拿不到锁：这一次在内存里转换后读出，不写文件、不备份，告警一行；之后拿得到锁即完成迁移", () =>
  withDirs("project", (dirs) => {
    writeFileSync(dirs.location.file, LEGACY);
    const release = acquireExclusiveLock(dirs.location.lock, "测试持锁");
    let held: ReturnType<typeof dirs.read>;
    try {
      held = dirs.read();
    } finally {
      release();
    }
    assert.equal(held.text, CONVERTED);
    assert.equal(held.exists, true);
    assert.equal(held.bytes, Buffer.byteLength(CONVERTED));
    assert.equal(readFileSync(dirs.location.file, "utf8"), LEGACY, "文件未动");
    assert.equal(existsSync(dirs.backup), false, "没有备份");
    assert.deepEqual(dirs.reports, [
      "[记忆] .pigeon/state/memory.md 是旧格式，这次没能改写成新格式（另一处正在写这一层）：本次在内存里按新格式读出，文件未动，下次读到时再试",
    ]);
    const done = dirs.read();
    assert.equal(done.text, CONVERTED);
    assert.equal(done.hash, held.hash, "内存里转换的与落盘改写的逐字相同");
    assert.equal(readFileSync(dirs.location.file, "utf8"), CONVERTED);
    assert.equal(readFileSync(dirs.backup, "utf8"), LEGACY);
    assert.equal(dirs.reports.length, 2);
  }));

test("备份出错：这一次在内存里转换后读出，文件未动，告警带出错原因；锁已放开，下次再试", () =>
  withDirs("project", (dirs) => {
    writeFileSync(dirs.location.file, LEGACY);
    // 备份目录的位置被一个普通文件占着
    mkdirSync(dirname(dirs.location.backupDir), { recursive: true });
    writeFileSync(dirs.location.backupDir, "占位");
    assert.equal(dirs.read().text, CONVERTED);
    assert.equal(readFileSync(dirs.location.file, "utf8"), LEGACY);
    assert.equal(dirs.reports.length, 1);
    assert.match(
      dirs.reports[0] ?? "",
      /^\[记忆\] \.pigeon\/state\/memory\.md 是旧格式，这次没能改写成新格式（.+）：本次在内存里按新格式读出，文件未动，下次读到时再试$/
    );
    assert.equal(existsSync(dirs.location.lock), false, "锁已放开");
    rmSync(dirs.location.backupDir);
    assert.equal(dirs.read().text, CONVERTED);
    assert.equal(readFileSync(dirs.location.file, "utf8"), CONVERTED);
  }));

test("锁内迁移（调用方持锁）：备份出错即抛出、不改写；新格式原样读出", () =>
  withDirs("project", (dirs) => {
    writeFileSync(dirs.location.file, CONVERTED);
    const plain = migrateMemoryFileLocked(dirs.location);
    assert.equal(plain.text, CONVERTED);
    assert.equal(plain.backup, undefined);
    writeFileSync(dirs.location.file, LEGACY);
    mkdirSync(dirname(dirs.location.backupDir), { recursive: true });
    writeFileSync(dirs.location.backupDir, "占位");
    assert.throws(() => migrateMemoryFileLocked(dirs.location));
    assert.equal(readFileSync(dirs.location.file, "utf8"), LEGACY);
  }));
