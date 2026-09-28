// 记忆工具 update_memory（决策 217、228、232；施工默认 Q12、Q13）：说明、参数与返回文字逐字照 B 第 2 节；增、按编号替换与删除；
// 编号不复用；完全相同不新增；user 引用换成会话编号；写满即拒且判定在锁内；人改坏格式时拒写并指出行号。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireExclusiveLock } from "../persistence/exclusive-lock.ts";
import { MEMORY_FILE_HEADER } from "./learned.ts";
import { memoryFileOf } from "./learned-store.ts";
import {
  applyMemoryUpdate,
  createUpdateMemoryTool,
  UPDATE_MEMORY_DESCRIPTION,
  type UpdateMemoryParams,
  UpdateMemoryParamsSchema,
  updateMemoryRegistration,
} from "./update-memory-tool.ts";

function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-update-memory-"));
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const SESSION = "sess_01TEST";

async function call(root: string, params: UpdateMemoryParams, limitChars?: number) {
  return applyMemoryUpdate(
    {
      governanceRoot: root,
      sessionId: SESSION,
      ...(limitChars !== undefined ? { limitChars } : {}),
    },
    params
  );
}

const add = (fact: string, refs: string[] = ["src/a.ts"], reason = "理由") =>
  ({ action: "add", fact, refs, reason }) as const;

test("工具说明与参数说明逐字照 B 第 2 节", () => {
  assert.equal(
    UPDATE_MEMORY_DESCRIPTION,
    "新增、改写或删除本项目的学到的记忆（.pigeon/learned/MEMORY.md）。只写不读：记忆已在会话开始时放进系统提示。\n" +
      "每条是一句陈述句的事实，不写成对自己的命令；附至少一处引用：代码写成 文件 或 文件::函数，来自用户明确要求而指不到代码的写 user（工具会补上本会话编号）；再附一句理由，写明依据。\n" +
      "只记以后在本项目仍然成立、会影响做法、又不容易从代码一眼看出的事实；不记任务经过、只在本次改动里才成立的事、环境一时的故障、通用常识、从代码一读就知道的内容，也不记密钥、令牌、密码等敏感信息（需要时只记去哪里找，不记值本身）。\n" +
      "记忆有总量上限，写满时新增会被拒绝，须先合并相近条目或删除过时条目。\n" +
      "引用为用户要求的条目，只有用户在本次会话里改口时才改写或删除。"
  );
  const props = UpdateMemoryParamsSchema.properties as unknown as Record<
    "action" | "id" | "fact" | "refs" | "reason",
    { description?: string }
  >;
  assert.equal(
    props.action.description,
    "add 新增一条；replace 用新内容整条替换编号指定的一条；remove 删除编号指定的一条"
  );
  assert.equal(props.id.description, "条目编号，如 L3，见记忆全文里每条开头的方括号");
  assert.equal(props.fact.description, "一句陈述句的事实、教训或做法");
  assert.equal(
    props.refs.description,
    '代码引用写成 path/to/file 或 path/to/file::symbol；来自用户明确要求、指不到代码的写 user，工具替换为"用户要求（会话 {会话编号}）"'
  );
  assert.equal(props.reason.description, "一句理由：为什么这条值得记、依据是什么");
  const tool = createUpdateMemoryTool({ governanceRoot: ".", sessionId: SESSION });
  assert.equal(tool.name, "update_memory");
  assert.equal(tool.description, UPDATE_MEMORY_DESCRIPTION);
});

test("治理档位为写、只写 learned/、免审批", () => {
  const registration = updateMemoryRegistration("/proj");
  assert.equal(registration.tier, "write");
  assert.equal(registration.approvalFree, true);
  assert.deepEqual(registration.pathConfinement, {
    kind: "roots",
    roots: [join("/proj", ".pigeon", "learned")],
  });
});

test("新增、替换、删除：返回文字逐字照 B 第 2 节；新建文件带文件头；已用按条目区码点计", () =>
  withRoot(async (root) => {
    const first = await call(root, add("甲事实"), 500);
    const file = readFileSync(memoryFileOf(root), "utf8");
    assert.ok(file.startsWith(MEMORY_FILE_HEADER));
    const used1 = [...file.slice(MEMORY_FILE_HEADER.length)].length;
    assert.equal(first.text, `已新增 L1（当前 ${used1}/500 字符）。`);
    const second = await call(root, add("乙事实😀"), 500);
    const used2 = [...readFileSync(memoryFileOf(root), "utf8").slice(MEMORY_FILE_HEADER.length)]
      .length;
    assert.equal(second.text, `已新增 L2（当前 ${used2}/500 字符）。`);
    const replaced = await call(
      root,
      { action: "replace", id: "L1", fact: "甲改", refs: ["src/b.ts"], reason: "新理由" },
      500
    );
    const used3 = [...readFileSync(memoryFileOf(root), "utf8").slice(MEMORY_FILE_HEADER.length)]
      .length;
    assert.equal(replaced.text, `已替换 L1（当前 ${used3}/500 字符）。`);
    const removed = await call(root, { action: "remove", id: "L2" }, 500);
    const used4 = [...readFileSync(memoryFileOf(root), "utf8").slice(MEMORY_FILE_HEADER.length)]
      .length;
    assert.equal(removed.text, `已删除 L2（当前 ${used4}/500 字符）。`);
    assert.equal(
      readFileSync(memoryFileOf(root), "utf8"),
      `${MEMORY_FILE_HEADER}- [L1] 事实：甲改\n  引用：src/b.ts\n  理由：新理由\n`
    );
  }));

