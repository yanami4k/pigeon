// 任务源接口（决策 102）与 runner 的配合：runner 不感知题目来源——实例、环境、判据命令、元数据都来自任务源；
// 任务源交回的执行端原样递给运行面（决策 098）；错误行口径（环境准备失败、模型服务故障、判据设施出错）不占续跑键；
// 并行不超过给定上限。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { asSessionId } from "../state/ids.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { deterministicErrorOf, type EvalResultLine, isContentRefusal, runEval } from "./runner.ts";
import type { EvalInstance, JudgeCommand, TaskSource } from "./task-source.ts";
import { runJudge } from "./verify.ts";

const ROOT = "/virtual/root";

function memoryHost(files: Map<string, string>): WorkspaceHost {
  return {
    platform: "linux",
    root: ROOT,
    async resolveExisting(inputPath) {
      return `${ROOT}/${inputPath}`;
    },
    async isFile(resolvedPath) {
      return files.has(resolvedPath);
    },
    async readText(resolvedPath) {
      return files.get(resolvedPath) ?? "";
    },
    async writeText(resolvedPath, content) {
      files.set(resolvedPath, content);
    },
    readTextSync: (inputPath) => files.get(`${ROOT}/${inputPath}`) ?? "",
    async exec() {
      throw new Error("本用例不执行命令");
    },
    async listFiles() {
      return { files: new Map(), truncated: false };
    },
    findLauncherScript: () => undefined,
  };
}

// 判据命令：按执行端里 answer.txt 的内容退出——0 通过、1 失败、7 表示判据自身出错
function exitWith(code: number, extra: Record<string, unknown> = {}): string[] {
  return [
    process.execPath,
    "-e",
    `console.log(JSON.stringify(${JSON.stringify({ code, ...extra })}));process.exit(${code})`,
  ];
}

interface FakeSourceLog {
  events: string[];
  running: number;
  peak: number;
}

function fakeSource(
  ids: readonly string[],
  behavior: {
    judgeExit?: (id: string, answer: string | undefined) => number;
    failPrepare?: ReadonlySet<string>;
    failJudge?: ReadonlySet<string>;
    holdMs?: number;
    // 按实例给的准备闸门：准备阶段等它放行（压过 holdMs）
    gateFor?: (id: string, log: FakeSourceLog) => Promise<void> | undefined;
    // 判据命令尾行 JSON 里附带的字段（如空补丁标注）
    judgeExtra?: (id: string) => Record<string, unknown>;
    maxTurns?: number;
  } = {}
): { source: TaskSource; log: FakeSourceLog; workspaces: Map<string, Map<string, string>> } {
  const log: FakeSourceLog = { events: [], running: 0, peak: 0 };
  const workspaces = new Map<string, Map<string, string>>();
  const placeholder = mkdtempSync(join(tmpdir(), "pigeon-fake-source-"));
  const instances: EvalInstance[] = ids.map((id) => ({
    id,
    instructions: `把 answer.txt 改成 done（${id}）`,
    budget: { maxTurns: behavior.maxTurns ?? 4, wallClockMs: 60_000 },
    holdout: false,
    tags: ["fixture"],
    difficulty: "<15 min fix",
  }));
  const source: TaskSource = {
    name: "fake",
    instances: () => instances,
    async prepare(instance, context) {
      log.events.push(`prepare:${instance.id}:${context.condition}:${context.attempt}`);
      if (behavior.failPrepare?.has(instance.id)) {
        throw new Error("镜像拉不下来");
      }
      log.running += 1;
      log.peak = Math.max(log.peak, log.running);
      const gate = behavior.gateFor?.(instance.id, log);
      if (gate !== undefined) {
        await gate;
      } else if (behavior.holdMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, behavior.holdMs));
      }
      const files = new Map([[`${ROOT}/answer.txt`, "todo\n"]]);
      workspaces.set(instance.id, files);
      return {
        workspaceRoot: placeholder,
        host: memoryHost(files),
        judgeCommandHint: ["judge", instance.id],
        async judge(): Promise<JudgeCommand> {
          log.events.push(`judge:${instance.id}`);
          if (behavior.failJudge?.has(instance.id)) {
            throw new Error("取 diff 失败：容器不在了");
          }
          const answer = files.get(`${ROOT}/answer.txt`);
          const code = behavior.judgeExit?.(instance.id, answer) ?? (answer === "done\n" ? 0 : 1);
          return {
            command: exitWith(code, behavior.judgeExtra?.(instance.id) ?? {}),
            cwd: placeholder,
            timeoutMs: 30_000,
            assets: [`${instance.id}.patch`],
            undeterminedExitCodes: [7],
          };
        },
        async release() {
          log.events.push(`release:${instance.id}`);
          log.running -= 1;
        },
      };
    },
  };
  return { source, log, workspaces };
}

