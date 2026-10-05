// 延续式实验的流清单（决策 127、141、153）：把一段人的提交历史按写死的规则逐步定性，
// 得到"题 / 维护步 / 套用 / 跳过 / 重置"的有序清单，随结果一起保存。
// 本文件只做纯规则：输入是逐提交的事实（改了哪些文件、Linux 容器里测得的判题探针、格式化比对），
// 输出是清单；取事实与跑探针在 stream-facts.ts，规则与 I/O 分开，便于用已知测量结果做回归检查。

export type StreamFileKind = "source" | "test" | "testaux" | "env" | "other";

export type StreamStepKind = "task" | "maintenance" | "apply" | "skip" | "reset";

export interface CommitFileChange {
  path: string;
  // 取事实时关闭改名检测：改名记为一删一增
  status: "A" | "M" | "D";
  added: number;
  deleted: number;
}

// 判题探针（必须在 Linux 容器里测得）：该提交的测试改动打到父提交上是否失败、打到提交本身上是否通过
export interface TestProbe {
  parentFails: boolean;
  commitPasses: boolean;
}

export interface CommitFacts {
  sha: string;
  parent: string;
  subject: string;
  // 提交信息全文（主题加正文），即题面与维护步的说明
  message: string;
  files: readonly CommitFileChange[];
  // 带测试改动的提交才有
  probe?: TestProbe;
  // 红测试对探针：本提交的测试在本提交上不过时，把它们放到下一个提交上是否通过
  nextPasses?: boolean;
  // 改了源代码的非题提交才有：对父提交跑格式化后是否与本提交逐字一致
  formatOnly?: boolean;
  // 探针因内存上限或超时被杀（退出码 137）：记为环境错误，不作父败或本败判定
  environmentError?: string;
}

export interface RepoProfile {
  name: string;
  classifyFile(path: string): StreamFileKind;
  // 该提交是否为重置点；是则返回理由
  resetReason(commit: CommitFacts): string | null;
  // 验证门命令（写死进清单）
  gateCommand: readonly string[];
}

export interface HumanFileOp {
  path: string;
  op: "write" | "delete";
  kind: StreamFileKind;
}

export interface StreamStep {
  // 在整份清单里的步序，从 1 起
  seq: number;
  kind: StreamStepKind;
  commit: string;
  parent: string;
  // 红测试对合并时的两个提交（先红后修），commit 为后者
  mergedCommits?: readonly string[];
  subject: string;
  // 提交信息全文（红测试对为两段相接）
  message: string;
  // 出清单时拼好的题面（题：本题测试文件路径、提交信息加测试文件全文；维护步：提交信息；其余为 null）。198 起跑批器
  // 不用它，按题面格式现拼（见 taskPromptOf）
  prompt: string | null;
  // 由程序从人的提交里写入工作区的文件：测试、测试辅助、环境文件；套用步为该提交的全部相关文件
  humanFiles: readonly HumanFileOp[];
  // 判题用的测试集（题才有；维护步只用验证门判）
  judgeTests: readonly string[];
  reason: string;
  // 开跑前置检查里人的代码在这一步没过验证门（人当时的代码就坏了）：这一步照常跑、照常判，
  // 只作标记，供之后分析时识别
  humanFailsGate?: boolean;
}

// 按开跑前置检查的结果给清单打标记：人的代码没过验证门的提交，对应的题与维护步记 humanFailsGate；其余步去掉这一标记
export function markHumanGateFailures(
  manifest: StreamManifest,
  failedCommits: readonly string[]
): StreamManifest {
  const failed = new Set(failedCommits);
  return {
    ...manifest,
    steps: manifest.steps.map((s) => {
      const { humanFailsGate: _old, ...rest } = s;
      return (s.kind === "task" || s.kind === "maintenance") && failed.has(s.commit)
        ? { ...rest, humanFailsGate: true }
        : rest;
    }),
  };
}

export interface StreamSegment {
  id: string;
  // 该流起点处人的代码
  startCommit: string;
  // 流内的步序（含首尾）；重置步本身不在任何流内，它的提交是下一条流的起点
  firstSeq: number;
  lastSeq: number;
}

export interface StreamManifest {
  version: 1;
  repo: string;
  rangeStart: string;
  rangeEnd: string;
  gateCommand: readonly string[];
  steps: readonly StreamStep[];
  streams: readonly StreamSegment[];
}

// 题面：开头每行一个本题测试文件的路径（相对仓库根；全文过长被截断时路径仍在），
// 其后是提交信息原文，再逐个附上该步新增或修改的测试文件全文。与 M9 同一做法，不加任何包装措辞
export function buildTaskPrompt(
  message: string,
  tests: readonly { path: string; content: string }[]
): string {
  const parts = tests.length > 0 ? [tests.map((t) => t.path).join("\n")] : [];
  parts.push(message.trimEnd());
  for (const t of tests) parts.push(`--- ${t.path} ---\n${t.content.trimEnd()}`);
  return `${parts.join("\n\n")}\n`;
}

