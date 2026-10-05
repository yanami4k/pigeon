// 记忆工具 update_memory（决策 328、329、331、332）：说明、参数与返回文字为记忆文字 v3；两层各自增、按编号替换与删除；
// 编号、日期、来源与会话编号由工具补在行内；新增被拒与替换被拒分开写、数字准确；替换后不比替换前长即放行；写满判定在锁内；
// 人改坏格式时拒写并指出行号；写入后经 onWritten 交出一行提示。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { MEMORY_FILE_HEADERS, type MemoryLayer } from "./learned.ts";
import { memoryLocation } from "./learned-store.ts";
import {
  applyMemoryUpdate,
  createUpdateMemoryTool,
  type MemoryWriteNotice,
  memoryWriteNoticeLine,
  UPDATE_MEMORY_DESCRIPTION,
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
    limits?: { project?: number; user?: number }
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
    call: (params, limits = {}) =>
      applyMemoryUpdate(
        {
          governanceRoot: root,
          homeDir: home,
          sessionId: SESSION,
          source: "tui",
          limits: { project: limits.project ?? 4000, user: limits.user ?? 4000 },
          onWritten: (notice) => notices.push(notice),
          now: () => TODAY,
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

// 说明与参数说明全仓只在这里逐字检查：守"改这段文字必须升 MEMORY_TEXT_VERSION"（版本号进跑批身份，文字一改即换条件）
test("工具说明与参数说明为记忆文字 v3：两层、只写内容、取向、写满时新增或改长都会被拒绝", () => {
  assert.equal(
    UPDATE_MEMORY_DESCRIPTION,
    "新增、改写或删除学到的记忆。记忆分两层：project 只对本项目（.pigeon/state/memory.md），user 对所有项目（~/.pigeon/state/memory.md）。只写不读：两层记忆已在开工状态里。\n" +
      "记用户的偏好、用户对你做法的纠正，以及从代码和 git 历史看不出的项目信息（外部资料在哪里、约定、背景）；不记能从代码或 git 历史看出的内容（代码结构、文件位置、实现细节、改过什么），不记任务经过，也不记密钥、令牌、密码等敏感信息（需要时只记去哪里找）。\n" +
      "每条一句话，只写内容；编号、日期、来源与会话编号由工具补上。只对本项目成立的记在 project，对所有项目都成立的记在 user；拿不准记在哪一层时，先问用户。\n" +
      "每层有字符上限，写满时新增或改长都会被拒绝，须先合并相近条目或删除过时条目。\n" +
      "用户亲口要求的条目，只有用户改口时才改写或删除。"
  );
  assert.doesNotMatch(UPDATE_MEMORY_DESCRIPTION, /引用|\[L|理由/);
  const props = UpdateMemoryParamsSchema.properties as unknown as Record<
    "action" | "layer" | "id" | "content",
    { description?: string }
  >;
  assert.deepEqual(Object.keys(props).sort(), ["action", "content", "id", "layer"]);
  assert.equal(
    props.action.description,
    "add 新增一条；replace 用新内容整条替换编号指定的一条；remove 删除编号指定的一条"
  );
  assert.equal(props.layer.description, "project 只对本项目；user 对所有项目");
  assert.equal(props.id.description, "条目编号，如 P3 或 U2，见记忆全文里每条开头的方括号");
  assert.equal(
    props.content.description,
    "一句话写明要记的内容（不写编号、日期与来源，工具会补上）"
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
    assert.equal(added.text, `已在项目级新增 P1（当前 ${p1}/4000 字符）。`);
    assert.equal(
      fx.read("project"),
      `${MEMORY_FILE_HEADERS.project}- [P1] 提交信息用英文祈使句${ORIGIN}\n`
    );
    const user = await fx.call({ action: "add", layer: "user", content: "回复用中文" });
    const u1 = lineChars("U1", "回复用中文");
    assert.equal(user.text, `已在用户级新增 U1（当前 ${u1}/4000 字符）。`);
    assert.equal(fx.file("user"), join(fx.home, ".pigeon", "state", "memory.md"));
    assert.equal(fx.read("user"), `${MEMORY_FILE_HEADERS.user}- [U1] 回复用中文${ORIGIN}\n`);
    // 内容里的换行并成一个空格，〔〕换成普通括号（〔〕留给来处）
    await fx.call({ action: "add", content: "设计文档\n在〔内部〕wiki" });
    assert.match(fx.read("project"), /- \[P2\] 设计文档 在（内部）wiki 〔/);
    const replaced = await fx.call({ action: "replace", id: "p1", content: "提交信息用英文" });
    const p2 = lineChars("P2", "设计文档 在（内部）wiki");
    const p1b = lineChars("P1", "提交信息用英文");
    assert.equal(replaced.text, `已替换项目级 P1（当前 ${p1b + p2}/4000 字符）。`);
    const removed = await fx.call({ action: "remove", id: "P2" });
    assert.equal(removed.text, `已删除项目级 P2（当前 ${p1b}/4000 字符）。`);
    assert.equal(
      fx.read("project"),
      `${MEMORY_FILE_HEADERS.project}- [P1] 提交信息用英文${ORIGIN}\n`
    );
    // 删掉最大编号之后再新增：编号取现有最大加一
    const again = await fx.call({ action: "add", content: "另一条" });
    assert.equal(again.details.id, "P2");
    assert.deepEqual(fx.notices.map(memoryWriteNoticeLine), [
      "[记忆] 已记下（项目级 P1）：提交信息用英文祈使句",
      "[记忆] 已记下（用户级 U1）：回复用中文",
      "[记忆] 已记下（项目级 P2）：设计文档 在（内部）wiki",
      "[记忆] 已改写（项目级 P1）：提交信息用英文",
      "[记忆] 已删除（项目级 P2）：设计文档 在（内部）wiki",
      "[记忆] 已记下（项目级 P2）：另一条",
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
    // 写满被拒的文字属记忆文字 v3，全仓只在这里逐字检查：守"改这段文字必须升 MEMORY_TEXT_VERSION"
    assert.equal(
      full.text,
      `项目级记忆已满，这条没有新增：当前 ${used}/${limit} 字符，这条需要 ${needed} 字符（含工具补上的编号、日期、来源与会话编号），还差 ${used + needed - limit} 字符。把这条写短，或先用 replace 合并相近条目、用 remove 删除过时条目，再新增。现有条目（编号：字符数）：P1：${a}、P2：${b}。`
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
    // 写满被拒的文字属记忆文字 v3，全仓只在这里逐字检查：守"改这段文字必须升 MEMORY_TEXT_VERSION"
    assert.equal(
      rejected.text,
      `替换后超出项目级上限，P1 没有替换：P1 现有 ${a} 字符，新内容 ${newChars} 字符（含工具补上的编号、日期、来源与会话编号），替换后共 ${after}/${limit} 字符，超出 ${after - limit} 字符。把新内容至少写短 ${after - limit} 字符，或先用 remove 删除别的过时条目，再替换。现有条目（编号：字符数）：P1：${a}、P2：${b}。`
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
      new RegExp(`^项目级记忆已满.*当前 ${p}/${p} 字符.*：P1：${p}。$`)
    );
    const user = await fx.call({ action: "add", layer: "user", content: "乙" }, limits);
    const u = lineChars("U1", "乙");
    assert.equal(user.text, `已在用户级新增 U1（当前 ${u}/4000 字符）。`);
    const userFull = await fx.call(
      { action: "add", layer: "user", content: "丙" },
      { project: 4000, user: u }
    );
    assert.match(userFull.text, new RegExp(`^用户级记忆已满.*当前 ${u}/${u} 字符.*：U1：${u}。$`));
  }));

test("内容相同不新增；缺内容、缺层级、编号不存在或层前缀不符：按固定文字回话、不写文件", () =>
  withFixture(async (fx) => {
    await fx.call({ action: "add", content: "一" });
    await fx.call({ action: "add", content: "二" });
    assert.equal(
      (await fx.call({ action: "add", content: " 一 " })).text,
      "与项目级 P1 内容相同，未新增。"
    );
    assert.equal(
      (await fx.call({ action: "add", content: "  " })).text,
      "add 与 replace 需要 content：一句话写明要记的内容。"
    );
    assert.equal(
      (await fx.call({ action: "replace", id: "P1" })).text,
      "add 与 replace 需要 content：一句话写明要记的内容。"
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
      "需要 layer：project（只对本项目）或 user（对所有项目）；拿不准时先问用户。"
    );
    assert.equal(
      (await fx.call({ action: "remove", id: "P9" })).text,
      "项目级没有 P9；现有条目编号：P1、P2。"
    );
    assert.equal(
      (await fx.call({ action: "remove", id: "U1" })).text,
      "项目级没有 U1；现有条目编号：P1、P2。"
    );
    assert.equal(
      (await fx.call({ action: "remove", layer: "user", id: "U1" })).text,
      "用户级没有 U1；现有条目编号：（没有条目）。"
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

test("人改坏格式：拒绝写入并指出文件与行号，文件原样不动", () =>
  withFixture(async (fx) => {
    const file = fx.file("project");
    mkdirSync(dirname(file), { recursive: true });
    const broken = `${MEMORY_FILE_HEADERS.project}- [P1] 一\n不是条目\n`;
    writeFileSync(file, broken);
    const result = await fx.call({ action: "add", content: "二" });
    assertIncludesAll(result.text, [
      ".pigeon/state/memory.md 第 5 行起格式不对",
      "/memory edit project",
    ]);
    assert.equal(fx.read("project"), broken);
  }));

test("Unicode 行分隔符也折叠：\\u2028 与 \\u2029 当换行并成一个空格", () =>
  withFixture(async (fx) => {
    await fx.call({ action: "add", content: "第一段\u2028第二段\u2029第三段" });
    assert.match(fx.read("project"), /- \[P1\] 第一段 第二段 第三段 〔/);
  }));
