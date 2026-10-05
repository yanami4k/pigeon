// 开工状态块的 git 状态来源（决策 363、354）：取不到时如实写原因，只有 git 说不是仓库时才写不是 git 仓库；
// git status 不抢索引锁（--no-optional-locks）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { sandboxStatusFacts } from "./sandbox-session.ts";
import {
  environmentText,
  GIT_STATUS_ARGS,
  gitFailure,
  gitText,
  localStatusProbe,
} from "./status-sources.ts";

// 决策 381：开工快照没带进来的文件写进环境一节（沙箱经 sandboxStatusFacts，worker 经装配层给的确知事实）
test("环境一节列出开工快照没带进来的文件与大小；没有即不写这一行", () => {
  const base = { root: "/workspace", platform: "linux" as const, remote: true, entries: [] };
  const facts = sandboxStatusFacts({
    network: "on",
    startSkipped: [{ path: "data/big.bin", bytes: 12 * 1024 * 1024 }],
  });
  assert.ok(
    environmentText({ ...base, facts }).includes("data/big.bin（12.0 MiB）"),
    environmentText({ ...base, facts })
  );
  assert.ok(
    !environmentText({ ...base, facts: sandboxStatusFacts({ network: "on" }) }).includes("没带进来")
  );
});

test("git 没有成功时按情形写原因：不是仓库、没装 git、超时、仓库属主不符、其余取报错第一行", () => {
  assert.equal(
    gitText(
      gitFailure({
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      })
    ),
    "不是 git 仓库。"
  );
  assert.match(gitText(gitFailure({ missing: true, stderr: "" })), /^取不到 git 状态：没有装 git/);
  assert.match(
    gitText(gitFailure({ timedOut: true, stderr: "" })),
    /^取不到 git 状态：git status 超过 \d+ 秒没有结束/
  );
  assert.match(
    gitText(
      gitFailure({
        stderr:
          "fatal: detected dubious ownership in repository at '/w'\nTo add an exception ...\n",
      })
    ),
    /^取不到 git 状态：仓库属主与当前用户不同，git 拒绝读取（dubious ownership/
  );
  assert.equal(
    gitText(gitFailure({ stderr: "\nfatal: index file corrupt\nmore\n" })),
    "取不到 git 状态：git 报错：fatal: index file corrupt"
  );
  assert.equal(
    gitText(gitFailure({ stderr: "" })),
    "取不到 git 状态：git status 没有成功，也没有报错输出"
  );
});

test("本机：不是仓库的目录写不是 git 仓库；git status 带 --no-optional-locks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-status-nogit-"));
  try {
    // 临时目录在某个仓库里时 git 给出该仓库的状态；不在仓库里时必须认作不是仓库，而不是取不到
    const state = await localStatusProbe(dir).gitState();
    assert.notEqual(state.kind, "unavailable", JSON.stringify(state));
    if (state.kind === "none") {
      assert.equal(gitText(state), "不是 git 仓库。");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(GIT_STATUS_ARGS.slice(0, 2), ["--no-optional-locks", "status"]);
});
