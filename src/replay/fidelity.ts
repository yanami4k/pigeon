// 重跑的一致性核对（决策 087 及修订、110、156）：从原尝试的起始记录解出的计划（replay/plan.ts）出发，
// 重跑的预算、工具、模型参数与工作方式指令一律沿用原尝试，任何放宽即拒绝。
// 预算放宽则成功率的变化来自预算，多给一件工具则来自那件工具，换推理档位、温度或工作方式指令就是换了尺子——
// 这几类失效都很隐蔽，结论会因此失去意义。
// 本模块只做核对与照搬，不执行任何东西；执行由调用方（跑批器的单步重跑）承担。
import type { AttemptBudget } from "../state/attempt-config.ts";
import type { WorkerLimits } from "../state/event-log.ts";
import { isThinkingLevel, type ThinkingLevel } from "../state/runtime-events.ts";
import type { AttemptPlan } from "./plan.ts";

// 原尝试的记录不足以原样重跑（如推理档位没记下或认不出）
export class AttemptFidelityError extends Error {}

// 重跑的预算比原尝试宽
export class BudgetWidenedError extends Error {}

// 原尝试某项没设上限时按调用方的缺省收紧（收紧只会让结论偏保守）
export interface DefaultLimits {
  maxTurns: number;
  wallClockMs: number;
}

// 原尝试的预算 → 重跑实际用的上限。
// 传入 requested 时逐项核对：任何一项比原尝试宽即拒绝；原尝试某项设了上限而 requested 放开成不设限同样算放宽。
export function effectiveLimits(
  budget: AttemptBudget,
  defaults: DefaultLimits,
  requested?: WorkerLimits
): WorkerLimits {
  const limits: WorkerLimits = requested ?? {
    maxTurns: budget.maxTurns ?? defaults.maxTurns,
    wallClockMs: budget.wallClockMs ?? defaults.wallClockMs,
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  };
  const widened: string[] = [];
  if (budget.maxTurns !== undefined && limits.maxTurns > budget.maxTurns) {
    widened.push(`轮次上限 ${limits.maxTurns} > ${budget.maxTurns}`);
  }
  if (budget.wallClockMs !== undefined && limits.wallClockMs > budget.wallClockMs) {
    widened.push(`墙钟上限 ${limits.wallClockMs} > ${budget.wallClockMs}`);
  }
  if (budget.maxTokens !== undefined && (limits.maxTokens ?? Infinity) > budget.maxTokens) {
    widened.push(`token 上限 ${limits.maxTokens ?? "不设限"} > ${budget.maxTokens}`);
  }
  if (widened.length > 0) {
    throw new BudgetWidenedError(
      `回放预算比被验证那次尝试宽：${widened.join("、")}。` +
        "预算放宽后成功率的提升将来自预算而非经验，且这种失效隐蔽，故一律拒绝"
    );
  }
  return limits;
}

// 工具取交集：ceiling 是重跑一方能给的工具上限，attemptTools 是原尝试实际拿到的工具名单（计划里的 tools）。
// 原尝试没有的工具重跑也不给；attemptTools 缺省时只按上限给
export function intersectAttemptTools(
  ceiling: readonly string[],
  attemptTools?: readonly string[]
): string[] {
  return attemptTools === undefined
    ? [...ceiling]
    : ceiling.filter((tool) => attemptTools.includes(tool));
}

// 推理档位必须能原样重放：认不出或没记下来的一律拒绝，不按缺省算。
// M5.5 之后的每条 run.started 都会写下档位（缺省写成 off），故这条只会在数据损坏或更早的记录上触发
export function assertThinkingLevelReproducible(model: AttemptPlan["model"]): ThinkingLevel {
  const level = model.thinkingLevel;
  if (level === undefined || !isThinkingLevel(level)) {
    throw new AttemptFidelityError(
      `被验证那次尝试的推理档位${level === undefined ? "没有记下来" : `认不出来（${level}）`}：` +
        "回放必须沿用它，按缺省算等于换了一把尺子，故拒绝验证"
    );
  }
  return level;
}

// 决定"尺子"的那一组：模型参数（含推理档位、输出上限、采样温度）与工作方式指令，整体交出，拆开传就会漏
export type AttemptSampling = Pick<AttemptPlan, "model" | "taskDirective">;

export function samplingOf(plan: AttemptPlan): AttemptSampling {
  return {
    model: plan.model,
    ...(plan.taskDirective !== undefined ? { taskDirective: plan.taskDirective } : {}),
  };
}

// 运行面沿用原尝试：核对推理档位后，把模型参数与工作方式指令照搬成运行面参数；原尝试没设的项就不带
export interface ReproducedRuntime {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens?: number;
  temperature?: number;
  taskDirective?: string;
}

export function reproducedRuntime(sampling: AttemptSampling): ReproducedRuntime {
  const { model } = sampling;
  const thinkingLevel = assertThinkingLevelReproducible(model);
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel,
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(sampling.taskDirective !== undefined ? { taskDirective: sampling.taskDirective } : {}),
  };
}
