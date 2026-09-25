// 延续式跑批的身份头（决策 147，修复审计"身份头、预算缺省与两种 agent 的参数"一节）：输出目录下的 identity.json。core 为参与比对的身份——仓库、清单摘要、镜像标识、预算、
// 条件、试跑的每流步数、两种 agent 的模型与推理参数（最简 agent 另记 mini-swe-agent 与 litellm 的版本），续跑时任何一项
// 与已写的不同即拒绝，避免不同仓库、不同预算或试跑结果混进正式实验；info 只作记录不比对（路数可能因内存降、跑批器代码
// 版本另记在每条结果行上；续跑时路数、账号数或各账号并发上限有变即在 infoLog 追加一条）。结果行带 core 的摘要，
// 据此认出每行属于哪一次身份
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessRef } from "./results.ts";
import type { StepBudget } from "./stream-runner.ts";

export interface StreamRunIdentity {
  core: {
    repo: string;
    manifestDigest: string;
    image: string;
    budget: StepBudget;
    conditions: readonly string[];
    maxSteps: number | null;
    agents: {
      pigeon?: {
        provider: string;
        modelId: string;
        temperature: number | null;
        thinking: string | null;
        maxOutputTokens: number | null;
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

export function identityDigest(core: StreamRunIdentity["core"]): string {
  return createHash("sha256").update(canonical(core)).digest("hex").slice(0, 16);
}

export function identityFile(outDir: string): string {
  return path.join(outDir, "identity.json");
}

// 身份头文件里 info 的变更记录：续跑时路数、账号数或各账号并发上限与最近一条不同即追加一条（带起始时刻），
// 结果行 gateway.accountRequests 的长度据此对上当时的账号数。info 与这些记录都不参与身份比对
export interface StreamInfoChange {
  since: string;
  info: StreamRunIdentity["info"];
}

// 比较 info 时不看跑批器代码版本（它另记在每条结果行上）
function infoShape(info: StreamRunIdentity["info"]): string {
  const { harness: _harness, ...rest } = info;
  return canonical(rest);
}

// 首次写入身份头；已有的与这次的 core 逐项比对，不同即抛错并列出不同的项；一致而 info 有变即追加一条变更记录。
// 返回 core 的摘要
export function checkOrWriteIdentity(
  outDir: string,
  identity: StreamRunIdentity,
  now: () => Date = () => new Date()
): string {
  const file = identityFile(outDir);
  const digest = identityDigest(identity.core);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as StreamRunIdentity & {
      infoLog?: StreamInfoChange[];
    };
    const differ = (
      Object.keys({ ...saved.core, ...identity.core }) as (keyof StreamRunIdentity["core"])[]
    ).filter((k) => canonical(saved.core[k]) !== canonical(identity.core[k]));
    if (differ.length > 0) {
      throw new Error(
        `输出目录的身份与这次不一致（${differ.join("、")}），拒绝续跑：不同仓库、预算、镜像、模型设定或试跑与正式的结果不能混在同一目录`
      );
    }
    const latest = saved.infoLog?.at(-1)?.info ?? saved.info;
    if (infoShape(latest) !== infoShape(identity.info)) {
      const infoLog = [
        ...(saved.infoLog ?? []),
        { since: now().toISOString(), info: identity.info },
      ];
      writeAtomic(file, `${JSON.stringify({ ...saved, infoLog }, null, 2)}\n`);
    }
    return digest;
  }
  // 没有身份头却已有跑批留下的东西（结果行、各作业的目录）：认不出它们属于哪一次身份，拒绝续跑，不补写身份头
  const leftovers = RUN_ARTIFACTS.filter((name) => existsSync(path.join(outDir, name)));
  if (leftovers.length > 0) {
    throw new Error(
      `输出目录里已有跑批结果（${leftovers.join("、")}）却没有 identity.json，认不出它们属于哪一次身份，拒绝续跑：请换一个空的输出目录`
    );
  }
  writeAtomic(file, `${JSON.stringify({ ...identity, digest }, null, 2)}\n`);
  return digest;
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
