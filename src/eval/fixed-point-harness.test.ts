// 定点对照一致性核对补的三项（决策 156）：harness 代码只许差在定点对照自己的文件上；验证分步与原尝试相同；镜像与无记忆整流的身份头相同
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertHarnessMatches,
  HarnessMismatchError,
  harnessViolations,
  normalizeForBehavior,
} from "./fixed-point-harness.ts";
import {
  assertSameImage,
  assertSameVerifySteps,
  FidelityRejectedError,
} from "./fixed-point-rerun.ts";
import { identityDigest, type StreamRunIdentity } from "./stream-identity.ts";

const RUNNER = [
  'import { a } from "./a.ts";',
  "// 跑一步",
  "interface Input { memory: boolean }",
  "function run(input: Input): string {",
  '  return input.memory ? "on" : "off";',
  "}",
  "",
].join("\n");

test("harness 核对：只差类型、export、注释、定点对照的标记段与 import 的，按运行行为视为相同", () => {
  const changed = [
    'import { a } from "./a.ts";',
    'import { fixed } from "./fixed-point-rerun.ts";',
    "// 跑一步（注释改了）",
    "export interface Input { memory: boolean; fixed?: readonly string[] }",
    'export function run(input: Pick<Input, "memory">): string {',
    '  return input.memory ? "on" : "off";',
    "  // 定点对照：开始",
    "  fixed();",
    "  // 定点对照：结束",
    "}",
  ].join("\n");
  assert.equal(normalizeForBehavior(changed), normalizeForBehavior(RUNNER));
  assert.deepEqual(
    harnessViolations([{ path: "src/eval/stream-runner.ts", before: RUNNER, after: changed }]),
    []
  );
});

test("harness 核对：改了运行行为的跑批器文件、未标记的新增、非 TypeScript 文件都算不同，列出文件名；定点对照自己的文件与文档放行", () => {
  const behavioral = RUNNER.replace('"on"', '"ON"');
  const unmarked = RUNNER.replace("}\n", "  fixed();\n}\n");
  assert.deepEqual(
    harnessViolations([
      { path: "src/eval/stream-runner.ts", before: RUNNER, after: behavioral },
      { path: "src/eval/stream-agents.ts", before: RUNNER, after: unmarked },
      { path: "package-lock.json", before: "{}", after: '{"x":1}' },
      { path: "src/eval/new-module.ts", before: null, after: RUNNER },
      { path: "src/eval/fixed-point-rerun.ts", before: RUNNER, after: behavioral },
      { path: "src/eval/fixed-point.test.ts", before: null, after: RUNNER },
      { path: "docs/audits/x.md", before: null, after: "审计" },
      { path: "src/eval/stream-report.ts", before: RUNNER, after: behavioral },
    ]),
    [
      "package-lock.json",
      "src/eval/new-module.ts",
      "src/eval/stream-agents.ts",
      "src/eval/stream-runner.ts",
    ]
  );
});

test("harness 核对（真实 git）：取记下的提交与当前工作区的差异，定点对照以外的文件不同即拒绝并列出；记下时或当前工作区有未提交改动即拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fp-harness-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "t");
    git("config", "user.email", "t@example.invalid");
    write("src/eval/stream-runner.ts", RUNNER);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("src/eval/fixed-point-rerun.ts", "export const x = 1;\n");
    write("src/eval/stream-runner.ts", RUNNER.replace("interface Input", "export interface Input"));
    git("add", "-A");
    git("commit", "-q", "-m", "fixed point");
    const head = { commit: git("rev-parse", "HEAD"), dirty: false };
    assert.doesNotThrow(() => assertHarnessMatches(dir, { commit: base, dirty: false }, head));
    // 其余都相符时，记下时或当前有未提交的改动也拒绝
    assert.throws(
      () => assertHarnessMatches(dir, { commit: base, dirty: true }, head),
      (error: unknown) =>
        error instanceof HarnessMismatchError && /未提交的改动/.test(String(error))
    );
    assert.throws(
      () => assertHarnessMatches(dir, { commit: base, dirty: false }, { ...head, dirty: true }),
      (error: unknown) =>
        error instanceof HarnessMismatchError && /未提交的改动/.test(String(error))
    );
    write("src/eval/stream-runner.ts", RUNNER.replace('"on"', '"ON"'));
    assert.throws(
      () => assertHarnessMatches(dir, { commit: base, dirty: false }, head),
      (error: unknown) =>
        error instanceof HarnessMismatchError && /src\/eval\/stream-runner\.ts/.test(String(error))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("验证分步与原尝试不同（名字、命令或执行目录）即拒绝", () => {
  const steps = [
    { name: "类型", command: "tsc" },
    { name: "测试", command: "node --test", cwd: "sub" },
  ];
  assert.doesNotThrow(() =>
    assertSameVerifySteps(
      "这一遍",
      steps,
      steps.map((s) => ({ ...s }))
    )
  );
  for (const other of [
    [steps[0], { ...steps[1], command: "node --test --x" }],
    [steps[0], { ...steps[1], cwd: undefined }],
    [steps[0]],
    undefined,
  ]) {
    assert.throws(
      () => assertSameVerifySteps("这一遍", steps, other as typeof steps | undefined),
      FidelityRejectedError
    );
  }
});

test("镜像与无记忆整流的身份头不同即拒绝；身份头与结果行记下的摘要对不上、或没有身份头，同样拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-fp-identity-"));
  try {
    const core = {
      repo: "memtoy",
      manifestDigest: "m",
      image: "sha256:aaa",
      budget: { maxTurns: 150, wallClockMs: 1800000 },
      conditions: ["no-memory"],
      maxSteps: null,
      agents: {},
    } as unknown as StreamRunIdentity["core"];
    const rows = [{ runIdentity: identityDigest(core) }];
    assert.throws(() => assertSameImage(dir, rows, "sha256:aaa"), /没有身份头/);
    writeFileSync(join(dir, "identity.json"), JSON.stringify({ core, info: {} }));
    assert.doesNotThrow(() => assertSameImage(dir, rows, "sha256:aaa"));
    assert.throws(() => assertSameImage(dir, rows, "sha256:bbb"), /镜像 sha256:bbb/);
    assert.throws(() => assertSameImage(dir, [{ runIdentity: "0000" }], "sha256:aaa"), /摘要/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
