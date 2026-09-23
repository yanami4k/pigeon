// 结构化记忆的事实派生（决策 131 / 132 / 133）：由程序从一个会话的账本推出两类"摩擦"，不经模型。
// - 回归与约束的红转绿：一步之中某次验证在题面以外的检查上失败，后续回炉后该检查转为通过。
//   格式、类型、分层（以及识别不出类型的步骤）的失败一律算；测试步只算"本步没有新增或修改过的测试文件"里的失败用例，
//   测试步输出无法解析时无法判断是否属题面，不记。
// - 被撤回的尝试：一步按 154（2026-09-23 修订）推断为已撤回时，记本步尝试改动过的文件与最后一次验证里失败的步名与指纹
//   （无法解析的记为未识别指纹）。
// 两类都只产生于回炉开启的一步（一个会话即一步，见 repair-step.ts）；每条事实只带一个指纹，同一次摩擦有几个指纹就展开成几条。
// 改动文件的取法：编辑工具调用（intent 的路径参数，且回执为已执行、未出错）、命令执行回执里的文件变化，外加调用方从快照之间的
// 差异算出的文件（git 在 IO 层，本模块只收结果）；三者按时间合并。工具报错、围栏拒绝、每步改动摘要与读过哪些文件都不记。
// 纯函数，无 IO。
import type { SessionId } from "./ids.ts";
import type { MaterializedSession } from "./materialize.ts";
import { lastGateVerificationOf, repairRoundsOf, repairStepOutcome } from "./repair-step.ts";
import {
  type Fingerprint,
  fingerprintKey,
  parseStepOutput,
  type StepFingerprints,
  type VerifyStepKind,
} from "./verify-fingerprint.ts";
import { LEGACY_VERIFY_STEP_NAME, recordStepsOf, underStepCwd } from "./verify-steps.ts";

export type FrictionKind = "regression" | "reverted";

export interface FrictionFact {
  kind: FrictionKind;
  sessionId: SessionId;
  stepName: string;
  stepKind: VerifyStepKind;
  fingerprint: Fingerprint;
  // 指纹键（步名、工具、错误码或规则或测试名、文件），合并用
  fingerprintKey: string;
  // 事发时刻：红转绿为转绿那次验证的时间，撤回为最后一次验证的时间（改动幅度从这里起算）
  at: number;
  // 执行验证的工作区（绝对路径；改动文件与报错路径都相对它）
  workspace: string;
  // 红转绿：变红那次验证的时间、变红时本步已改动的文件、之后回炉各轮补改的文件
  redAt?: number;
  changedAtRed?: string[];
  repairFiles?: string[];
  // 撤回：本步尝试改动过的文件
  attemptedFiles?: string[];
}

// 一次文件改动（时间取落盘记录的时间）
export interface FileChangeEvent {
  at: number;
  files: string[];
}

// 一对相邻快照：改动文件由调用方用 git 比较两次提交算出，时间取后一个快照记录
export interface CheckpointPair {
  at: number;
  from: string;
  to: string;
}

type DerivableSession = Pick<
  MaterializedSession,
  "sessionId" | "records" | "runStarteds" | "attemptVerifieds" | "checkpoints"
>;

