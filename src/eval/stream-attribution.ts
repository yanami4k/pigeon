// 延续式实验的失败归因（决策 142、141、145）：由程序判定，三类——
//   没做出来；改坏旧功能（回归）；
//   维护步接口不同：测试加载时找不到的文件或名字，恰好是某个维护步里人新建了、而 agent 没建的
//   （报错本身即说明 agent 这边没有它）。
// 找不到的文件或名字从判题（或验证门）输出里按两种运行时的报错文案提取；本应新建的取人的 diff：新增文件与新增行里的
// 顶层导出定义。优先级：维护步接口不同 > 回归 > 没做出来——前者是上游缺口，回归是本步把旧的弄坏。
// 缺前置（此前被撤回的题本应新建的）随撤回拆除（决策 173）不再判定，只留在类型与标签里供旧结果行读出与显示。

export type FailureAttribution =
  | "not-done"
  | "regression"
  | "missing-prerequisite"
  | "maintenance-interface";

export interface MissingRefs {
  // 相对工作区根的文件路径（node）或模块路径片段（python，点换成斜杠、不带扩展名）
  paths: string[];
  names: string[];
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function relative(path: string, root: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const r = norm(root);
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

export function extractMissing(output: string, root: string): MissingRefs {
  const paths: string[] = [];
  const names: string[] = [];
  for (const m of output.matchAll(/Cannot find module '([^']+)'/g)) {
    if (m[1] !== undefined) paths.push(relative(m[1], root));
  }
  for (const m of output.matchAll(/does not provide an export named '([\w$]+)'/g)) {
    if (m[1] !== undefined) names.push(m[1]);
  }
  for (const m of output.matchAll(/No module named '([\w.]+)'/g)) {
    if (m[1] !== undefined) paths.push(m[1].replace(/\./g, "/"));
  }
  for (const m of output.matchAll(/cannot import name '(\w+)' from '([\w.]+)'/g)) {
    if (m[1] !== undefined) names.push(m[1]);
  }
  return { paths: unique(paths), names: unique(names) };
}

export interface CreatedRefs {
  files: string[];
  names: Set<string>;
}

// 顶层导出定义：TS 的 export function/const/let/class/interface/type/enum，Python 的顶格 def/class
const TS_EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([\w$]+)/;
const PY_DEF = /^(?:async\s+)?(?:def|class)\s+(\w+)/;

export function createdByDiff(input: {
  addedFiles: readonly string[];
  addedLines: readonly string[];
}): CreatedRefs {
  const names = new Set<string>();
  for (const line of input.addedLines) {
    const m = TS_EXPORT.exec(line) ?? PY_DEF.exec(line);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return { files: [...input.addedFiles], names };
}

function withoutExtension(path: string): string {
  return path.replace(/\.[^./]+$/, "");
}

// 缺失的路径是否对应某个新建文件：node 为同一相对路径；python 为模块路径片段是新建文件（去扩展名）的后缀，
// 包目录对应其 __init__.py
function pathMatches(missing: string, created: string): boolean {
  if (missing === created) return true;
  const stem = withoutExtension(created);
  const target = stem.endsWith("/__init__") ? stem.slice(0, -"/__init__".length) : stem;
  return target === missing || target.endsWith(`/${missing}`) || withoutExtension(missing) === stem;
}

function hits(missing: MissingRefs, created: readonly CreatedRefs[]): boolean {
  return created.some(
    (c) =>
      missing.names.some((n) => c.names.has(n)) ||
      missing.paths.some((p) => c.files.some((f) => pathMatches(p, f)))
  );
}

export function attributeFailure(input: {
  passed: boolean;
  missing: MissingRefs;
  // 此前维护步里人新建的
  maintenanceCreated: readonly CreatedRefs[];
  // 本步全量测量里、上一步在 agent 代码上通过而本步不再通过的用例数
  regressions: number;
}): FailureAttribution | null {
  if (input.passed) return null;
  if (hits(input.missing, input.maintenanceCreated)) return "maintenance-interface";
  if (input.regressions > 0) return "regression";
  return "not-done";
}

export const ATTRIBUTION_LABELS: Record<FailureAttribution, string> = {
  "not-done": "没做出来",
  regression: "回归",
  "missing-prerequisite": "缺前置",
  "maintenance-interface": "维护步接口不同",
};
