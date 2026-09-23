// pytest 的韧性运行（strands 的探针、全量测量与人的基准共用）：一个卡死或失控的用例不能让同一次运行里其余用例的结果丢失。
//   写出了 junit 报告：以报告为准（pytest 在报告写完后若因残留线程或事件循环不退出，外壳会等几秒后杀掉它，结果不受影响）；
//   报告写出前就被杀（容器内存上限、墙钟）：从 -v 的逐行进度里收回已完成的用例，把正在跑、没有结果的那条记为失败
//   （卡死），再以 --deselect 排除两者续跑剩下的；没有任何进展即停下，记为未完成。
// 用例集由调用方固定（人的基准），这里只负责把能拿到的逐用例结果都拿到。
import { type CaseOutcome, parseJunitCases, type TestCaseResult } from "./stream-measure.ts";

export interface VerboseProgress {
  completed: { nodeid: string; outcome: CaseOutcome }[];
  // 已开始、还没有结果的那条（被杀时即卡死的用例）
  running: string | null;
}

const OUTCOMES: Record<string, CaseOutcome> = {
  PASSED: "passed",
  XFAIL: "passed",
  XPASS: "passed",
  SKIPPED: "skipped",
  FAILED: "failed",
  ERROR: "failed",
};

// 进度区之后的分节（失败详情、收集错误、警告、简短汇总）：其中的行不是进度
const SECTION_END = /^=+ (FAILURES|ERRORS|warnings summary|short test summary info|PASSES)\b/;
const WITH_OUTCOME = /^(\S+?\.py::.+?) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s|$)/;
const NODE_START = /^\S+?\.py::/;
const BARE_OUTCOME = /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s|$)/;

export function parseVerboseProgress(output: string): VerboseProgress {
  const completed: VerboseProgress["completed"] = [];
  let pending: string | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (SECTION_END.test(line)) break;
    const full = WITH_OUTCOME.exec(line);
    if (full !== null) {
      completed.push({
        nodeid: full[1] as string,
        outcome: OUTCOMES[full[2] as string] ?? "failed",
      });
      pending = null;
      continue;
    }
    if (NODE_START.test(line)) {
      // 超时横幅紧跟在标识之后（"标识 +++ Timeout +++"），或者只有标识
      pending = line.split(/ \+{3,}/)[0]?.trimEnd() ?? null;
      continue;
    }
    const bare = BARE_OUTCOME.exec(line);
    if (bare !== null && pending !== null) {
      completed.push({ nodeid: pending, outcome: OUTCOMES[bare[1] as string] ?? "failed" });
      pending = null;
    }
  }
  return { completed, running: pending };
}

export interface PytestRun {
  exitCode: number | null;
  timedOut: boolean;
  // 读到的 junit 报告；没写出为 null
  junit: string | null;
  output: string;
}

export interface ResilientOutcome {
  cases: TestCaseResult[];
  // 卡死、被记为失败的用例
  stuck: string[];
  // 最后一次运行写出了报告，即全部用例都有结果
  complete: boolean;
  attempts: number;
  outputs: string[];
}

export async function runPytestResilient(
  run: (deselect: readonly string[]) => Promise<PytestRun>,
  options: { root: string; relativeBase: string; maxAttempts?: number }
): Promise<ResilientOutcome> {
  const prefix = options.relativeBase === "" ? "" : `${options.relativeBase.replace(/\/+$/, "")}/`;
  const byId = new Map<string, TestCaseResult>();
  const deselect: string[] = [];
  const stuck: string[] = [];
  const outputs: string[] = [];
  const maxAttempts = options.maxAttempts ?? 20;
  let complete = false;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const r = await run([...deselect]);
    outputs.push(r.output);
    if (r.junit !== null) {
      for (const c of parseJunitCases(r.junit, options.root, options.relativeBase, "pytest")) {
        byId.set(c.id, c);
      }
      complete = true;
      break;
    }
    const progress = parseVerboseProgress(r.output);
    for (const c of progress.completed) {
      const id = `${prefix}${c.nodeid}`;
      byId.set(id, { id, file: `${prefix}${c.nodeid.split("::")[0]}`, outcome: c.outcome });
      deselect.push(c.nodeid);
    }
    if (progress.running !== null) {
      const id = `${prefix}${progress.running}`;
      byId.set(id, { id, file: `${prefix}${progress.running.split("::")[0]}`, outcome: "failed" });
      stuck.push(id);
      deselect.push(progress.running);
    }
    // 没有任何进展（例如收集阶段就被杀）：再跑也一样
    if (progress.completed.length === 0 && progress.running === null) break;
  }
  return { cases: [...byId.values()], stuck, complete, attempts, outputs };
}
