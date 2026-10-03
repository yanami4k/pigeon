// 两类用例与每步计分（决策 196、201、214）：人在该步的测试（该步提交上人写的全部测试）叠放到人在该步之前的代码（parent）
// 上跑两遍、在人该步的代码（commit）上跑两遍——
//   要做到的（fail-to-pass）：之前两遍都没通过（失败、跳过、缺席都算没通过；parent 侧收集失败时该文件的用例整个缺席，
//     按没通过算，人在该步没改的文件除外，见下），之后两遍都通过；
//   不许挂的（pass-to-pass）：四遍都通过；
//   时过时不过：同一侧两遍结果不一（通过、失败、跳过、缺席任一不同，与人的基准同一口径）的，两类都不进、单独计数；
//   其余（之后没通过，即人自己弄坏或删掉的）两类都不进。
// 收集失败的伪用例（"文件::<collection>"）不进任何一类。人在该步没有改动的测试文件，若在 parent 侧整文件收集失败
// （叠放上去的人的测试辅助文件依赖该步才有的代码，例如 conftest 导入新模块），其中的用例不进要做到的（决策 274）：
// 它们在人之前的代码与测试辅助文件上本来就通过，不是人在该步修好的；人新写或改过的测试文件照旧计入。
// 判题时放入人在该步的全部测试跑一次全量，按两类统计：
// 每步得分 = 要做到的里通过的比例；做成 = 要做到的全过且不许挂的无一失败；要做到的为零的步得分为空、不进主判据分母。
import type { TestCaseResult } from "./stream-measure.ts";

// 一侧两遍的逐条比对（与人的基准同形：每遍都通过的、结果不一的）
export interface SideRuns {
  passing: readonly string[];
  flaky: readonly string[];
  // 收集出的全部用例（含收集失败的伪用例）：parent 侧据此认出整文件收集失败的测试文件
  cases?: readonly { id: string }[];
}

export interface CaseClasses {
  failToPass: string[];
  passToPass: string[];
  // 四遍中时过时不过、因此两类都不进的用例
  excludedFlaky: string[];
}

const COLLECTION_SUFFIX = "::<collection>";
const isCollectionEntry = (id: string) => id.endsWith(COLLECTION_SUFFIX);
// 用例编号里的测试文件路径（"文件::…"的前一段）
const fileOf = (id: string) => {
  const cut = id.indexOf("::");
  return cut < 0 ? id : id.slice(0, cut);
};

// changedTests：人在该步新写或改过的测试文件（本题测试文件）
export function classifyCases(
  commitSide: SideRuns,
  parentSide: SideRuns,
  changedTests: ReadonlySet<string>
): CaseClasses {
  const parentPassing = new Set(parentSide.passing);
  const parentFlaky = new Set(parentSide.flaky);
  // parent 侧整文件收集失败、人在该步又没有改动的测试文件
  const collapsed = new Set(
    (parentSide.cases ?? [])
      .filter((c) => isCollectionEntry(c.id))
      .map((c) => c.id.slice(0, -COLLECTION_SUFFIX.length))
      .filter((file) => !changedTests.has(file))
  );
  const failToPass: string[] = [];
  const passToPass: string[] = [];
  for (const id of commitSide.passing) {
    if (isCollectionEntry(id) || parentFlaky.has(id)) continue;
    if (parentPassing.has(id)) passToPass.push(id);
    else if (!collapsed.has(fileOf(id))) failToPass.push(id);
  }
  const excludedFlaky = [...new Set([...commitSide.flaky, ...parentSide.flaky])].filter(
    (id) => !isCollectionEntry(id)
  );
  return {
    failToPass: failToPass.sort(),
    passToPass: passToPass.sort(),
    excludedFlaky: excludedFlaky.sort(),
  };
}

export interface StepJudging {
  // 要做到的：agent 代码上通过的条数与总数
  failToPass: { passed: number; total: number };
  // 每步得分（201）：要做到的通过比例；总数为 0 时为 null，不进主判据分母
  score: number | null;
  // 不许挂的：agent 代码上没通过的条数与总数
  passToPass: { failed: number; total: number };
  // 做成（196）：要做到的全过且不许挂的无一失败；要做到的为零时为 null
  solved: boolean | null;
  // 没通过的用例编号（两类全记；决策 327：不再截断——旧结果行的 failedCases 可能带 truncated 标记，读取时忽略）
  failedCases: { failToPass: string[]; passToPass: string[] };
  // 因时过时不过而两类都不进的用例数
  excludedFlaky: number;
}

// 按两类集合给 agent 代码上跑出的全量结果计分：没有结果（缺席、收集失败）的用例算没通过
export function judgeStep(
  classes: CaseClasses,
  agentCases: readonly TestCaseResult[]
): StepJudging {
  const passed = new Set(agentCases.filter((c) => c.outcome === "passed").map((c) => c.id));
  const f2pFailed = classes.failToPass.filter((id) => !passed.has(id));
  const p2pFailed = classes.passToPass.filter((id) => !passed.has(id));
  const total = classes.failToPass.length;
  const f2pPassed = total - f2pFailed.length;
  return {
    failToPass: { passed: f2pPassed, total },
    score: total === 0 ? null : f2pPassed / total,
    passToPass: { failed: p2pFailed.length, total: classes.passToPass.length },
    solved: total === 0 ? null : f2pFailed.length === 0 && p2pFailed.length === 0,
    failedCases: { failToPass: f2pFailed, passToPass: p2pFailed },
    excludedFlaky: classes.excludedFlaky.length,
  };
}
