// 按环境只注册用得上的工具（决策 359）：每样环境缺一即不注册对应的工具并记进 Run 开始条目；/reload 沿用开局的检查结果。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { sessionFileName } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  buildRuntime,
  disposeRuntime,
  type FrozenSessionPrompt,
  WEB_FETCH_SENTENCE,
  WEB_TOOLS_SENTENCE,
} from "./runtime.ts";
import { ScriptGate } from "./script-naming.ts";
import { ScriptSlot } from "./script-tool.ts";
import { SpawnWorkerSlot } from "./spawn-worker-tool.ts";
import { statusTextOf } from "./status-fixtures.ts";

const SPAWN =
  "spawn_worker wait_workers worker_status message_worker stop_worker take_worker".split(" ");
const SESSIONS = ["search_sessions", "read_session_entry", "list_sessions"];
const TOOLS = [...SPAWN, "orchestrate", "web_search", "web_fetch", ...SESSIONS];
// history：other 为会话树外有会话，family 为只有本会话派出的子会话，empty 为只有空的会话文件
const ALL = {
  git: true,
  docker: true,
  history: "other" as "other" | "family" | "empty",
  key: true,
};
const DOCKER = process.platform === "win32" ? "docker.exe" : "docker";
const backend = { id: "fake", search: async () => ({ backend: "fake", query: "", results: [] }) };

// 按给定环境装一个主会话运行面并跑一轮，交回广告的工具、Run 开始条目的没注册记录、开工状态块（决策 363：联网的说法在它的
// 联网一节）与冻结内容
async function assemble(env: typeof ALL, frozenPrompt?: FrozenSessionPrompt) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tool-env-"));
  const bin = mkdtempSync(join(tmpdir(), "pigeon-tool-env-bin-"));
  try {
    if (env.git) execFileSync("git", ["init", "-q"], { cwd: root });
    if (env.docker) writeFileSync(join(bin, DOCKER), "", { mode: 0o755 });
    const sessionId = newSessionId();
    const earlier = newSessionId();
    const parent = env.history === "family" ? { parentSessionId: sessionId } : {};
    const header = { kind: "header", version: 4, id: earlier, createdAt: 1, cwd: root, ...parent };
    mkdirSync(join(sessionsDirOf(root), "earlier"), { recursive: true });
    writeFileSync(
      join(sessionsDirOf(root), "earlier", sessionFileName(1, earlier)),
      env.history === "empty" ? "" : `${JSON.stringify(header)}\n`
    );
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      spawnWorker: new SpawnWorkerSlot(),
      scriptOrchestration: new ScriptSlot(new ScriptGate({ modelDecides: true })),
      webTools: {
        search: env.key
          ? { backend, defaultMaxResults: 5 }
          : { unavailable: "缺 key", defaultMaxResults: 5 },
        fetch: { timeoutMs: 1000, maxBytes: 1000, maxChars: 1000 },
        distillMaxTokens: 100,
      },
      env: { PATH: bin },
      ...(frozenPrompt !== undefined ? { frozenPrompt } : {}),
    });
    const advertised = bundle.adapter.snapshot().tools.advertised;
    await bundle.adapter.run("你好").finally(() => disposeRuntime(bundle));
    const tools = (streamFn.calls[0]?.context.tools ?? []) as Array<{
      name: string;
      description: string;
    }>;
    return {
      absent: TOOLS.filter((tool) => !advertised.includes(tool)).sort(),
      skipped: loadStoreSession(sessionsDirOf(root), sessionId)?.view.runs[0]?.start.skippedTools,
      status: statusTextOf(streamFn.calls[0]),
      spawnText: tools.find((tool) => tool.name === "spawn_worker")?.description ?? "",
      notice: bundle.toolsNotice,
      frozen: bundle.frozenPrompt,
    };
  } finally {
    for (const dir of [root, bin]) rmSync(dir, { recursive: true, force: true });
  }
}

const CASES: Array<[string, Partial<typeof ALL>, string[]]> = [
  ["环境齐全：各组都注册、不带没注册的记录", {}, []],
  ["缺 docker：不注册 orchestrate", { docker: false }, ["orchestrate"]],
  ["不是 git 仓库：不注册派 worker 一组与 orchestrate", { git: false }, [...SPAWN, "orchestrate"]],
  [
    "缺搜索 key：不注册 web_search，提示换成 web_fetch 那句并在终端提示",
    { key: false },
    ["web_search"],
  ],
  ["只有本会话派出的子会话：不注册会话检索三件", { history: "family" }, SESSIONS],
  ["只有空的会话文件：不注册会话检索三件", { history: "empty" }, SESSIONS],
];

for (const [label, lacking, missing] of CASES) {
  test(`按环境注册——${label}`, async () => {
    const got = await assemble({ ...ALL, ...lacking });
    const recorded = got.skipped?.flatMap((entry) => entry.tools).sort();
    assert.deepEqual(
      [got.absent, recorded],
      [[...missing].sort(), missing.length > 0 ? [...missing].sort() : undefined]
    );
    const web = !missing.includes("web_search");
    assert.deepEqual(
      [
        got.status.includes(WEB_TOOLS_SENTENCE),
        got.status.includes(WEB_FETCH_SENTENCE),
        got.notice !== undefined,
      ],
      [web, !web, !web]
    );
    assert.equal(got.spawnText.includes("web_search"), web && !missing.includes("spawn_worker"));
  });
}

test("一次会话内工具清单固定：/reload 沿用开局的检查结果，搜索后端改了只提示重启后生效", async () => {
  const first = await assemble({ ...ALL, docker: false, key: false });
  const reloaded = await assemble(ALL, first.frozen);
  assert.deepEqual(
    [reloaded.absent, reloaded.notice !== undefined],
    [["orchestrate", "web_search"], true]
  );
});

test("治理根与工作区根分开（--governance-root）时，git 工作区探针看工作区根：工作区是 git 仓库、治理根不是，派 worker 一组与 orchestrate 照注册", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pigeon-tool-env-ws-"));
  const gov = mkdtempSync(join(tmpdir(), "pigeon-tool-env-gov-"));
  const bin = mkdtempSync(join(tmpdir(), "pigeon-tool-env-bin-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    writeFileSync(join(bin, DOCKER), "", { mode: 0o755 });
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: workspace,
      governanceRoot: gov,
      homeDir: workspace,
      sessionId: newSessionId(),
      yolo: true,
      provider: "fake-provider",
      modelId: "fake-model-1",
      spawnWorker: new SpawnWorkerSlot(),
      scriptOrchestration: new ScriptSlot(new ScriptGate({ modelDecides: true })),
      webTools: {
        search: { backend, defaultMaxResults: 5 },
        fetch: { timeoutMs: 1000, maxBytes: 1000, maxChars: 1000 },
        distillMaxTokens: 100,
      },
      env: { PATH: bin },
    });
    const advertised = bundle.adapter.snapshot().tools.advertised;
    await bundle.adapter.run("你好").finally(() => disposeRuntime(bundle));
    for (const tool of [...SPAWN, "orchestrate"]) {
      assert.ok(advertised.includes(tool), `${tool} 应注册`);
    }
  } finally {
    for (const dir of [workspace, gov, bin]) rmSync(dir, { recursive: true, force: true });
  }
});
