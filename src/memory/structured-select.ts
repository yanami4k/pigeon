// 结构化记忆的挑选、用前核验与推送文字（决策 134 / 135 / 136）。只在开局与回炉两个时机由程序推送，不做模型自取的查询工具。
// - 开局挑选：只用题面直接指到的文件——题面里出现的路径，以及题面所附代码中的导入语句解析出的仓库内文件；取挂在这些文件上的
//   记忆，最多 2 条；指不到或这些文件上没有记忆就一条都不给。
// - 回炉挑选：报错指纹对上的优先（同一步、同一错误码或测试名、同一文件），其次是挂在本次报错涉及文件上的记忆，最多 2 条。
// - 两处挑选后、给出前逐条核验：锚点文件仍存在；报错里附带的名字（类型检查的标识符、测试名）仍能在报错所在的文件里以文本找到；
//   分层违规的两端模块文件仍存在。文件都按版本历史里的改名追踪。任一不过即不给。事发以来锚点文件的改动幅度只用于排序，
//   改得越少越靠前；不按"多久没被用到"淘汰。同一指纹只给一条。
// 不解析代码：导入语句按文本匹配、名字按文本查找。

import { reportedPathOf } from "../state/structured-memory.ts";
import {
  describeFingerprint,
  type Fingerprint,
  fingerprintKey,
  parseStepOutput,
} from "../state/verify-fingerprint.ts";
import type { VerifyStepResult } from "../state/verify-steps.ts";
import type { MemoryEntry } from "./structured-store.ts";
import type { WorkspaceProbe } from "./structured-workspace.ts";

// 开局与回炉各自最多给几条（决策 135）
export const STRUCTURED_MEMORY_LIMIT = 2;
// 结构化记忆段落的字符预算：与常驻 Memory 分开计（决策 129），每条另有上限
export const STRUCTURED_MEMORY_BUDGET_CHARS = 1200;
const ENTRY_TEXT_LIMIT = 400;
// 参与核验与排序的候选上限（按最近出现排序后截取），防止热门文件上的大量记忆拖慢开局
const CANDIDATE_LIMIT = 50;

export const STRUCTURED_MEMORY_DISCLAIMER = "过去发生的事实，仅供参考；与当前代码冲突时以代码为准";

// ---- 用前核验 ----

export interface EntryCheck {
  ok: boolean;
  // 不过的原因（给只读命令与测试看）
  reason?: string;
  // 事发以来锚点文件的改动行数（只用于排序）
  changedLines: number;
}

// 核验一条记忆：锚点文件在；报错名字仍在报错所在文件里（改名追踪）；分层违规两端都在
export function checkEntry(entry: MemoryEntry, probe: WorkspaceProbe): EntryCheck {
  const since = entry.latest.at;
  const anchor = probe.renamedSince(entry.anchor, since);
  if (!probe.exists(anchor)) {
    return { ok: false, reason: `锚点文件已不存在：${entry.anchor}`, changedLines: 0 };
  }
  const fingerprint = entry.fingerprint;
  if (fingerprint.file !== undefined) {
    const errorFile = probe.renamedSince(fingerprint.file, since);
    const content = probe.read(errorFile);
    if (content === undefined) {
      return { ok: false, reason: `报错所在文件已不存在：${fingerprint.file}`, changedLines: 0 };
    }
    // 同一指纹合并了几处报错的名字：任一仍在即算通过
    if (fingerprint.names.length > 0 && !fingerprint.names.some((name) => content.includes(name))) {
      return {
        ok: false,
        reason: `名字 ${fingerprint.names.join("、")} 都已不在 ${errorFile} 里`,
        changedLines: 0,
      };
    }
  }
  if (fingerprint.to !== undefined && !probe.exists(probe.renamedSince(fingerprint.to, since))) {
    return { ok: false, reason: `分层违规的被依赖端已不存在：${fingerprint.to}`, changedLines: 0 };
  }
  return { ok: true, changedLines: probe.changedLinesSince(anchor, since) };
}

