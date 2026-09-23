// 结构化记忆的推送、挑选与用前核验（决策 134 / 135 / 136 / 157），以及故障处理。
// 历史由真实 headless 回炉流程写进账本；新的一步经 headless 正常入口跑，检查系统提示、回炉反馈与 run.started 留痕。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { STRUCTURED_MEMORY_DISCLAIMER } from "../memory/structured-select.ts";
import {
  buildMemoryEntries,
  loadStructuredMemory,
  structuredMemoryCachePath,
} from "../memory/structured-store.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { SessionId } from "../state/ids.ts";
import { type HeadlessRunOptions, runHeadless } from "./headless.ts";
import type { StructuredMemoryOptions } from "./structured-memory.ts";
import {
  edits,
  finished,
  type MemoryRepo,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const DISCLAIMER_TAIL = "与当前代码冲突时以代码为准";

const FILES = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = helper;\n",
  "src/c.ts": "export const c = 'OK';\n",
  "src/c.test.ts": "// FAILS_UNLESS src/c.ts OK c keeps value\n",
  "src/z.ts": "export const z = 0;\n",
  "src/layer/x.ts": "export const x = 1;\n",
  "src/layer/y.ts": "export const y = 1;\n",
  "pkg/mod.py": "VALUE = 1\n",
};

const STEPS = ["格式", "类型", "测试", "分层"];

async function history(repo: MemoryRepo, replies: FakeReply[]): Promise<void> {
  await runHeadless({
    task: "以往的一步",
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({ replies }),
    yolo: true,
    homeDir: repo.home,
    verify: memoryVerifyConfig(STEPS),
    repairRounds: 3,
    structuredMemory: { enabled: false },
  });
  repo.commit("落地这一步");
}

