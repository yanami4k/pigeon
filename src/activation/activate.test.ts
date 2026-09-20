// 激活落点与写入（M8 S7，决策 093；094 收敛为两类）：按种类复制到治理根的正常目录；
// 激活后重算哈希必须与批准内容一致；激活路径永不触碰放权文件与命令规则（090 保留的那条不变式）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACTIVATION_DIRS,
  activateExperience,
  activationPathFor,
  activationTargets,
  driftOf,
  revokeExperience,
} from "./activate.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "pigeon-activate-"));
}

test("落点：只剩 Memory 与 Skill 两类，各有自己的目录且互不嵌套（决策 094）", () => {
  assert.deepEqual(ACTIVATION_DIRS, {
    skill: ".pigeon/skills",
    memory: ".pigeon/memory",
  });
  const dirs = Object.values(ACTIVATION_DIRS);
  assert.equal(new Set(dirs).size, dirs.length, "两个目录互不相同");
  assert.ok(!dirs[0]?.startsWith(`${dirs[1]}/`) && !dirs[1]?.startsWith(`${dirs[0]}/`), "互不嵌套");
  assert.equal(
    activationPathFor("skill", "read-before-edit"),
    ".pigeon/skills/read-before-edit/SKILL.md"
  );
  assert.equal(activationPathFor("memory", "note"), ".pigeon/memory/note.md");
});

test("激活：写到正常目录，回读哈希与批准内容一致", () => {
  const dir = root();
  const content = "# 先读后改\n";
  const result = activateExperience({
    governanceRoot: dir,
    kind: "skill",
    name: "read-before-edit",
    content,
  });
  assert.equal(result.path, ".pigeon/skills/read-before-edit/SKILL.md");
  assert.equal(readFileSync(join(dir, result.path), "utf8"), content);
  assert.equal(result.activatedHash, result.contentHash, "激活内容摘要与批准内容一致");
  const memory = activateExperience({
    governanceRoot: dir,
    kind: "memory",
    name: "note",
    content: "一条备忘\n",
  });
  assert.equal(memory.path, ".pigeon/memory/note.md");
  assert.ok(!existsSync(join(dir, ".pigeon", "skills", "note")), "两类各写各的目录");
});

test("激活：已停止产出的种类没有落点，旧候选不可激活（决策 094）", () => {
  const dir = root();
  assert.throws(
    () =>
      activateExperience({
        governanceRoot: dir,
        kind: "policy",
        name: "allow-npm",
        content: "建议给 npm test 一条固化规则",
      }),
    (error: unknown) => /已停止产出/.test(String(error))
  );
  assert.ok(!existsSync(join(dir, ".pigeon", "policy")));
});

test("激活：永不触碰放权文件与命令规则（决策 090 保留的那条不变式）", () => {
  const dir = root();
  mkdirSync(join(dir, ".pigeon"), { recursive: true });
  const grants = join(dir, ".pigeon", "grants.json");
  const commands = join(dir, ".pigeon", "commands.json");
  writeFileSync(grants, '{"version":1,"grants":[]}', "utf8");
  writeFileSync(commands, '{"version":1,"commands":{}}', "utf8");
  const before = [readFileSync(grants, "utf8"), readFileSync(commands, "utf8")];
  activateExperience({
    governanceRoot: dir,
    kind: "skill",
    name: "run-checks",
    content: "改完记得跑项目自带的检查。\n",
  });
  activateExperience({
    governanceRoot: dir,
    kind: "memory",
    name: "team",
    content: "团队约定。\n",
  });
  assert.deepEqual([readFileSync(grants, "utf8"), readFileSync(commands, "utf8")], before);
});

test("漂移：落点被人改过时标注已脱离批准版本，不阻止使用；落点被删同样如实标注", () => {
  const dir = root();
  const activated = activateExperience({
    governanceRoot: dir,
    kind: "memory",
    name: "note",
    content: "原文",
  });
  assert.deepEqual(
    driftOf({ governanceRoot: dir, path: activated.path, activatedHash: activated.activatedHash }),
    {
      state: "same",
    }
  );
  writeFileSync(join(dir, activated.path), "人改过了", "utf8");
  const drifted = driftOf({
    governanceRoot: dir,
    path: activated.path,
    activatedHash: activated.activatedHash,
  });
  assert.equal(drifted.state, "drifted");
  assert.equal(typeof drifted.currentHash, "string");
  revokeExperience({ governanceRoot: dir, path: activated.path });
  assert.equal(
    driftOf({ governanceRoot: dir, path: activated.path, activatedHash: activated.activatedHash })
      .state,
    "missing"
  );
});

test("撤销：移走文件，不追溯既往——同名旧文件移走后目录里不再有它", () => {
  const dir = root();
  const activated = activateExperience({
    governanceRoot: dir,
    kind: "skill",
    name: "read-before-edit",
    content: "正文",
  });
  assert.ok(existsSync(join(dir, activated.path)));
  revokeExperience({ governanceRoot: dir, path: activated.path });
  assert.ok(!existsSync(join(dir, activated.path)));
});

test("落点清单：给回放与漂移检查同一份路径来源", () => {
  const targets = activationTargets([
    { kind: "skill", name: "a" },
    { kind: "memory", name: "b" },
  ]);
  assert.deepEqual(targets, [".pigeon/skills/a/SKILL.md", ".pigeon/memory/b.md"]);
});