// ---- 挑选 ----

export interface MemoryPick {
  entry: MemoryEntry;
  changedLines: number;
}

export type EntryChecker = (entry: MemoryEntry, probe: WorkspaceProbe) => EntryCheck;

// 一次挑选的结果：给出的条目，与参与核验而没过、被拦下的条目编号（跑批器据此判断这一组是否真的拿到了记忆）
export interface MemorySelection {
  picks: MemoryPick[];
  blocked: string[];
}

// 核验、排序（改动越少越前，其次越新越前、出现越多越前）、同一指纹只留一条，取前 limit 条
function verifiedTop(
  candidates: readonly MemoryEntry[],
  probe: WorkspaceProbe,
  limit: number,
  check: EntryChecker,
  taken: Set<string>
): MemorySelection {
  const recent = [...candidates]
    .sort((left, right) => right.latest.at - left.latest.at)
    .slice(0, CANDIDATE_LIMIT);
  // 同一指纹只给一条，跨种类也一样：按指纹分组，组内核验后挑代表——红转绿优先（带修法），同种类取最近一次，再比改动幅度
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of recent) {
    if (taken.has(entry.fingerprintKey)) {
      continue;
    }
    groups.set(entry.fingerprintKey, [...(groups.get(entry.fingerprintKey) ?? []), entry]);
  }
  const representative = new Map<string, MemoryPick>();
  // 整组都没过核验的组：记组头（按同一偏好排在最前的那条），再看它是否落在名额之内
  const failedHeads = new Map<string, MemoryEntry>();
  for (const [key, members] of groups) {
    for (const entry of members) {
      const result = check(entry, probe);
      if (!result.ok) {
        continue;
      }
      const pick = { entry, changedLines: result.changedLines };
      const current = representative.get(key);
      if (current === undefined || betterRepresentative(pick, current)) {
        representative.set(key, pick);
      }
    }
    if (!representative.has(key)) {
      const head = [...members].sort((left, right) =>
        betterRepresentative({ entry: left, changedLines: 0 }, { entry: right, changedLines: 0 })
          ? -1
          : 1
      )[0];
      if (head !== undefined) {
        failedHeads.set(key, head);
      }
    }
  }
  // 被拦下：按核验前的次序（最近出现、出现次数、编号）排组，前 limit 组里整组没过核验的，即"本会给出但被拦下"
  const blocked = [...groups.keys()]
    .map((key) => representative.get(key)?.entry ?? failedHeads.get(key))
    .filter((entry): entry is MemoryEntry => entry !== undefined)
    .sort(
      (left, right) =>
        right.latest.at - left.latest.at ||
        right.count - left.count ||
        left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, limit))
    .filter((entry) => !representative.has(entry.fingerprintKey))
    .map((entry) => entry.id);
  const ranked = [...representative.values()].sort(
    (left, right) =>
      left.changedLines - right.changedLines ||
      right.entry.latest.at - left.entry.latest.at ||
      right.entry.count - left.entry.count ||
      left.entry.id.localeCompare(right.entry.id)
  );
  const picks: MemoryPick[] = [];
  for (const pick of ranked) {
    if (picks.length >= limit || taken.has(pick.entry.fingerprintKey)) {
      continue;
    }
    taken.add(pick.entry.fingerprintKey);
    picks.push(pick);
  }
  return { picks, blocked };
}

function betterRepresentative(candidate: MemoryPick, current: MemoryPick): boolean {
  if (candidate.entry.kind !== current.entry.kind) {
    return candidate.entry.kind === "regression";
  }
  if (candidate.entry.latest.at !== current.entry.latest.at) {
    return candidate.entry.latest.at > current.entry.latest.at;
  }
  return candidate.changedLines < current.changedLines;
}

