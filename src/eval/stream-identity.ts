// 提交流跑批的身份头（决策 147，修复审计"身份头、预算缺省与两种 agent 的参数"一节）：输出目录下的 identity.json。core 为参与比对的身份——仓库、清单摘要、镜像标识、预算、
// 条件、步的范围（193、215、216 的固定起点与题的接法）、题面格式（198、213）、试跑的题数、两种 agent 的模型与推理参数
// （最简 agent 另记 mini-swe-agent 与 litellm 的版本）、选题方式，续跑时任何一项
// 与已写的不同即拒绝（条件与 agent 参数例外：按子集续跑时取并集、同一 agent 两次都记了才比，见 mergeCore），避免不同仓库、不同预算或试跑结果混进正式实验；info 只作记录不比对（路数可能因内存降；
// 续跑时路数、账号数或各账号并发上限有变即在 infoLog 追加一条）。跑批器代码版本（info.harness）例外：实验代码冻结（269）
// 后续跑时代码版本不符即拒绝，只有显式放行才通过并留痕，见 checkHarness。结果行带 core 的摘要，据此认出每行属于哪一次身份
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompactionConfig } from "../pi-runtime/index.ts";
import { describeHarness, type HarnessRef } from "./stream-harness.ts";
import type { StepBudget } from "./stream-runner.ts";

export interface StreamRunIdentity {
  core: {
    repo: string;
    manifestDigest: string;
    image: string;
    budget: StepBudget;
    conditions: readonly string[];
    // 步的范围与起点的取法：清单相同而题的接法或起点不同，结果不能混
    stepScope: string;
    // 题面格式（测试文件路径或用例名）：清单相同而题面不同，结果不能混
    promptFormat: string;
    // 题面的版式（两段名单等）：格式相同而版式不同，结果不能混
    promptLayout: string;
    // 选了哪些题（202、219）：全部、给定题号，或按种子抽样（选法、种子、样本数与抽出的题号都记下）
    taskSelection: TaskSelection;
    maxSteps: number | null;
    agents: {
      pigeon?: {
        provider: string;
        modelId: string;
        temperature: number | null;
        thinking: string | null;
        maxOutputTokens: number | null;
        // 上下文压缩的实际生效配置（188、218）：没给参数即产品缺省；加这一项之前写下的身份头没有它，续跑即判为不同
        compaction?: CompactionConfig;
        // 推送记忆（191、221、223、243）：学到的记忆的总量上限（字符）、复盘模板版本与复盘上限，实际生效的值（没给即缺省）；
        // 与压缩配置同一口径，加这几项之前写下的身份头没有它们，续跑即判为不同
        memoryLimitChars?: number;
        reviewTemplate?: string;
        reviewBudget?: { maxTurns: number; wallClockMs: number };
        // 主 agent 派 worker（265）：实际生效的值（各条件都关掉）；与压缩配置同一口径，加这一项之前写下的身份头没有它，续跑即判为不同
        spawnWorkers?: boolean;
        // 联网工具（291 与 265 的先例）：实际生效的值（各条件都关掉）；同一口径
        webTools?: boolean;
        // 取用 worker 改动的工具 take_worker（279）：与派 worker 同槽，各条件同样关掉；加这一项之前写下的身份头没有它，续跑即判为不同
        takeWorker?: boolean;
      };
      minimal?: {
        model: string;
        miniSweAgent: string | null;
        litellm: string | null;
        // 最简 agent 按决策 099 用它自己的公开设定（swebench 配置里的 model_kwargs），这里如实记下
        modelKwargs: Record<string, unknown> | null;
      };
    };
  };
  // 只记不比：路数、账号数与各账号并发上限（加账号前写下的身份头没有后两项）
  info: {
    concurrency: number;
    accounts?: number;
    accountConcurrency?: number[];
    harness: HarnessRef;
  };
}

// 稳定序列化：对象键排序
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 选题方式：题号为清单里的题按时间接成的流中的序号（从 1 起）
export type TaskSelection =
  | { method: "all" }
  | { method: "list"; tasks: number[] }
  | {
      method: "sample";
      // Python 的 random.Random(seed).sample(总体, k)，再按时间排序
      seed: number;
      k: number;
      // 总体的说明（只在要做到的用例不为零的题中抽）
      population: string;
      tasks: number[];
    };