// 题面格式（198、213）：提交信息加应通过的测试名单，不附测试内容。名单先给测试文件路径（test-files）；给用例名
// （test-cases）作为校准做成率过低时的备用，要先算出人在该步使其由失败变通过的用例，由跑批器二接上
export type TaskPromptFormat = "test-files" | "test-cases";
export const TASK_PROMPT_FORMATS: readonly TaskPromptFormat[] = ["test-files", "test-cases"];
export const DEFAULT_TASK_PROMPT_FORMAT: TaskPromptFormat = "test-files";

// 名单前的一行说明：名单里的测试（新写的或改过的）此刻不在工作区里或还是旧版本，判题时才放入
const SHOULD_PASS_HEADINGS: Record<TaskPromptFormat, string> = {
  "test-files":
    "Test files that should pass after the change (new or updated; their final versions are not in the repository and are added when the change is checked):",
  "test-cases":
    "Test cases that should pass after the change (in new or updated test files; their final versions are not in the repository and are added when the change is checked):",
};

// 第二段名单前的一行说明：要做到的用例落在本题新写或改过的测试文件之外时，这些用例所在的、仓库里本来就有的测试文件
// （或用例名）此刻失败、改完应通过；这些文件照常在工作区里，不扣下
const OTHER_FAILING_HEADINGS: Record<TaskPromptFormat, string> = {
  "test-files":
    "Other test files already in the repository that currently fail and should pass after the change:",
  "test-cases":
    "Other test cases in test files already in the repository that currently fail and should pass after the change:",
};

// 题面的版式（进身份头比对）：应通过的名单，另有要做到的用例落在本题测试文件之外时再列第二段
export const TASK_PROMPT_LAYOUT =
  "commit message; should-pass list; second list of other failing tests already in the repository";

// 题面的接口说明（374）：测试要用到、起点里没有的模块与名字及签名，由分析包按规则抽出（eval/analysis 的
// task_interface.py），跑批器只渲染。kind 为 class、function、async function 或 other；params 为参数表（不带括号），
// returns 为返回注解，没有即 null
export interface TaskInterfaceName {
  name: string;
  kind: "class" | "function" | "async function" | "other";
  params: string | null;
  returns: string | null;
}

export interface TaskInterfaceModule {
  module: string;
  // 起点里没有这个模块
  newModule: boolean;
  names: readonly TaskInterfaceName[];
}

// 接口说明一节的说明行，定稿原文（374；属于被测条件，定稿后不再改）。分析包 task_interface.py 的
// INTERFACES_HEADING 与它逐字一致
const INTERFACES_HEADING =
  "Modules and names used by these tests that are not in the repository yet (listed by signature):";

// 带接口说明时的版式（进身份头比对）；不带时仍是 TASK_PROMPT_LAYOUT
export const TASK_PROMPT_LAYOUT_WITH_INTERFACES = `${TASK_PROMPT_LAYOUT}; interface section after the lists`;

const DECLARATION_KEYWORDS: Record<TaskInterfaceName["kind"], string> = {
  class: "class ",
  function: "def ",
  "async function": "async def ",
  other: "",
};

// 一个名字一行：类给构造参数，函数给参数与返回注解，其余（及构造参数定不下来的类）只给名字
function interfaceLine(n: TaskInterfaceName): string {
  const head = `${DECLARATION_KEYWORDS[n.kind]}${n.name}`;
  if (n.kind === "other" || n.params === null) return head;
  return `${head}(${n.params})${n.returns !== null ? ` -> ${n.returns}` : ""}`;
}

// 接口说明一节：说明行，其后每个模块一行（起点没有的标 new module），模块下的名字各缩进两格一行；没有内容为空串
export function interfacesSection(modules: readonly TaskInterfaceModule[]): string {
  if (modules.length === 0) return "";
  const lines = [INTERFACES_HEADING];
  for (const m of modules) {
    lines.push(`${m.module}${m.newModule ? " (new module)" : ""}`);
    for (const n of m.names) lines.push(`  ${interfaceLine(n)}`);
  }
  return lines.join("\n");
}

// 跑批器拼的题面：提交信息原文，其后一行说明与应通过的测试名单（每行一个）；第二段只在 otherFailing 不为空时出现；
// 接口说明（374）只在 interfaces 不为空时接在名单之后。两段名单都为空时只有提交信息（与接口说明）
export function taskPromptOf(
  message: string,
  format: TaskPromptFormat,
  shouldPass: readonly string[],
  otherFailing: readonly string[] = [],
  interfaces: readonly TaskInterfaceModule[] = []
): string {
  const parts = [message.trimEnd()];
  if (shouldPass.length > 0)
    parts.push(`${SHOULD_PASS_HEADINGS[format]}\n${shouldPass.join("\n")}`);
  if (otherFailing.length > 0)
    parts.push(`${OTHER_FAILING_HEADINGS[format]}\n${otherFailing.join("\n")}`);
  if (interfaces.length > 0) parts.push(interfacesSection(interfaces));
  return `${parts.join("\n\n")}\n`;
}

