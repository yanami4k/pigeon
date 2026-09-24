// 测试夹具：定点对照（决策 139、156、157）用的一条小流。只供测试使用。
// 人的仓库放着按源码标记报错的分步验证脚本（v.mjs，见结构化记忆夹具）与逐用例判题脚本（cases.mjs）；四步题：
//   1 Add feature：agent 改 feature 时顺手删了 core 的标记，core 的测试（题面以外）变红，回炉补改 core 后转绿（记忆 F1）；
//   2 Add extra：agent 给 util 加了类型错误，回炉删掉后转绿（记忆 F2，名字 Ghost 仍留在 util 的注释里，核验能过）；
//   3 Tune core：题面指到 src/core.ts，开局本能挑到挂在它上面的 F1——事件（开局）；
//   4 Add other：agent 又删了 core 的标记，首轮验证报与 F1 同一指纹，回炉本能挑到 F1——事件（第 1 轮回炉）。
// "去掉记忆"一遍整流用真的 Pigeon（假模型、在本机执行命令的假 docker）跑出；跑批器给每步开工时的树建了引用，
// 导出的流历史带着它们。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  edits,
  finished,
  MEMORY_VERIFY_SCRIPT,
} from "../application/structured-memory-fixtures.ts";
import { createContainerWorkspaceHost } from "../execution/container-host.ts";
import { localDockerHost } from "../execution/local-docker-fixtures.ts";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { pigeonStepAgent } from "./stream-agents.ts";
import { gitHumanRepo, type HumanRepo } from "./stream-facts.ts";
import { buildTaskPrompt, type StreamManifest, type StreamStep } from "./stream-manifest.ts";
import { runJunitOnce, type StreamRepoRuntime } from "./stream-profiles.ts";
import type {
  HumanReferenceCases,
  StepAgent,
  StepAgentInput,
  StreamEnvFactory,
} from "./stream-runner.ts";
import { runStreams } from "./stream-runner.ts";
import { localStreamShell } from "./stream-shell-fixtures.ts";
import { StreamWorkspace } from "./stream-workspace.ts";

// 逐用例判题：每个测试文件里每行 "// FAILS_UNLESS <文件> <标记> <用例名>" 是一条用例，<文件> 含 <标记> 即通过
const CASES_SCRIPT = String.raw`import { readFileSync, writeFileSync } from "node:fs";
const [out, ...tests] = process.argv.slice(2);
const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
const cases = [];
for (const t of tests) {
  const text = read(t);
  if (text === null) { cases.push('<testcase name="load" file="' + t + '"><failure message="missing"/></testcase>'); continue; }
  for (const m of text.matchAll(/\/\/ FAILS_UNLESS (\S+) (\S+) (.+)/g)) {
    const ok = (read(m[1]) ?? "").includes(m[2]);
    cases.push('<testcase name="' + m[3].trim() + '" file="' + t + '">' + (ok ? "" : '<failure message="x"/>') + "</testcase>");
  }
}
writeFileSync(out, "<testsuites>" + cases.join("") + "</testsuites>");
`;

const NODE = `"${process.execPath}"`;

export const memToyRuntime: StreamRepoRuntime = {
  profile: {
    name: "memtoy",
    classifyFile(path) {
      if (!path.startsWith("src/")) return "other";
      return path.endsWith(".test.ts") ? "test" : "source";
    },
    resetReason: () => null,
    gateCommand: ["true"],
  },
  verifySteps: [
    { name: "类型", command: `${NODE} v.mjs 类型` },
    { name: "测试", command: `${NODE} v.mjs 测试` },
  ],
  casesCommand: CASES_SCRIPT,
  quality: { type: null, format: null, layer: null },
  runCases: (ws, tests, options) =>
    runJunitOnce(ws, (junit) => [process.execPath, "cases.mjs", junit, ...tests], options),
  formatCommand: () => ["true"],
  depsLinks: [],
  envSyncCommand: null,
};

// 全量测量的人的基准在定点对照里用不上：一律给空
export const emptyReference: HumanReferenceCases = {
  casesAt: async () => ({ cases: [], passing: [], flaky: [], runs: [], slowest: null }),
};