// 按条件子集续跑（202、219）：同一输出目录可以分几次、每次只跑一部分条件。条件与各 agent 的参数因此不整体比对——条件取
// 并集；某个 agent 两次都记了参数才逐项比对，只有一边记了即补上。其余各项逐项比对。摘要不含这两项，子集续跑时不变
const MERGED_KEYS: readonly string[] = ["conditions", "agents"];

export function identityDigest(core: StreamRunIdentity["core"]): string {
  const { conditions: _conditions, agents: _agents, ...compared } = core;
  return createHash("sha256").update(canonical(compared)).digest("hex").slice(0, 16);
}

function mergeCore(
  saved: StreamRunIdentity["core"],
  now: StreamRunIdentity["core"]
): { differ: string[]; merged: StreamRunIdentity["core"] } {
  const differ: string[] = (
    Object.keys({ ...saved, ...now }) as (keyof StreamRunIdentity["core"])[]
  )
    .filter((k) => !MERGED_KEYS.includes(k))
    .filter((k) => canonical(saved[k]) !== canonical(now[k]));
  const agents = { ...(saved.agents ?? {}) } as Record<string, unknown>;
  for (const [name, settings] of Object.entries(now.agents ?? {})) {
    if (settings === undefined) continue;
    const before = agents[name] as Record<string, unknown> | undefined;
    if (before !== undefined && canonical(before) !== canonical(settings)) {
      // 列出具体不同的参数（如 agents.pigeon.compaction）
      const now = settings as Record<string, unknown>;
      for (const key of Object.keys({ ...before, ...now })) {
        if (canonical(before[key]) !== canonical(now[key])) differ.push(`agents.${name}.${key}`);
      }
    }
    agents[name] = agents[name] ?? settings;
  }
  const conditions = [...(saved.conditions ?? [])];
  for (const c of now.conditions) if (!conditions.includes(c)) conditions.push(c);
  return {
    differ,
    merged: { ...saved, conditions, agents: agents as StreamRunIdentity["core"]["agents"] },
  };
}

export function identityFile(outDir: string): string {
  return path.join(outDir, "identity.json");
}

// 身份头文件里 info 的变更记录：续跑时路数、账号数或各账号并发上限与最近一条不同即追加一条（带起始时刻），
// 结果行 gateway.accountRequests 的长度据此对上当时的账号数；续跑时经显式放行换了代码也追加一条，带放行的原因。
// info 与这些记录都不参与身份摘要
export interface StreamInfoChange {
  since: string;
  info: StreamRunIdentity["info"];
  // 经 --accept-harness-change 显式放行代码版本不符时的原因（269）
  acceptHarnessChange?: string;
}

// 身份头文件的全貌：身份、摘要、开跑时是否经 --allow-dirty-harness 放行、info 的变更记录
export interface StoredStreamIdentity extends StreamRunIdentity {
  digest?: string;
  allowDirtyHarness?: true;
  infoLog?: StreamInfoChange[];
}

// 代码版本的显式放行（269）：acceptHarnessChange 为续跑时代码版本不符的放行原因（冻结后修缺陷用）；allowDirtyHarness
// 放行首次开跑时的未提交改动或读不到的提交号（开发自测用）
export interface HarnessAllowance {
  acceptHarnessChange?: string;
  allowDirtyHarness?: boolean;
}

// 比较 info 时不看跑批器代码版本（它另由 checkHarness 比对）
function infoShape(info: StreamRunIdentity["info"]): string {
  const { harness: _harness, ...rest } = info;
  return canonical(rest);
}

// 代码版本认得出：提交号读得到且没有未提交改动。认不出的一方与谁都不能认定为同一份代码
function identifiable(ref: HarnessRef | undefined): ref is HarnessRef {
  return ref !== undefined && ref.commit !== "unknown" && ref.commit !== "" && !ref.dirty;
}

// 续跑时比对代码版本（269）：记录的（最近一条 infoLog 的，没有即开跑时的）与当前的都认得出且提交号相同才算一致；
// 不一致而没有显式放行即拒绝。经放行时返回放行的原因（要留痕），一致时返回 undefined
function checkHarness(
  recorded: HarnessRef | undefined,
  current: HarnessRef,
  allowance: HarnessAllowance
): string | undefined {
  if (identifiable(recorded) && identifiable(current) && recorded.commit === current.commit) {
    return undefined;
  }
  if (allowance.acceptHarnessChange !== undefined) return allowance.acceptHarnessChange;
  throw new Error(
    `输出目录记录的代码与当前的代码不一致，拒绝续跑（实验代码冻结后，校准与正式跑只用同一份代码）：记录的代码：${describeHarness(recorded)}；当前的代码：${describeHarness(current)}。` +
      `确需换代码（修使运行无效的缺陷）时加 --accept-harness-change "<原因>" 显式放行，放行会记进身份头与报告`
  );
}

