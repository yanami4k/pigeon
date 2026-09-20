// 启动时的激活告警（M8 S7 / S8，决策 091 / 093）：会话启动时把已激活经验的两类问题说出来。
//
//   1. 漂移（093）：激活记录存的是写盘后回读的内容哈希；启动时拿它与落点现状比对，
//      不一致就标注"已脱离批准版本"，落点被删就标注"文件已不在"。两者都不阻止使用——
//      人仍可直接编辑 .pigeon/memory 与 .pigeon/skills（042 / 043 不变），
//      可见性与项目一贯做法（悬账、崩溃残留、截断标注）一致。
//   2. 批准失效（091）：本次会话的模型标识、预算参数与验证命令，与当初批准所依据的验证环境比对；
//      任一项落在封闭四项清单里且不同，就说明"这条经验当初是在另一套环境下验出来的"。
//      同样不阻止使用——阻止会把一次模型换代变成全部经验一起失效的硬故障。
//
// 告警走标准错误、按类别去重（决策 080 口径）：这是运行时诊断，不是运行事实，不进账本。

import { type ApprovalStalenessKey, stalenessReasons } from "../replay/environment.ts";
import type { AttemptBudget, VerifyConfig } from "../state/attempt-config.ts";
import type { VerificationEnvironment } from "../state/event-log.ts";
import { activationDrift } from "./candidate-decision.ts";
import { buildCandidateIndex, type LocatedCandidate } from "./candidate-lookup.ts";
import { type LaunchFlags, resolveVerifyConfig } from "./launch-flags.ts";

// 当下这一侧取不到预算时跳过预算判定（见 startupEnvironmentOf 的说明）
const UNKNOWN_BUDGET: ReadonlySet<ApprovalStalenessKey> = new Set<ApprovalStalenessKey>(["budget"]);

export interface StartupEnvironment {
  model: { provider: string; id: string; thinkingLevel?: string; maxOutputTokens?: number };
  // 本次会话的预算；交互式 cli 与 tui 没有预算可言，缺省即"这一项取不到，不判"（M8 收口修复）
  budget?: AttemptBudget;
  verify?: VerifyConfig;
}

// 生产接线唯一的一份环境构造（M8 收口修复）：cli 的启动与 resume、tui 的启动都走它。
// 此前两个入口各自硬传了一个空预算，而回执里记的是被验证那次尝试的真实数字，
// budgetShape 必然不等——每条验过并激活的经验每次开会话都会报一次"批准已失效"。
export function startupEnvironmentOf(
  flags: LaunchFlags,
  governanceRoot: string
): StartupEnvironment {
  const verify = resolveVerifyConfig(flags, governanceRoot);
  return {
    model: {
      provider: flags.provider,
      id: flags.modelId,
      ...(flags.thinkingLevel !== undefined ? { thinkingLevel: flags.thinkingLevel } : {}),
      ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    },
    ...(verify !== undefined ? { verify } : {}),
  };
}

// 生效中的已激活经验：状态为已激活的那些（已撤销、已取代的不在其列）
function activeEntries(governanceRoot: string): LocatedCandidate[] {
  return buildCandidateIndex(governanceRoot).candidates.filter(
    (entry) => entry.status === "Active" && entry.activated !== undefined
  );
}

export function activationStartupWarnings(
  governanceRoot: string,
  current?: StartupEnvironment
): string[] {
  const notes: string[] = [];
  for (const entry of activeEntries(governanceRoot)) {
    const label = `${entry.candidate.kind}/${entry.candidate.name}`;
    const drift = activationDrift(governanceRoot, entry);
    if (drift?.state === "drifted") {
      notes.push(
        `[激活] ${label} 已脱离批准版本：落点 ${drift.path} 的内容与批准时不同（人改过；不阻止使用）`
      );
    } else if (drift?.state === "missing") {
      notes.push(`[激活] ${label} 的落点 ${drift.path} 已不在：本次会话不会装载它`);
    }
    if (entry.activated?.unverified === true) {
      notes.push(`[激活] ${label} 未经回放证实：当初是人显式批准的，回放没有测出它的效果`);
    }
    const approved = entry.verified?.environment;
    if (approved !== undefined && current !== undefined) {
      const reasons = stalenessReasons(
        approved,
        currentEnvironmentOf(approved, current),
        current.budget === undefined ? UNKNOWN_BUDGET : undefined
      );
      for (const reason of reasons) {
        notes.push(
          `[激活] ${label} 的批准已失效（${reason.key}）：${reason.detail}——` +
            "结论是在另一套环境下验出来的，要重新确认请跑 pigeon verify（不阻止使用）"
        );
      }
    }
  }
  return notes;
}

// 拿当下这次会话的环境去填一份可比的摘要：清单外的项（harness、Node、平台、经验明细）
// 原样沿用批准时的值，避免它们混进判定；经验集合哈希取批准时那一条——
// 集合是否还是同一套由批准路径在激活前把关（candidate-decision.ts），启动时不重复判定
function currentEnvironmentOf(
  approved: VerificationEnvironment,
  current: StartupEnvironment
): VerificationEnvironment {
  return {
    ...approved,
    model: {
      provider: current.model.provider,
      id: current.model.id,
      ...(current.model.thinkingLevel !== undefined
        ? { thinkingLevel: current.model.thinkingLevel }
        : {}),
      ...(current.model.maxOutputTokens !== undefined
        ? { maxOutputTokens: current.model.maxOutputTokens }
        : {}),
    },
    budget: current.budget ?? approved.budget,
    ...(current.verify !== undefined ? { verify: current.verify } : {}),
  };
}
