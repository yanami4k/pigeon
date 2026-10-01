// 容器执行端的装配护栏（112 的延伸）：注入了非本地执行端时，workspaceRoot 在宿主一侧、不是 agent 干活的工作区。
// 会分叉的会话（失败自动重试、分支会话）要在 workspaceRoot 上打 git 快照——对执行端另一侧的工作区只会得到假结果，
// 故装配前一律拒绝，且不写任何账本；本地工作区照常。会话级验证命令经执行端在它的工作区里执行（日常沙箱，决策 237）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import { asWorkspaceHost } from "../tools/local-host.ts";
import { runHeadless } from "./headless.ts";

test("容器执行端不与分叉重试、分支会话同用：装配前拒绝、不写账本；会话验证命令经执行端执行；不带执行端时照常", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-guard-gov-"));
  const placeholder = mkdtempSync(join(tmpdir(), "pigeon-guard-ws-"));
  const remote = mkdtempSync(join(tmpdir(), "pigeon-guard-remote-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-guard-home-"));
  try {
    // 执行端本身是什么不重要：注入即视为非本地（与 112 的判定一致）；它的工作区与宿主一侧的 workspaceRoot 不是同一处
    const host = asWorkspaceHost(remote);
    writeFileSync(join(remote, "only-remote.txt"), "x");
    const base = {
      task: "什么也不用做",
      governanceRoot: governance,
      workspaceRoot: placeholder,
      workspaceHost: host,
      streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
      yolo: true,
      homeDir: home,
    };
    const combos = [
      ["retryOnFail", { retryOnFail: 1 }, /分叉重试/],
      ["branchHeader", { branchHeader: {} as BranchHeaderInput }, /分支会话/],
    ] as const;
    for (const [name, extra, reason] of combos) {
      await assert.rejects(
        runHeadless({ ...base, ...extra }),
        (error: Error) => /容器工作区/.test(error.message) && reason.test(error.message),
        name
      );
    }
    assert.equal(
      existsSync(join(governance, ".pigeon", "state", "sessions")),
      false,
      "被拒的装配不写账本"
    );
    // 会话验证命令经执行端在它的工作区里执行：文件只在执行端一侧，能通过即证明不在宿主一侧执行
    const verified = await runHeadless({
      ...base,
      verify: { command: "test -f only-remote.txt", timeoutMs: 5000 },
    });
    assert.equal(verified.status, "completed");
    assert.equal(verified.verification?.verdict, "pass");
    // 对照：不带执行端（本地工作区）时，验证命令照常跑并落结论
    const { workspaceHost: _host, ...local } = base;
    const result = await runHeadless({ ...local, verify: { command: "exit 0", timeoutMs: 5000 } });
    assert.equal(result.status, "completed");
    assert.equal(result.verification?.verdict, "pass");
  } finally {
    rmSync(governance, { recursive: true, force: true });
    rmSync(placeholder, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
