// 一轮之内的失控（决策 367）：撞上限续跑与流式重复检测的配置——settings.json 的 truncationContinuation、repetitionGuard
// 两节。纯类型与缺省，无 IO；人手写，可缺省，各项不给即取缺省。
// - 续跑：末条回复因输出上限截断且没有工具调用时不收尾，提示后接着跑；连续与每次运行合计各有上限。按截断的原因分开
//   （决策 376）：重复检测掐断的去掉截断的回复、提示直接发工具调用；单纯撞上限的保留截断的正文、提示从断处接着写
// - 重复检测：逐字周期与段落相似度两种判据，只看正文与思考；掐断（abort）即中止本条回复、按撞上限交给续跑，
//   只记录（log）不掐断。参数先取档位（omp 为缺省，wide 为试跑用的宽参数），节里单独给的项覆盖档位
import { type Static, Type } from "typebox";

// 续跑时追加给模型的提示（运行面发出；回看历史时据此认出它不是人输入的话）：重复检测掐断的回复已从上下文去掉，
// 提示直接发工具调用；单纯撞上限的回复留在上下文里，提示从断处接着写（决策 376）
export const TRUNCATION_CONTINUE_PROMPT =
  "上条回复被截断，未执行任何工具；不要重复前文，简短说明下一步并直接发出一个工具调用";
export const TRUNCATION_RESUME_PROMPT =
  "上条回复因长度上限被截断；从断处接着写，不要重复已写的内容";

// 续跑行为的版本（跑批身份头照记）：v1 为 367 的一律去掉截断的回复，v2 为 376 的按原因分开。设定不变而行为变了时换版本
export const TRUNCATION_CONTINUATION_VERSION = "v2";

export const TruncationContinuationSectionSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    maxConsecutive: Type.Optional(Type.Integer({ minimum: 1 })),
    maxPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false }
);
export type TruncationContinuationSection = Static<typeof TruncationContinuationSectionSchema>;

// 生效的续跑设定：连续续跑次数（中间有一条回复没触发续跑即清零）与每次运行合计次数的上限
export interface TruncationContinuationSettings {
  enabled: boolean;
  maxConsecutive: number;
  maxPerRun: number;
}

export const DEFAULT_TRUNCATION_CONTINUATION: Readonly<TruncationContinuationSettings> = {
  enabled: true,
  maxConsecutive: 2,
  maxPerRun: 5,
};

export function truncationContinuationSettings(
  file: TruncationContinuationSection | undefined
): TruncationContinuationSettings {
  const base = DEFAULT_TRUNCATION_CONTINUATION;
  return {
    enabled: file?.enabled ?? base.enabled,
    maxConsecutive: file?.maxConsecutive ?? base.maxConsecutive,
    maxPerRun: file?.maxPerRun ?? base.maxPerRun,
  };
}

export const RepetitionGuardModeSchema = Type.Union([Type.Literal("abort"), Type.Literal("log")]);
export type RepetitionGuardMode = Static<typeof RepetitionGuardModeSchema>;
export const RepetitionGuardPresetSchema = Type.Union([Type.Literal("omp"), Type.Literal("wide")]);
export type RepetitionGuardPreset = Static<typeof RepetitionGuardPresetSchema>;

// 检测参数。字符数按 UTF-16 码元计
export interface RepetitionGuardParams {
  // 逐字周期：每收到这么多新字符检查一次最近 windowChars 个字符的末尾，是否由同一单元首尾相接重复构成
  checkIntervalChars: number;
  windowChars: number;
  // 单元最长；单元不超过 shortPeriodChars 的按短周期门槛（遍数与覆盖字符数），0 即不分短周期
  maxPeriodChars: number;
  minRepeats: number;
  minRepeatedChars: number;
  shortPeriodChars: number;
  shortMinRepeats: number;
  shortMinRepeatedChars: number;
  // 段落相似度：按空行切段（无空行时到 segmentMaxChars 强制切），去掉标题行后不含空白不足 segmentMinChars 个字符的段不计；
  // 与最近 segmentWindow 段比较词三元组相似度，达 similarity 的算近似；攒满 minSegments 段之后，近似段（含本段）达
  // minCluster、且最近连续 minConsecutive 段每段都与前一段近似，才命中（防只差编号、人名的模板段误判）
  similarity: number;
  segmentMaxChars: number;
  segmentMinChars: number;
  segmentWindow: number;
  minSegments: number;
  minCluster: number;
  minConsecutive: number;
}