// 锚点的当前路径：按版本历史追踪事发以来的改名
function currentAnchor(entry: MemoryEntry, probe: WorkspaceProbe): string {
  return probe.renamedSince(entry.anchor, entry.latest.at);
}

// 开局：只取挂在题面直接指到的文件上的记忆
export function selectOpening(
  entries: readonly MemoryEntry[],
  referencedFiles: readonly string[],
  probe: WorkspaceProbe,
  check: EntryChecker = checkEntry,
  limit: number = STRUCTURED_MEMORY_LIMIT
): MemorySelection {
  const files = new Set(referencedFiles);
  const candidates = entries.filter((entry) => files.has(currentAnchor(entry, probe)));
  return verifiedTop(candidates, probe, limit, check, new Set());
}

// 本次验证失败各步的指纹（与派生同一套解析，路径相对工作区）
export function failingFingerprints(
  steps: readonly VerifyStepResult[],
  workspace: string
): Array<{ stepName: string; fingerprint: Fingerprint }> {
  return steps
    .filter((step) => step.verdict === "fail")
    .flatMap((step) =>
      parseStepOutput({ name: step.name, output: step.output }).fingerprints.map((fingerprint) => ({
        stepName: step.name,
        fingerprint: {
          ...fingerprint,
          ...(fingerprint.file !== undefined
            ? { file: reportedPathOf(fingerprint.file, workspace, step.cwd) }
            : {}),
          ...(fingerprint.to !== undefined
            ? { to: reportedPathOf(fingerprint.to, workspace, step.cwd) }
            : {}),
        },
      }))
    );
}

// 回炉：指纹对上的优先，其次是挂在本次报错涉及文件上的记忆
export function selectRepair(
  entries: readonly MemoryEntry[],
  failing: ReadonlyArray<{ stepName: string; fingerprint: Fingerprint }>,
  probe: WorkspaceProbe,
  check: EntryChecker = checkEntry,
  limit: number = STRUCTURED_MEMORY_LIMIT
): MemorySelection {
  // 未识别的指纹没有错误码、测试名与文件，谈不上"对上"：只参加"涉及文件"那一档
  const keys = new Set(
    failing
      .filter((entry) => entry.fingerprint.tool !== "unrecognized")
      .map((entry) => fingerprintKey(entry.stepName, entry.fingerprint))
  );
  const files = new Set(
    failing.flatMap((entry) =>
      [entry.fingerprint.file, entry.fingerprint.to].filter(
        (file): file is string => file !== undefined
      )
    )
  );
  const matched = entries.filter((entry) => keys.has(entry.fingerprintKey));
  const byFile = entries.filter(
    (entry) => !keys.has(entry.fingerprintKey) && files.has(currentAnchor(entry, probe))
  );
  const taken = new Set<string>();
  const first = verifiedTop(matched, probe, limit, check, taken);
  const second = verifiedTop(byFile, probe, limit - first.picks.length, check, taken);
  return {
    picks: [...first.picks, ...second.picks],
    blocked: [...first.blocked, ...second.blocked],
  };
}

// 固定挑选指定了视图里不存在的编号：调用方配置有误，响亮失败
export class FixedSelectionError extends Error {}

// 固定挑选（决策 157）：调用方指定的条目按给定顺序取出（同一编号去重，数量由调用方定、不受"最多 2 条"限制），
// 核验与正式挑选相同，核验没过的记为被拦下；指定的编号不存在即抛 FixedSelectionError
export function selectFixed(
  entries: readonly MemoryEntry[],
  ids: readonly string[],
  probe: WorkspaceProbe,
  check: EntryChecker = checkEntry
): MemorySelection {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const picks: MemoryPick[] = [];
  const blocked: string[] = [];
  for (const id of new Set(ids)) {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new FixedSelectionError(`固定挑选指定的记忆条目不存在：${id}`);
    }
    const result = check(entry, probe);
    if (result.ok) {
      picks.push({ entry, changedLines: result.changedLines });
    } else {
      blocked.push(entry.id);
    }
  }
  return { picks, blocked };
}

