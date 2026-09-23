// 结构化记忆的事实派生（决策 131）：真实 headless 回炉流程写下的账本 → 程序推出的两类摩擦。
// 红转绿：格式、类型、分层、他处测试失败后修好各记一条；本步题面测试（本步新增的测试文件）一开始不过不记；
// 测试步输出无法解析时不记红转绿；非测试步无法解析时记"未识别"指纹。撤回：按 154 修订的推断记录尝试。
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { SessionId } from "../state/ids.ts";
import { repairStepOutcome } from "../state/repair-step.ts";
import { deriveSessionFrictions, type FrictionFact } from "../state/structured-memory.ts";
import { runHeadless } from "./headless.ts";
import {
  edits,
  finished,
  type MemoryRepo,
  makeFile,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const BASE_FILES = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = helper;\n",
  "src/c.ts": "export const c = 'OK';\n",
  "src/c.test.ts": "// FAILS_UNLESS src/c.ts OK c keeps value\n",
  "src/d.ts": "export const d = 0;\n",
  "src/e.ts": "e\n",
  "src/f.ts": "f\n",
  "src/state/x.ts": "export const x = 1;\n",
  "templates/new.test.ts": "// FAILS_UNLESS src/d.ts DONE new feature works\n",
};

async function runStep(repo: MemoryRepo, replies: FakeReply[], repairRounds = 3) {
  const result = await runHeadless({
    task: "做一件事",
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({ replies }),
    yolo: true,
    homeDir: repo.home,
    verify: memoryVerifyConfig(),
    repairRounds,
  });
  return materializeSession(join(repo.root, ".pigeon", "sessions"), result.sessionId as SessionId, {
    content: false,
  });
}

function brief(fact: FrictionFact) {
  return {
    kind: fact.kind,
    step: fact.stepName,
    stepKind: fact.stepKind,
    tool: fact.fingerprint.tool,
    what: fact.fingerprint.code ?? fact.fingerprint.rule ?? fact.fingerprint.test ?? null,
    file: fact.fingerprint.file ?? null,
    names: fact.fingerprint.names,
  };
}

const BREAK_ALL = edits(
  ["src/a.ts", "export const a = 1;", "export const a = 1; // FMT_BAD"],
  ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"],
  ["src/c.ts", "'OK'", "'changed'"],
  ["src/state/x.ts", "= 1;", "= 1; // LAYER_BAD:src/application/y.ts"],
  ["src/e.ts", "e", "e ITEST_BAD"],
  ["src/f.ts", "f", "f BUILD_BAD"]
);

const FIX_ALL = edits(
  ["src/a.ts", " // FMT_BAD", ""],
  ["src/b.ts", " // TYPE_BAD:helper", " // helper fixed"],
  ["src/c.ts", "'changed'", "'OK changed'"],
  ["src/state/x.ts", " // LAYER_BAD:src/application/y.ts", ""],
  ["src/e.ts", " ITEST_BAD", ""],
  ["src/f.ts", " BUILD_BAD", ""],
  ["src/d.ts", "= 0;", "= 0; // DONE"]
);

test("红转绿：格式、类型、分层、他处测试失败后修好各记一条；本步新增的题面测试一开始不过不记；测试步输出无法解析不记，非测试步记未识别", async () => {
  const repo = makeMemoryRepo(BASE_FILES);
  try {
    const session = await runStep(repo, [
      BREAK_ALL,
      makeFile("templates/new.test.ts", "src/new.test.ts"),
      finished(),
      FIX_ALL,
      finished("修好了"),
    ]);
    assert.equal(repairStepOutcome(session)?.verdict, "pass");
    const facts = deriveSessionFrictions(session);
    assert.deepEqual(
      facts.map(brief).sort((left, right) => left.step.localeCompare(right.step)),
      [
        {
          kind: "regression",
          step: "分层",
          stepKind: "layer",
          tool: "dependency-cruiser",
          what: "layer-rule",
          file: "src/state/x.ts",
          names: [],
        },
        {
          kind: "regression",
          step: "构建",
          stepKind: "unknown",
          tool: "unrecognized",
          what: null,
          file: null,
          names: [],
        },
        {
          kind: "regression",
          step: "格式",
          stepKind: "format",
          tool: "biome",
          what: "format",
          file: "src/a.ts",
          names: [],
        },
        {
          kind: "regression",
          step: "测试",
          stepKind: "test",
          tool: "node-test",
          what: "c keeps value",
          file: "src/c.test.ts",
          names: ["c keeps value"],
        },
        {
          kind: "regression",
          step: "类型",
          stepKind: "type",
          tool: "tsc",
          what: "TS2304",
          file: "src/b.ts",
          names: ["helper"],
        },
      ].sort((left, right) => left.step.localeCompare(right.step))
    );
    // 分层违规的被依赖端也记下
    assert.equal(
      facts.find((fact) => fact.stepName === "分层")?.fingerprint.to,
      "src/application/y.ts"
    );
    // 变红时本步已改动的文件（编辑调用加命令新建的文件），之后回炉补改的文件
    const typeFact = facts.find((fact) => fact.stepName === "类型");
    assert.deepEqual(typeFact?.changedAtRed, [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/e.ts",
      "src/f.ts",
      "src/new.test.ts",
      "src/state/x.ts",
    ]);
    assert.deepEqual(typeFact?.repairFiles, [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/state/x.ts",
    ]);
    assert.ok((typeFact?.redAt ?? 0) < (typeFact?.at ?? 0));
  } finally {
    repo.cleanup();
  }
});

