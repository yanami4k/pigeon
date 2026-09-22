// 采样参数的保真（决策 087 修订、110）：回放与分叉重试必须沿用原尝试的采样温度与工作方式指令。
// 同一个模型换一个温度就是换了尺子——087 修订说"日后新增同类维度按本条推定"，温度与工作方式指令都属于这一类。
// 失效判定的封闭清单（091）本轮不纳入温度，是已知缺口，见审计。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { swebenchTemperature } from "../eval/swebench-source.ts";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { resolveAttemptPlan } from "../replay/plan.ts";
import type { ObservationInput } from "../state/event-log.ts";
import { newRunId, newSessionId } from "../state/ids.ts";
import { runHeadless } from "./headless.ts";
import type { McpSession } from "./mcp.ts";
import { rerunSamplingOf, verifierRuntimeDeps } from "./rerun.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

type RunStartedPayload = Extract<ObservationInput, { kind: "run.started" }>["payload"];

function attemptWith(
  dir: string,
  model: RunStartedPayload["model"],
  extra: Partial<RunStartedPayload>
) {
  const sessionId = newSessionId();
  const runId = newRunId();
  const log = new JsonlEventLog(dir, sessionId);
  log.appendObservation({
    kind: "run.started",
    runId,
    payload: {
      model,
      policy: { allow: ["read_file"], deny: [], approvalMode: "yolo" },
      advertisedTools: ["read_file"],
      systemPromptHash: "b".repeat(64),
      memory: [],
      skills: [],
      budget: { maxTurns: 5, wallClockMs: 60_000 },
      ...extra,
    },
  });
  log.appendEntry({ runId, runSeq: 1, role: "user", message: { role: "user", content: "修好它" } });
  log.close();
  return { sessionId, runId };
}

test("回放计划：从原尝试的 run.started 取出温度与工作方式指令；原尝试没设就不带", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-sampling-plan-"));
  try {
    const set = attemptWith(
      dir,
      { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
      { taskDirective: "Your task is to fix the issue." }
    );
    const plan = resolveAttemptPlan({ sessionsDir: dir, ...set, startCommit: "a".repeat(40) });
    assert.equal(plan.model.temperature, 0);
    assert.equal(plan.taskDirective, "Your task is to fix the issue.");

    const unset = attemptWith(dir, { provider: "p", id: "m", thinkingLevel: "off" }, {});
    const plain = resolveAttemptPlan({ sessionsDir: dir, ...unset, startCommit: "a".repeat(40) });
    assert.equal("temperature" in plain.model, false);
    assert.equal("taskDirective" in plain, false);

    // 推理开启时温度没有生效：计划带上当时请求的值，回放照原样请求（同档位下同样不生效）
    const ignored = attemptWith(
      dir,
      {
        provider: "p",
        id: "m",
        thinkingLevel: "high",
        temperatureIgnored: { requested: 0.3, reason: "reasoning-enabled" },
      },
      {}
    );
    const again = resolveAttemptPlan({ sessionsDir: dir, ...ignored, startCommit: "a".repeat(40) });
    assert.equal(again.model.temperature, 0.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("验证器运行面：计划里的温度与工作方式指令原样传下去；计划里没有就不设", () => {
  const streamFn = createFakeStreamFn({ replies: [{ text: "ok" }] });
  const deps = verifierRuntimeDeps({
    model: { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
    taskDirective: "Your task is to fix the issue.",
    streamFn,
    persistThinking: true,
  });
  assert.equal(deps.temperature, 0);
  assert.equal(deps.taskDirective, "Your task is to fix the issue.");
  const plain = verifierRuntimeDeps({
    model: { provider: "p", id: "m", thinkingLevel: "off" },
    streamFn,
    persistThinking: true,
  });
  assert.equal("temperature" in plain, false);
  assert.equal("taskDirective" in plain, false);
});

test("回放派发器交给验证器运行面的是计划里的整组采样参数：模型参数与工作方式指令一起，缺哪样就不带哪样", () => {
  const base = {
    sessionId: newSessionId(),
    runId: newRunId(),
    task: "t",
    startCommit: "a".repeat(40),
    startSource: "given" as const,
    budget: { maxTurns: 1 },
    budgetSource: "run-started" as const,
    approvalMode: "yolo" as const,
    tools: [],
  };
  assert.deepEqual(
    rerunSamplingOf({
      ...base,
      model: { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
      taskDirective: "D",
    }),
    {
      model: { provider: "p", id: "m", thinkingLevel: "off", temperature: 0 },
      taskDirective: "D",
    }
  );
  assert.deepEqual(rerunSamplingOf({ ...base, model: { provider: "p", id: "m" } }), {
    model: { provider: "p", id: "m" },
  });
});

test("外部基准的采样温度缺省固定为 0；显式给出的值原样沿用", () => {
  assert.equal(swebenchTemperature(undefined), 0);
  assert.equal(swebenchTemperature(0.4), 0.4);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("分叉重试沿用来源尝试的温度与工作方式指令：重试那次的调用选项与 run.started 与来源尝试一致", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-sampling-fork-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-sampling-fork-home-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "pigeon@example.invalid"]);
    git(dir, ["config", "user.name", "pigeon-test"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
    writeFileSync(join(dir, "a.txt"), "old\n");
    writeFileSync(
      join(dir, "check.mjs"),
      'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("a.txt", "utf8") === "new\\n" ? 0 : 1);\n'
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    const edit = (content: string) => ({
      text: "改",
      toolCalls: [
        { name: "edit_file", args: { path: "a.txt", old_string: "old\n", new_string: content } },
      ],
    });
    const fake = createFakeStreamFn({
      replies: [edit("wrong\n"), { text: "改好了" }, edit("new\n"), { text: "这次对了" }],
    });
    const calls: Array<{ temperature: unknown; systemPrompt: string }> = [];
    const streamFn: StreamFn = (model, context, options) => {
      calls.push({
        temperature: (options as { temperature?: unknown } | undefined)?.temperature,
        systemPrompt: context.systemPrompt ?? "",
      });
      return fake(model, context, options);
    };
    const directive = "Your task is to make a.txt read new.";
    const result = await runHeadless({
      task: "把 a.txt 改成 new",
      governanceRoot: dir,
      workspaceRoot: dir,
      streamFn,
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      verify: { command: `"${process.execPath}" check.mjs`, timeoutMs: 30_000 },
      retryOnFail: 1,
      temperature: 0,
      taskDirective: directive,
    });
    assert.equal(result.retries?.length, 1);
    const branchId = result.retries?.[0]?.branchSessionId;
    assert.ok(branchId !== undefined);
    // 来源尝试两轮、重试两轮：每一次调用都带温度 0 与同一句指令
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.temperature, 0);
      assert.ok(call.systemPrompt.endsWith(directive));
    }
    const branch = materializeSession(join(dir, ".pigeon", "sessions"), branchId);
    assert.equal(branch.runStarteds[0]?.payload.model.temperature, 0);
    assert.equal(branch.runStarteds[0]?.payload.taskDirective, directive);
  } finally {
    try {
      git(dir, ["worktree", "prune"]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
