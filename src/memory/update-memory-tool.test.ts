// 记忆工具 update_memory（决策 328、329、331、332、428）：说明、参数与返回文字为记忆文字 v4；两层各自增、按编号替换与删除；
// 编号、日期、来源与会话编号由工具补在行内；新增被拒与替换被拒分开写、数字准确；替换后不比替换前长即放行；写满判定在锁内；
// 人改坏格式时拒写并指出行号；写入后经 onWritten 交出一行提示；等锁超时按固定文字回话；两个进程同时写同一层，条目不丢不重。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { MEMORY_FILE_HEADERS, type MemoryLayer, parseMemory } from "./learned.ts";
import { memoryLocation } from "./learned-store.ts";
import {
  applyMemoryUpdate,
  createUpdateMemoryTool,
  type MemoryWriteNotice,
  memoryWriteNoticeLine,
  UPDATE_MEMORY_DESCRIPTION,
  UPDATE_MEMORY_TEXTS,
  type UpdateMemoryParams,
  UpdateMemoryParamsSchema,
  updateMemoryRegistration,
} from "./update-memory-tool.ts";

const SESSION = "sess_01TEST";
const TODAY = new Date(2026, 9, 1, 12, 0);
// 工具补在行尾的来处（终端界面、本会话、2026-10-01）
const ORIGIN = ` 〔2026-10-01 · 终端界面 · 会话 ${SESSION}〕`;

interface Fixture {
  root: string;
  home: string;
  notices: MemoryWriteNotice[];
  call(
    params: Omit<UpdateMemoryParams, "layer"> & { layer?: MemoryLayer },
    limits?: { project?: number; user?: number },
    lockWaitMs?: number
  ): ReturnType<typeof applyMemoryUpdate>;
  file(layer: MemoryLayer): string;
  read(layer: MemoryLayer): string;
}

function withFixture(body: (fx: Fixture) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-update-memory-"));
  const root = join(base, "proj");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  const notices: MemoryWriteNotice[] = [];
  const file = (layer: MemoryLayer) =>
    memoryLocation(layer, { governanceRoot: root, homeDir: home }).file;
  const fx: Fixture = {
    root,
    home,
    notices,
    call: (params, limits = {}, lockWaitMs) =>
      applyMemoryUpdate(
        {
          governanceRoot: root,
          homeDir: home,
          sessionId: SESSION,
          source: "tui",
          limits: { project: limits.project ?? 4000, user: limits.user ?? 4000 },
          onWritten: (notice) => notices.push(notice),
          now: () => TODAY,
          ...(lockWaitMs !== undefined ? { lockWaitMs } : {}),
        },
        { layer: "project", ...params } as UpdateMemoryParams
      ),
    file,
    read: (layer) => readFileSync(file(layer), "utf8"),
  };
  return body(fx).finally(() => rmSync(base, { recursive: true, force: true }));
}

// 一行条目的字符数（连同结尾换行），按码点计——不经被测模块，独立算
function lineChars(id: string, content: string): number {
  return [...`- [${id}] ${content}${ORIGIN}\n`].length;
}

// 返回文字含有各关键片段（数值、编号、路径等），不逐字比对整句
function assertIncludesAll(text: string, fragments: readonly string[]): void {
  for (const fragment of fragments) {
    assert.ok(text.includes(fragment), `缺少「${fragment}」：${text}`);
  }
}