// 相对工作区的正斜杠路径；工作区外的绝对路径原样（正斜杠）保留
export function workspaceRelative(file: string, workspace: string | undefined): string {
  const normalized = file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (workspace === undefined) {
    return normalized;
  }
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  const rootLower = root.toLowerCase();
  if (lower.startsWith(`${rootLower}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

// 工具在某一步里报出的路径 → 相对工作区根的路径：绝对路径按工作区相对化；相对路径是相对这一步的执行目录报的，补上执行目录
export function reportedPathOf(
  file: string,
  workspace: string,
  stepCwd: string | undefined
): string {
  const normalized = file.trim().replace(/\\/g, "/");
  return /^([A-Za-z]:)?\//.test(normalized)
    ? workspaceRelative(normalized, workspace)
    : underStepCwd(normalized, stepCwd);
}

// 本会话的快照链：首个快照对比它的改前基线，之后每个对比上一个
export function checkpointPairsOf(
  session: Pick<MaterializedSession, "checkpoints">
): CheckpointPair[] {
  const pairs: CheckpointPair[] = [];
  let previous: string | undefined;
  for (const record of session.checkpoints) {
    const from = previous ?? record.payload.baseCommit;
    if (from !== undefined) {
      pairs.push({ at: record.timestamp, from, to: record.payload.commit });
    }
    previous = record.payload.commit;
  }
  return pairs;
}

// 账本里的文件改动：已执行且未出错的编辑调用的路径参数，加上命令执行回执里的文件变化
export function ledgerFileChanges(
  session: Pick<MaterializedSession, "records">,
  workspace: string | undefined
): FileChangeEvent[] {
  const editPaths = new Map<string, string>();
  const events: FileChangeEvent[] = [];
  for (const record of session.records) {
    if (record.kind === "intent" && record.toolName === "edit_file") {
      const raw = record.rawArgs as { path?: unknown } | undefined;
      if (typeof raw?.path === "string" && raw.path.trim() !== "") {
        editPaths.set(record.executionId, raw.path);
      }
      continue;
    }
    if (record.kind !== "receipt" || !record.receipt.executed || record.receipt.isError) {
      continue;
    }
    const files: string[] = [];
    const edited = editPaths.get(record.receipt.executionId);
    if (edited !== undefined) {
      files.push(edited);
    }
    const changes = record.receipt.exec?.fileChanges;
    if (changes !== undefined) {
      files.push(...changes.added, ...changes.removed, ...changes.modified);
    }
    // 治理目录（会话文件、缓存）的变化不是代码改动
    const code = files
      .map((file) => workspaceRelative(file, workspace))
      .filter((file) => file !== ".pigeon" && !file.startsWith(".pigeon/"));
    if (code.length > 0) {
      events.push({ at: record.timestamp, files: code });
    }
  }
  return events;
}

function filesIn(
  events: readonly FileChangeEvent[],
  after: number | undefined,
  upTo: number | undefined
): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if ((after === undefined || event.at > after) && (upTo === undefined || event.at <= upTo)) {
      for (const file of event.files) {
        files.add(file);
      }
    }
  }
  return [...files].sort();
}

interface ParsedStep {
  name: string;
  verdict: "pass" | "fail" | "undetermined";
  parsed: StepFingerprints;
}

interface ParsedVerification {
  at: number;
  workspace: string;
  steps: Map<string, ParsedStep>;
}

type GateRecord = MaterializedSession["attemptVerifieds"][number];

function parseVerification(
  record: GateRecord,
  commands: ReadonlyMap<string, string>
): ParsedVerification {
  const steps = new Map<string, ParsedStep>();
  for (const step of recordStepsOf(record)) {
    const command = commands.get(step.name);
    const parsed = parseStepOutput({
      name: step.name,
      ...(command !== undefined ? { command } : {}),
      output: step.output,
    });
    // 报错路径统一为相对工作区根（在子目录里执行的步骤补上执行目录）
    parsed.fingerprints = parsed.fingerprints.map((entry) => ({
      ...entry,
      ...(entry.file !== undefined
        ? { file: reportedPathOf(entry.file, record.workspace, step.cwd) }
        : {}),
      ...(entry.to !== undefined
        ? { to: reportedPathOf(entry.to, record.workspace, step.cwd) }
        : {}),
    }));
    steps.set(step.name, { name: step.name, verdict: step.verdict, parsed });
  }
  return { at: record.timestamp, workspace: record.workspace, steps };
}

// 某步变红时算作摩擦的指纹：测试步只算题面以外（本步没有新增或修改过的测试文件）的失败用例，输出无法解析即不算；
// 其余类型一律算（无法解析的记未识别指纹）
function countedFingerprints(step: ParsedStep, stepFiles: ReadonlySet<string>): Fingerprint[] {
  if (step.verdict !== "fail") {
    return [];
  }
  if (step.parsed.kind !== "test") {
    return step.parsed.fingerprints;
  }
  if (!step.parsed.recognized) {
    return [];
  }
  return step.parsed.fingerprints.filter(
    (entry) => entry.file === undefined || !stepFiles.has(entry.file)
  );
}

// 这一步在这次验证里是否已把这些指纹修好：非测试步看整步通过；测试步看这些用例不再失败（输出须能解析，否则不算修好）
function resolved(step: ParsedStep | undefined, open: readonly Fingerprint[]): boolean {
  if (step === undefined || step.verdict === "undetermined") {
    return false;
  }
  if (step.verdict === "pass") {
    return true;
  }
  if (step.parsed.kind !== "test" || !step.parsed.recognized) {
    return false;
  }
  const failing = new Set(
    step.parsed.fingerprints.map((entry) => fingerprintKey(step.name, entry))
  );
  return open.every((entry) => !failing.has(fingerprintKey(step.name, entry)));
}

// 本会话里验证门写下的各步命令（取自 run.started 冻结的验证配置），供识别不了工具时按命令推断步骤类型
function stepCommands(session: Pick<MaterializedSession, "runStarteds">): Map<string, string> {
  const verify = session.runStarteds[0]?.payload.verify;
  const commands = new Map<string, string>();
  for (const step of verify?.steps ?? []) {
    commands.set(step.name, step.command);
  }
  if (verify !== undefined && verify.steps === undefined) {
    commands.set(LEGACY_VERIFY_STEP_NAME, verify.command);
  }
  return commands;
}

export interface DeriveOptions {
  // 调用方从快照之间的差异算出的文件改动（没有快照或 git 不可用时缺省）
  snapshotChanges?: readonly FileChangeEvent[];
}

// 一个会话（回炉开启的一步）派生出的全部摩擦事实；回炉未开启返回空
export function deriveSessionFrictions(
  session: DerivableSession,
  options: DeriveOptions = {}
): FrictionFact[] {
  if (repairRoundsOf(session) === 0) {
    return [];
  }
  const gates = session.attemptVerifieds
    .filter((record) => record.target.sessionId === session.sessionId)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (gates.length === 0) {
    return [];
  }
  const workspace = gates[0]?.workspace;
  const changes = [
    ...ledgerFileChanges(session, workspace),
    ...(options.snapshotChanges ?? []).map((event) => ({
      at: event.at,
      files: event.files.map((file) => workspaceRelative(file, workspace)),
    })),
  ];
  const commands = stepCommands(session);
  const verifications = gates.map((record) => parseVerification(record, commands));
  const stepFiles = new Set(filesIn(changes, undefined, undefined));
  const facts: FrictionFact[] = [];

  // 红转绿：按步名逐次扫描，一段"变红到转绿"记一次
  const stepNames = [...new Set(verifications.flatMap((entry) => [...entry.steps.keys()]))];
  for (const name of stepNames) {
    let open: { index: number; fingerprints: Fingerprint[] } | undefined;
    for (const [index, verification] of verifications.entries()) {
      const step = verification.steps.get(name);
      if (open !== undefined) {
        if (!resolved(step, open.fingerprints)) {
          continue;
        }
        const red = verifications[open.index] as ParsedVerification;
        const changedAtRed = filesIn(changes, undefined, red.at);
        const repairFiles = filesIn(changes, red.at, verification.at);
        const kind = red.steps.get(name)?.parsed.kind ?? "unknown";
        for (const fingerprint of open.fingerprints) {
          facts.push({
            kind: "regression",
            sessionId: session.sessionId,
            stepName: name,
            stepKind: kind,
            fingerprint,
            fingerprintKey: fingerprintKey(name, fingerprint),
            at: verification.at,
            workspace: verification.workspace,
            redAt: red.at,
            changedAtRed,
            repairFiles,
          });
        }
        open = undefined;
        continue;
      }
      if (step === undefined) {
        continue;
      }
      const counted = countedFingerprints(step, stepFiles);
      if (counted.length > 0) {
        open = { index, fingerprints: counted };
      }
    }
  }

  // 被撤回的尝试（154 修订：回炉开启、最后一个 Run 有验证记录且为失败）
  const outcome = repairStepOutcome(session);
  const lastRun = session.runStarteds.at(-1)?.runId;
  const last = lastRun !== undefined ? lastGateVerificationOf(session, lastRun) : undefined;
  if (outcome?.reverted === true && last !== undefined) {
    const parsed = parseVerification(last, commands);
    const attemptedFiles = [...stepFiles].sort();
    for (const step of parsed.steps.values()) {
      if (step.verdict !== "fail") {
        continue;
      }
      for (const fingerprint of step.parsed.fingerprints) {
        facts.push({
          kind: "reverted",
          sessionId: session.sessionId,
          stepName: step.name,
          stepKind: step.parsed.kind,
          fingerprint,
          fingerprintKey: fingerprintKey(step.name, fingerprint),
          at: parsed.at,
          workspace: parsed.workspace,
          attemptedFiles,
        });
      }
    }
  }
  return facts;
}

// 一条事实挂在哪些文件上（决策 133）：红转绿挂报错所在文件、变红时已改文件与回炉补改文件；撤回挂尝试改过的文件与报错文件
export function frictionAnchors(fact: FrictionFact): string[] {
  const files = new Set<string>();
  const add = (file: string | undefined) => {
    if (file !== undefined && file !== "") {
      files.add(file);
    }
  };
  add(fact.fingerprint.file);
  add(fact.fingerprint.to);
  for (const file of [
    ...(fact.changedAtRed ?? []),
    ...(fact.repairFiles ?? []),
    ...(fact.attemptedFiles ?? []),
  ]) {
    add(file);
  }
  return [...files].sort();
}
