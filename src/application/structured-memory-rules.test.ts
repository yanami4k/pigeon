// 结构化记忆挑选与推送的若干规则（决策 135 / 136 / 157）：同一指纹跨种类只给一条（优先红转绿）；未识别指纹不参加回炉的
// "指纹对上"档；固定挑选的编号去重、不存在即响亮失败；题面路径归一化、只留受跟踪文件；合并了几处报错的名字任一仍在即算
// 通过；事实字段损坏导致成文出错时这次不推送、运行照常完成。
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildMemoryEntries, loadStructuredMemory } from "../memory/structured-store.ts";
import { taskReferencedFiles, workspaceProbe } from "../memory/structured-workspace.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { SessionId } from "../state/ids.ts";
import type { FrictionFact } from "../state/structured-memory.ts";
import { fingerprintKey } from "../state/verify-fingerprint.ts";
import { type HeadlessRunOptions, runHeadless } from "./headless.ts";
import type { StructuredMemoryOptions } from "./structured-memory.ts";
import {
  edits,
  finished,
  type MemoryRepo,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const FILES = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = helper;\n",
  "src/z.ts": "export const z = 0;\n",
};

async function step(
  repo: MemoryRepo,
  task: string,
  replies: FakeReply[],
  memory: StructuredMemoryOptions,
  extra: Partial<HeadlessRunOptions> = {}
) {
  const result = await runHeadless({
    task,
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({ replies }),
    yolo: true,
    homeDir: repo.home,
    structuredMemory: memory,
    ...extra,
  });
  const session = materializeSession(join(repo.root, ".pigeon", "sessions"), result.sessionId, {
    content: false,
  });
  return { result, runStarteds: session.runStarteds };
}

const repairing = (names: string[], rounds = 2): Partial<HeadlessRunOptions> => ({
  verify: memoryVerifyConfig(names),
  repairRounds: rounds,
});

test("同一指纹既有红转绿又有撤回：挑选时只给一条，优先红转绿；两种事实在合并键里分开", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await step(
      repo,
      "以往",
      [
        edits(["src/a.ts", "= 1;", "= 2;"], ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
        finished("修好了"),
      ],
      { enabled: false },
      repairing(["类型"])
    );
    repo.commit("落地");
    // 更近的一步：同一指纹一直没修好，撤回
    await step(
      repo,
      "以往",
      [
        edits(["src/b.ts", " // helper ok", " // helper ok TYPE_BAD:helper"]),
        finished(),
        finished("修不好"),
      ],
      { enabled: false },
      repairing(["类型"], 1)
    );
    const onB = buildMemoryEntries(loadStructuredMemory(repo.root).facts).filter(
      (entry) => entry.anchor === "src/b.ts"
    );
    assert.deepEqual(onB.map((entry) => entry.kind).sort(), ["regression", "reverted"]);
    assert.equal(onB[0]?.fingerprintKey, onB[1]?.fingerprintKey);
    const regression = onB.find((entry) => entry.kind === "regression");
    const next = await step(repo, "改 src/b.ts", [finished("看过了")], {});
    assert.deepEqual(next.runStarteds[0]?.payload.structuredMemory?.opening, [regression?.id]);
  } finally {
    repo.cleanup();
  }
});

test('回炉挑选：未识别的指纹不参加"指纹对上"那一档，只参加"涉及文件"那一档', async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    // 以往：代码检查步输出无法解析（按关键字认作代码检查，记未识别指纹），修好
    await step(
      repo,
      "以往",
      [
        edits(["src/a.ts", "= 1;", "= 1; // LINT_BAD"]),
        finished(),
        edits(["src/a.ts", " // LINT_BAD", ""]),
        finished("修好了"),
      ],
      { enabled: false },
      repairing(["lint"])
    );
    repo.commit("落地");
    const [entry] = buildMemoryEntries(loadStructuredMemory(repo.root).facts);
    assert.equal(entry?.fingerprint.tool, "unrecognized");
    // 这一步在别的文件上同样报出无法解析的代码检查错误：指纹键相同，但不算"对上"；报错也不带文件，没有"涉及文件"
    const next = await step(
      repo,
      "调整",
      [
        edits(["src/z.ts", "= 0;", "= 0; // LINT_BAD"]),
        finished(),
        edits(["src/z.ts", " // LINT_BAD", ""]),
        finished("修好了"),
      ],
      {},
      repairing(["lint"])
    );
    assert.deepEqual(next.runStarteds[1]?.payload.structuredMemory?.repair, []);
  } finally {
    repo.cleanup();
  }
});

