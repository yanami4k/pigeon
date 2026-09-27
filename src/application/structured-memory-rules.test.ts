// 结构化记忆挑选与推送的若干规则（决策 135 / 136 / 157）：同一指纹跨种类只给一条（优先红转绿）；未识别指纹不参加回炉的
// "指纹对上"档；固定挑选的编号去重、不存在即响亮失败；题面路径归一化、只留受跟踪文件；合并了几处报错的名字任一仍在即算
// 通过；事实字段损坏导致成文出错时这次不推送、运行照常完成。
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildMemoryEntries, loadStructuredMemory } from "../memory/structured-store.ts";
import {
  runStructuredMemoryGit,
  StructuredMemoryGitTimeoutError,
  taskReferencedFiles,
  workspaceProbe,
} from "../memory/structured-workspace.ts";
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
    // 这一轮没有任何候选，自然也没有被拦下的
    assert.equal(next.runStarteds[1]?.payload.structuredMemory?.repairBlocked, undefined);
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

// 合成一条挂在给定文件上的事实（报错文件同为该文件、不带名字，核验只看文件在不在）
function syntheticFact(repo: MemoryRepo, file: string, stepName: string, at: number): FrictionFact {
  const fingerprint = { tool: "tsc" as const, code: "TS2304", file, names: [] };
  return {
    kind: "regression",
    sessionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" as SessionId,
    stepName,
    stepKind: "type",
    fingerprint,
    fingerprintKey: fingerprintKey(stepName, fingerprint),
    at,
    workspace: repo.root,
    changedAtRed: [file],
    repairFiles: [file],
  };
}

test('固定挑选：不受"最多 2 条"限制，数量由调用方定', async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const facts = ["甲", "乙", "丙"].map((name, index) =>
      syntheticFact(repo, "src/a.ts", name, 1_000 + index)
    );
    const ids = buildMemoryEntries(facts).map((entry) => entry.id);
    assert.equal(ids.length, 3);
    const given = await step(repo, "调整", [finished()], {
      fixed: { opening: ids },
      phases: { load: () => facts },
    });
    assert.deepEqual(given.runStarteds[0]?.payload.structuredMemory?.opening, ids);
  } finally {
    repo.cleanup();
  }
});

test("固定挑选：指定条目成文后超出字符预算即响亮报错，不静默截断", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const facts = ["一", "二", "三", "四"].map((name, index) =>
      syntheticFact(repo, "src/a.ts", name.repeat(300), 1_000 + index)
    );
    const ids = buildMemoryEntries(facts).map((entry) => entry.id);
    await assert.rejects(
      step(repo, "调整", [finished()], {
        fixed: { opening: ids },
        phases: { load: () => facts },
      }),
      /超出字符预算/
    );
  } finally {
    repo.cleanup();
  }
});

test('被拦下只记"按挑选规则本会给出、但核验没过"的：名额之外核验不过的不记', async () => {
  const repo = makeMemoryRepo({
    ...FILES,
    "src/p1.ts": "p1\n",
    "src/p2.ts": "p2\n",
    "src/p3.ts": "p3\n",
    "src/p4.ts": "p4\n",
  });
  try {
    // 四次红转绿，报错分别在 p1..p4 里、名字 n1..n4，都挂在 a.ts 上；p4 最新
    for (const index of [1, 2, 3, 4]) {
      await step(
        repo,
        "以往",
        [
          edits(
            ["src/a.ts", "export", `export /* ${index} */`],
            [`src/p${index}.ts`, `p${index}`, `p${index} TYPE_BAD:n${index}`]
          ),
          finished(),
          edits([`src/p${index}.ts`, ` TYPE_BAD:n${index}`, ` n${index} ok`]),
          finished("修好了"),
        ],
        { enabled: false },
        repairing(["类型"])
      );
      repo.commit(`落地 ${index}`);
    }
    const onA = buildMemoryEntries(loadStructuredMemory(repo.root).facts).filter(
      (entry) => entry.anchor === "src/a.ts"
    );
    const idOf = (index: number) =>
      onA.find((entry) => entry.fingerprint.file === `src/p${index}.ts`)?.id;
    // 最新的 p4 与最旧的 p1 都核验不过（名字没了）
    repo.write("src/p4.ts", "p4\n");
    repo.write("src/p1.ts", "p1\n");
    repo.commit("名字没了");
    const next = await step(repo, "改 src/a.ts", [finished()], {});
    const memory = next.runStarteds[0]?.payload.structuredMemory;
    // 按核验前的次序前两组是 p4、p3：p4 被拦下；p1 在名额之外，不记
    assert.deepEqual(memory?.openingBlocked, [idOf(4)]);
    assert.equal(memory?.opening.length, 2);
    // 给出的是名额内核验通过的 p3 与名额外补上的 p2（p1 核验不过、也不在名额内）
    assert.ok(idOf(2) !== undefined && idOf(3) !== undefined);
    assert.deepEqual([...(memory?.opening ?? [])].sort(), [idOf(2), idOf(3)].sort());
  } finally {
    repo.cleanup();
  }
});

test("MCP 摘要抛错时，回炉 Run 的结构化记忆留痕仍在", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const next = await step(
      repo,
      "调整",
      [
        edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " // TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      {},
      {
        ...repairing(["类型"]),
        startMcp: async () => ({
          tools: [],
          prompts: [],
          problems: [],
          connections: [{} as never],
          summary: () => {
            throw new Error("MCP 摘要取不到");
          },
          close: async () => {},
        }),
      }
    );
    assert.equal(next.runStarteds[1]?.payload.mcpTools, undefined);
    assert.deepEqual(next.runStarteds[1]?.payload.structuredMemory?.repair, []);
  } finally {
    repo.cleanup();
  }
});