test("编号不复用：删掉最大编号后再新增，编号接着往上走（跨进程另存）", () =>
  withRoot(async (root) => {
    await call(root, add("一"));
    await call(root, add("二"));
    await call(root, { action: "remove", id: "L2" });
    const next = await call(root, add("三"));
    assert.equal(next.details.id, "L3");
    assert.equal(readFileSync(join(root, ".pigeon", "learned", "next-id"), "utf8"), "4\n");
    // 人删了另存的编号：按现有最大编号续
    rmSync(join(root, ".pigeon", "learned", "next-id"));
    const after = await call(root, add("四"));
    assert.equal(after.details.id, "L4");
  }));

test("完全相同（事实、引用、理由三项都相同）不新增；任一项不同即新增", () =>
  withRoot(async (root) => {
    await call(root, add("甲", ["a.ts", "b.ts"], "因为")); // L1
    const dup = await call(root, add("甲", ["a.ts", "b.ts"], "因为"));
    assert.equal(dup.text, "与 L1 完全相同，未新增。");
    assert.equal(dup.details.written, false);
    assert.equal((await call(root, add("甲", ["a.ts"], "因为"))).details.id, "L2");
    assert.equal((await call(root, add("甲", ["a.ts", "b.ts"], "所以"))).details.id, "L3");
  }));

test("refs 里的 user 换成用户要求加本会话编号", () =>
  withRoot(async (root) => {
    await call(root, add("提交信息用英文祈使句", ["user", "src/a.ts"]));
    assert.ok(
      readFileSync(memoryFileOf(root), "utf8").includes(
        "  引用：用户要求（会话 sess_01TEST）, src/a.ts\n"
      )
    );
  }));

test("缺字段或 refs 为空、编号不存在：返回文字逐字照 B 第 2 节，不写文件", () =>
  withRoot(async (root) => {
    const missing = "每条必须有 fact、reason 和至少一处 refs（文件、文件::函数，或 user）。";
    assert.equal(
      (await call(root, { action: "add", fact: "甲", refs: [], reason: "乙" })).text,
      missing
    );
    assert.equal((await call(root, { action: "add", fact: "甲", refs: ["a"] })).text, missing);
    assert.equal(
      (await call(root, { action: "add", fact: " ", refs: ["a"], reason: "r" })).text,
      missing
    );
    await call(root, add("一"));
    await call(root, add("二"));
    assert.equal(
      (await call(root, { action: "remove", id: "L9" })).text,
      "没有 L9；现有条目编号：L1、L2。"
    );
    assert.equal(
      (await call(root, { action: "replace", id: "L9", fact: "x", refs: ["a"], reason: "y" })).text,
      "没有 L9；现有条目编号：L1、L2。"
    );
  }));

test("写满即拒：判的是写入后的条目区总字符数，拒绝文字逐字照 B 第 2 节；文件头不计入", () =>
  withRoot(async (root) => {
    const entry = "- [L1] 事实：一\n  引用：a\n  理由：r\n";
    const limit = [...entry].length;
    const first = await call(root, add("一", ["a"], "r"), limit);
    assert.equal(first.text, `已新增 L1（当前 ${limit}/${limit} 字符）。`);
    const full = await call(root, add("二😀", ["a"], "r"), limit);
    const needed = [..."- [L2] 事实：二😀\n  引用：a\n  理由：r\n"].length;
    assert.equal(
      full.text,
      `记忆已满：当前 ${limit}/${limit} 字符，这条需要 ${needed} 字符。先用 replace 合并相近条目，或用 remove 删掉过时条目，再新增。现有条目编号：L1。`
    );
    // 替换成更长的同样按写满拒绝
    const longer = await call(
      root,
      { action: "replace", id: "L1", fact: "一二", refs: ["a"], reason: "r" },
      limit
    );
    assert.equal(longer.details.rejected, "full");
  }));

test("写满判定在锁内：等锁期间另一处写满了记忆，拿到锁后现读现判、拒绝新增，不覆盖对方写的", () =>
  withRoot(async (root) => {
    const entry = "- [L1] 事实：一\n  引用：a\n  理由：r\n";
    const limit = [...entry].length + 2;
    // 另一个写者（另一进程的复盘等）正持有记忆锁
    const release = acquireExclusiveLock(join(root, ".pigeon", "learned.lock"), "测试持锁");
    const pending = call(root, add("二", ["a"], "r"), limit);
    // 持锁期间对方写满
    mkdirSync(join(root, ".pigeon", "learned"), { recursive: true });
    writeFileSync(memoryFileOf(root), `${MEMORY_FILE_HEADER}${entry}`);
    release();
    const result = await pending;
    assert.equal(result.details.rejected, "full");
    assert.equal(readFileSync(memoryFileOf(root), "utf8"), `${MEMORY_FILE_HEADER}${entry}`);
  }));

test("人改坏格式：拒绝写入并指出行号，文件原样不动", () =>
  withRoot(async (root) => {
    mkdirSync(join(root, ".pigeon", "learned"), { recursive: true });
    const broken = `${MEMORY_FILE_HEADER}- [L1] 事实：一\n引用：a\n  理由：r\n`;
    writeFileSync(memoryFileOf(root), broken);
    const result = await call(root, add("二"));
    assert.equal(
      result.text,
      "MEMORY.md 第 5 行起格式不对，已拒绝写入，以免覆盖人的修改；请告知用户修复。"
    );
    assert.equal(readFileSync(memoryFileOf(root), "utf8"), broken);
  }));