// 说明与参数说明全仓只在这里逐字检查：守"改这段文字必须升 MEMORY_TEXT_VERSION"（版本号进跑批身份，文字一改即换条件）。
// 例外（决策 383）："新增前去重"与"纠正过时条目"两句不升版本——跑批不注册 update_memory，说明的变化到不了跑批
test("工具说明与参数说明为记忆文字 v4：两层、只写内容、取向、写满时新增或改长都会被拒绝；新增前去重与纠正过时条目（383，不升版本）", () => {
  assert.equal(
    UPDATE_MEMORY_DESCRIPTION,
    "Add, rewrite, or delete learned memory entries. Memory has two layers: project applies only to this project (.pigeon/state/memory.md), and user applies to all projects (~/.pigeon/state/memory.md). This tool only writes and does not read: both layers are already in the startup status.\n" +
      "Record the user's preferences, the user's corrections to how you work, and project information that cannot be seen from the code or git history (where external material is, conventions, background). Do not record what can be seen from the code or git history (code structure, file locations, implementation details, what was changed), do not record the course of a task, and do not record secrets such as keys, tokens, or passwords (if needed, record only where to find them).\n" +
      "One sentence per entry, content only; the tool adds the ID, date, source, and session ID. Record what holds only for this project in project, and what holds for all projects in user; if you are unsure which layer, ask the user first.\n" +
      "Each layer has a character limit; when it is full, adding an entry or making one longer is rejected, so first merge similar entries or delete outdated ones.\n" +
      "Before adding, check whether either layer already has an entry about the same thing; if so, rewrite that entry with replace instead of adding another.\n" +
      "When you find that a memory entry is no longer right (it conflicts with the current state of the project or with what the user said most recently): for the kind the user explicitly asked for, point it out and ask the user; rewrite or delete the others directly, and say so in your reply.\n" +
      "Rewrite or delete an entry the user explicitly asked for only when the user changes their mind."
  );
  assert.doesNotMatch(UPDATE_MEMORY_DESCRIPTION, /\bcit(e|ation)|\[L|\breason/i);
  const props = UpdateMemoryParamsSchema.properties as unknown as Record<
    "action" | "layer" | "id" | "content",
    { description?: string }
  >;
  assert.deepEqual(Object.keys(props).sort(), ["action", "content", "id", "layer"]);
  assert.equal(
    props.action.description,
    "add adds an entry; replace replaces the whole entry with the given id with new content; remove deletes the entry with the given id"
  );
  assert.equal(
    props.layer.description,
    "project applies only to this project; user applies to all projects"
  );
  assert.equal(
    props.id.description,
    "Entry ID, such as P3 or U2; see the square brackets at the start of each entry in the memory text"
  );
  assert.equal(
    props.content.description,
    "One sentence stating what to remember (do not include the ID, date, or source; the tool adds them)"
  );
  const tool = createUpdateMemoryTool({
    governanceRoot: ".",
    sessionId: SESSION,
    source: "tui",
    limits: { project: 1, user: 1 },
  });
  assert.equal(tool.name, "update_memory");
  assert.equal(tool.description, UPDATE_MEMORY_DESCRIPTION);
});

test("治理档位为写、只写两层记忆文件、免审批", () => {
  const registration = updateMemoryRegistration({ governanceRoot: "/proj", homeDir: "/home/u" });
  assert.equal(registration.tier, "write");
  assert.equal(registration.approvalFree, true);
  assert.deepEqual(registration.pathConfinement, {
    kind: "roots",
    roots: [
      join("/proj", ".pigeon", "state", "memory.md"),
      join("/home/u", ".pigeon", "state", "memory.md"),
    ],
  });
});

test("新增、替换、删除：两层各写各的文件；工具补编号、日期、来源与会话编号；新建文件带各层文件头；写入后交出提示", () =>
  withFixture(async (fx) => {
    const added = await fx.call({ action: "add", content: "提交信息用英文祈使句" });
    const p1 = lineChars("P1", "提交信息用英文祈使句");
    assert.equal(added.text, `Added P1 to the project memory (now ${p1}/4000 characters).`);
    assert.equal(
      fx.read("project"),
      `${MEMORY_FILE_HEADERS.project}- [P1] 提交信息用英文祈使句${ORIGIN}\n`
    );
    const user = await fx.call({ action: "add", layer: "user", content: "回复用中文" });
    const u1 = lineChars("U1", "回复用中文");
    assert.equal(user.text, `Added U1 to the user memory (now ${u1}/4000 characters).`);
    assert.equal(fx.file("user"), join(fx.home, ".pigeon", "state", "memory.md"));
    assert.equal(fx.read("user"), `${MEMORY_FILE_HEADERS.user}- [U1] 回复用中文${ORIGIN}\n`);
    // 内容里的换行并成一个空格，〔〕换成普通括号（〔〕留给来处）
    await fx.call({ action: "add", content: "设计文档\n在〔内部〕wiki" });
    assert.match(fx.read("project"), /- \[P2\] 设计文档 在（内部）wiki 〔/);
    const replaced = await fx.call({ action: "replace", id: "p1", content: "提交信息用英文" });
    const p2 = lineChars("P2", "设计文档 在（内部）wiki");
    const p1b = lineChars("P1", "提交信息用英文");
    assert.equal(
      replaced.text,
      `Replaced P1 in the project memory (now ${p1b + p2}/4000 characters).`
    );
    const removed = await fx.call({ action: "remove", id: "P2" });
    assert.equal(removed.text, `Removed P2 from the project memory (now ${p1b}/4000 characters).`);
    assert.equal(
      fx.read("project"),
      `${MEMORY_FILE_HEADERS.project}- [P1] 提交信息用英文${ORIGIN}\n`
    );
    // 决策 382：删掉最大编号之后再新增，删掉的编号不再分配（已分配过的最大编号记在 .maxid 小文件里）
    const again = await fx.call({ action: "add", content: "另一条" });
    assert.equal(again.details.id, "P3");
    assert.deepEqual(fx.notices.map(memoryWriteNoticeLine), [
      "[记忆] 已记下（项目级 P1）：提交信息用英文祈使句",
      "[记忆] 已记下（用户级 U1）：回复用中文",
      "[记忆] 已记下（项目级 P2）：设计文档 在（内部）wiki",
      "[记忆] 已改写（项目级 P1）：提交信息用英文",
      "[记忆] 已删除（项目级 P2）：设计文档 在（内部）wiki",
      "[记忆] 已记下（项目级 P3）：另一条",
    ]);
  }));

test("新增被拒（328）：写明当前用量、该条字数与还差多少，提示写短或先合并、删除；附现有条目编号与各条字数", () =>
  withFixture(async (fx) => {
    const a = lineChars("P1", "甲甲甲");
    const b = lineChars("P2", "乙");
    const limit = a + b + 5;
    await fx.call({ action: "add", content: "甲甲甲" }, { project: limit });
    await fx.call({ action: "add", content: "乙" }, { project: limit });
    const used = a + b;
    const needed = lineChars("P3", "丙丙丙丙丙丙丙😀");
    const full = await fx.call({ action: "add", content: "丙丙丙丙丙丙丙😀" }, { project: limit });
    // 写满被拒的文字属记忆文字 v4，全仓只在这里逐字检查：守"改这段文字必须升 MEMORY_TEXT_VERSION"
    assert.equal(
      full.text,
      `The project memory is full, so this entry was not added: currently ${used}/${limit} characters; this entry needs ${needed} characters (including the ID, date, source, and session ID the tool adds), ${used + needed - limit} characters more than is left. Shorten this entry, or first merge similar entries with replace and delete outdated ones with remove, then add it. Existing entries (ID: characters): P1: ${a}, P2: ${b}.`
    );
    assert.equal(full.details.rejected, "full");
    assert.equal(fx.notices.length, 2, "被拒不交出提示");
    // 恰好放得下即放行
    const fits = lineChars("P3", "丁");
    const exact = await fx.call({ action: "add", content: "丁" }, { project: used + fits });
    assert.equal(exact.details.written, true);
  }));

test("替换被拒（328）：写明被替换条目现有字数、新内容字数、替换后总数与超出多少，提示把新内容至少写短超出的字数；附各条字数", () =>
  withFixture(async (fx) => {
    const a = lineChars("P1", "甲");
    const b = lineChars("P2", "乙乙");
    const limit = a + b + 3;
    await fx.call({ action: "add", content: "甲" }, { project: limit });
    await fx.call({ action: "add", content: "乙乙" }, { project: limit });
    const newChars = lineChars("P1", "甲甲甲甲甲甲");
    const after = a + b - a + newChars;
    const rejected = await fx.call(
      { action: "replace", id: "P1", content: "甲甲甲甲甲甲" },
      { project: limit }
    );
    // 写满被拒的文字属记忆文字 v4，全仓只在这里逐字检查：守"改这段文字必须升 MEMORY_TEXT_VERSION"
    assert.equal(
      rejected.text,
      `Replacing would exceed the project memory limit, so P1 was not replaced: P1 currently has ${a} characters, the new content has ${newChars} characters (including the ID, date, source, and session ID the tool adds), and after replacing the total would be ${after}/${limit} characters, ${after - limit} characters over. Shorten the new content by at least ${after - limit} characters, or first delete other outdated entries with remove, then replace it. Existing entries (ID: characters): P1: ${a}, P2: ${b}.`
    );
    // 按提示把新内容写短超出的字数即放得下
    const shortened = "甲".repeat(6 - (after - limit));
    const ok = await fx.call(
      { action: "replace", id: "P1", content: shortened },
      { project: limit }
    );
    assert.equal(ok.details.written, true);
    assert.equal(ok.details.usedChars, limit);
  }));

test("替换后变短或等长一律放行：即使该层已超上限（人手改出来的），也不拦减少用量的改写；新增照样拦", () =>
  withFixture(async (fx) => {
    const long = "甲".repeat(30);
    await fx.call({ action: "add", content: long });
    await fx.call({ action: "add", content: "乙" });
    const used = lineChars("P1", long) + lineChars("P2", "乙");
    const limit = used - 10;
    const shorter = await fx.call(
      { action: "replace", id: "P1", content: "甲".repeat(25) },
      { project: limit }
    );
    assert.equal(shorter.details.written, true);
    assert.equal(shorter.details.usedChars, used - 5);
    const same = await fx.call({ action: "replace", id: "P2", content: "丙" }, { project: limit });
    assert.equal(same.details.written, true);
    const longer = await fx.call(
      { action: "replace", id: "P2", content: "丙丙" },
      { project: limit }
    );
    assert.equal(longer.details.rejected, "full");
    const add = await fx.call({ action: "add", content: "丁" }, { project: limit });
    assert.equal(add.details.rejected, "full");
  }));

test("两层分别计：项目级写满不影响用户级新增，拒绝文字里的用量、上限与条目只算本层", () =>
  withFixture(async (fx) => {
    const p = lineChars("P1", "甲");
    const limits = { project: p, user: 4000 };
    await fx.call({ action: "add", content: "甲" }, limits);
    const projectFull = await fx.call({ action: "add", content: "乙" }, limits);
    assert.match(
      projectFull.text,
      new RegExp(`^The project memory is full.*currently ${p}/${p} characters.*: P1: ${p}\\.$`)
    );
    const user = await fx.call({ action: "add", layer: "user", content: "乙" }, limits);
    const u = lineChars("U1", "乙");
    assert.equal(user.text, `Added U1 to the user memory (now ${u}/4000 characters).`);
    const userFull = await fx.call(
      { action: "add", layer: "user", content: "丙" },
      { project: 4000, user: u }
    );
    assert.match(
      userFull.text,
      new RegExp(`^The user memory is full.*currently ${u}/${u} characters.*: U1: ${u}\\.$`)
    );
  }));

test("内容相同不新增；缺内容、缺层级、编号不存在或层前缀不符：按固定文字回话、不写文件", () =>
  withFixture(async (fx) => {
    await fx.call({ action: "add", content: "一" });
    await fx.call({ action: "add", content: "二" });
    assert.equal(
      (await fx.call({ action: "add", content: " 一 " })).text,
      "Same content as P1 in the project memory; not added."
    );
    assert.equal(
      (await fx.call({ action: "add", content: "  " })).text,
      "add and replace need content: one sentence stating what to remember."
    );
    assert.equal(
      (await fx.call({ action: "replace", id: "P1" })).text,
      "add and replace need content: one sentence stating what to remember."
    );
    const noLayer = await applyMemoryUpdate(
      {
        governanceRoot: fx.root,
        sessionId: SESSION,
        source: "line",
        limits: { project: 9, user: 9 },
      },
      { action: "add", content: "x" } as unknown as UpdateMemoryParams
    );
    assert.equal(
      noLayer.text,
      "layer is required: project (this project only) or user (all projects); if you are unsure, ask the user first."
    );
    assert.equal(
      (await fx.call({ action: "remove", id: "P9" })).text,
      "The project memory has no P9; existing entry IDs: P1, P2."
    );
    assert.equal(
      (await fx.call({ action: "remove", id: "U1" })).text,
      "The project memory has no U1; existing entry IDs: P1, P2."
    );
    assert.equal(
      (await fx.call({ action: "remove", layer: "user", id: "U1" })).text,
      "The user memory has no U1; existing entry IDs: (no entries)."
    );
    assert.equal(fx.notices.length, 2);
  }));

test("写满判定在锁内：等锁期间另一处写满了这一层，拿到锁后现读现判、拒绝新增，不覆盖对方写的", () =>
  withFixture(async (fx) => {
    const entry = `- [P1] 一${ORIGIN}\n`;
    const limit = [...entry].length + 2;
    const location = memoryLocation("project", { governanceRoot: fx.root, homeDir: fx.home });
    const release = acquireExclusiveLock(location.lock, "测试持锁");
    const pending = fx.call({ action: "add", content: "二" }, { project: limit });
    mkdirSync(dirname(location.file), { recursive: true });
    writeFileSync(location.file, `${MEMORY_FILE_HEADERS.project}${entry}`);
    release();
    const result = await pending;
    assert.equal(result.details.rejected, "full");
    assert.equal(fx.read("project"), `${MEMORY_FILE_HEADERS.project}${entry}`);
  }));

test("等锁超时：同一层一直被另一处占着，按固定文字回话、不写文件、不交出写入提示；锁放开后照常写入", () =>
  withFixture(async (fx) => {
    const location = memoryLocation("project", { governanceRoot: fx.root, homeDir: fx.home });
    mkdirSync(dirname(location.file), { recursive: true });
    const release = acquireExclusiveLock(location.lock, "测试持锁");
    try {
      const result = await fx.call({ action: "add", content: "一" }, {}, 50);
      assert.equal(result.text, UPDATE_MEMORY_TEXTS.busy("project"));
      assert.deepEqual(
        { written: result.details.written, rejected: result.details.rejected },
        { written: false, rejected: "busy" }
      );
    } finally {
      release();
    }
    assert.equal(existsSync(location.file), false);
    assert.equal(fx.notices.length, 0);
    assert.equal((await fx.call({ action: "add", content: "一" })).details.written, true);
  }));

test("人改坏格式：拒绝写入并指出文件与行号，文件原样不动", () =>
  withFixture(async (fx) => {
    const file = fx.file("project");
    mkdirSync(dirname(file), { recursive: true });
    const broken = `${MEMORY_FILE_HEADERS.project}- [P1] 一\n不是条目\n`;
    writeFileSync(file, broken);
    const result = await fx.call({ action: "add", content: "二" });
    assertIncludesAll(result.text, [
      ".pigeon/state/memory.md is malformed from line 5 on",
      "/memory edit project",
    ]);
    assert.equal(fx.read("project"), broken);
  }));

test("Unicode 行分隔符也折叠：\\u2028 与 \\u2029 当换行并成一个空格", () =>
  withFixture(async (fx) => {
    await fx.call({ action: "add", content: "第一段\u2028第二段\u2029第三段" });
    assert.match(fx.read("project"), /- \[P1\] 第一段 第二段 第三段 〔/);
  }));

// 子进程：等开跑文件出现后，向同一项目级记忆连续新增若干条（argv：被测模块、治理根、主目录、标签、条数、开跑文件）
const CONCURRENT_WRITER = [
  'import { existsSync } from "node:fs";',
  "const [moduleUrl, root, home, tag, count, goPath] = process.argv.slice(1);",
  "const { applyMemoryUpdate } = await import(moduleUrl);",
  "while (!existsSync(goPath)) await new Promise((resolve) => setTimeout(resolve, 5));",
  "for (let i = 0; i < Number(count); i += 1) {",
  "  const result = await applyMemoryUpdate(",
  '    { governanceRoot: root, homeDir: home, sessionId: "sess_" + tag, source: "tui", limits: { project: 100000, user: 100000 } },',
  '    { action: "add", layer: "project", content: tag + "-" + i }',
  "  );",
  "  if (!result.details.written) { console.error(result.text); process.exit(1); }",
  "}",
].join("\n");

test("两个进程同时写同一份记忆：各自的条目一条不丢、不重复，编号各不相同，文件格式完好", () =>
  withFixture(async (fx) => {
    const count = 20;
    const goPath = join(fx.root, "go");
    const moduleUrl = new URL("./update-memory-tool.ts", import.meta.url).href;
    const writers = ["A", "B"].map((tag) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          CONCURRENT_WRITER,
          moduleUrl,
          fx.root,
          fx.home,
          tag,
          String(count),
          goPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return new Promise<{ code: number | null; stderr: string }>((resolve) =>
        child.on("exit", (code) => resolve({ code, stderr }))
      );
    });
    writeFileSync(goPath, "");
    for (const exit of await Promise.all(writers)) {
      assert.equal(exit.code, 0, exit.stderr);
    }
    const parsed = parseMemory(fx.read("project"), "project");
    assert.ok(parsed.ok);
    const expected = ["A", "B"].flatMap((tag) =>
      Array.from({ length: count }, (_, i) => `${tag}-${i}`)
    );
    assert.deepEqual(parsed.doc.entries.map((entry) => entry.content).sort(), expected.sort());
    assert.equal(new Set(parsed.doc.entries.map((entry) => entry.id)).size, 2 * count);
  }));
