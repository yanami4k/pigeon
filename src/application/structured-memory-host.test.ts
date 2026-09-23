// 结构化记忆经执行端访问工作区（工作区在容器里）：派生里的工作区查询、开局挑选与核验都经执行端在"容器"里做，
// 与本地访问得出同样的结论。容器以在本机执行命令的假 docker 代替，工作区是真实的 git 仓库
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { buildMemoryEntries, loadStructuredMemory } from "../memory/structured-store.ts";
import {
  hostWorkspaceAccess,
  StructuredMemoryGitTimeoutError,
} from "../memory/structured-workspace.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runHeadless } from "./headless.ts";
import { createStructuredMemoryPush } from "./structured-memory.ts";
import {
  edits,
  finished,
  makeMemoryRepo,
  memoryVerifyConfig,
} from "./structured-memory-fixtures.ts";

const SUBDIR_FILES = {
  "strands-py/src/pkg/mod.py": "VALUE = 1  # VALUE_OK\n",
  "strands-py/tests/test_mod.py":
    "# FAILS_UNLESS src/pkg/mod.py VALUE_OK test_value\ndef test_value():\n    pass\n",
};

// 以往的一步：pytest 步骤在 strands-py 下失败、回炉一轮修好，派生出一条事实
async function history() {
  const repo = makeMemoryRepo(SUBDIR_FILES);
  await runHeadless({
    task: "以往的一步",
    governanceRoot: repo.root,
    workspaceRoot: repo.root,
    streamFn: createFakeStreamFn({
      replies: [
        edits(["strands-py/src/pkg/mod.py", "  # VALUE_OK", ""]),
        finished(),
        edits(["strands-py/src/pkg/mod.py", "VALUE = 1", "VALUE = 1  # VALUE_OK again"]),
        finished("修好了"),
      ],
    }),
    yolo: true,
    homeDir: repo.home,
    verify: memoryVerifyConfig([{ name: "子测试", cwd: "strands-py" }]),
    repairRounds: 2,
  });
  repo.commit("落地");
  return repo;
}

test("经执行端派生：开工时的脏文件、快照间的改动、题面文件都在容器里查，与本地访问得出同样的事实", async () => {
  const repo = await history();
  const docker = localDockerHost(repo.root);
  try {
    const local = loadStructuredMemory(repo.root, { persist: false }).facts;
    assert.equal(local.length, 1);
    // 经执行端的 git 调用计数：派生确实在"容器"里查了开工时的脏文件等
    const gitCalls: string[] = [];
    const viaHost = loadStructuredMemory(repo.root, {
      persist: false,
      accessFor: () => {
        const access = hostWorkspaceAccess(docker.host);
        return {
          ...access,
          git: (args) => {
            gitCalls.push(args[0] ?? "");
            return access.git(args);
          },
        };
      },
    }).facts;
    assert.deepEqual(viaHost, local);
    assert.ok(gitCalls.includes("diff-tree"), "开工时的脏文件经执行端查");
  } finally {
    docker.cleanup();
    repo.cleanup();
  }
});

test("经执行端挑选与核验：开局按题面挑中、核验在容器里读文件通过；名字从报错所在文件里消失即被拦下", async () => {
  const repo = await history();
  const docker = localDockerHost(repo.root);
  const placeholder = mkdtempSync(join(tmpdir(), "pigeon-memory-placeholder-"));
  try {
    const entries = buildMemoryEntries(loadStructuredMemory(repo.root).facts);
    const onModule = entries.find((entry) => entry.anchor === "strands-py/src/pkg/mod.py");
    assert.ok(onModule !== undefined);
    const push = () =>
      createStructuredMemoryPush({
        governanceRoot: repo.root,
        workspaceRoot: placeholder,
        workspaceHost: docker.host,
        sessionId: newSessionId(),
        options: {},
      }).opening("修改 strands-py/src/pkg/mod.py");
    assert.deepEqual(push().manifest.opening, [onModule.id]);
    // 名字 test_value 从报错所在的测试文件里消失：核验在容器里读到新内容，拦下
    repo.write("strands-py/tests/test_mod.py", "def test_other():\n    pass\n");
    repo.commit("改写测试");
    const blocked = push();
    assert.deepEqual(blocked.manifest.opening, []);
    assert.deepEqual(blocked.manifest.openingBlocked, [onModule.id]);
  } finally {
    docker.cleanup();
    rmSync(placeholder, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("执行端探针：文件在不在、读文件、受跟踪清单、改名追踪都在容器里做；git 超时抛超时错误", () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-memory-host-probe-"));
  const repo = makeMemoryRepo({ "src/old.ts": "export const x = 1;\n" });
  const docker = localDockerHost(repo.root);
  try {
    const before = Date.now() - 5_000;
    repo.git(["mv", "src/old.ts", "src/new.ts"]);
    repo.commit("改名");
    mkdirSync(join(base, "x"));
    writeFileSync(join(repo.root, "untracked.txt"), "u\n");
    const probe = hostWorkspaceAccess(docker.host).probe();
    assert.equal(probe.exists("src/new.ts"), true);
    assert.equal(probe.exists("src/old.ts"), false);
    assert.equal(probe.read("src/new.ts"), "export const x = 1;\n");
    assert.equal(probe.read("src/old.ts"), undefined);
    assert.ok(probe.tracked().has("src/new.ts"));
    assert.ok(!probe.tracked().has("untracked.txt"));
    assert.equal(probe.renamedSince("src/old.ts", before), "src/new.ts");
    assert.equal(hostWorkspaceAccess(docker.host).present(), true);
    assert.throws(
      () => hostWorkspaceAccess(docker.host, 1).git(["log"]),
      StructuredMemoryGitTimeoutError
    );
  } finally {
    docker.cleanup();
    repo.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});