// 缺省档：照 omp（oh-my-pi 的 thinking-loop 检测）的常量
export const OMP_REPETITION_PARAMS: Readonly<RepetitionGuardParams> = {
  checkIntervalChars: 128,
  windowChars: 4096,
  maxPeriodChars: 1024,
  minRepeats: 3,
  minRepeatedChars: 1024,
  shortPeriodChars: 60,
  shortMinRepeats: 4,
  shortMinRepeatedChars: 180,
  similarity: 0.8,
  segmentMaxChars: 700,
  segmentMinChars: 60,
  segmentWindow: 16,
  minSegments: 8,
  minCluster: 4,
  minConsecutive: 3,
};

// 试跑用的宽档：单元最长 16,384 字符、至少重复 3 遍、重复段至少 2,000 字符，不分短周期；窗口放到恰好容得下
// 最长单元重复 3 遍。段落相似度的参数同缺省档
export const WIDE_REPETITION_PARAMS: Readonly<RepetitionGuardParams> = {
  ...OMP_REPETITION_PARAMS,
  windowChars: 16_384 * 3,
  maxPeriodChars: 16_384,
  minRepeats: 3,
  minRepeatedChars: 2000,
  shortPeriodChars: 0,
};

export const REPETITION_PRESETS: Readonly<
  Record<RepetitionGuardPreset, Readonly<RepetitionGuardParams>>
> = {
  omp: OMP_REPETITION_PARAMS,
  wide: WIDE_REPETITION_PARAMS,
};

const positive = Type.Optional(Type.Integer({ minimum: 1 }));

export const RepetitionGuardSectionSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    mode: Type.Optional(RepetitionGuardModeSchema),
    preset: Type.Optional(RepetitionGuardPresetSchema),
    checkIntervalChars: positive,
    windowChars: positive,
    maxPeriodChars: positive,
    minRepeats: Type.Optional(Type.Integer({ minimum: 2 })),
    minRepeatedChars: positive,
    shortPeriodChars: Type.Optional(Type.Integer({ minimum: 0 })),
    shortMinRepeats: Type.Optional(Type.Integer({ minimum: 2 })),
    shortMinRepeatedChars: positive,
    similarity: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
    segmentMaxChars: positive,
    segmentMinChars: positive,
    segmentWindow: positive,
    minSegments: positive,
    minCluster: Type.Optional(Type.Integer({ minimum: 2 })),
    minConsecutive: positive,
  },
  { additionalProperties: false }
);
export type RepetitionGuardSection = Static<typeof RepetitionGuardSectionSchema>;

// 生效的检测设定
export interface RepetitionGuardSettings {
  enabled: boolean;
  mode: RepetitionGuardMode;
  preset: RepetitionGuardPreset;
  params: RepetitionGuardParams;
}

export const DEFAULT_REPETITION_GUARD: Readonly<RepetitionGuardSettings> = {
  enabled: true,
  mode: "abort",
  preset: "omp",
  params: OMP_REPETITION_PARAMS,
};

// 配置 → 生效设定；窗口容不下最长单元重复到门槛遍数时返回问题描述（由读取方响亮失败）
export function repetitionGuardSettings(
  file: RepetitionGuardSection | undefined
): { settings: RepetitionGuardSettings } | { problem: string } {
  const preset = file?.preset ?? DEFAULT_REPETITION_GUARD.preset;
  const params: RepetitionGuardParams = { ...REPETITION_PRESETS[preset] };
  for (const key of Object.keys(params) as (keyof RepetitionGuardParams)[]) {
    const value = file?.[key];
    if (value !== undefined) {
      params[key] = value;
    }
  }
  if (params.windowChars < params.maxPeriodChars * params.minRepeats) {
    return {
      problem: `windowChars ${params.windowChars} 须不小于 maxPeriodChars × minRepeats（${params.maxPeriodChars * params.minRepeats}）`,
    };
  }
  return {
    settings: {
      enabled: file?.enabled ?? DEFAULT_REPETITION_GUARD.enabled,
      mode: file?.mode ?? DEFAULT_REPETITION_GUARD.mode,
      preset,
      params,
    },
  };
}
