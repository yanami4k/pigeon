// 无人值守自动验证（M8 S6，决策 086）：触发缺省人工（`pigeon verify`），另给一个显式开关，
// 供并行派发或失败重试整夜跑时自动把新落库的候选验一遍。
//
// 为什么缺省关：一次验证是四组各 N 次的真执行，开销与一轮 Eval 同量级；落库即自动会让一次
// 并行派发悄悄变成二十次额外运行。开关必须是人显式拨的（同 079 的失败自动分叉重试）。
//
// 故障口径同决策 080：自动验证自身的故障（前置不满足、回放拉不起来）不进账本，
// 只按类别去重向标准错误告警——它是运行时诊断，不是运行事实。

import type { PersistDistillerResult } from "../distillation/candidates.ts";
import { mainRepoRoot } from "../orchestration/worktree.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { CandidateVerifiedRecord } from "../state/event-log.ts";
import { verifierRuntimeFactory } from "./rerun.ts";
import { type VerifyCandidateOptions, verifyCandidate } from "./verify-command.ts";
import { dedupedWarner, failureDetail } from "./warnings.ts";

export interface AutoVerifyWiring {
  // 缺省关（决策 086）：人显式拨开才自动验证
  enabled: boolean;
  // 验证一个候选所需的其余参数（候选选择器由本模块按新落库的候选逐个填）
  options: Omit<VerifyCandidateOptions, "selector">;
}

export interface AutoVerifyOutcome {
  records: CandidateVerifiedRecord[];
  errors: unknown[];
}

// 自动验证刚落库的那批候选；开关关着或这次提炼没产出候选时直接返回空
export async function autoVerifyCandidates(
  wiring: AutoVerifyWiring | undefined,
  persisted: PersistDistillerResult | undefined
): Promise<AutoVerifyOutcome> {
  const records: CandidateVerifiedRecord[] = [];
  const errors: unknown[] = [];
  if (wiring?.enabled !== true || persisted === undefined) {
    return { records, errors };
  }
  const warn = dedupedWarner();
  for (const candidate of persisted.written) {
    try {
      const result = await verifyCandidate({ ...wiring.options, selector: candidate.contentHash });
      records.push(result.record);
      errors.push(...result.errors);
    } catch (error) {
      errors.push(error);
      warn(
        error,
        `自动验证告警：${failureDetail(error)}（该候选停在已扫描，可用 pigeon verify 手动重试，不影响运行）`
      );
    }
  }
  return { records, errors };
}

// Actor 侧的标准接线（cli / tui 共用）：回放用宿主的仓库根、宿主的验证命令，
// 模型接入沿用主会话那一份；模型标识按被验证那次尝试逐次取（087：模型沿用被验证那次尝试）
export function autoVerifyWiring(
  governanceRoot: string,
  verify: VerifyCandidateOptions["verify"],
  streamFn: StreamFn,
  persistThinking: boolean
): AutoVerifyWiring {
  return {
    enabled: true,
    options: {
      governanceRoot,
      repoRoot: mainRepoRoot(governanceRoot),
      verify,
      // 与 pigeon verify 共用同一份依赖构造：模型标识、推理档位与单轮输出上限一律沿用被验证那次尝试
      runtimeFactoryFor: (sampling) =>
        verifierRuntimeFactory({ ...sampling, streamFn, persistThinking }),
    },
  };
}
