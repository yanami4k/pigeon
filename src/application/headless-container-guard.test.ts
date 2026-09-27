// 容器执行端的装配护栏（112 的延伸）：注入了非本地执行端时，workspaceRoot 只是宿主侧的占位目录。
// 会分叉的会话（失败自动重试、分支会话）要在 workspaceRoot 上打 git 快照，会话级验证命令要在 workspaceRoot 里执行——
// 在占位目录上做这些只会得到假结果，故装配前一律拒绝，且不写任何账本；本地工作区照常。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import { asWorkspaceHost } from "../tools/local-host.ts";
import { runHeadless } from "./headless.ts";

test("容器执行端不与分叉重试、会话验证命令、分支会话同用：装配前拒绝、不写账本；不带执行端时同样的配置照常", async () => {
  const governance = mkdtempSync(join(tmpdir(), "pigeon-guard-gov-"));
  const placeholder = mkdtempSync(join(tmpdir(), "pigeon-guard-ws-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-guard-home-"));
  try {
    // 执行端本身是什么不重要：注入即视为非本地（与 112 的判定一致）
    const host = asWorkspaceHost(placeholder);
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
      ["verify", { verify: { command: "exit 0", timeoutMs: 1000 } }, /会话验证命令/],
      ["branchHeader", { branchHeader: {} as BranchHeaderInput }, /分支会话/],
    ] as const;
    for (const [name, extra, reason] of combos) {
      await assert.rejects(
        runHeadless({ ...base, ...extra }),
        (error: Error) => /容器工作区/.test(error.message) && reason.test(error.message),
        name
      );
    }
    assert.equal(existsSync(join(governance, ".pigeon", "sessions")), false, "被拒的装配不写账本");
    // 对照：不带执行端（本地工作区）时，验证命令照常跑并落结论
    const { workspaceHost: _host, ...local } = base;
    const result = await runHeadless({ ...local, verify: { command: "exit 0", timeoutMs: 5000 } });
    assert.equal(result.status, "completed");
    assert.equal(result.verification?.verdict, "pass");
  } finally {
    rmSync(governance, { recursive: true, force: true });
    rmSync(placeholder, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