// 首次写入身份头；已有的与这次的 core 逐项比对，不同即抛错并列出不同的项；再比对代码版本（见 checkHarness）；
// 一致而 info 有变即追加一条变更记录。首次开跑时代码版本认不出（有未提交改动或读不到提交号）即拒绝，除非给了
// allowDirtyHarness（放行即记进身份头）。返回 core 的摘要
export function checkOrWriteIdentity(
  outDir: string,
  identity: StreamRunIdentity,
  now: () => Date = () => new Date(),
  allowance: HarnessAllowance = {}
): string {
  if (allowance.acceptHarnessChange !== undefined && allowance.acceptHarnessChange.trim() === "") {
    throw new Error("--accept-harness-change 的原因不能为空：放行换代码必须写明为什么换");
  }
  const file = identityFile(outDir);
  const digest = identityDigest(identity.core);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as StoredStreamIdentity;
    const { differ, merged } = mergeCore(saved.core, identity.core);
    if (differ.length > 0) {
      throw new Error(
        `输出目录的身份与这次不一致（${differ.join("、")}），拒绝续跑：不同仓库、预算、镜像、模型设定、选题或试跑与正式的结果不能混在同一目录`
      );
    }
    const latest = saved.infoLog?.at(-1)?.info ?? saved.info;
    const accepted = checkHarness(latest?.harness, identity.info.harness, allowance);
    let next = saved;
    // 这次跑了新的条件或新接入的 agent：并进身份头（摘要不变）
    if (canonical(merged) !== canonical(saved.core)) next = { ...next, core: merged };
    if (accepted !== undefined || infoShape(latest) !== infoShape(identity.info)) {
      const change: StreamInfoChange = {
        since: now().toISOString(),
        info: identity.info,
        ...(accepted !== undefined ? { acceptHarnessChange: accepted } : {}),
      };
      next = { ...next, infoLog: [...(saved.infoLog ?? []), change] };
    }
    if (next !== saved) writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return digest;
  }
  // 没有身份头却已有跑批留下的东西（结果行、各作业的目录）：认不出它们属于哪一次身份，拒绝续跑，不补写身份头
  const leftovers = RUN_ARTIFACTS.filter((name) => existsSync(path.join(outDir, name)));
  if (leftovers.length > 0) {
    throw new Error(
      `输出目录里已有跑批结果（${leftovers.join("、")}）却没有 identity.json，认不出它们属于哪一次身份，拒绝续跑：请换一个空的输出目录`
    );
  }
  const dirty = !identifiable(identity.info.harness);
  if (dirty && allowance.allowDirtyHarness !== true) {
    throw new Error(
      `当前的代码认不出确定的版本（${describeHarness(identity.info.harness)}），拒绝开跑：实验只用提交过的代码。` +
        "开发自测时加 --allow-dirty-harness 放行，放行会记进身份头与报告"
    );
  }
  const stored: StoredStreamIdentity = {
    ...identity,
    digest,
    ...(dirty ? { allowDirtyHarness: true as const } : {}),
  };
  writeAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
  return digest;
}

// 读输出目录的身份头；没有即 undefined
export function readStoredIdentity(outDir: string): StoredStreamIdentity | undefined {
  const file = identityFile(outDir);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as StoredStreamIdentity;
}

// 先写临时文件再改名：写到一半被杀不会留下读不出的身份头（那样续跑会一直被拒）
function writeAtomic(file: string, content: string): void {
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
}

// 跑批在输出目录里留下的东西：结果行、报告、各作业的目录（流历史、断点、治理根）、作废尝试的隔离目录
const RUN_ARTIFACTS = ["results.jsonl", "report.md", "streams", "voided"];

// 清单文件的摘要（内容逐字）
export function manifestDigestOf(manifestFile: string): string {
  return createHash("sha256").update(readFileSync(manifestFile)).digest("hex").slice(0, 16);
}
