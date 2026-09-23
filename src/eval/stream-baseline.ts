// 人的基准提前单独算：全量测量的分母（人的代码在每一步的提交上跑人截至该步的全部测试，跑两遍）不依赖回炉与记忆，
// 清单出来后即可先算。用独立的参考容器，与作业的参考工作区分开；结果按提交原子落盘，同一目录重跑时已算的直接跳过，
// 加路数即带更大的并行数重跑。正式实验读这个目录，不再现算。
import type { HumanRepo } from "./stream-facts.ts";
import { type StreamManifest, stepsOf } from "./stream-manifest.ts";
import type { StreamRepoRuntime } from "./stream-profiles.ts";
import { type HumanBaseline, humanTestsAt, type ReferenceCases } from "./stream-runner.ts";
import { runWorkQueue } from "./work-queue.ts";

export interface BaselineTarget {
  commit: string;
  // 该提交上人写的全部测试文件
  tests: string[];
  // 用到这个提交的步序
  seqs: number[];
}

// 需要全量测量的步（题、维护步、套用）的提交，按清单顺序去重；跳过与重置沿用上一步的测量，不在其内
export function baselineTargets(input: {
  manifest: StreamManifest;
  human: HumanRepo;
  runtime: StreamRepoRuntime;
  streams?: readonly string[];
}): BaselineTarget[] {
  const ids = input.streams ?? input.manifest.streams.map((s) => s.id);
  const byCommit = new Map<string, BaselineTarget>();
  for (const id of ids) {
    for (const step of stepsOf(input.manifest, id)) {
      if (step.kind !== "task" && step.kind !== "maintenance" && step.kind !== "apply") continue;
      const known = byCommit.get(step.commit);
      if (known !== undefined) {
        known.seqs.push(step.seq);
        continue;
      }
      byCommit.set(step.commit, {
        commit: step.commit,
        tests: humanTestsAt(input.human, input.runtime, step.commit),
        seqs: [step.seq],
      });
    }
  }
  return [...byCommit.values()];
}

export interface BaselineSummary {
  total: number;
  // 本次算的与此前已落盘的（按用例基准计；只做验证门检查时按验证门计）
  computed: number;
  cached: number;
  failed: { commit: string; error: string }[];
  // 开跑前置检查：人的代码在验证门上没过的提交与没过的步（做了验证门检查时在场）
  gateFailures: { commit: string; seqs: number[]; failedSteps: string[]; outputTail: string }[];
}

// 算什么：人的基准（用例）、开跑前置检查（人的代码逐步跑验证门），或两者
export type BaselineCheck = "cases" | "gate" | "both";

// 每一路一个参考工作区：哪一路空了就取下一个提交。一个提交出错记下来、接着算其余的
export async function computeBaselines(input: {
  targets: readonly BaselineTarget[];
  references: readonly ReferenceCases[];
  log?: (line: string) => void;
  check?: BaselineCheck;
  // 验证门命令（做验证门检查时必需）
  gateCommand?: readonly string[];
}): Promise<BaselineSummary> {
  const log = input.log ?? (() => {});
  const check = input.check ?? "cases";
  const cases = check !== "gate";
  const gate = check !== "cases";
  if (gate && input.gateCommand === undefined) throw new Error("做验证门检查却没有验证门命令");
  const free = [...input.references];
  if (free.length === 0) throw new Error("没有参考工作区");
  const summary: BaselineSummary = {
    total: input.targets.length,
    computed: 0,
    cached: 0,
    failed: [],
    gateFailures: [],
  };
  const done = (t: BaselineTarget) =>
    input.references.some((r) => (cases ? r.has(t.commit) : r.hasGate(t.commit)));
  for (const t of input.targets) if (done(t)) summary.cached++;
  log(
    `人的基准（${check}）：共 ${summary.total} 个提交，已落盘 ${summary.cached} 个，本次算 ${summary.total - summary.cached} 个`
  );
  // 已落盘的也过一遍：验证门的结果从落盘文件读回，汇总才完整
  await runWorkQueue(input.targets, free.length, async (target) => {
    const reference = free.pop();
    if (reference === undefined) throw new Error("参考工作区不够分");
    const fresh = !done(target);
    try {
      if (cases) {
        const baseline = await reference.casesAt(target.commit, target.tests);
        if (fresh) {
          summary.computed++;
          log(describe(target, baseline, summary.cached + summary.computed, summary.total));
        }
      }
      if (gate) {
        const result = await reference.gateAt(target.commit, input.gateCommand ?? []);
        if (!cases && fresh) summary.computed++;
        if (!result.passed) {
          summary.gateFailures.push({
            commit: target.commit,
            seqs: target.seqs,
            failedSteps: result.failedSteps,
            outputTail: result.outputTail,
          });
        }
        if (fresh) {
          log(
            `验证门 ${target.commit}（步 ${target.seqs.join(",")}）：${result.passed ? "通过" : `未通过（${result.failedSteps.join("、") || "无法判定"}）`}，${(result.wallMs / 60_000).toFixed(1)} 分`
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({ commit: target.commit, error: message });
      log(`人的基准 ${target.commit}（步 ${target.seqs.join(",")}）出错：${message.slice(0, 500)}`);
    } finally {
      free.push(reference);
    }
  });
  return summary;
}

const mib = (bytes: number | null) => (bytes === null ? "—" : `${Math.round(bytes / 1048576)} MiB`);

function describe(target: BaselineTarget, b: HumanBaseline, done: number, total: number): string {
  const runs = b.runs
    .map((r, i) => `第 ${i + 1} 遍 ${(r.wallMs / 60_000).toFixed(1)} 分、峰值 ${mib(r.peakBytes)}`)
    .join("；");
  const slowest =
    b.slowest === null ? "" : `；最慢用例 ${b.slowest.id}（${b.slowest.seconds.toFixed(1)} 秒）`;
  return (
    `人的基准 ${done}/${total} ${target.commit}（步 ${target.seqs.join(",")}）：用例 ${b.cases.length} 条，` +
    `每遍都过 ${b.passing.length} 条，时过时不过 ${b.flaky.length} 条；${runs}${slowest}`
  );
}
