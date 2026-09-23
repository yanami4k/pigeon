// pytest 的韧性运行（strands 的探针、全量测量与人的基准共用）：一个卡死或失控的用例不能让同一次运行里其余用例的结果丢失。
//   写出了 junit 报告：以报告为准（pytest 在报告写完后若因残留线程或事件循环不退出，外壳会等几秒后杀掉它，结果不受影响）；
//   报告写出前就被杀（容器内存上限、墙钟）：从 -v 的逐行进度里收回已完成的用例，把正在跑、没有结果的那条记为失败
//   （卡死），再以 --deselect 排除两者续跑剩下的；没有任何进展即停下，记为未完成；
//   conftest 导入失败（pytest 在收集前整次中止、不写报告，--continue-on-collection-errors 管不到）：该 conftest 所在目录下
//   的测试文件各记一条"文件::<collection>"失败，其余文件去掉它们续跑——与单个文件收集出错同一口径。
// 用例集由调用方固定（人的基准），这里只负责把能拿到的逐用例结果都拿到。
import {
  type CaseOutcome,
  parseJunitCases,
  relativeTestPath,
  type TestCaseResult,
} from "./stream-measure.ts";

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
// --reruns 的重跑：这一次失败、还会再跑，最终结果在其后的行里
const RERUN = /^(\S+?\.py::.+?) RERUN(?:\s|$)/;
const BARE_OUTCOME = /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s|$)/;

export function parseVerboseProgress(output: string): VerboseProgress {
  const completed: VerboseProgress["completed"] = [];
  let pending: string | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (SECTION_END.test(line)) break;
    const again = RERUN.exec(line);
    if (again !== null) {
      pending = again[1] as string;
      continue;
    }
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

// 一次运行：跑哪些测试文件（相对 pytest 的运行目录）、排除哪些用例
export interface PytestAttempt {
  tests: readonly string[];
  deselect: readonly string[];
}

// conftest 导入失败的报错（ImportError 与语法错误等都报成这一句），取出 conftest 的路径
const CONFTEST_FAILURE = /ImportError while loading conftest '([^']+)'/;

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
  run: (attempt: PytestAttempt) => Promise<PytestRun>,
  options: { root: string; relativeBase: string; tests: readonly string[]; maxAttempts?: number }
): Promise<ResilientOutcome> {
  const prefix = options.relativeBase === "" ? "" : `${options.relativeBase.replace(/\/+$/, "")}/`;
  const byId = new Map<string, TestCaseResult>();
  const deselect: string[] = [];
  const stuck: string[] = [];
  const outputs: string[] = [];
  const maxAttempts = options.maxAttempts ?? 20;
  let tests = [...options.tests];
  let complete = false;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const r = await run({ tests: [...tests], deselect: [...deselect] });
    outputs.push(r.output);
    if (r.junit !== null) {
      for (const c of parseJunitCases(r.junit, options.root, options.relativeBase, "pytest")) {
        byId.set(c.id, c);
      }
      complete = true;
      break;
    }
    const conftest = CONFTEST_FAILURE.exec(r.output)?.[1];
    if (conftest !== undefined) {
      const rel = relativeTestPath(conftest, `${options.root}/${options.relativeBase}`);
      const dir = rel.slice(0, rel.lastIndexOf("/") + 1);
      const affected = tests.filter((t) => t.replace(/\\/g, "/").startsWith(dir));
      // 出错的 conftest 不在请求的文件之上：再跑也一样
      if (affected.length === 0) break;
      for (const t of affected) {
        const id = `${prefix}${t}::<collection>`;
        byId.set(id, { id, file: `${prefix}${t}`, outcome: "failed" });
      }
      tests = tests.filter((t) => !affected.includes(t));
      if (tests.length === 0) {
        complete = true;
        break;
      }
      continue;
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
