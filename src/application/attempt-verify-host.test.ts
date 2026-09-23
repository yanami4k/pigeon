// 验证经执行端执行（工作区在容器里）：分步配置各步在容器工作区里按各自的 cwd 执行、各出结论；单条命令同样经执行端。
// 容器以在本机执行命令的假 docker 代替
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import type { AttemptVerifiedInput, AttemptVerifiedRecord } from "../state/event-log.ts";
import { verifyAttempt } from "./attempt-verify.ts";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "pigeon-verify-host-"));
  const root = join(base, "testbed");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "sub", "marker"), "m\n");
  const docker = localDockerHost(root);
  const records: AttemptVerifiedInput[] = [];
  const sink = {
    appendAttemptVerified: (input: AttemptVerifiedInput) => {
      records.push(input);
      return input as unknown as AttemptVerifiedRecord;
    },
  };
  return {
    ...docker,
    records,
    sink,
    cleanup: () => {
      docker.cleanup();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const target = { sessionId: "sess_x" as never, runId: "run_x" as never };

test("经执行端验证：分步配置各步在容器工作区里按各自的 cwd 执行、各出结论，记录里的工作区是执行端的工作区根", async () => {
  const s = setup();
  try {
    const result = await verifyAttempt({
      config: {
        command: "（分步）",
        timeoutMs: 30_000,
        steps: [
          { name: "根目录", command: "test -f a.txt" },
          { name: "子目录", command: "test -f marker && echo in-sub", cwd: "sub" },
          { name: "失败", command: "echo broken && exit 3" },
        ],
      },
      workspace: s.host.root,
      host: s.host,
      target,
      sink: s.sink,
    });
    assert.deepEqual(
      result.steps?.map((step) => [step.name, step.verdict, step.exitCode]),
      [
        ["根目录", "pass", 0],
        ["子目录", "pass", 0],
        ["失败", "fail", 3],
      ]
    );
    assert.match(result.steps?.[1]?.output ?? "", /in-sub/);
    assert.equal(result.outcome.verdict, "fail");
    assert.equal(s.records[0]?.workspace, s.host.root);
  } finally {
    s.cleanup();
  }
});

test("经执行端验证：单条命令的配置同样在容器工作区里执行", async () => {
  const s = setup();
  try {
    const passing = await verifyAttempt({
      config: { command: "test -f a.txt && test -f sub/marker", timeoutMs: 30_000 },
      workspace: s.host.root,
      host: s.host,
      target,
      sink: s.sink,
    });
    assert.equal(passing.outcome.verdict, "pass");
    const failing = await verifyAttempt({
      config: { command: "test -f nope.txt", timeoutMs: 30_000 },
      workspace: s.host.root,
      host: s.host,
      target,
      sink: s.sink,
    });
    assert.equal(failing.outcome.verdict, "fail");
  } finally {
    s.cleanup();
  }
});