// 经 edit_file 把 answer.txt 改成 done，然后收工
function editingStreamFn(): StreamFn {
  return (model, context, options) => {
    const last = context.messages[context.messages.length - 1];
    const script =
      last?.role === "toolResult"
        ? createFakeStreamFn({ replies: [{ text: "完成" }] })
        : createFakeStreamFn({
            replies: [
              {
                text: "改文件",
                toolCalls: [
                  {
                    name: "edit_file",
                    args: { path: "answer.txt", old_string: "todo", new_string: "done" },
                  },
                ],
              },
            ],
          });
    return script(model, context, options);
  };
}

// 轮询直到条件成立或超时（超时也放行：由调用方的断言判定顺序对不对）
async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readRows(file: string): EvalResultLine[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row) as EvalResultLine);
}

// 取某题的结果行：行必须存在——"某字段不在场"的断言才不会因为整行缺失而空转
function rowOf(rows: ReadonlyMap<string, EvalResultLine>, id: string): EvalResultLine {
  const row = rows.get(id);
  assert.ok(row !== undefined, `结果里没有 ${id} 这一行`);
  return row;
}

test("runner 经任务源跑通：执行端原样递给运行面（改动落在任务源的工作区里），判据命令定判决，元数据进结果行，环境必释放", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const { source, log, workspaces } = fakeSource(["inst-a"]);
    const summary = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
    });
    assert.equal(summary.ran, 1);
    // agent 的编辑经任务源给的执行端落在它的工作区里，宿主占位目录没被碰
    assert.equal(workspaces.get("inst-a")?.get(`${ROOT}/answer.txt`), "done\n");
    const [row] = readRows(summary.resultsFile);
    assert.equal(row?.taskId, "inst-a");
    assert.equal(row?.status, "completed");
    assert.equal(row?.verdict, "pass");
    assert.equal(row?.difficulty, "<15 min fix");
    assert.equal(typeof row?.wallMs, "number");
    assert.deepEqual(log.events, ["prepare:inst-a:none:1", "judge:inst-a", "release:inst-a"]);
    // candidate 条件没给 Skill 根：响亮失败而不是悄悄当成无 Skill
    const again = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["candidate"],
    });
    const candidateRow = readRows(again.resultsFile).at(-1);
    assert.equal(candidateRow?.status, "error");
    assert.match(candidateRow?.error ?? "", /需要 Skill 根/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("错误行口径：环境准备失败、判据备料失败、判据约定的出错退出码都记 error 且不占续跑键；任务判失败是正常结果行", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const ids = ["prep-bad", "judge-bad", "judge-infra", "task-fail", "task-pass"];
    const flaky = fakeSource(ids, {
      failPrepare: new Set(["prep-bad"]),
      failJudge: new Set(["judge-bad"]),
      judgeExit: (id, answer) =>
        id === "judge-infra" ? 7 : id === "task-fail" ? 1 : answer === "done\n" ? 0 : 1,
    });
    const options = {
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
    };
    const first = await runEval({ ...options, source: flaky.source });
    assert.equal(first.ran, 5);
    const byId = new Map(readRows(first.resultsFile).map((row) => [row.taskId, row]));
    assert.equal(byId.get("prep-bad")?.status, "error");
    assert.match(byId.get("prep-bad")?.error ?? "", /准备环境失败：镜像拉不下来/);
    assert.equal(byId.get("judge-bad")?.status, "error");
    assert.match(byId.get("judge-bad")?.error ?? "", /取 diff 失败/);
    assert.equal(byId.get("judge-infra")?.status, "error");
    assert.match(byId.get("judge-infra")?.error ?? "", /判据自身出错（退出码 7）/);
    for (const id of ["prep-bad", "judge-bad", "judge-infra"]) {
      assert.equal(byId.get(id)?.verdict, "undetermined");
    }
    // 任务判失败不是错误行
    assert.equal(byId.get("task-fail")?.status, "completed");
    assert.equal(byId.get("task-fail")?.verdict, "fail");
    assert.equal(byId.get("task-pass")?.verdict, "pass");
    // 出错的运行环境也释放了（准备失败的那个没有环境可释放）
    assert.deepEqual(flaky.log.events.filter((event) => event.startsWith("release:")).sort(), [
      "release:judge-bad",
      "release:judge-infra",
      "release:task-fail",
      "release:task-pass",
    ]);

    // 设施恢复后重跑同一输出目录：三条错误行的键补跑，两条正常行跳过
    const healthy = fakeSource(ids, { judgeExit: (id) => (id === "task-fail" ? 1 : 0) });
    const second = await runEval({ ...options, source: healthy.source });
    assert.equal(second.ran, 3);
    assert.equal(second.skipped, 2);
    assert.deepEqual(healthy.log.events.filter((event) => event.startsWith("prepare:")).sort(), [
      "prepare:judge-bad:none:1",
      "prepare:judge-infra:none:1",
      "prepare:prep-bad:none:1",
    ]);
    assert.equal(readRows(second.resultsFile).length, 8);
    // 报告按读侧口径：5 题里 4 题通过、1 题失败，错误行不进分母
    assert.match(readFileSync(second.reportFile, "utf8"), /\| task-pass \| 1\/1（100%）/);
    assert.match(readFileSync(second.reportFile, "utf8"), /\| prep-bad \| 1\/1（100%）/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("模型服务故障记错误行且不判分；重跑时补跑", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const broken = fakeSource(["inst-a"]);
    const options = {
      outDir: out,
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
    };
    const first = await runEval({
      ...options,
      source: broken.source,
      streamFn: createFakeStreamFn({
        replies: [{ text: "不会到这里" }],
        failOnCall: 1,
        failureMessage: "429 配额耗尽",
      }),
    });
    const [row] = readRows(first.resultsFile);
    assert.equal(row?.status, "error");
    assert.equal(row?.failureClass, "infrastructure");
    assert.match(row?.error ?? "", /基础设施错误（模型服务故障/);
    assert.equal(broken.log.events.includes("judge:inst-a"), false);
    assert.equal(broken.log.events.includes("release:inst-a"), true);
    const healthy = fakeSource(["inst-a"]);
    const second = await runEval({
      ...options,
      source: healthy.source,
      streamFn: editingStreamFn(),
    });
    assert.equal(second.ran, 1);
    assert.equal(readRows(second.resultsFile).at(-1)?.verdict, "pass");
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("模型流以错误收尾（终态 failed，失败分类并非基础设施）同样记错误行且不判分：连接中断不算任务失败", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    // 先正常改完文件，再在下一轮以流内错误收尾：此时工作区里的改动足以让判据通过，
    // 若仍去判分就会把一次没跑完的运行记成"通过"或"失败"
    const edit = editingStreamFn();
    const broken = createFakeStreamFn({
      replies: [{ text: "", streamError: "Connection error." }],
    });
    const streamFn: StreamFn = (model, context, options) => {
      const last = context.messages[context.messages.length - 1];
      return last?.role === "toolResult"
        ? broken(model, context, options)
        : edit(model, context, options);
    };
    const source = fakeSource(["inst-a"]);
    const options = {
      outDir: out,
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
    };
    const first = await runEval({ ...options, source: source.source, streamFn });
    const [row] = readRows(first.resultsFile);
    assert.equal(row?.status, "error");
    assert.equal(row?.verdict, "undetermined");
    assert.match(row?.error ?? "", /基础设施错误（模型服务故障，终态 failed）/);
    assert.match(row?.error ?? "", /Connection error\./);
    assert.equal(source.log.events.includes("judge:inst-a"), false);
    // 不占续跑键：服务恢复后补跑
    const healthy = fakeSource(["inst-a"]);
    const second = await runEval({
      ...options,
      source: healthy.source,
      streamFn: editingStreamFn(),
    });
    assert.equal(second.ran, 1);
    assert.equal(second.skipped, 0);
    assert.equal(readRows(second.resultsFile).at(-1)?.verdict, "pass");
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("内容审核类拒答是独立状态：不判分、不补跑（占续跑键）、不进成败统计；普通的流内错误仍是错误行", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const refusing = createFakeStreamFn({
      replies: [{ text: "", streamError: "The model refused to complete the request" }],
    });
    const source = fakeSource(["inst-r", "inst-ok"]);
    const streamFn: StreamFn = (model, context, options) =>
      JSON.stringify(context.messages).includes("inst-r")
        ? refusing(model, context, options)
        : editingStreamFn()(model, context, options);
    const options = {
      outDir: out,
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
      streamFn,
    };
    const first = await runEval({ ...options, source: source.source });
    const rows = new Map(readRows(first.resultsFile).map((row) => [row.taskId, row]));
    assert.equal(rows.get("inst-r")?.status, "refused");
    assert.equal(rows.get("inst-r")?.verdict, "undetermined");
    assert.match(rows.get("inst-r")?.error ?? "", /内容审核拒答/);
    assert.equal(source.log.events.includes("judge:inst-r"), false);
    assert.equal(source.log.events.includes("release:inst-r"), true);
    assert.equal(rows.get("inst-ok")?.verdict, "pass");
    // 不补跑：拒答行占键
    const again = fakeSource(["inst-r", "inst-ok"]);
    const second = await runEval({ ...options, source: again.source });
    assert.equal(second.ran, 0);
    assert.equal(second.skipped, 2);
    // 不进成败统计：报告合计 1/1
    const report = readFileSync(second.reportFile, "utf8");
    assert.match(report, /\| 合计 \| 1\/1（100%） \|/);
    assert.match(report, /内容审核拒答：1 次/);
    for (const [message, expected] of [
      ["The model refused to complete the request", true],
      ["Provider stopped with: sensitive", true],
      [
        '400 {"error":{"type":"content_filter","message":"The request was rejected because it was considered high risk"}}',
        true,
      ],
      ["Connection error.", false],
      ['429 {"error":{"type":"rate_limit_error"}}', false],
      [undefined, false],
    ] as const) {
      assert.equal(isContentRefusal(message), expected, String(message));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("确定性错误（上下文超长）：重跑必复现，照常判分（中途改了什么判什么）、不进错误行、占续跑键不补跑，结果行与报告标注", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const overflow = createFakeStreamFn({
      replies: [
        { text: "", streamError: "exceeded model token limit: 262144 (requested: 301234)" },
      ],
    });
    // edited：先改对文件，下一轮请求超长；untouched：第一轮就超长
    const streamFn: StreamFn = (model, context, options) => {
      const last = context.messages[context.messages.length - 1];
      return JSON.stringify(context.messages).includes("untouched") || last?.role === "toolResult"
        ? overflow(model, context, options)
        : editingStreamFn()(model, context, options);
    };
    const source = fakeSource(["edited", "untouched"]);
    const options = {
      outDir: out,
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
      streamFn,
    };
    const first = await runEval({ ...options, source: source.source });
    const rows = new Map(readRows(first.resultsFile).map((row) => [row.taskId, row]));
    const edited = rows.get("edited");
    const untouched = rows.get("untouched");
    assert.ok(edited !== undefined && untouched !== undefined);
    // 照常判分：不是错误行，判决来自判据
    assert.equal(edited.status, "failed");
    assert.equal(edited.verdict, "pass");
    assert.equal(edited.deterministicError, "context-overflow");
    assert.match(edited.error ?? "", /确定性错误（上下文超长/);
    assert.match(edited.error ?? "", /exceeded model token limit/);
    assert.equal(untouched.status, "failed");
    assert.equal(untouched.verdict, "fail");
    assert.equal(untouched.deterministicError, "context-overflow");
    assert.equal(source.log.events.includes("judge:edited"), true);
    assert.equal(source.log.events.includes("judge:untouched"), true);
    // 占续跑键：不补跑
    const again = fakeSource(["edited", "untouched"]);
    const second = await runEval({ ...options, source: again.source });
    assert.equal(second.ran, 0);
    assert.equal(second.skipped, 2);
    const report = readFileSync(second.reportFile, "utf8");
    assert.match(report, /\| 合计 \| 1\/2（50%） \|/);
    assert.match(
      report,
      /- 确定性错误（重跑必复现，不补跑）：2 次，其中判分通过 1 次：edited（上下文超长，通过）、untouched（上下文超长，失败）/
    );
    // 分类：只认上游识别的上下文超长；限额、服务故障、拒答都不算
    for (const [text, expected] of [
      ["exceeded model token limit: 262144 (requested: 301234)", "context-overflow"],
      ["400 prompt is too long: 210000 tokens > 200000 maximum", "context-overflow"],
      ['400 {"error":{"code":"context_length_exceeded"}}', "context-overflow"],
      ["429 Too many requests: too many tokens per minute", undefined],
      ["Rate limit reached: token limit exceeded for this minute", undefined],
      ["Request timed out.", undefined],
      ["Connection error.", undefined],
      ["The model refused to complete the request", undefined],
      [undefined, undefined],
    ] as const) {
      assert.equal(deterministicErrorOf(text), expected, String(text));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("空补丁仍判失败但带标注；改了没改对的失败不带", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const { source } = fakeSource(["untouched", "wrong-fix"], {
      judgeExit: () => 1,
      judgeExtra: (id) => (id === "untouched" ? { emptyPatch: true } : {}),
    });
    const summary = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
    });
    const rows = new Map(readRows(summary.resultsFile).map((row) => [row.taskId, row]));
    assert.equal(rows.get("untouched")?.verdict, "fail");
    assert.equal(rows.get("untouched")?.status, "completed");
    assert.equal(rows.get("untouched")?.emptyPatch, true);
    assert.equal(rows.get("wrong-fix")?.verdict, "fail");
    assert.equal("emptyPatch" in rowOf(rows, "wrong-fix"), false);
    assert.match(
      readFileSync(summary.reportFile, "utf8"),
      /空补丁（判失败，根本没改）：1 次：untouched/
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("连续指标：判据尾行 JSON 的 progress 原样进结果行（目标用例与回归用例各通过几条）；形状不对的不收", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const { source } = fakeSource(["near-miss", "far-off", "no-progress", "bad-shape"], {
      judgeExit: () => 1,
      judgeExtra: (id) =>
        id === "near-miss"
          ? {
              progress: {
                target: { passed: 2, total: 2 },
                regression: { passed: 116, total: 117 },
              },
            }
          : id === "far-off"
            ? { progress: { target: { passed: 0, total: 3 } } }
            : id === "bad-shape"
              ? { progress: { target: { passed: "2", total: 2 } } }
              : {},
    });
    const summary = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
    });
    const rows = new Map(readRows(summary.resultsFile).map((row) => [row.taskId, row]));
    assert.deepEqual(rows.get("near-miss")?.testProgress, {
      target: { passed: 2, total: 2 },
      regression: { passed: 116, total: 117 },
    });
    assert.deepEqual(rows.get("far-off")?.testProgress, { target: { passed: 0, total: 3 } });
    assert.equal("testProgress" in rowOf(rows, "no-progress"), false);
    assert.equal("testProgress" in rowOf(rows, "bad-shape"), false);
    // 判决不受连续指标影响：目标用例全过但有回归，仍是失败
    assert.equal(rows.get("near-miss")?.verdict, "fail");
    const report = readFileSync(summary.reportFile, "utf8");
    assert.match(report, /## 失败运行的连续指标/);
    assert.match(report, /\| near-miss \| none \| 2\/2 \| 116\/117 \|/);
    assert.match(report, /\| far-off \| none \| 0\/3 \| — \|/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("撞上限但判分通过计为通过：验证结论压过运行终态，结果行标注撞的是哪个上限", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    // 第一轮改对文件，之后一直读文件不收工，直到撞轮次上限
    const keepReading = createFakeStreamFn({
      replies: [
        { text: "再看看", toolCalls: [{ name: "read_file", args: { path: "answer.txt" } }] },
      ],
    });
    const streamFn: StreamFn = (model, context, options) => {
      const last = context.messages[context.messages.length - 1];
      return last?.role === "toolResult"
        ? keepReading(model, context, options)
        : editingStreamFn()(model, context, options);
    };
    const { source } = fakeSource(["inst-a"], { maxTurns: 3 });
    const summary = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn,
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
    });
    const [row] = readRows(summary.resultsFile);
    assert.equal(row?.status, "turn-limit");
    assert.equal(row?.limitHit, "turn-limit");
    assert.equal(row?.verdict, "pass");
    const report = readFileSync(summary.reportFile, "utf8");
    assert.match(report, /\| inst-a \| 1\/1（100%） \|/);
    assert.match(report, /撞上限：1 次，其中判分通过 1 次：inst-a（turn-limit，通过）/);
    // 正常收尾的行不带这个标注
    const normal = fakeSource(["inst-b"]);
    const plain = await runEval({
      source: normal.source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
    });
    const plainRow = rowOf(
      new Map(readRows(plain.resultsFile).map((row) => [row.taskId, row])),
      "inst-b"
    );
    assert.equal(plainRow.status, "completed");
    assert.equal("limitHit" in plainRow, false);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("采样温度：给了就传到每一次模型调用并记进该次运行的 run.started；不给则调用选项里没有这个键", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    const streamFn: StreamFn = (model, context, options) => {
      seen.push({ ...(options as Record<string, unknown> | undefined) });
      return editingStreamFn()(model, context, options);
    };
    const base = {
      outDir: out,
      runs: 1,
      streamFn,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
    };
    const fixed = await runEval({
      ...base,
      source: fakeSource(["inst-t0"]).source,
      temperature: 0,
    });
    assert.ok(seen.length > 0 && seen.every((options) => options.temperature === 0));
    const [row] = readRows(fixed.resultsFile);
    const started = materializeSession(
      join(out, ".pigeon", "sessions"),
      asSessionId(row?.sessionId ?? "")
    ).runStarteds[0];
    assert.equal(started?.payload.model.temperature, 0);
    seen.length = 0;
    await runEval({ ...base, source: fakeSource(["inst-default"]).source });
    assert.ok(seen.length > 0 && seen.every((options) => !("temperature" in options)));
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("任务源给的系统指令进模型实际看到的 system prompt 并冻结进该次运行；任务说明原样作用户消息；不给则 system prompt 不变", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const seen: Array<{ systemPrompt: string; firstUser: string }> = [];
    const streamFn: StreamFn = (model, context, options) => {
      seen.push({
        systemPrompt: context.systemPrompt ?? "",
        firstUser: JSON.stringify(context.messages[0] ?? {}),
      });
      return editingStreamFn()(model, context, options);
    };
    const base = {
      outDir: out,
      runs: 1,
      streamFn,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
    };
    const directive = "Your task is to change the repository so that the issue is fixed.";
    const withDirective = fakeSource(["inst-d"]);
    const instances = withDirective.source.instances();
    const directed: TaskSource = {
      ...withDirective.source,
      instances: () => instances.map((instance) => ({ ...instance, systemDirective: directive })),
    };
    const first = await runEval({ ...base, source: directed });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((call) => call.systemPrompt.includes(directive)));
    // 指令不进用户消息，任务说明不进指令
    assert.ok(seen.every((call) => !call.firstUser.includes(directive)));
    assert.ok(seen.every((call) => call.firstUser.includes("inst-d")));
    const hashOf = (file: string): string | undefined => {
      const row = readRows(file).at(-1);
      return materializeSession(join(out, ".pigeon", "sessions"), asSessionId(row?.sessionId ?? ""))
        .runStarteds[0]?.payload.systemPromptHash;
    };
    const directedHash = hashOf(first.resultsFile);
    const directedPrompt = seen[0]?.systemPrompt ?? "";

    seen.length = 0;
    const plain = await runEval({ ...base, source: fakeSource(["inst-plain"]).source });
    assert.ok(seen.every((call) => !call.systemPrompt.includes(directive)));
    // 去掉这一句，其余 system prompt 逐字相同；冻结的哈希随之不同
    assert.equal(directedPrompt.replace(`\n\n${directive}`, ""), seen[0]?.systemPrompt);
    assert.notEqual(directedHash, hashOf(plain.resultsFile));
    assert.match(directedHash ?? "", /^[0-9a-f]{64}$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("并行：同时进行的运行不超过上限，全部实例各落一行", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const { source, log } = fakeSource(ids, { holdMs: 150 });
    const seen: string[] = [];
    const summary = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
      concurrency: 3,
      onResult: (line) => seen.push(line.taskId),
    });
    assert.equal(summary.ran, 7);
    assert.equal(log.peak, 3);
    assert.deepEqual([...seen].sort(), ids);
    assert.deepEqual(
      readRows(summary.resultsFile)
        .map((row) => row.taskId)
        .sort(),
      ids
    );
    assert.ok(readRows(summary.resultsFile).every((row) => row.verdict === "pass"));
    await assert.rejects(
      runEval({
        source,
        outDir: out,
        runs: 1,
        streamFn: editingStreamFn(),
        yolo: true,
        concurrency: 0,
      }),
      /并行数需要正整数/
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("工作队列：哪一路空了就取下一题，一道慢题不挡住其余各路（不按批等待）", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const ids = ["slow", "q1", "q2", "q3", "q4"];
    // 慢题一直占着一路，直到其余四题都放掉才继续（按批等待时它们根本起不来，只能等满兜底超时）
    const { source, log } = fakeSource(ids, {
      gateFor: (id, events) =>
        id === "slow" ? waitUntil(() => events.events.includes("release:q4"), 20_000) : undefined,
    });
    const summary = await runEval({
      source,
      outDir: out,
      runs: 1,
      streamFn: editingStreamFn(),
      yolo: true,
      homeDir: home,
      editMode: "replace",
      conditions: ["none"],
      concurrency: 2,
    });
    assert.equal(summary.ran, 5);
    // 慢题还没放掉之前，另一路已经把其余四题都跑完了
    const slowReleased = log.events.indexOf("release:slow");
    for (const id of ["q1", "q2", "q3", "q4"]) {
      const released = log.events.indexOf(`release:${id}`);
      assert.ok(released !== -1 && released < slowReleased, `${id} 应在慢题之前完成`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("逐题落盘：每一题结果行在回调之前已写进结果文件；进程中途停下，续跑跳过已完成的题、只跑剩下的", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const ids = ["d1", "d2", "d3", "d4"];
    const options = {
      outDir: out,
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
      streamFn: editingStreamFn(),
    };
    const onDisk: number[] = [];
    // 第二题写完后模拟进程死掉
    await assert.rejects(
      runEval({
        ...options,
        source: fakeSource(ids).source,
        onResult: () => {
          const rows = readRows(join(out, "results.jsonl"));
          onDisk.push(rows.length);
          if (rows.length === 2) {
            throw new Error("模拟进程中途退出");
          }
        },
      }),
      /模拟进程中途退出/
    );
    assert.deepEqual(onDisk, [1, 2]);
    const resumed = fakeSource(ids);
    const second = await runEval({ ...options, source: resumed.source });
    assert.equal(second.skipped, 2);
    assert.equal(second.ran, 2);
    const prepared = resumed.log.events.filter((event) => event.startsWith("prepare:"));
    assert.deepEqual(prepared, ["prepare:d3:none:1", "prepare:d4:none:1"]);
    assert.deepEqual(
      readRows(second.resultsFile)
        .map((row) => row.taskId)
        .sort(),
      ids
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("断供：连续若干次模型服务故障即全体暂停一段再取题；暂停次数用满仍连续故障就停止取新题，已完成的行保留，摘要写明原因；续跑补上其余", async () => {
  const out = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-source-home-"));
  try {
    const ids = ["ok-1", "x1", "x2", "x3", "x4", "x5"];
    const failing = createFakeStreamFn({
      replies: [{ text: "", streamError: "Connection error." }],
    });
    const streamFn: StreamFn = (model, context, options) =>
      /（x\d）/.test(JSON.stringify(context.messages))
        ? failing(model, context, options)
        : editingStreamFn()(model, context, options);
    const pauses: number[] = [];
    const warnings: string[] = [];
    const options = {
      outDir: out,
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
    };
    const first = await runEval({
      ...options,
      source: fakeSource(ids).source,
      streamFn,
      outage: {
        consecutiveFailures: 2,
        pauseMs: 600_000,
        maxPauses: 1,
        sleep: async (ms) => {
          pauses.push(ms);
        },
        warn: (text) => warnings.push(text),
      },
    });
    // ok-1 通过；x1、x2 连续故障 → 暂停一次；x3、x4 仍连续故障 → 暂停次数已用满，停止；x5 没跑
    assert.deepEqual(pauses, [600_000]);
    assert.equal(first.ran, 5);
    assert.match(first.stopped ?? "", /模型服务持续不可用/);
    const rows = readRows(first.resultsFile);
    assert.deepEqual(
      rows.map((row) => row.taskId),
      ["ok-1", "x1", "x2", "x3", "x4"]
    );
    assert.equal(rows[0]?.verdict, "pass");
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /暂停 10 分钟/);
    assert.match(warnings[1] ?? "", /停止取新题/);
    // 服务恢复后续跑：通过的那题跳过，其余（含错误行）补上
    const healthy = await runEval({
      ...options,
      source: fakeSource(ids).source,
      streamFn: editingStreamFn(),
    });
    assert.equal(healthy.skipped, 1);
    assert.equal(healthy.ran, 5);
    assert.equal(healthy.stopped, undefined);
    // 中间夹着成功的故障不算连续：不暂停
    const mixedOut = mkdtempSync(join(tmpdir(), "pigeon-source-out-"));
    try {
      const mixedPauses: number[] = [];
      const mixed = await runEval({
        ...options,
        outDir: mixedOut,
        source: fakeSource(["x1", "ok-2", "x2", "ok-3", "x3"]).source,
        streamFn,
        outage: {
          consecutiveFailures: 2,
          pauseMs: 1,
          maxPauses: 1,
          sleep: async (ms) => {
            mixedPauses.push(ms);
          },
          warn: () => {},
        },
      });
      assert.equal(mixed.ran, 5);
      assert.deepEqual(mixedPauses, []);
      assert.equal(mixed.stopped, undefined);
    } finally {
      rmSync(mixedOut, { recursive: true, force: true });
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("判据命令：约定的出错退出码记未判定并说明；未约定时同一退出码是失败；备料抛错记未判定并保留命令提示", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pigeon-judge-"));
  try {
    const spec = (undeterminedExitCodes?: number[]): JudgeCommand => ({
      command: exitWith(7),
      cwd,
      timeoutMs: 30_000,
      assets: ["x.patch"],
      ...(undeterminedExitCodes !== undefined ? { undeterminedExitCodes } : {}),
    });
    const declared = await runJudge(async () => spec([7]), ["hint"]);
    assert.equal(declared.verdict, "undetermined");
    assert.equal(declared.exitCode, 7);
    assert.match(declared.error ?? "", /判据自身出错（退出码 7）/);
    assert.deepEqual(declared.details, { code: 7 });
    assert.deepEqual(declared.assets, ["x.patch"]);
    const plain = await runJudge(async () => spec(), ["hint"]);
    assert.equal(plain.verdict, "fail");
    assert.equal(plain.error, undefined);
    const thrown = await runJudge(async () => {
      throw new Error("容器不在了");
    }, ["hint", "cmd"]);
    assert.equal(thrown.verdict, "undetermined");
    assert.equal(thrown.error, "容器不在了");
    assert.deepEqual(thrown.command, ["hint", "cmd"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