// 改 a.ts 时把 b.ts 的类型弄坏，回炉一轮修好：一条挂在 a.ts 与 b.ts 上的类型检查红转绿（名字 helper 在 b.ts 里）
const TYPE_HISTORY: FakeReply[] = [
  edits(["src/a.ts", "= 1;", "= 2;"], ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
  finished(),
  edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
  finished("修好了"),
];

// 改 c.ts 把他处测试弄红，回炉修好：一条挂在 c.ts 与 c.test.ts 上的测试红转绿（名字是测试名，在 c.test.ts 里）
const TEST_HISTORY: FakeReply[] = [
  edits(["src/c.ts", "'OK'", "'changed'"]),
  finished(),
  edits(["src/c.ts", "'changed'", "'OK again'"]),
  finished("修好了"),
];

interface NewStep {
  streamFn: FakeStreamFn;
  sessionId: SessionId;
  result: Awaited<ReturnType<typeof runHeadless>>;
  systemPrompt: string;
  runStarteds: ReturnType<typeof materializeSession>["runStarteds"];
}

async function newStep(
  repo: MemoryRepo,
  task: string,
  memory: StructuredMemoryOptions,
  replies: FakeReply[] = [finished("看过了")],
  extra: Partial<HeadlessRunOptions> = {}
): Promise<NewStep> {
  const streamFn = createFakeStreamFn({ replies });
  const result = await runHeadless({
    task,
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn,
    yolo: true,
    homeDir: repo.home,
    structuredMemory: memory,
    ...extra,
  });
  const session = materializeSession(join(repo.root, ".pigeon", "sessions"), result.sessionId, {
    content: false,
  });
  const context = streamFn.calls[0]?.context as { systemPrompt?: string } | undefined;
  return {
    streamFn,
    sessionId: result.sessionId,
    result,
    systemPrompt: context?.systemPrompt ?? "",
    runStarteds: session.runStarteds,
  };
}

function entriesOf(repo: MemoryRepo) {
  return buildMemoryEntries(loadStructuredMemory(repo.root).facts);
}

function lastUserText(streamFn: FakeStreamFn, call: number): string {
  const messages = (streamFn.calls[call]?.context.messages ?? []) as Array<{
    role: string;
    content: unknown;
  }>;
  const last = messages.findLast((message) => message.role === "user");
  if (last === undefined) {
    return "";
  }
  return typeof last.content === "string"
    ? last.content
    : (last.content as Array<{ type: string; text?: string }>)
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("");
}

test("开局：只按题面指到的文件挑选——题面里的路径、所附代码的导入（含 Python）解析出的文件；指不到就一条都不给", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const [onA] = entriesOf(repo).filter((entry) => entry.anchor === "src/a.ts");
    assert.ok(onA !== undefined);
    // 题面直接写了路径
    const byPath = await newStep(repo, "请修改 src/a.ts，把 a 调成 3。", {});
    assert.ok(byPath.systemPrompt.includes("## 结构化记忆"), byPath.systemPrompt);
    assert.ok(byPath.systemPrompt.includes(onA.id), byPath.systemPrompt);
    assert.deepEqual(byPath.runStarteds[0]?.payload.structuredMemory, {
      enabled: true,
      selection: "auto",
      opening: [onA.id],
    });
    assert.deepEqual(byPath.result.structuredMemory, {
      enabled: true,
      opening: [onA.id],
      openingBlocked: [],
      repair: [],
      repairBlocked: [],
    });
    // 题面所附测试代码里的相对导入（以所附文件为基准）
    const byImport = await newStep(
      repo,
      'a 要变成 3。\n\nsrc/a2.test.ts\n```ts\nimport { a } from "./a.ts";\n```\n',
      {}
    );
    assert.deepEqual(byImport.runStarteds[0]?.payload.structuredMemory?.opening, [onA.id]);
    // 指到的文件上没有记忆：一条都不给，系统提示里没有这一段
    const unrelated = await newStep(repo, "改一下 src/z.ts", {});
    assert.ok(!unrelated.systemPrompt.includes("结构化记忆"), unrelated.systemPrompt);
    assert.deepEqual(unrelated.runStarteds[0]?.payload.structuredMemory?.opening, []);
    // 题面没指到任何文件
    const none = await newStep(repo, "把 a 的值调大一点", {});
    assert.deepEqual(none.runStarteds[0]?.payload.structuredMemory?.opening, []);
  } finally {
    repo.cleanup();
  }
});

test("开局：Python 导入语句按点号模块解析到仓库内文件", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, [
      edits(["pkg/mod.py", "VALUE = 1", "VALUE = 1  # TYPE_BAD:VALUE"]),
      finished(),
      edits(["pkg/mod.py", "  # TYPE_BAD:VALUE", "  # VALUE ok"]),
      finished("修好了"),
    ]);
    const [entry] = entriesOf(repo);
    assert.ok(entry !== undefined);
    const step = await newStep(
      repo,
      "tests/test_mod.py\n```python\nfrom pkg.mod import VALUE\n```",
      {}
    );
    assert.deepEqual(step.runStarteds[0]?.payload.structuredMemory?.opening, [entry.id]);
  } finally {
    repo.cleanup();
  }
});

