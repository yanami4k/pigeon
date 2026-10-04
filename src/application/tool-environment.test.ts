// 按环境只注册用得上的工具（决策 359）：每样环境缺一即不注册对应的工具并记进 Run 开始条目；/reload 沿用开局的检查结果。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionFileName } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { buildRuntime, disposeRuntime, type FrozenSessionPrompt } from "./runtime.ts";
import { ScriptGate } from "./script-naming.ts";
import { ScriptSlot } from "./script-tool.ts";
import { SpawnWorkerSlot } from "./spawn-worker-tool.ts";

const SPAWN =
  "spawn_worker wait_workers worker_status message_worker stop_worker take_worker".split(" ");
const SESSIONS = ["search_sessions", "read_session_entry", "list_sessions"];
const TOOLS = [...SPAWN, "orchestrate", "web_search", "web_fetch", ...SESSIONS];
const ALL = { git: true, docker: true, history: true, key: true };
const DOCKER = process.platform === "win32" ? "docker.exe" : "docker";
const backend = { id: "fake", search: async () => ({ backend: "fake", query: "", results: [] }) };

// 按给定环境装一个主会话运行面并跑一轮，交回广告的工具、Run 开始条目记的没注册的工具与冻结内容
async function assemble(env: typeof ALL, frozenPrompt?: FrozenSessionPrompt) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tool-env-"));
  const bin = mkdtempSync(join(tmpdir(), "pigeon-tool-env-bin-"));
  try {
    if (env.git) execFileSync("git", ["init", "-q"], { cwd: root });
    if (env.docker) writeFileSync(join(bin, DOCKER), "", { mode: 0o755 });
    if (env.history) {
      mkdirSync(join(sessionsDirOf(root), "earlier"), { recursive: true });
      writeFileSync(join(sessionsDirOf(root), "earlier", sessionFileName(1, newSessionId())), "");
    }
    const sessionId = newSessionId();
    const bundle = buildRuntime({
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
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
    const start = loadStoreSession(sessionsDirOf(root), sessionId)?.view.runs[0]?.start;
    const skipped = (start?.skippedTools ?? []).flatMap((entry) => entry.tools).sort();
    return { advertised, skipped, frozen: bundle.frozenPrompt };
  } finally {
    for (const dir of [root, bin]) rmSync(dir, { recursive: true, force: true });
  }
}

const CASES: Array<[string, Partial<typeof ALL>, string[]]> = [
  ["缺 docker：不注册 orchestrate", { docker: false }, ["orchestrate"]],
  ["不是 git 仓库：不注册派 worker 一组与 orchestrate", { git: false }, [...SPAWN, "orchestrate"]],
  ["缺搜索 key：不注册 web_search", { key: false }, ["web_search"]],
  ["没有历史会话：不注册会话检索三件", { history: false }, SESSIONS],
];

for (const [label, lacking, missing] of CASES) {
  test(`按环境注册——${label}，没注册的记进 Run 开始条目`, async () => {
    const { advertised, skipped } = await assemble({ ...ALL, ...lacking });
    const absent = TOOLS.filter((tool) => !advertised.includes(tool)).sort();
    assert.deepEqual([absent, skipped], [[...missing].sort(), [...missing].sort()]);
  });
}

test("一次会话内工具清单固定：/reload 沿用开局的检查结果，环境中途变了也不改", async () => {
  const first = await assemble({ ...ALL, docker: false });
  assert.deepEqual((await assemble(ALL, first.frozen)).skipped, ["orchestrate"]);
});
