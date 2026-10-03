// 按保存的改动重判（决策 270 ①、316）：不重跑 agent，只把每行存下的改动打回起点，照正式跑同一判题路径再判一次，取完整的
// 逐用例结果，供按用例剔除后重算（316 的敏感性分析）使用。
// 判题路径与 runStep 相同：新开干净环境检出人在该步之前的代码，写入人在该步的环境文件并切依赖，打上保存的改动（即 agent
// 开工到收工之间的树差），恢复被 agent 动过的测试与测试辅助文件（restoreTests）、判题前清理（cleanForJudging）、再切依赖，
// 同步人在该步的全部测试后跑一次（judgeCases，与 judgeFull 共用），按预计算的两类用例计分。
// 一致性核对是硬门槛：重判的计数与失败用例与原结果行逐项一致，这一行的逐用例结果才可用
// （决策 327 起失败用例全记；此前的旧结果行只记前 20 条并带 truncated 标记，对旧行只比前缀）。
// 结果另存到输出目录下的 rejudge/cases.jsonl，原结果行一字不改；同一文件已有的行跳过，重跑即续做。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { judgeStep, type StepJudging } from "./stream-classes.ts";
import { imageIdentityOf, readManifest } from "./stream-experiment.ts";
import { gitHumanRepo, type HumanRepo, ReferenceWorkspace } from "./stream-facts.ts";
import { currentHarnessRef } from "./stream-harness.ts";
import type { StreamManifest, StreamStep } from "./stream-manifest.ts";
import type { StreamRepoRuntime } from "./stream-profiles.ts";
import { readStreamResults, type StreamResultLine } from "./stream-results.ts";
import {
  cleanForJudging,
  dockerStreamEnvs,
  judgeCases,
  ReferenceCases,
  restoreTests,
  STREAM_CONTAINER_ROOT,
  type StepClasses,
  type StreamEnvFactory,
  syncEnv,
} from "./stream-runner.ts";
import { dockerStreamShell, type StreamWorkspace } from "./stream-workspace.ts";

export const REJUDGE_DIR = "rejudge";
export const REJUDGE_CASES_FILE = "cases.jsonl";

export interface RejudgeLine {
  condition: StreamResultLine["condition"];
  attempt: number;
  seq: number;
  commit: string;
  diff: string;
  // 重判所用镜像的身份（内容层摘要）与代码版本
  image: string;
  harness: string;
  // 与原结果行逐项一致才可用
  consistent: boolean;
  mismatches: string[];
  // 全部用例都有结果（写出了报告）
  complete: boolean;
  // 重判的计数（同 StepJudging，失败用例不截断）
  judging: StepJudging;
  // 原结果行的判题摘要
  original: Omit<StepJudging, "failedCases"> & { failedCases: StepJudging["failedCases"] };
}

// 重判与原结果行逐项比对：两类计数、得分、做成、时过时不过数与失败用例。
// 327 起失败用例全记、没有截断标记；旧结果行可能带 truncated——旧行截断过即只比它记下的前缀，否则全长逐项比
export function compareJudging(original: StepJudging, rejudged: StepJudging): string[] {
  // 旧结果行的截断标记（327 起不再写）：以 in 窄化读取
  const legacyTruncated =
    "truncated" in original.failedCases && original.failedCases.truncated === true;
  const out: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      out.push(`${what}：原 ${JSON.stringify(a)}，重判 ${JSON.stringify(b)}`);
  };
  same("要做到的通过数", original.failToPass.passed, rejudged.failToPass.passed);
  same("要做到的总数", original.failToPass.total, rejudged.failToPass.total);
  same("不许挂的失败数", original.passToPass.failed, rejudged.passToPass.failed);
  same("不许挂的总数", original.passToPass.total, rejudged.passToPass.total);
  same("得分", original.score, rejudged.score);
  same("做成", original.solved, rejudged.solved);
  same("时过时不过", original.excludedFlaky, rejudged.excludedFlaky);
  same(
    "要做到的失败用例",
    original.failedCases.failToPass,
    legacyTruncated
      ? rejudged.failedCases.failToPass.slice(0, original.failedCases.failToPass.length)
      : rejudged.failedCases.failToPass
  );
  same(
    "不许挂的失败用例",
    original.failedCases.passToPass,
    legacyTruncated
      ? rejudged.failedCases.passToPass.slice(0, original.failedCases.passToPass.length)
      : rejudged.failedCases.passToPass
  );
  return out;
}