test("开局：最多 2 条；同一指纹只给一条", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    // 先后三次摩擦都挂在 a.ts 上：格式（最早）、分层，最后一次类型检查同时挂在 a.ts 与 b.ts 上（最新、事后两文件都没再改）
    await history(repo, [
      edits(["src/a.ts", "= 1;", "= 2; // FMT_BAD"]),
      finished(),
      edits(["src/a.ts", " // FMT_BAD", ""]),
      finished("修好了"),
    ]);
    await history(repo, [
      edits(["src/a.ts", "= 2;", "= 3; // LAYER_BAD:src/layer/y.ts"]),
      finished(),
      edits(["src/a.ts", " // LAYER_BAD:src/layer/y.ts", ""]),
      finished("修好了"),
    ]);
    await history(repo, [
      edits(["src/a.ts", "= 3;", "= 4;"], ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
      finished(),
      edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
      finished("修好了"),
    ]);
    const all = entriesOf(repo);
    const typeIds = all.filter((entry) => entry.stepName === "类型").map((entry) => entry.id);
    const layerOnA = all.find((entry) => entry.anchor === "src/a.ts" && entry.stepName === "分层");
    assert.equal(typeIds.length, 2, "类型检查那条挂在两个锚点上：排序后前两位是同一指纹");
    assert.ok(layerOnA !== undefined);
    const step = await newStep(repo, "改 src/a.ts 与 src/b.ts", {});
    const opening = step.runStarteds[0]?.payload.structuredMemory?.opening ?? [];
    // 最多 2 条；同一指纹只给一条，第二条让给下一个指纹（分层；格式那条事后 a.ts 被改得更多，排在后面）
    assert.equal(opening.length, 2);
    assert.equal(opening.filter((id) => typeIds.includes(id)).length, 1);
    assert.equal(opening[1], layerOnA.id);
  } finally {
    repo.cleanup();
  }
});

test("回炉：报错指纹对上的优先，其次是挂在本次报错涉及文件上的记忆；该轮回炉 Run 的 run.started 记给了哪几条", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    // 两条都挂在 b.ts 上：一条类型检查（helper），一条格式
    await history(repo, TYPE_HISTORY);
    await history(repo, [
      edits(["src/b.ts", "helper; // helper ok", "helper; // helper ok FMT_BAD"]),
      finished(),
      edits(["src/b.ts", " FMT_BAD", ""]),
      finished("修好了"),
    ]);
    const all = entriesOf(repo);
    const formatEntry = all.find(
      (entry) => entry.anchor === "src/b.ts" && entry.stepName === "格式"
    );
    // 类型检查那条挂在 a.ts 与 b.ts 两个锚点上、指纹相同，只给一条：b.ts 事发后又被改过，给的是 a.ts 上那条
    const typeEntry = all.find((entry) => entry.anchor === "src/a.ts" && entry.stepName === "类型");
    assert.ok(typeEntry !== undefined && formatEntry !== undefined);
    // 新的一步：题面不指文件（开局不给），改坏 b.ts 的类型，回炉一轮修好
    const step = await newStep(
      repo,
      "调整一下",
      {},
      [
        edits(["src/b.ts", "helper; // helper ok", "helper; // helper ok TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      { verify: memoryVerifyConfig(STEPS), repairRounds: 2 }
    );
    const feedback = lastUserText(step.streamFn, 2);
    const typeAt = feedback.indexOf(typeEntry.id);
    const formatAt = feedback.indexOf(formatEntry.id);
    assert.ok(typeAt > 0 && formatAt > typeAt, feedback);
    assert.ok(feedback.indexOf("修正代码直到验证通过") < typeAt, "记忆附在回炉反馈之后");
    assert.deepEqual(step.runStarteds[0]?.payload.structuredMemory?.opening, []);
    assert.equal(step.runStarteds[0]?.payload.structuredMemory?.repair, undefined);
    assert.deepEqual(step.runStarteds[1]?.payload.structuredMemory?.repair, [
      typeEntry.id,
      formatEntry.id,
    ]);
    assert.deepEqual(step.result.structuredMemory, {
      enabled: true,
      opening: [],
      openingBlocked: [],
      repair: [[typeEntry.id, formatEntry.id]],
      repairBlocked: [[]],
    });
  } finally {
    repo.cleanup();
  }
});

test("固定挑选：调用方指定开局与回炉给哪几条（或一条都不给），推送路径与正式使用相同——同样拼进系统提示，不进题面", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const [onA] = entriesOf(repo).filter((entry) => entry.anchor === "src/a.ts");
    assert.ok(onA !== undefined);
    const task = "调整一下 src/a.ts";
    const auto = await newStep(repo, task, {});
    // 题面不指任何文件，但固定给这一条
    const fixed = await newStep(repo, "调整一下", { fixed: { opening: [onA.id], repair: [] } });
    assert.deepEqual(fixed.runStarteds[0]?.payload.structuredMemory, {
      enabled: true,
      selection: "fixed",
      opening: [onA.id],
    });
    // 与正式挑选同一条时，系统提示里的段落逐字相同；题面（用户消息）里没有记忆
    const section = (prompt: string) => prompt.slice(prompt.indexOf("## 结构化记忆"));
    assert.ok(auto.systemPrompt.includes(onA.id) && fixed.systemPrompt.includes(onA.id));
    assert.equal(
      section(fixed.systemPrompt).split("\n\n")[0],
      section(auto.systemPrompt).split("\n\n")[0]
    );
    assert.ok(!lastUserText(fixed.streamFn, 0).includes(onA.id));
    assert.equal(lastUserText(fixed.streamFn, 0), "调整一下");
    // 固定为一条都不给：题面即便指到有记忆的文件也不给
    const empty = await newStep(repo, task, { fixed: { opening: [], repair: [] } });
    assert.deepEqual(empty.runStarteds[0]?.payload.structuredMemory?.opening, []);
    assert.ok(!empty.systemPrompt.includes("结构化记忆"));
  } finally {
    repo.cleanup();
  }
});