test('git 子进程超时：抛可识别的超时错误；推送时按"这次不给"处理并去重告警，运行照常完成', async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    assert.throws(
      () => runStructuredMemoryGit(repo.root, ["log", "--oneline"], 1),
      StructuredMemoryGitTimeoutError
    );
    const lines: string[] = [];
    const timedOut = (): never => {
      throw new StructuredMemoryGitTimeoutError("git ls-files 超过 30000 毫秒未返回");
    };
    const next = await step(
      repo,
      "改 src/a.ts",
      [
        edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " // TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      {
        warn: (line) => lines.push(line),
        phases: {
          probe: (root) => ({ ...workspaceProbe(root), tracked: timedOut, renamedSince: timedOut }),
          load: () => [syntheticFact(repo, "src/b.ts", "类型", Date.now() - 1_000)],
        },
      },
      repairing(["类型"])
    );
    assert.equal(next.result.repair?.verdict, "pass");
    // 开局与回炉的超时同属一类，只告警一次
    assert.equal(lines.length, 1, lines.join(" | "));
    assert.ok(lines[0]?.includes("不推送结构化记忆"), lines[0]);
    assert.deepEqual(next.result.structuredMemory?.opening, []);
    assert.deepEqual(next.result.structuredMemory?.repair, [[]]);
  } finally {
    repo.cleanup();
  }
});

test("派生失败后本次运行内不再重试：各轮回炉直接不给", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    let calls = 0;
    const lines: string[] = [];
    const next = await step(
      repo,
      "改 src/a.ts",
      [
        edits(["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
        finished(),
        finished("还没修"),
        edits(["src/b.ts", " // TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      {
        warn: (line) => lines.push(line),
        phases: {
          load: () => {
            calls += 1;
            throw new Error("派生超时");
          },
        },
      },
      repairing(["类型"], 3)
    );
    assert.equal(next.result.repair?.rounds, 2);
    assert.equal(calls, 1, "开局失败一次后，两轮回炉都不再重试");
    assert.equal(lines.length, 1);
    assert.deepEqual(next.result.structuredMemory?.repair, [[], []]);
  } finally {
    repo.cleanup();
  }
});

// 合成一条类型检查事实：错误码、报错文件与名字可指定（名字不在文件里即核验不过）
function typeFact(
  repo: MemoryRepo,
  code: string,
  file: string,
  names: string[],
  at: number
): FrictionFact {
  const fingerprint = { tool: "tsc" as const, code, file, names };
  return {
    kind: "regression",
    sessionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" as SessionId,
    stepName: "类型",
    stepKind: "type",
    fingerprint,
    fingerprintKey: fingerprintKey("类型", fingerprint),
    at,
    workspace: repo.root,
    changedAtRed: [file],
    repairFiles: [file],
  };
}

test("回炉两档合计的被拦下名额：第二档扣掉第一档已被拦下的条数", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    const now = Date.now() - 60_000;
    // 第一档：与本次报错指纹对上的两组（a.ts、z.ts 上的 TS2304），名字都不在，核验都不过
    const firstA = typeFact(repo, "TS2304", "src/a.ts", ["gone"], now + 4);
    const firstZ = typeFact(repo, "TS2304", "src/z.ts", ["gone"], now + 3);
    // 第二档：挂在报错文件 a.ts 上的另两组，一组过、一组不过
    const secondOk = typeFact(repo, "TS2322", "src/a.ts", [], now + 2);
    const secondBad = typeFact(repo, "TS2345", "src/a.ts", ["gone"], now + 1);
    const facts = [firstA, firstZ, secondOk, secondBad];
    const idOf = (fact: FrictionFact) =>
      buildMemoryEntries(facts).find(
        (entry) =>
          entry.fingerprintKey === fact.fingerprintKey && entry.anchor === fact.fingerprint.file
      )?.id;
    const next = await step(
      repo,
      "调整",
      [
        edits(
          ["src/a.ts", "= 1;", "= 1; // TYPE_BAD:alpha"],
          ["src/z.ts", "= 0;", "= 0; // TYPE_BAD:beta"]
        ),
        finished(),
        edits(["src/a.ts", " // TYPE_BAD:alpha", ""], ["src/z.ts", " // TYPE_BAD:beta", ""]),
        finished("修好了"),
      ],
      { phases: { load: () => facts } },
      repairing(["类型"])
    );
    const memory = next.runStarteds[1]?.payload.structuredMemory;
    assert.deepEqual(memory?.repair, [idOf(secondOk)]);
    assert.deepEqual(
      [...(memory?.repairBlocked ?? [])].sort(),
      [idOf(firstA), idOf(firstZ)].sort()
    );
  } finally {
    repo.cleanup();
  }
});

test("工作区探针遇到 git 超时即锁定：后续查询不再调用 git，直接按取不到处理", () => {
  let calls = 0;
  const probe = workspaceProbe("/repo", {
    run: () => {
      calls += 1;
      throw new StructuredMemoryGitTimeoutError("git log 超过 30000 毫秒未返回");
    },
  });
  assert.throws(() => probe.renamedSince("src/a.ts", 0), StructuredMemoryGitTimeoutError);
  assert.throws(() => probe.tracked(), StructuredMemoryGitTimeoutError);
  assert.throws(() => probe.changedLinesSince("src/a.ts", 0), StructuredMemoryGitTimeoutError);
  assert.equal(calls, 1);
});