// 固定起点的步（215、216）：清单里的题按时间接成一条流，维护步、套用步与跳过步都不跑，重置点不再切分
export const TASK_CHAIN_ID = "tasks";
// 身份头里记的步的范围
export const TASK_CHAIN_SCOPE =
  "fixed-start: all tasks chained in time order; non-task steps not run";

export function chainedTasks(manifest: StreamManifest): StreamStep[] {
  return manifest.steps.filter((s) => s.kind === "task");
}

export type ReadHumanFile = (sha: string, path: string) => string;

interface Classified {
  commit: CommitFacts;
  kinds: Map<string, StreamFileKind>;
}

function classify(profile: RepoProfile, commit: CommitFacts): Classified {
  const kinds = new Map<string, StreamFileKind>();
  for (const f of commit.files) kinds.set(f.path, profile.classifyFile(f.path));
  return { commit, kinds };
}

function filesOf(c: Classified, ...wanted: StreamFileKind[]): CommitFileChange[] {
  return c.commit.files.filter((f) => wanted.includes(c.kinds.get(f.path) ?? "other"));
}

function liveTests(c: Classified): string[] {
  return filesOf(c, "test")
    .filter((f) => f.status !== "D")
    .map((f) => f.path);
}

function humanOps(c: Classified, ...wanted: StreamFileKind[]): HumanFileOp[] {
  return filesOf(c, ...wanted).map((f) => ({
    path: f.path,
    op: f.status === "D" ? "delete" : "write",
    kind: c.kinds.get(f.path) ?? "other",
  }));
}