test("开关：关闭时开局与回炉都不推送，run.started 记下关闭", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const step = await newStep(
      repo,
      "改 src/a.ts 与 src/b.ts",
      { enabled: false },
      [
        edits(["src/b.ts", "helper; // helper ok", "helper; // helper ok TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      { verify: memoryVerifyConfig(STEPS), repairRounds: 2 }
    );
    assert.ok(!step.systemPrompt.includes("结构化记忆"));
    assert.ok(!lastUserText(step.streamFn, 2).includes("mem_"));
    assert.deepEqual(step.runStarteds[0]?.payload.structuredMemory, {
      enabled: false,
      selection: "auto",
      opening: [],
    });
    assert.deepEqual(step.result.structuredMemory, {
      enabled: false,
      opening: [],
      openingBlocked: [],
      repair: [[]],
      repairBlocked: [[]],
    });
  } finally {
    repo.cleanup();
  }
});

test("核验：锚点文件删除即不给；已提交的改名按版本历史追踪、题面写新名字照给；未进版本历史的改名追踪不到、不给", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const entries = entriesOf(repo);
    const onA = entries.find((entry) => entry.anchor === "src/a.ts");
    const onB = entries.find((entry) => entry.anchor === "src/b.ts");
    assert.ok(onA !== undefined && onB !== undefined);
    // 已提交的改名：记忆挂在旧名上，题面写的是新名字
    repo.git(["mv", "src/a.ts", "src/a-renamed.ts"]);
    repo.commit("改名");
    const renamed = await newStep(repo, "改 src/a-renamed.ts", {});
    assert.deepEqual(renamed.runStarteds[0]?.payload.structuredMemory?.opening, [onA.id]);
    // 只在工作区里挪走、没提交：版本历史里没有这次改名，锚点按不存在处理
    repo.write("src/b-moved.ts", "export const b = helper; // helper ok\n");
    rmSync(join(repo.root, "src/b.ts"));
    const moved = await newStep(repo, "调整", { fixed: { opening: [onB.id] } });
    assert.deepEqual(moved.runStarteds[0]?.payload.structuredMemory?.opening, []);
    // 删除
    rmSync(join(repo.root, "src/a-renamed.ts"));
    repo.commit("删掉");
    const deleted = await newStep(repo, "调整", { fixed: { opening: [onA.id] } });
    assert.deepEqual(deleted.runStarteds[0]?.payload.structuredMemory?.opening, []);
  } finally {
    repo.cleanup();
  }
});