// 把保存的改动（git diff --binary 的输出）打到工作区：空改动不打
export async function applySavedDiff(ws: StreamWorkspace, diff: Buffer): Promise<void> {
  if (diff.length === 0) return;
  const file = `${ws.root}/.git/pigeon-rejudge.diff`;
  await ws.writeFile(file, diff);
  const r = await ws.run(["git", "apply", "--binary", "--whitespace=nowarn", file], 300_000);
  if (r.exitCode !== 0 || r.timedOut) {
    throw new Error(`打不上保存的改动（退出码 ${r.exitCode}）：${r.output.slice(-500)}`);
  }
  await ws.run(["rm", "-f", file], 60_000);
}

export interface RejudgeOptions {
  runtime: StreamRepoRuntime;
  human: HumanRepo;
  manifest: StreamManifest;
  envs: StreamEnvFactory;
  // 只从落盘结果读两类用例（ReferenceCases.cachedClasses）；读不到即这一行不判
  classesOf: (step: StreamStep) => StepClasses | undefined;
  // 正式跑的输出目录：读 results.jsonl 与各行的改动，结果写到其下 rejudge/
  outDir: string;
  // 只重判这些步序（结果行的 seq）的行；缺省全部
  seqs?: readonly number[];
  // 最多重判几行（先抽几行核对时用）
  limit?: number;
  concurrency?: number;
  judgeTimeoutMs?: number;
  image: string;
  harness: string;
  log?: (line: string) => void;
}

const rowKey = (r: { condition: string; attempt: number; seq: number }) =>
  `${r.condition}|${r.attempt}|${r.seq}`;

// 要重判的行：判过分的题步，同一条件、遍、步取文件中最后出现的一行（重做以最后结果为准）
export function rowsToRejudge(
  rows: readonly StreamResultLine[],
  seqs?: readonly number[]
): StreamResultLine[] {
  const want = seqs === undefined ? undefined : new Set(seqs);
  const last = new Map<string, StreamResultLine>();
  for (const r of rows) last.set(rowKey(r), r);
  return [...last.values()]
    .filter(
      (r) =>
        r.kind === "task" &&
        r.judged &&
        r.judging !== null &&
        r.diff !== null &&
        (want === undefined || want.has(r.seq))
    )
    .sort(
      (a, b) => a.seq - b.seq || a.condition.localeCompare(b.condition) || a.attempt - b.attempt
    );
}

// 一行的重判：与 runStep 同一顺序调用同一批函数
export async function rejudgeRow(
  options: Pick<
    RejudgeOptions,
    "runtime" | "human" | "envs" | "classesOf" | "outDir" | "judgeTimeoutMs"
  >,
  row: StreamResultLine,
  step: StreamStep,
  slot = 0
): Promise<{ judging: StepJudging; complete: boolean }> {
  const classes = options.classesOf(step);
  if (classes === undefined || classes.unbuildable !== null) {
    throw new Error(`第 ${step.seq} 步读不到预计算的两类用例`);
  }
  const diff = readFileSync(path.join(options.outDir, row.diff as string));
  const env = await options.envs.open(
    { stream: REJUDGE_DIR, condition: row.condition, attempt: row.attempt },
    { startCommit: step.parent, slot }
  );
  try {
    const { ws } = env;
    // 开工：人在该步的环境文件、按人的声明切依赖（与 runStep 开工时相同）；保存的改动即在此之上取的树差
    await ws.applyHumanFiles(
      step.humanFiles.filter((f) => f.kind === "env"),
      (p) => options.human.show(step.commit, p)
    );
    await syncEnv(options, ws, step.commit);
    await applySavedDiff(ws, diff);
    await ws.grantOwnerAccess();
    // 收工后判题：与 runStep 相同
    await restoreTests(options, ws, step);
    await cleanForJudging(options, ws, step);
    await syncEnv(options, ws, step.commit);
    const run = await judgeCases(options, ws, step);
    return {
      judging: judgeStep(classes, run.cases),
      complete: run.complete,
    };
  } finally {
    await env.dispose();
  }
}

function readDone(file: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(file)) return done;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      done.add(rowKey(JSON.parse(raw) as RejudgeLine));
    } catch {
      // 撕裂的末行：这一行重做
    }
  }
  return done;
}

export interface RejudgeSummary {
  file: string;
  selected: number;
  skipped: number;
  consistent: number;
  inconsistent: { key: string; mismatches: string[] }[];
  errors: { key: string; error: string }[];
}

