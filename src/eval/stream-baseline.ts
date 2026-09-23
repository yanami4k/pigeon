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
  // 本次算的与此前已落盘的
  computed: number;
  cached: number;
  failed: { commit: string; error: string }[];
}

// 每一路一个参考工作区：哪一路空了就取下一个提交。一个提交出错记下来、接着算其余的
export async function computeBaselines(input: {
  targets: readonly BaselineTarget[];
  references: readonly ReferenceCases[];
  log?: (line: string) => void;
}): Promise<BaselineSummary> {
  const log = input.log ?? (() => {});
  const free = [...input.references];
  if (free.length === 0) throw new Error("没有参考工作区");
  const summary: BaselineSummary = {
    total: input.targets.length,
    computed: 0,
    cached: 0,
    failed: [],
  };
  const pending = input.targets.filter((t) => {
    const cached = input.references.some((r) => r.has(t.commit));
    if (cached) summary.cached++;
    return !cached;
  });
  log(
    `人的基准：共 ${summary.total} 个提交，已落盘 ${summary.cached} 个，本次算 ${pending.length} 个`
  );
  await runWorkQueue(pending, free.length, async (target) => {
    const reference = free.pop();
    if (reference === undefined) throw new Error("参考工作区不够分");
    try {
      const baseline = await reference.casesAt(target.commit, target.tests);
      summary.computed++;
      log(describe(target, baseline, summary.cached + summary.computed, summary.total));
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
