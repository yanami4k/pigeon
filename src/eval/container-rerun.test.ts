// 任务源上的回放验证（M9 第二阶段）：被验证的尝试来自 Eval 跑批、工作区在任务源的执行端里。回放照原尝试的尺子
// （温度、工作方式指令、预算、工具）在任务源重新准备的环境里重跑同一道题，经验按 085 播种、显式作为经验根装载，
// 判决用任务源的判据命令；四组交错发起、可并行，回执照常落在宿主治理根。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyCandidate } from "../application/verify-command.ts";
import { sessionsDirOf } from "../application/workspace.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { stageCandidate } from "../review/candidates.ts";
import type { AttemptRef } from "../state/attempt-ref.ts";
import { CANDIDATE_VERSION } from "../state/candidate.ts";
import { asRunId, asSessionId, newRunId, newSessionId } from "../state/ids.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import {
  createTaskSourceRerunDispatcher,
  evalTaskIdOf,
  taskSourcePlanFor,
} from "./container-rerun.ts";
import { runEval } from "./runner.ts";
import type { EvalInstance, JudgeCommand, TaskSource } from "./task-source.ts";

const ROOT = "/virtual/root";
const DIRECTIVE = "Fix the issue in the repository.";
const SKILL = "marker-skill";

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

// 假任务源：一道题，answer.txt 改成 done 即通过；记下准备与放掉的次数
function fakeSource(): { source: TaskSource; prepared: string[]; released: string[] } {
  const prepared: string[] = [];
  const released: string[] = [];
  const placeholder = mkdtempSync(join(tmpdir(), "pigeon-rerun-placeholder-"));
  const instance: EvalInstance = {
    id: "task-1",
    instructions: "把 answer.txt 改成 done",
    budget: { maxTurns: 6, wallClockMs: 60_000 },
    holdout: false,
    tags: ["fixture"],
    systemDirective: DIRECTIVE,
  };
  const source: TaskSource = {
    name: "fake",
    instances: () => [instance],
    async prepare(target, context) {
      prepared.push(`${target.id}:${context.sessionId}`);
      const files = new Map([[`${ROOT}/answer.txt`, "todo\n"]]);
      return {
        workspaceRoot: placeholder,
        host: memoryHost(files),
        judgeCommandHint: ["judge", target.id],
        async judge(): Promise<JudgeCommand> {
          const code = files.get(`${ROOT}/answer.txt`) === "done\n" ? 0 : 1;
          return {
            command: [process.execPath, "-e", `process.exit(${code})`],
            cwd: placeholder,
            timeoutMs: 30_000,
            assets: [],
          };
        },
        async release() {
          released.push(target.id);
        },
      };
    },
  };
  return { source, prepared, released };
}

// 改文件的脚本：先改 answer.txt，再收工
function editing(): StreamFn {
  return (model, context, options) => {
    const last = context.messages[context.messages.length - 1];
    return (
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
          })
    )(model, context, options);
  };
}

const idle: StreamFn = (model, context, options) =>
  createFakeStreamFn({ replies: [{ text: "我看完了，不用改" }] })(model, context, options);

function attemptRef(evalDir: string, label: "Passed" | "Failed"): AttemptRef {
  const row = JSON.parse(readFileSync(join(evalDir, "results.jsonl"), "utf8").trim()) as {
    sessionId: string;
    runId: string;
  };
  return {
    governanceRoot: evalDir,
    sessionId: asSessionId(row.sessionId),
    runId: asRunId(row.runId),
    entryRange: { from: 1, to: 2 },
    label,
  };
}

