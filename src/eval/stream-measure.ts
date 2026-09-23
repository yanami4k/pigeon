// 延续式实验的全量测量（决策 145）：每步结束后在另一份副本上跑"截至该步人写的全部测试"，得全量测试通过率。
// 两种算法：按条数——以人的代码在同一提交上通过的用例为分母，数 agent 的代码上同样通过的；
// 按题——截至该步做过的题里，其判题测试（取人的当前版本）在 agent 的代码上仍全部通过的比例。
// 用例结果统一取自 junit 报告：node --test 的 junit 报告器与 pytest（junit_family=xunit1，带文件路径）同一解析。

export type CaseOutcome = "passed" | "failed" | "skipped";

export interface TestCaseResult {
  // 用例标识：相对文件路径 :: 分组路径 :: 名称（跨步稳定，用于与人的基准对齐）
  id: string;
  // 相对工作区根的测试文件路径；报告里没有文件信息时为 null
  file: string | null;
  outcome: CaseOutcome;
  // 报告里的用例耗时（秒）；没有时缺省
  seconds?: number;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? `&${e};`;
  });
}

function attrs(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], decode(m[2]));
  }
  return out;
}

// 把报告里的文件路径化为相对仓库根的正斜杠路径：绝对路径去掉工作区根；相对路径（pytest 相对其运行目录）补上
// 运行目录在仓库里的位置 relativeBase；绝对路径不在根下的原样保留
export function relativeTestPath(file: string, root: string, relativeBase = ""): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(file);
  const r = norm(root);
  if (f.startsWith(`${r}/`)) return f.slice(r.length + 1);
  const absolute = f.startsWith("/") || /^[a-z]:\//i.test(f);
  if (absolute || relativeBase === "") return f;
  return `${norm(relativeBase)}/${f.replace(/^\.\//, "")}`;
}

export type JunitStyle = "node" | "pytest";

// pytest（xunit1）用例的标识：与 pytest 的 nodeid 一致——文件::类::用例（类名由 classname 去掉模块路径得到，
// 嵌套类逐层用 :: 连接）；收集失败的条目 classname 为空、name 为模块名，记为"文件::<collection>"——
// 文件取 file（pytest 9 起才有），没有时由模块名换算
function pytestCase(
  a: Map<string, string>,
  root: string,
  relativeBase: string
): { id: string; file: string } {
  const name = a.get("name") ?? "";
  const classname = a.get("classname") ?? "";
  const fileAttr = a.get("file");
  const prefix = relativeBase === "" ? "" : `${relativeBase.replace(/\/+$/, "")}/`;
  if (classname === "" || fileAttr === undefined) {
    const file =
      fileAttr !== undefined
        ? relativeTestPath(fileAttr, root, relativeBase)
        : `${prefix}${(classname !== "" ? classname : name).replace(/\./g, "/")}.py`;
    return { id: `${file}::<collection>`, file };
  }
  const file = relativeTestPath(fileAttr, root, relativeBase);
  const module = file.slice(prefix.length).replace(/\.py$/, "").replace(/\//g, ".");
  const cls = classname.startsWith(`${module}.`) ? classname.slice(module.length + 1) : "";
  const parts = [file, ...(cls === "" ? [] : cls.split(".")), name];
  return { id: parts.join("::"), file };
}

// 解析 junit 报告。失败与出错（含测试文件加载失败，两种报告器都记成一条出错用例）一律记 failed
export function parseJunitCases(
  xml: string,
  root: string,
  relativeBase = "",
  style: JunitStyle = "node"
): TestCaseResult[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const tag = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
  const suites: string[] = [];
  const out: TestCaseResult[] = [];
  let open: {
    name: string;
    file: string | null;
    key: string;
    id?: string;
    outcome: CaseOutcome;
    seconds?: number;
  } | null = null;
  const finish = () => {
    if (open === null) return;
    out.push({
      id: open.id ?? `${open.key}::${[...suites, open.name].join("::")}`,
      file: open.file,
      outcome: open.outcome,
      ...(open.seconds !== undefined ? { seconds: open.seconds } : {}),
    });
    open = null;
  };
  for (const m of body.matchAll(tag)) {
    const [, closing, name, rest = "", selfClosing] = m;
    if (name === "testsuite") {
      if (closing === "/") suites.pop();
      else if (selfClosing !== "/") suites.push(attrs(rest).get("name") ?? "");
      continue;
    }
    if (name === "testcase") {
      if (closing === "/") {
        finish();
        continue;
      }
      const a = attrs(rest);
      if (style === "pytest") {
        const c = pytestCase(a, root, relativeBase);
        open = {
          name: a.get("name") ?? "",
          file: c.file,
          key: c.file,
          id: c.id,
          outcome: "passed",
        };
      } else {
        const fileAttr = a.get("file");
        const file = fileAttr === undefined ? null : relativeTestPath(fileAttr, root, relativeBase);
        open = {
          name: a.get("name") ?? "",
          file,
          key: file ?? a.get("classname") ?? "",
          outcome: "passed",
        };
      }
      const time = Number(a.get("time"));
      if (a.has("time") && Number.isFinite(time)) open.seconds = time;
      if (selfClosing === "/") finish();
      continue;
    }
    if (open === null || closing === "/") continue;
    if (name === "skipped") {
      if (open.outcome === "passed") open.outcome = "skipped";
    } else {
      open.outcome = "failed";
    }
  }
  finish();
  return out;
}

export interface CountPassRate {
  // 人的代码上通过、agent 的代码上也通过的用例数
  passed: number;
  // 人的代码上通过的用例数（分母）
  total: number;
  rate: number;
}

// 按条数：分母是人的代码在同一提交上通过的用例；agent 代码上缺失（加载失败、被删）的用例算没过
export function countPassRate(
  humanPassing: ReadonlySet<string>,
  agentCases: readonly TestCaseResult[]
): CountPassRate {
  const agentPassed = new Set(agentCases.filter((c) => c.outcome === "passed").map((c) => c.id));
  let passed = 0;
  for (const id of humanPassing) if (agentPassed.has(id)) passed++;
  const total = humanPassing.size;
  return { passed, total, rate: total === 0 ? 1 : passed / total };
}

export interface TaskPassRate {
  passed: number;
  total: number;
  rate: number;
  // 判题测试在 agent 代码上不再全过的题（步序）
  failingSeqs: number[];
}

// 按题：一题算过，当且仅当它的判题测试文件里、人的代码上通过的每条用例在 agent 的代码上也通过。
// 判题文件在人的基准里一条通过用例都没有（文件已被人删掉或改名）的题不计入分母
export function taskPassRate(
  tasks: readonly { seq: number; judgeTests: readonly string[] }[],
  humanCases: readonly TestCaseResult[],
  agentCases: readonly TestCaseResult[]
): TaskPassRate {
  const agentPassed = new Set(agentCases.filter((c) => c.outcome === "passed").map((c) => c.id));
  let passed = 0;
  let total = 0;
  const failingSeqs: number[] = [];
  for (const task of tasks) {
    const files = new Set(task.judgeTests);
    const required = humanCases.filter(
      (c) => c.outcome === "passed" && c.file !== null && files.has(c.file)
    );
    if (required.length === 0) continue;
    total++;
    if (required.every((c) => agentPassed.has(c.id))) passed++;
    else failingSeqs.push(task.seq);
  }
  return { passed, total, rate: total === 0 ? 1 : passed / total, failingSeqs };
}