// 同一路径以后者为准（红测试对合并时两次提交可能改同一文件）
function mergeOps(...lists: HumanFileOp[][]): HumanFileOp[] {
  const byPath = new Map<string, HumanFileOp>();
  for (const list of lists) for (const op of list) byPath.set(op.path, op);
  return [...byPath.values()];
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function requireProbe(c: Classified): TestProbe {
  if (c.commit.probe === undefined) throw new Error(`提交 ${c.commit.sha} 带测试改动但缺判题探针`);
  return c.commit.probe;
}

// 红测试对（127）：提交自身测试不过、且下一次提交让它过；两次提交合为一题
function isRedPairHead(c: Classified, next: Classified | undefined, profile: RepoProfile): boolean {
  if (next === undefined || profile.resetReason(next.commit) !== null) return false;
  if (liveTests(c).length === 0) return false;
  const probe = requireProbe(c);
  return probe.parentFails && !probe.commitPasses && c.commit.nextPasses === true;
}

type Draft = Omit<StreamStep, "seq">;

function draftOne(c: Classified, profile: RepoProfile, read: ReadHumanFile): Draft {
  const { commit } = c;
  const base = {
    commit: commit.sha,
    parent: commit.parent,
    subject: commit.subject,
    message: commit.message.trimEnd(),
  };
  const reset = profile.resetReason(commit);
  if (reset !== null) {
    return { ...base, kind: "reset", prompt: null, humanFiles: [], judgeTests: [], reason: reset };
  }
  const relevant = filesOf(c, "source", "test", "testaux", "env");
  if (relevant.length === 0) {
    return {
      ...base,
      kind: "skip",
      prompt: null,
      humanFiles: [],
      judgeTests: [],
      reason: "不碰被测代码",
    };
  }
  const humanFiles = humanOps(c, "test", "testaux", "env");
  const tests = liveTests(c);
  // 带测试改动的提交一律要探针，只改测试的也不例外：红测试对的先手正是只改测试的提交
  const probe = tests.length > 0 ? requireProbe(c) : undefined;
  if (filesOf(c, "source").length === 0) {
    return {
      ...base,
      kind: "apply",
      prompt: null,
      humanFiles,
      judgeTests: [],
      reason: "只改测试、测试辅助或环境文件，套用人的版本",
    };
  }
  if (probe !== undefined) {
    if (probe.parentFails && probe.commitPasses) {
      return {
        ...base,
        kind: "task",
        prompt: buildTaskPrompt(
          commit.message,
          tests.map((path) => ({ path, content: read(commit.sha, path) }))
        ),
        humanFiles,
        judgeTests: tests,
        reason: "测试改动在父提交上失败、在本提交上通过",
      };
    }
  }
  if (commit.formatOnly === undefined)
    throw new Error(`提交 ${commit.sha} 改了源代码且不成题，但缺格式化比对结果`);
  if (commit.formatOnly) {
    return {
      ...base,
      kind: "skip",
      prompt: null,
      humanFiles: [],
      judgeTests: [],
      reason: "只有格式变化",
    };
  }
  return {
    ...base,
    kind: "maintenance",
    prompt: `${commit.message.trimEnd()}\n`,
    humanFiles,
    judgeTests: [],
    reason:
      tests.length > 0
        ? "改了源代码，测试在父提交上已通过或本提交上也不过"
        : "改了源代码但不带测试",
  };
}

function draftRedPair(head: Classified, fix: Classified, read: ReadHumanFile): Draft {
  const testsHead = liveTests(head);
  const testsFix = liveTests(fix);
  const all = unique([...testsHead, ...testsFix]);
  // 同一路径取修复提交里的版本（修复提交若改了测试，以它为准）
  const contents = all.map((path) => ({
    path,
    content: read(testsFix.includes(path) ? fix.commit.sha : head.commit.sha, path),
  }));
  return {
    kind: "task",
    commit: fix.commit.sha,
    parent: head.commit.parent,
    mergedCommits: [head.commit.sha, fix.commit.sha],
    subject: fix.commit.subject,
    message: `${head.commit.message.trimEnd()}\n\n${fix.commit.message.trimEnd()}`,
    prompt: buildTaskPrompt(
      `${head.commit.message.trimEnd()}\n\n${fix.commit.message.trimEnd()}`,
      contents
    ),
    humanFiles: mergeOps(
      humanOps(head, "test", "testaux", "env"),
      humanOps(fix, "test", "testaux", "env")
    ),
    judgeTests: all,
    reason: "红测试对：先提交的测试在自身上不过、在下一次提交上通过，合为一题",
  };
}

// 按写死的规则给一段历史出清单。commits 为 rangeStart 之后到 rangeEnd（含）的主线提交，按时间正序
export function composeStreamManifest(input: {
  profile: RepoProfile;
  rangeStart: string;
  commits: readonly CommitFacts[];
  readHumanFile: ReadHumanFile;
}): StreamManifest {
  const { profile, commits } = input;
  const last = commits.at(-1);
  if (last === undefined) throw new Error("提交区间为空");
  // 探针环境错误的提交不能定性：单列出来，处理方式待定之前不出清单
  const envErrors = commits.filter((c) => c.environmentError !== undefined);
  if (envErrors.length > 0) {
    throw new Error(
      `探针环境错误的提交，处理方式待定：${envErrors
        .map((c) => `${c.sha.slice(0, 9)}（${c.environmentError}）`)
        .join("；")}`
    );
  }
  const classified = commits.map((c) => classify(profile, c));
  const drafts: Draft[] = [];
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i] as Classified;
    const next = classified[i + 1];
    if (
      profile.resetReason(c.commit) === null &&
      isRedPairHead(c, next, profile) &&
      next !== undefined
    ) {
      drafts.push(draftRedPair(c, next, input.readHumanFile));
      i++;
      continue;
    }
    drafts.push(draftOne(c, profile, input.readHumanFile));
  }
  const steps: StreamStep[] = drafts.map((d, i) => ({ seq: i + 1, ...d }));
  return {
    version: 1,
    repo: profile.name,
    rangeStart: input.rangeStart,
    rangeEnd: last.sha,
    gateCommand: [...profile.gateCommand],
    steps,
    streams: splitStreams(input.rangeStart, steps),
  };
}

// 在重置点把清单切成若干条流：重置步的提交即下一条流的起点
function splitStreams(rangeStart: string, steps: readonly StreamStep[]): StreamSegment[] {
  const out: StreamSegment[] = [];
  let start = rangeStart;
  let first: number | null = null;
  let lastSeq = 0;
  const close = () => {
    if (first !== null)
      out.push({ id: `s${out.length + 1}`, startCommit: start, firstSeq: first, lastSeq });
    first = null;
  };
  for (const s of steps) {
    if (s.kind === "reset") {
      close();
      start = s.commit;
      continue;
    }
    if (first === null) first = s.seq;
    lastSeq = s.seq;
  }
  close();
  return out;
}

export function countStepKinds(steps: readonly StreamStep[]): Record<StreamStepKind, number> {
  const counts: Record<StreamStepKind, number> = {
    task: 0,
    maintenance: 0,
    apply: 0,
    skip: 0,
    reset: 0,
  };
  for (const s of steps) counts[s.kind]++;
  return counts;
}

export function stepsOf(manifest: StreamManifest, streamId: string): StreamStep[] {
  const seg = manifest.streams.find((s) => s.id === streamId);
  if (seg === undefined) throw new Error(`清单里没有流 ${streamId}`);
  return manifest.steps.filter((s) => s.seq >= seg.firstSeq && s.seq <= seg.lastSeq);
}