export async function runRejudge(options: RejudgeOptions): Promise<RejudgeSummary> {
  const dir = path.join(options.outDir, REJUDGE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, REJUDGE_CASES_FILE);
  const done = readDone(file);
  const steps = new Map(options.manifest.steps.map((s) => [s.seq, s]));
  const all = rowsToRejudge(
    readStreamResults(path.join(options.outDir, "results.jsonl")),
    options.seqs
  );
  const pending = all.filter((r) => !done.has(rowKey(r)));
  const todo = pending.slice(0, options.limit ?? Infinity);
  const summary: RejudgeSummary = {
    file,
    selected: all.length,
    skipped: all.length - pending.length,
    consistent: 0,
    inconsistent: [],
    errors: [],
  };
  let next = 0;
  const worker = async (slot: number) => {
    while (next < todo.length) {
      const row = todo[next++] as StreamResultLine;
      const key = rowKey(row);
      const step = steps.get(row.seq);
      try {
        if (step === undefined) throw new Error(`清单里没有第 ${row.seq} 步`);
        const started = Date.now();
        const { judging, complete } = await rejudgeRow(options, row, step, slot);
        const original = row.judging as StepJudging;
        const mismatches = compareJudging(original, judging);
        if (!complete) mismatches.push("重判没拿全用例结果");
        const line: RejudgeLine = {
          condition: row.condition,
          attempt: row.attempt,
          seq: row.seq,
          commit: row.commit,
          diff: row.diff as string,
          image: options.image,
          harness: options.harness,
          consistent: mismatches.length === 0,
          mismatches,
          complete,
          judging,
          original,
        };
        appendFileSync(file, `${JSON.stringify(line)}\n`);
        if (line.consistent) summary.consistent++;
        else summary.inconsistent.push({ key, mismatches });
        options.log?.(
          `${key}：${line.consistent ? "一致" : `不一致（${mismatches.join("；")}）`}，${((Date.now() - started) / 1000).toFixed(0)} 秒`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push({ key, error: message });
        options.log?.(`${key}：出错 ${message}`);
      }
    }
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 1, todo.length));
  await Promise.all(Array.from({ length: lanes }, (_, k) => worker(k)));
  return summary;
}

// 重判起的作业容器另带的标签：只清理带这个标签的容器
export const REJUDGE_CONTAINER_LABEL = "pigeon.rejudge=1";

export interface StreamRejudgeInput {
  manifestFile: string;
  repoDir: string;
  // 判题所用镜像；两类用例按 classesImage 的身份从落盘结果读（缺省即 image）
  image: string;
  classesImage?: string;
  baselineDir: string;
  outDir: string;
  seqs?: readonly number[];
  limit?: number;
  concurrency?: number;
  // 作业容器的参数（与正式跑相同的内存上限等），另加专用标签
  containerRunArgs: readonly string[];
  docker?: readonly string[];
  log?: (line: string) => void;
}

export async function runStreamRejudge(input: StreamRejudgeInput): Promise<RejudgeSummary> {
  const { manifest, runtime } = readManifest(input.manifestFile);
  const docker = input.docker ?? ["docker"];
  const human = gitHumanRepo(input.repoDir);
  const outDir = path.resolve(input.outDir);
  const image = imageIdentityOf(input.image, docker);
  const classesImage =
    input.classesImage === undefined ? image : imageIdentityOf(input.classesImage, docker);
  // 只读落盘的两类用例（cachedClasses），不起参考容器
  const reference = new ReferenceCases({
    reference: new ReferenceWorkspace(
      dockerStreamShell({ container: "pigeon-rejudge-unused", root: STREAM_CONTAINER_ROOT, docker })
    ),
    runtime,
    human,
    cacheDir: path.resolve(input.baselineDir),
    image: classesImage,
  });
  const prefix = `pigeon-rejudge-${createHash("sha256").update(outDir).digest("hex").slice(0, 8)}`;
  const harness = currentHarnessRef();
  return runRejudge({
    runtime,
    human,
    manifest,
    envs: dockerStreamEnvs({
      image: input.image,
      human,
      prefix,
      docker,
      runArgs: [...input.containerRunArgs, "--label", REJUDGE_CONTAINER_LABEL],
      ...(input.log !== undefined ? { log: input.log } : {}),
    }),
    classesOf: (step) => reference.cachedClasses(step),
    outDir,
    image,
    harness: `${harness.commit}${harness.dirty ? "+dirty" : ""}`,
    ...(input.seqs !== undefined ? { seqs: input.seqs } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    ...(input.log !== undefined ? { log: input.log } : {}),
  });
}