// 工作区的完整状态：HEAD 与工作区全部文件（不含被忽略的）写成的树
export function worktreeState(root: string): { head: string; tree: string } {
  const index = join(root, ".git", "pigeon-fixture-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  rmSync(index, { force: true });
  git("read-tree", "HEAD");
  git("add", "-A");
  const tree = git("write-tree");
  rmSync(index, { force: true });
  return { head: git("rev-parse", "HEAD"), tree };
}

// 固定目录的本地"假容器"：每次打开都清空同一个目录再从 bundle 建（容器里工作区根总是同一个路径，
// 账本里记下的工作区与执行端的根因此对得上）。只能依次打开，不能并行
export function fixedDirEnvs(input: {
  root: string;
  containerRoot: string;
  bundleOf: (commit: string) => Buffer;
}): StreamEnvFactory & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(job, init) {
      opened.push(`${job.stream}|${job.condition}|${job.attempt}`);
      rmSync(input.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      mkdirSync(input.root, { recursive: true });
      const ws = new StreamWorkspace(localStreamShell(input.root));
      if (init.resume !== undefined)
        await ws.restoreFromBundle(init.resume.bundle, init.resume.head);
      else await ws.initFromBundle(input.bundleOf(init.startCommit), init.startCommit);
      return {
        ws,
        target: { container: "box", root: input.containerRoot },
        measureRoot: join(dirname(input.root), "measure"),
        dispose: async () => {},
      };
    },
  };
}

// 每步用各自的一串假回复造一个 Pigeon agent；onStart 在 agent 开工前看一眼工作区（验证起点一致用）
export function perStepPigeon(input: {
  docker: readonly string[];
  home: string;
  repliesFor: (step: StepAgentInput) => FakeReply[];
  onStart?: (step: StepAgentInput) => void;
  settings?: {
    provider?: string;
    modelId?: string;
    thinking?: ThinkingLevel;
    maxOutputTokens?: number;
    temperature?: number;
  };
  // 每次运行的假模型（按调用顺序）：看交给模型的系统提示与消息
  streams?: Array<{ step: StepAgentInput; fn: ReturnType<typeof createFakeStreamFn> }>;
}): StepAgent {
  return {
    async run(step) {
      input.onStart?.(step);
      const fn = createFakeStreamFn({ replies: input.repliesFor(step) });
      input.streams?.push({ step, fn });
      return pigeonStepAgent({
        streamFn: fn,
        yolo: true,
        docker: input.docker,
        homeDir: input.home,
        ...(input.settings?.provider !== undefined ? { provider: input.settings.provider } : {}),
        ...(input.settings?.modelId !== undefined ? { modelId: input.settings.modelId } : {}),
        ...(input.settings?.thinking !== undefined ? { thinking: input.settings.thinking } : {}),
        ...(input.settings?.maxOutputTokens !== undefined
          ? { maxOutputTokens: input.settings.maxOutputTokens }
          : {}),
        ...(input.settings?.temperature !== undefined
          ? { temperature: input.settings.temperature }
          : {}),
      }).run(step);
    },
  };
}

// "去掉记忆"整流里 agent 在各步的做法（见文件头）
export function noMemoryReplies(seq: number): FakeReply[] {
  switch (seq) {
    case 1:
      return [
        edits(
          ["src/feature.ts", "feature = 0;", "feature = 1; // FEATURE_OK"],
          ["src/core.ts", " // CORE_OK", ""]
        ),
        finished(),
        edits(["src/core.ts", "core = 1;", "core = 1; // CORE_OK"]),
        finished("修好了"),
      ];
    case 2:
      return [
        edits(
          ["src/extra.ts", "extra = 0;", "extra = 1; // EXTRA_OK"],
          ["src/util.ts", "util = 1;", "util = 1; // TYPE_BAD:Ghost"]
        ),
        finished(),
        edits(["src/util.ts", " // TYPE_BAD:Ghost", ""]),
        finished("修好了"),
      ];
    case 3:
      return [edits(["src/core.ts", "// CORE_OK", "// CORE_OK CORE2_OK"]), finished()];
    default:
      return [
        edits(
          ["src/other.ts", "other = 0;", "other = 1; // OTHER_OK"],
          ["src/core.ts", " CORE_OK", ""]
        ),
        finished(),
        edits(["src/core.ts", "core = 1; //", "core = 1; // CORE_OK"]),
        finished("修好了"),
      ];
  }
}

export interface FixedPointToy {
  base: string;
  human: HumanRepo;
  manifest: StreamManifest;
  // "去掉记忆"整流的输出目录
  noMemoryDir: string;
  // 固定目录的假容器（事件认定与重跑都用它）与它的执行端
  envs: ReturnType<typeof fixedDirEnvs>;
  root: string;
  containerRoot: string;
  docker: string[];
  hostFor: (target: { container: string; root: string }) => WorkspaceHost;
  home: string;
  // 整流里每步 agent 开工时工作区的状态
  startStates: Map<number, { head: string; tree: string }>;
  cleanup(): void;
}