test("红转绿：他处测试所在的测试文件若在本步被修改过，即算题面、不记", async () => {
  const repo = makeMemoryRepo(BASE_FILES);
  try {
    const session = await runStep(repo, [
      edits(
        ["src/c.ts", "'OK'", "'changed'"],
        ["src/c.test.ts", "c keeps value", "c keeps value (edited)"]
      ),
      finished(),
      edits(["src/c.ts", "'changed'", "'OK'"]),
      finished("修好了"),
    ]);
    assert.equal(repairStepOutcome(session)?.verdict, "pass");
    assert.deepEqual(deriveSessionFrictions(session), []);
  } finally {
    repo.cleanup();
  }
});

test("红转绿：多轮回炉才修好只记一次，指纹取变红那次；回炉未开启的会话不记任何事实", async () => {
  const repo = makeMemoryRepo(BASE_FILES);
  try {
    const session = await runStep(repo, [
      edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
      finished(),
      edits(["src/a.ts", "= 1;", "= 2;"]),
      finished("还没修"),
      edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
      finished("修好了"),
    ]);
    const facts = deriveSessionFrictions(session);
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0]?.changedAtRed, ["src/b.ts"]);
    assert.deepEqual(facts[0]?.repairFiles, ["src/a.ts", "src/b.ts"]);
    const plain = await runHeadless({
      task: "不开回炉",
      governanceRoot: repo.root,
      workspaceRoot: repo.root,
      streamFn: createFakeStreamFn({
        replies: [edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]), finished()],
      }),
      yolo: true,
      homeDir: repo.home,
      verify: memoryVerifyConfig(),
    });
    const plainSession = materializeSession(
      join(repo.root, ".pigeon", "sessions"),
      plain.sessionId,
      { content: false }
    );
    assert.deepEqual(deriveSessionFrictions(plainSession), []);
  } finally {
    repo.cleanup();
  }
});

test("撤回：回炉到上限仍失败即推断为已撤回，记本步尝试改动过的文件与最后一次验证里失败的步名与指纹（无法解析的记未识别）", async () => {
  const repo = makeMemoryRepo(BASE_FILES);
  try {
    const session = await runStep(
      repo,
      [
        edits(
          ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"],
          ["src/e.ts", "e", "e ITEST_BAD"]
        ),
        finished(),
        edits(["src/d.ts", "= 0;", "= 5;"]),
        finished("试试"),
        finished("再试"),
      ],
      2
    );
    assert.equal(repairStepOutcome(session)?.reverted, true);
    const facts = deriveSessionFrictions(session);
    const reverted = facts.filter((fact) => fact.kind === "reverted");
    assert.deepEqual(
      reverted.map(brief).sort((left, right) => left.step.localeCompare(right.step)),
      [
        {
          kind: "reverted",
          step: "类型",
          stepKind: "type",
          tool: "tsc",
          what: "TS2304",
          file: "src/b.ts",
          names: ["helper"],
        },
        {
          kind: "reverted",
          step: "集成测试",
          stepKind: "test",
          tool: "unrecognized",
          what: null,
          file: null,
          names: [],
        },
      ].sort((left, right) => left.step.localeCompare(right.step))
    );
    for (const fact of reverted) {
      assert.deepEqual(fact.attemptedFiles, ["src/b.ts", "src/d.ts", "src/e.ts"]);
    }
    // 始终没修好，没有红转绿
    assert.equal(facts.filter((fact) => fact.kind === "regression").length, 0);
  } finally {
    repo.cleanup();
  }
});

test("撤回推断沿用 154 修订：最后一个 Run 没有验证记录（未收尾）不推为撤回，不记尝试", async () => {
  const repo = makeMemoryRepo(BASE_FILES);
  try {
    const session = await runStep(
      repo,
      [
        edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        finished("修不好"),
      ],
      1
    );
    assert.equal(repairStepOutcome(session)?.reverted, true);
    // 去掉最后一个 Run 的验证记录，模拟"回炉 Run 结束后、验证落盘前崩溃"
    const lastRun = session.runStarteds.at(-1)?.runId;
    const truncated = {
      ...session,
      attemptVerifieds: session.attemptVerifieds.filter(
        (record) => record.target.runId !== lastRun
      ),
    };
    assert.equal(repairStepOutcome(truncated)?.reverted, false);
    assert.deepEqual(
      deriveSessionFrictions(truncated).filter((fact) => fact.kind === "reverted"),
      []
    );
  } finally {
    repo.cleanup();
  }
});