test("核验：改名追踪——锚点与报错文件改名后，按旧名挂的记忆仍能核验通过", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const onB = entriesOf(repo).find((entry) => entry.anchor === "src/b.ts");
    assert.ok(onB !== undefined);
    repo.git(["mv", "src/b.ts", "src/b2.ts"]);
    repo.commit("改名");
    // 固定挑选只走核验：锚点 b.ts 与报错文件 b.ts 都已改名为 b2.ts，名字 helper 仍在 b2.ts 里
    const step = await newStep(repo, "调整", { fixed: { opening: [onB.id] } });
    assert.deepEqual(step.runStarteds[0]?.payload.structuredMemory?.opening, [onB.id]);
  } finally {
    repo.cleanup();
  }
});

test("核验：报错里的名字在报错所在文件里找不到即不给——从变红时改过的文件那个锚点挑出来的也一样", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TEST_HISTORY);
    const onC = entriesOf(repo).find(
      (entry) => entry.anchor === "src/c.ts" && entry.stepName === "测试"
    );
    assert.ok(onC !== undefined);
    assert.equal(onC.fingerprint.file, "src/c.test.ts");
    const before = await newStep(repo, "改 src/c.ts", {});
    assert.deepEqual(before.runStarteds[0]?.payload.structuredMemory?.opening, [onC.id]);
    // 测试名从报错所在的测试文件里删掉（锚点 c.ts 本身没动）
    repo.write("src/c.test.ts", "// 这个测试被删了\n");
    repo.commit("删测试");
    const after = await newStep(repo, "改 src/c.ts", {});
    assert.deepEqual(after.runStarteds[0]?.payload.structuredMemory?.opening, []);
  } finally {
    repo.cleanup();
  }
});

test("核验：分层违规的被依赖端模块不在了即不给", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, [
      edits(["src/layer/x.ts", "= 1;", "= 1; // LAYER_BAD:src/layer/y.ts"]),
      finished(),
      edits(["src/layer/x.ts", " // LAYER_BAD:src/layer/y.ts", ""]),
      finished("修好了"),
    ]);
    const [entry] = entriesOf(repo);
    assert.equal(entry?.fingerprint.to, "src/layer/y.ts");
    const before = await newStep(repo, "改 src/layer/x.ts", {});
    assert.equal(before.runStarteds[0]?.payload.structuredMemory?.opening.length, 1);
    rmSync(join(repo.root, "src/layer/y.ts"));
    repo.commit("删被依赖端");
    const after = await newStep(repo, "改 src/layer/x.ts", {});
    assert.deepEqual(after.runStarteds[0]?.payload.structuredMemory?.opening, []);
  } finally {
    repo.cleanup();
  }
});

test("排序：事发以来锚点文件改得越少越靠前；超出上限的是改得最多的那条", async () => {
  const repo = makeMemoryRepo({
    ...FILES,
    "src/p.ts": "p\n",
    "src/q.ts": "q\n",
    "src/r.ts": "r\n",
  });
  try {
    for (const file of ["src/p.ts", "src/q.ts", "src/r.ts"]) {
      const letter = file.slice(4, 5);
      await history(repo, [
        edits([file, letter, `${letter} FMT_BAD`]),
        finished(),
        edits([file, " FMT_BAD", ""]),
        finished("修好了"),
      ]);
    }
    const entries = entriesOf(repo);
    const idOf = (file: string) => entries.find((entry) => entry.anchor === file)?.id;
    repo.write(
      "src/p.ts",
      `${Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")}\n`
    );
    repo.commit("大改 p.ts");
    repo.write("src/q.ts", "q\nq2\n");
    repo.commit("小改 q.ts");
    const step = await newStep(repo, "改 src/p.ts、src/q.ts、src/r.ts", {});
    assert.deepEqual(step.runStarteds[0]?.payload.structuredMemory?.opening, [
      idOf("src/r.ts"),
      idOf("src/q.ts"),
    ]);
  } finally {
    repo.cleanup();
  }
});

