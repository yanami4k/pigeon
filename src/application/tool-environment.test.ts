// 按环境只注册用得上的工具（决策 359）：以 git 工作区、PATH 里有 docker、有历史会话、有搜索后端为基准，每样缺一即不注册对应的
// 工具，原因记进 Run 开始条目；检查结果随开局冻结的内容沿用到 /reload（一次会话内工具清单固定）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionFileName } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { buildRuntime, type FrozenSessionPrompt } from "./runtime.ts";
import { ScriptGate } from "./script-naming.ts";
import { ScriptSlot } from "./script-tool.ts";
import { SpawnWorkerSlot } from "./spawn-worker-tool.ts";
import type { WebToolsConfig } from "./web-tools.ts";

const SPAWN_GROUP = [
  "spawn_worker",
  "wait_workers",
  "worker_status",
  "message_worker",
  "stop_worker",
  "take_worker",
];
const SESSION_TOOLS = ["search_sessions", "read_session_entry", "list_sessions"];

interface Environment {
  git: boolean;
  docker: boolean;
  history: boolean;
  key: boolean;
}

const ALL: Environment = { git: true, docker: true, history: true, key: true };

// 按给定环境装一个主会话运行面并跑一轮，交回广告的工具、Run 开始条目记的没注册的工具与冻结内容
async function assemble(environment: Environment, frozenPrompt?: FrozenSessionPrompt) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tool-env-"));
  const bin = mkdtempSync(join(tmpdir(), "pigeon-tool-env-bin-"));
  try {
    if (environment.git) {
      execFileSync("git", ["init", "-q"], { cwd: root });
    }
    if (environment.docker) {
      const docker = join(bin, process.platform === "win32" ? "docker.exe" : "docker");
      writeFileSync(docker, "");
      chmodSync(docker, 0o755);
    }
    if (environment.history) {
      const earlier = join(sessionsDirOf(root), "earlier");
      mkdirSync(earlier, { recursive: true });
      writeFileSync(join(earlier, sessionFileName(Date.now() - 60_000, newSessionId())), "");
    }
    const webTools: WebToolsConfig = {
      search: environment.key
        ? {
            backend: {
              id: "fake",
              search: async () => ({ backend: "fake", query: "", results: [] }),
            },
            defaultMaxResults: 5,
          }
        : { unavailable: "没配 key", defaultMaxResults: 5 },
      fetch: { timeoutMs: 1000, maxBytes: 1000, maxChars: 1000 },
      distillMaxTokens: 100,
    };
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
      webTools,
      env: { PATH: bin },
      ...(frozenPrompt !== undefined ? { frozenPrompt } : {}),
    });
    let advertised: readonly string[];
    try {
      advertised = bundle.adapter.snapshot().tools.advertised;
      await bundle.adapter.run("你好");
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    const start = loadStoreSession(sessionsDirOf(root), sessionId)?.view.runs[0]?.start;
    const skipped = (start?.skippedTools ?? []).flatMap((entry) => entry.tools);
    return { advertised, skipped, frozen: bundle.frozenPrompt };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

function registered(advertised: readonly string[], tools: readonly string[]): boolean[] {
  return tools.map((tool) => advertised.includes(tool));
}

test("环境齐全：各组工具都注册，Run 开始条目不记没注册的工具", async () => {
  const { advertised, skipped } = await assemble(ALL);
  for (const tool of [...SPAWN_GROUP, "orchestrate", "web_search", "web_fetch", ...SESSION_TOOLS]) {
    assert.ok(advertised.includes(tool), tool);
  }
  assert.deepEqual(skipped, []);
});

test("PATH 里找不到 docker：不注册 orchestrate，派 worker 那一组照常", async () => {
  const { advertised, skipped } = await assemble({ ...ALL, docker: false });
  assert.ok(!advertised.includes("orchestrate"));
  assert.ok(advertised.includes("spawn_worker"));
  assert.deepEqual(skipped, ["orchestrate"]);
});

test("工作区不是 git 仓库：派 worker 那一组与 orchestrate 都不注册", async () => {
  const { advertised, skipped } = await assemble({ ...ALL, git: false });
  assert.deepEqual(registered(advertised, [...SPAWN_GROUP, "orchestrate"]), Array(7).fill(false));
  assert.deepEqual([...skipped].sort(), [...SPAWN_GROUP, "orchestrate"].sort());
});

test("没有搜索用的 key：不注册 web_search，web_fetch 照常", async () => {
  const { advertised, skipped } = await assemble({ ...ALL, key: false });
  assert.deepEqual(registered(advertised, ["web_search", "web_fetch"]), [false, true]);
  assert.deepEqual(skipped, ["web_search"]);
});

test("本项目没有历史会话：会话检索三件都不注册", async () => {
  const { advertised, skipped } = await assemble({ ...ALL, history: false });
  assert.deepEqual(registered(advertised, SESSION_TOOLS), [false, false, false]);
  assert.deepEqual(skipped, SESSION_TOOLS);
});

test("一次会话内工具清单固定：/reload 沿用开局的检查结果，环境中途变了也不改", async () => {
  const first = await assemble({ ...ALL, docker: false });
  const reloaded = await assemble(ALL, first.frozen);
  assert.ok(!reloaded.advertised.includes("orchestrate"));
  assert.deepEqual(reloaded.skipped, ["orchestrate"]);
});