function humanCommits(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "human");
  git("config", "user.email", "human@example.invalid");
  git("config", "core.autocrlf", "false");
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return [
    commit(
      {
        "v.mjs": MEMORY_VERIFY_SCRIPT,
        "cases.mjs": CASES_SCRIPT,
        ".gitignore": ".pigeon/\n",
        "src/core.ts": "export const core = 1; // CORE_OK\n",
        "src/core.test.ts": "// FAILS_UNLESS src/core.ts CORE_OK core works\n",
        "src/util.ts": "export const util = 1; // Ghost helper\n",
        "src/feature.ts": "export const feature = 0;\n",
        "src/extra.ts": "export const extra = 0;\n",
        "src/other.ts": "export const other = 0;\n",
      },
      "Start"
    ),
    commit(
      {
        "src/feature.ts": "export const feature = 1; // FEATURE_OK\n",
        "src/feature.test.ts": "// FAILS_UNLESS src/feature.ts FEATURE_OK feature works\n",
      },
      "Add feature"
    ),
    commit(
      {
        "src/extra.ts": "export const extra = 1; // EXTRA_OK\n",
        "src/extra.test.ts": "// FAILS_UNLESS src/extra.ts EXTRA_OK extra works\n",
      },
      "Add extra"
    ),
    commit(
      {
        "src/core.ts": "export const core = 1; // CORE_OK CORE2_OK\n",
        "src/core2.test.ts": "// FAILS_UNLESS src/core.ts CORE2_OK core tuned\n",
      },
      "Tune core"
    ),
    commit(
      {
        "src/other.ts": "export const other = 1; // OTHER_OK\n",
        "src/other.test.ts": "// FAILS_UNLESS src/other.ts OTHER_OK other works\n",
      },
      "Add other"
    ),
  ];
}

function manifestOf(human: HumanRepo, commits: string[]): StreamManifest {
  const steps: StreamStep[] = commits.slice(1).map((sha, i) => {
    const parent = commits[i] as string;
    const tests = human
      .changes(parent, sha)
      .filter((f) => f.path.endsWith(".test.ts"))
      .map((f) => f.path);
    const subject = ["Add feature", "Add extra", "Tune core", "Add other"][i] as string;
    return {
      seq: i + 1,
      kind: "task",
      commit: sha,
      parent,
      subject,
      message: `${subject}\n`,
      prompt: buildTaskPrompt(
        `${subject}\n`,
        tests.map((path) => ({ path, content: human.show(sha, path).toString("utf8") }))
      ),
      humanFiles: tests.map((path) => ({ path, op: "write", kind: "test" })),
      judgeTests: tests,
      reason: "题",
    };
  });
  return {
    version: 1,
    repo: "memtoy",
    rangeStart: commits[0] as string,
    rangeEnd: commits.at(-1) as string,
    gateCommand: ["true"],
    steps,
    streams: [{ id: "s1", startCommit: commits[0] as string, firstSeq: 1, lastSeq: steps.length }],
  };
}

export async function fixedPointToy(): Promise<FixedPointToy> {
  const base = mkdtempSync(join(tmpdir(), "pigeon-fixed-point-"));
  const humanDir = join(base, "human");
  const commits = humanCommits(humanDir);
  const human = gitHumanRepo(humanDir);
  const manifest = manifestOf(human, commits);
  const root = join(base, "box");
  mkdirSync(root, { recursive: true });
  const local = localDockerHost(root);
  const containerRoot = local.containerRoot;
  const envs = fixedDirEnvs({ root, containerRoot, bundleOf: (c) => human.bundle(c) });
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const startStates = new Map<number, { head: string; tree: string }>();
  const noMemoryDir = join(base, "no-memory");
  const summary = await runStreams({
    manifest,
    runtime: memToyRuntime,
    human,
    envs,
    agents: {
      pigeon: perStepPigeon({
        docker: local.docker,
        home,
        repliesFor: (step) => noMemoryReplies(step.step.seq),
        onStart: (step) => startStates.set(step.step.seq, worktreeState(root)),
      }),
    },
    reference: emptyReference,
    outDir: noMemoryDir,
    conditions: ["no-memory"],
    budget: { maxTurns: 150, wallClockMs: 600_000 },
    harnessRef: { commit: "test", dirty: false },
    concurrency: 1,
  });
  const stopped = summary.jobs.find((j) => j.stopped !== undefined);
  if (stopped !== undefined) throw new Error(`夹具的整流没跑完：${stopped.stopped}`);
  const jobDir = join(noMemoryDir, "streams", "s1-no-memory-1");
  if (!existsSync(join(jobDir, "history.bundle"))) throw new Error("夹具的整流没有导出流历史");
  return {
    base,
    human,
    manifest,
    noMemoryDir,
    envs,
    root,
    containerRoot,
    docker: local.docker,
    hostFor: (target) =>
      createContainerWorkspaceHost({
        container: target.container,
        root: target.root,
        docker: local.docker,
      }),
    home,
    startStates,
    cleanup() {
      local.cleanup();
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

// 内容摘要（比较两份清单是否逐字相同）
export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