test("推送文字：每条写明是过去的事实、仅供参考、与当前代码冲突时以代码为准，开局段落与回炉附加内容都带", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const step = await newStep(
      repo,
      "改 src/a.ts",
      {},
      [
        edits(["src/b.ts", "helper; // helper ok", "helper; // helper ok TYPE_BAD:helper"]),
        finished(),
        edits(["src/b.ts", " TYPE_BAD:helper", ""]),
        finished("修好了"),
      ],
      { verify: memoryVerifyConfig(STEPS), repairRounds: 2 }
    );
    const section = step.systemPrompt.slice(step.systemPrompt.indexOf("## 结构化记忆"));
    const entryLines = section.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(entryLines.length > 0);
    for (const line of entryLines) {
      assert.ok(line.includes(STRUCTURED_MEMORY_DISCLAIMER), line);
      assert.ok(
        line.includes("过去") && line.includes("仅供参考") && line.includes(DISCLAIMER_TAIL)
      );
      assert.ok(line.length <= 402, line);
    }
    const appendix = lastUserText(step.streamFn, 2);
    assert.ok(appendix.includes(DISCLAIMER_TAIL), appendix);
    // 常驻 Memory 与结构化记忆分开：段落标题各自独立
    assert.ok(!section.includes("## 常驻 Memory"));
  } finally {
    repo.cleanup();
  }
});

test("故障：派生、缓存读写、挑选、核验出错即这次不给，同一类只告警一次并说明后果；运行照常完成、结论不受影响", async () => {
  const repo = makeMemoryRepo(FILES);
  try {
    await history(repo, TYPE_HISTORY);
    const breakAndFix: FakeReply[] = [
      edits(["src/b.ts", "helper; // helper ok", "helper; // helper ok TYPE_BAD:helper"]),
      finished(),
      edits(["src/b.ts", " TYPE_BAD:helper", ""]),
      finished("修好了"),
    ];
    const repairRun: Partial<HeadlessRunOptions> = {
      verify: memoryVerifyConfig(STEPS),
      repairRounds: 2,
    };
    const baseline = await newStep(repo, "改 src/a.ts", { enabled: false }, breakAndFix, repairRun);
    const boom = () => {
      throw new Error("模拟故障");
    };
    const cases: Array<{ phase: string; memory: StructuredMemoryOptions; setup?: () => void }> = [
      { phase: "派生", memory: { phases: { load: boom } } },
      {
        phase: "缓存读写",
        memory: {},
        setup: () => {
          rmSync(structuredMemoryCachePath(repo.root), { force: true });
          mkdirSync(structuredMemoryCachePath(repo.root), { recursive: true });
        },
      },
      { phase: "挑选", memory: { phases: { selectOpening: boom, selectRepair: boom } } },
      { phase: "核验", memory: { phases: { check: boom } } },
    ];
    for (const entry of cases) {
      entry.setup?.();
      const lines: string[] = [];
      const step = await newStep(
        repo,
        "改 src/a.ts",
        { ...entry.memory, warn: (line) => lines.push(line) },
        breakAndFix,
        repairRun
      );
      assert.equal(lines.length, 1, `${entry.phase}：${lines.join(" | ")}`);
      assert.ok(lines[0]?.includes(`${entry.phase}出错`), lines[0]);
      assert.ok(lines[0]?.includes("不推送结构化记忆") && lines[0]?.includes("运行照常完成"));
      assert.ok(!step.systemPrompt.includes("结构化记忆"));
      assert.ok(!lastUserText(step.streamFn, 2).includes("mem_"));
      assert.equal(step.result.status, baseline.result.status);
      assert.equal(step.result.label, baseline.result.label);
      assert.deepEqual(step.result.repair, baseline.result.repair);
      assert.deepEqual(step.runStarteds[0]?.payload.structuredMemory?.opening, []);
      rmSync(structuredMemoryCachePath(repo.root), { recursive: true, force: true });
    }
  } finally {
    repo.cleanup();
  }
});
