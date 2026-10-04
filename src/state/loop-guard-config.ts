// 打转检测的配置（决策 308；决策 325 起为 settings.json 的 loopGuard 一节）：纯类型与缺省，无 IO。人手写，可缺省；各项不给即取缺省。
// - enabled：整体开关（缺省开）
// - remindAt / warnAt / stopAt：计到第几轮提醒、再提醒、叫停（306，缺省 5、10、20；须为递增的正整数）
// - exemptTools：追加豁免的工具名（缺省只豁免 wait_workers，追加的与缺省的合并）
import { type Static, Type } from "typebox";

export const LoopGuardSectionSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    remindAt: Type.Optional(Type.Integer({ minimum: 1 })),
    warnAt: Type.Optional(Type.Integer({ minimum: 1 })),
    stopAt: Type.Optional(Type.Integer({ minimum: 1 })),
    exemptTools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);
export type LoopGuardSection = Static<typeof LoopGuardSectionSchema>;

// 生效的设定
export interface LoopGuardSettings {
  enabled: boolean;
  remindAt: number;
  warnAt: number;
  stopAt: number;
  // 豁免的工具名（已含缺省豁免）
  exemptTools: readonly string[];
}

// 缺省豁免：等待 worker 的工具（超时即原样返回"仍在跑"，是正当等待）与读后台作业的工具（决策 365：不带等待的连续查询
// 由它自己另计）。与 application 层、tools 层的工具名常量一致（有用例对照）
export const DEFAULT_LOOP_GUARD_EXEMPT_TOOLS: readonly string[] = ["wait_workers", "job_output"];

export const DEFAULT_LOOP_GUARD_SETTINGS: Readonly<LoopGuardSettings> = {
  enabled: true,
  remindAt: 5,
  warnAt: 10,
  stopAt: 20,
  exemptTools: DEFAULT_LOOP_GUARD_EXEMPT_TOOLS,
};

// 关掉的设定（跑批器各条件用）：只改开关，轮数与豁免照缺省，身份头里只记开关
export const DISABLED_LOOP_GUARD_SETTINGS: Readonly<LoopGuardSettings> = {
  ...DEFAULT_LOOP_GUARD_SETTINGS,
  enabled: false,
};

// 配置 → 生效设定；三个轮数不递增时返回问题描述（由读取方响亮失败）
export function loopGuardSettings(
  file: LoopGuardSection | undefined
): { settings: LoopGuardSettings } | { problem: string } {
  const base = DEFAULT_LOOP_GUARD_SETTINGS;
  const remindAt = file?.remindAt ?? base.remindAt;
  const warnAt = file?.warnAt ?? base.warnAt;
  const stopAt = file?.stopAt ?? base.stopAt;
  if (!(remindAt < warnAt && warnAt < stopAt)) {
    return {
      problem: `三个轮数须递增：remindAt ${remindAt}、warnAt ${warnAt}、stopAt ${stopAt}`,
    };
  }
  const exemptTools = [...new Set([...base.exemptTools, ...(file?.exemptTools ?? [])])];
  return {
    settings: { enabled: file?.enabled ?? base.enabled, remindAt, warnAt, stopAt, exemptTools },
  };
}
