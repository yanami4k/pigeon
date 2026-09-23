// 端到端：结构化记忆在容器工作区上闭环——一步首轮在题面以外的检查（类型）上变红、回炉修好，派生出一条事实；
// 下一步开局挑中它，并在容器里通过用前核验。容器以在本机执行命令的假 docker 代替，工作区是真实的 git 仓库；
// 治理根（账本）与工作区分开，与延续式跑批一致
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { buildMemoryEntries, loadStructuredMemory } from "../memory/structured-store.ts";
import { hostWorkspaceAccess } from "../memory/structured-workspace.ts";
import { materializeSession } from "../persistence/event-log.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import { runHeadless } from "./headless.ts";
import {
  edits,
  finished,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

test("容器里的结构化记忆：首轮类型检查变红、回炉修好即派生出事实；下一步开局挑中并在容器里核验通过", async () => {
  const repo = makeMemoryRepo({
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = helper;\n",
  });
  const docker = localDockerHost(repo.root);
  const governance = mkdtempSync(join(tmpdir(), "pigeon-memory-job-"));
  const placeholder = join(governance, "workspace");
  const step = (task: string, replies: FakeReply[]) =>
    runHeadless({
      task,
      governanceRoot: governance,
      workspaceRoot: placeholder,
      workspaceHost: docker.host,
      streamFn: createFakeStreamFn({ replies }),
      yolo: true,
      homeDir: repo.home,
      verify: memoryVerifyConfig(["类型"]),
      repairRounds: 2,
      structuredMemory: {},
    });
  try {
    const first = await step("以往的一步", [
      edits(["src/a.ts", "= 1;", "= 2;"], ["src/b.ts", "helper;", "helper; // TYPE_BAD:helper"]),
      finished(),
      edits(["src/b.ts", " // TYPE_BAD:helper", " // helper ok"]),
      finished("修好了"),
    ]);
    assert.deepEqual(
      [first.repair?.rounds, first.repair?.verdict, first.repair?.reverted],
      [1, "pass", false]
    );
    // 验证经执行端在容器里执行：记录里的工作区是执行端的工作区根
    const session = materializeSession(join(governance, ".pigeon", "sessions"), first.sessionId, {
      content: false,
    });
    assert.ok(session.attemptVerifieds.every((record) => record.workspace === docker.host.root));
    // 跑批器落地这一步
    repo.commit("落地");
    const facts = loadStructuredMemory(governance, {
      persist: false,
      accessFor: () => hostWorkspaceAccess(docker.host),
    }).facts;
    assert.ok(facts.length > 0, "派生出事实");
    const entries = buildMemoryEntries(facts);
    const onA = entries.find((entry) => entry.anchor === "src/a.ts");
    assert.ok(onA !== undefined, "事实挂在首轮改过的 a.ts 上");
    // 下一步：题面指到 a.ts，开局挑中这条记忆，核验在容器里读 b.ts 找得到名字 helper，放行
    const next = await step("改 src/a.ts", [finished("看过了")]);
    const nextSession = materializeSession(
      join(governance, ".pigeon", "sessions"),
      next.sessionId,
      { content: false }
    );
    assert.ok(nextSession.runStarteds[0]?.payload.structuredMemory?.opening?.includes(onA.id));
    assert.equal(nextSession.runStarteds[0]?.payload.structuredMemory?.openingBlocked, undefined);
  } finally {
    docker.cleanup();
    rmSync(governance, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    repo.cleanup();
  }
});