test("任务源上的回放验证：四组照原尝试的尺子在任务源重新准备的环境里重跑、任务源判分，候选只进带经验组；回执落宿主治理根", async () => {
  const host = mkdtempSync(join(tmpdir(), "pigeon-rerun-host-"));
  const failDir = mkdtempSync(join(tmpdir(), "pigeon-rerun-fail-"));
  const passDir = mkdtempSync(join(tmpdir(), "pigeon-rerun-pass-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-rerun-home-"));
  try {
    const common = {
      runs: 1,
      yolo: true,
      homeDir: home,
      editMode: "replace" as const,
      conditions: ["none"] as const,
      temperature: 0,
    };
    await runEval({ ...common, source: fakeSource().source, outDir: failDir, streamFn: idle });
    await runEval({ ...common, source: fakeSource().source, outDir: passDir, streamFn: editing() });
    const failed = attemptRef(failDir, "Failed");
    const successful = attemptRef(passDir, "Passed");
    assert.equal(evalTaskIdOf(failed), "task-1");

    const content = `---\nname: ${SKILL}\ndescription: 改 answer.txt 之前先想清楚要改成什么\n---\n把 answer.txt 改成 done\n`;
    const candidate = stageCandidate({
      governanceRoot: host,
      kind: "skill",
      name: SKILL,
      content,
      build: (facts) => ({
        version: CANDIDATE_VERSION,
        origin: "distiller",
        kind: "skill",
        name: SKILL,
        contentHash: facts.contentHash,
        bytes: facts.bytes,
        source: {
          sessionId: failed.sessionId,
          runId: failed.runId,
          producerSessionId: newSessionId(),
          entryRunSeqs: [1],
          contentDigest: "d".repeat(64),
        },
        summary: "改之前先想清楚",
        strength: 0.6,
        scan: facts.scan,
        createdAt: 1,
        contrast: { form: "lesson", successful: [successful], failed: [failed] },
      }),
    });
    if (candidate === undefined) {
      throw new Error("候选落盘失败");
    }
    const producer = newSessionId();
    const log = new JsonlEventLog(sessionsDirOf(host), producer);
    const runId = newRunId();
    log.appendCandidateProposed({ runId, candidate, model: { provider: "p", id: "m" } });
    log.close();

    // 回放用的模型：system prompt 里看得到这条经验就改文件，看不到就不改；记下每次调用的温度与 system prompt
    const seen: Array<{ temperature: unknown; systemPrompt: string }> = [];
    const rerunStream: StreamFn = (model, context, options) => {
      seen.push({
        temperature: (options as { temperature?: unknown } | undefined)?.temperature,
        systemPrompt: context.systemPrompt ?? "",
      });
      return (context.systemPrompt ?? "").includes(SKILL)
        ? editing()(model, context, options)
        : idle(model, context, options);
    };
    const reruns = fakeSource();
    const { record } = await verifyCandidate({
      governanceRoot: host,
      selector: candidate.contentHash,
      verify: { command: "任务源判据命令", timeoutMs: 1 },
      n: 3,
      concurrency: 2,
      harness: { commit: "test", dirty: false },
      planFor: taskSourcePlanFor("fake"),
      dispatcherFor: ({ nameSeed }) =>
        createTaskSourceRerunDispatcher({
          hostGovernanceRoot: host,
          source: reruns.source,
          streamFn: rerunStream,
          editMode: "replace",
          nameSeed,
          homeDir: home,
        }),
    });
    assert.equal(record.conclusion, "passed");
    assert.equal(record.runs.length, 12);
    // 回执按交错次序排列：第 1 次的四组、第 2 次的四组……
    assert.deepEqual(
      record.runs.slice(0, 4).map((run) => `${run.arm}#${run.index}`),
      ["failed-baseline#1", "failed-with#1", "successful-baseline#1", "successful-with#1"]
    );
    for (const run of record.runs) {
      assert.equal(run.verdict, run.arm.endsWith("-with") ? "pass" : "fail", run.arm);
      // 回放会话收回宿主会话目录，且带任务源判分的 eval.verified
      const session = materializeSession(sessionsDirOf(host), asSessionId(run.sessionId), {
        content: false,
      });
      assert.equal(session.evalVerifieds.at(-1)?.payload.taskId, "task-1");
      assert.equal(session.evalVerifieds.at(-1)?.payload.verdict, run.verdict);
      // 尺子沿用原尝试：温度与工作方式指令
      const started = session.runStarteds[0]?.payload;
      assert.equal(started?.model.temperature, 0);
      assert.equal(started?.taskDirective, DIRECTIVE);
      // 经验只进带经验组
      assert.equal(
        started?.skills.some((skill) => skill.name === SKILL),
        run.arm.endsWith("-with"),
        run.arm
      );
      assert.ok(run.governanceRoot.startsWith(join(host, ".pigeon", "reruns")));
    }
    assert.ok(seen.length >= 12);
    assert.ok(seen.every((call) => call.temperature === 0));
    assert.ok(seen.every((call) => call.systemPrompt.endsWith(DIRECTIVE)));
    // 每次回放都由任务源重新准备环境并放掉
    assert.equal(reruns.prepared.length, 12);
    assert.equal(reruns.released.length, 12);
    assert.deepEqual(record.environment.harness, { commit: "test", dirty: false });
    assert.equal(existsSync(join(host, ".pigeon", "sessions")), true);
  } finally {
    for (const dir of [host, failDir, passDir, home]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