// ---- 推送文字 ----

function fileList(files: readonly string[] | undefined): string {
  const list = files ?? [];
  if (list.length === 0) {
    return "（无）";
  }
  const shown = list.slice(0, 3).join("、");
  return list.length > 3 ? `${shown} 等 ${list.length} 个文件` : shown;
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// 一条记忆的推送文字：一两句，写明是过去的事实、仅供参考、与当前代码冲突时以代码为准
export function renderEntry(entry: MemoryEntry): string {
  const fact = entry.latest;
  const what = describeFingerprint(entry.fingerprint);
  const names =
    entry.fingerprint.names.length > 0 ? `（涉及 ${entry.fingerprint.names.join("、")}）` : "";
  const repeated = entry.count > 1 ? `同类出现过 ${entry.count} 次。` : "";
  const body =
    entry.kind === "regression"
      ? `${day(fact.at)} 的一步里改动 ${fileList(fact.changedAtRed)} 后，「${entry.stepName}」检查报 ${what}${names}，` +
        `随后补改 ${fileList(fact.repairFiles)} 才通过。`
      : `${day(fact.at)} 的一步尝试改动 ${fileList(fact.attemptedFiles)}，「${entry.stepName}」检查一直报 ${what}${names}，` +
        "修到上限仍未通过、改动已撤回。";
  const text = `[${entry.id}] ${STRUCTURED_MEMORY_DISCLAIMER}：${body}${repeated}`;
  return text.length > ENTRY_TEXT_LIMIT ? `${text.slice(0, ENTRY_TEXT_LIMIT - 1)}…` : text;
}

// 固定挑选的条目成文后超出字符预算：调用方指定的内容放不下，响亮失败，不静默截断
export class StructuredMemoryBudgetError extends Error {}

// 成文的结果：段落文字与实际成文给出的条目（放不下的整条不给，留痕只记给出的）
export interface RenderedMemory {
  text: string;
  given: MemoryPick[];
}

// 按字符预算逐条放入；strict（固定挑选）时有放不下的即抛 StructuredMemoryBudgetError
function renderWithin(
  header: readonly string[],
  picks: readonly MemoryPick[],
  strict: boolean
): RenderedMemory {
  if (picks.length === 0) {
    return { text: "", given: [] };
  }
  const lines = [...header];
  const given: MemoryPick[] = [];
  for (const pick of picks) {
    const line = `- ${renderEntry(pick.entry)}`;
    if ([...lines, line].join("\n").length > STRUCTURED_MEMORY_BUDGET_CHARS) {
      if (strict) {
        throw new StructuredMemoryBudgetError(
          `固定挑选指定的记忆条目成文后超出字符预算 ${STRUCTURED_MEMORY_BUDGET_CHARS}：${pick.entry.id}`
        );
      }
      continue;
    }
    lines.push(line);
    given.push(pick);
  }
  return given.length === 0 ? { text: "", given } : { text: lines.join("\n"), given };
}

// 开局段落（拼进系统提示，与常驻 Memory 分开计预算）；没有条目为空串
export function renderOpeningSection(
  picks: readonly MemoryPick[],
  options: { strict?: boolean } = {}
): RenderedMemory {
  return renderWithin(
    ["## 结构化记忆", `以下是程序从本项目以往运行记录中取出的${STRUCTURED_MEMORY_DISCLAIMER}。`],
    picks,
    options.strict === true
  );
}

// 回炉附加内容（附在回炉反馈之后）；没有条目为空串
export function renderRepairAppendix(
  picks: readonly MemoryPick[],
  options: { strict?: boolean } = {}
): RenderedMemory {
  return renderWithin(
    [`相关的结构化记忆（${STRUCTURED_MEMORY_DISCLAIMER}）：`],
    picks,
    options.strict === true
  );
}
