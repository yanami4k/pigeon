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
  // 提交信息全文（红测试对为两段相接）；落地时程序以它提交（148）
  message: string;
  // 题：提交信息加测试文件全文；维护步：提交信息；其余为 null
  prompt: string | null;
  // 由程序从人的提交里写入工作区的文件：测试、测试辅助、环境文件；套用步为该提交的全部相关文件
  humanFiles: readonly HumanFileOp[];
  // 判题用的测试集（题才有；维护步只用验证门判）
  judgeTests: readonly string[];
  reason: string;
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

// 题面：提交信息原文，其后逐个附上该步新增或修改的测试文件全文。与 M9 同一做法，不加任何包装措辞
export function buildTaskPrompt(
  message: string,
  tests: readonly { path: string; content: string }[]
): string {
  const parts = [message.trimEnd()];
  for (const t of tests) parts.push(`--- ${t.path} ---\n${t.content.trimEnd()}`);
  return `${parts.join("\n\n")}\n`;
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