async function typeHistory(repo: MemoryRepo, names: string): Promise<void> {
  await step(
    repo,
    "以往",
    [
      edits(["src/a.ts", "= 1;", "= 2;"], ["src/b.ts", "helper;", `helper; // ${names}`]),
      finished(),
      edits(["src/b.ts", ` // ${names}`, " // one two ok"]),
      finished("修好了"),
    ],
    { enabled: false },
    repairing(["类型"])
  );
  repo.commit("落地");
}

test("固定挑选：同一编号去重；指定的编号不存在即响亮失败", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await typeHistory(repo, "TYPE_BAD:helper");
    const [entry] = buildMemoryEntries(loadStructuredMemory(repo.root).facts);
    assert.ok(entry !== undefined);
    const twice = await step(repo, "调整", [finished()], {
      fixed: { opening: [entry.id, entry.id] },
    });
    assert.deepEqual(twice.runStarteds[0]?.payload.structuredMemory?.opening, [entry.id]);
    await assert.rejects(
      step(repo, "调整", [finished()], { fixed: { opening: [], repair: ["mem_000000000000"] } }),
      /固定挑选指定的记忆条目不存在：mem_000000000000/
    );
  } finally {
    repo.cleanup();
  }
});

test("核验：同一指纹合并了几处报错的名字，任一仍在报错所在文件里即算通过，全都不在才拦下", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await typeHistory(repo, "TYPE_BAD:one TYPE_BAD:two");
    const onB = buildMemoryEntries(loadStructuredMemory(repo.root).facts).find(
      (entry) => entry.anchor === "src/b.ts"
    );
    assert.deepEqual(onB?.fingerprint.names, ["one", "two"]);
    repo.write("src/b.ts", "export const b = two;\n");
    repo.commit("只剩 two");
    const some = await step(repo, "调整", [finished()], { fixed: { opening: [onB?.id ?? ""] } });
    assert.deepEqual(some.runStarteds[0]?.payload.structuredMemory?.opening, [onB?.id]);
    repo.write("src/b.ts", "export const b = 0;\n");
    repo.commit("都没了");
    const none = await step(repo, "调整", [finished()], { fixed: { opening: [onB?.id ?? ""] } });
    assert.deepEqual(none.runStarteds[0]?.payload.structuredMemory?.openingBlocked, [onB?.id]);
  } finally {
    repo.cleanup();
  }
});

test("题面指到的文件：路径先归一化，含 .. 或跑出工作区的丢弃，只保留受跟踪的文件", () => {
  const repo = makeMemoryRepo(FILES);
  try {
    repo.write("src/untracked.ts", "export {};\n");
    const files = taskReferencedFiles(
      [
        "../outside.ts",
        "src/../src/b.ts",
        "/abs/x.ts",
        `${repo.root}/../elsewhere.ts`,
        "src/untracked.ts",
        "./src/a.ts",
        `${repo.root}/src/z.ts`,
      ].join(" 与 "),
      workspaceProbe(repo.root)
    );
    assert.deepEqual(files, ["src/a.ts", "src/z.ts"]);
  } finally {
    repo.cleanup();
  }
});

test("事实字段损坏（时间越界）导致成文出错：开局与回炉都这次不给，只告警一次，运行照常完成", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const fingerprint = {
      tool: "tsc" as const,
      code: "TS2304",
      file: "src/b.ts",
      names: ["helper"],
    };
    const broken: FrictionFact = {
      kind: "regression",
      sessionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" as SessionId,
      stepName: "类型",
      stepKind: "type",
      fingerprint,
      fingerprintKey: fingerprintKey("类型", fingerprint),
      at: 1e20,
      workspace: repo.root,
      changedAtRed: ["src/a.ts"],
      repairFiles: ["src/b.ts"],
    };
    const lines: string[] = [];
    const next = await step(
      repo,
      "改 src/b.ts",
      [
        edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " // TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      { phases: { load: () => [broken] }, warn: (line) => lines.push(line) },
      repairing(["类型"])
    );
    assert.equal(next.result.repair?.verdict, "pass");
    assert.equal(lines.length, 1, lines.join(" | "));
    assert.ok(lines[0]?.includes("不推送结构化记忆"), lines[0]);
    assert.deepEqual(next.result.structuredMemory?.opening, []);
    assert.deepEqual(next.result.structuredMemory?.repair, [[]]);
  } finally {
    repo.cleanup();
  }
});
