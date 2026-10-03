// 缓存规则表（决策 362）：各家服务方的提示缓存怎么开、留多久、写入与读取按输入价的几倍、最小可缓存前缀，以及出处。
// 按实际服务方定键，不按接口格式：经 Anthropic 兼容端点访问 DeepSeek，查的是 DeepSeek 的规则；同一服务方下可再按模型名前缀
// 细分（取最长的匹配前缀，没有前缀的行是该服务方的兜底）。查不到的服务方给全未知的规则，由用到它的功能各自保守处理。
// 两档：short 是较短或缺省的一档，long 是较长或须另开的一档；只有一档的服务方只填 short。
// 依据类别：fixed 文档给的确定时长；minimum 至少这么久（可能更久）；typical 通常这么久（不保证）；best-effort 尽力而为、
// 可随时清除（秒数取原文说法的保守下限）；unstated 文档没写。
// 写缓存倍率 1 表示不另收写入费（写入的 token 按未命中价计）。出处的引句由 scripts/check-cache-rule-sources.ts 手动复核。
// 纯数据与查找，无 IO、不依赖任何包（复核脚本直接运行它）。

export type CacheMode = "auto" | "explicit" | "both" | "none" | "unknown";
export type RetentionBasis = "fixed" | "minimum" | "typical" | "best-effort" | "unstated";
export type Unknown = "unknown";

export interface RetentionTier {
  seconds: number | Unknown;
  basis: RetentionBasis;
  // 命中是否续期（从命中时刻重新计时）
  refreshOnHit: boolean | Unknown;
  // 写缓存按输入价的倍数（1 = 不另收写入费）
  writeMultiplier: number | Unknown;
  // 命中按输入价的倍数
  readMultiplier: number | Unknown;
  // 如何开启
  enable: string;
}

export interface CacheRuleSource {
  url: string;
  // 取用日期（YYYY-MM-DD）
  retrieved: string;
  // 原文短引，须是页面去标签后的连续文字
  quote: string;
}

export interface CacheRule {
  mode: CacheMode;
  short?: RetentionTier;
  long?: RetentionTier;
  // 最小可缓存前缀（token）：按模型不同时给区间
  minPrefixTokens: { min: number; max: number } | Unknown;
  sources: readonly CacheRuleSource[];
  // 原文的保留说法、例外型号等补充
  note?: string;
}

export interface CacheRuleRow {
  // 行标识（写进会话记录）
  id: string;
  // 实际服务方：pi-ai 的 provider 名与常见别名
  servedBy: readonly string[];
  // 模型名前缀；缺省 = 该服务方的兜底行
  modelPrefixes?: readonly string[];
  rule: CacheRule;
}

const RETRIEVED = "2026-10-03";
const src = (url: string, quote: string): CacheRuleSource => ({ url, retrieved: RETRIEVED, quote });

const ANTHROPIC_URL = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching";
const OPENAI_URL = "https://developers.openai.com/api/docs/guides/prompt-caching";
const GEMINI_URL = "https://ai.google.dev/gemini-api/docs/caching?hl=en";
const GEMINI_EXPLICIT_URL = "https://ai.google.dev/gemini-api/docs/generate-content/caching?hl=en";
const VERTEX_GEMINI_URL =
  "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview?hl=en";
const VERTEX_GEMINI_CREATE_URL =
  "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-create?hl=en";
const VERTEX_CLAUDE_URL =
  "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/prompt-caching?hl=en";
const BEDROCK_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html";
const DEEPSEEK_URL = "https://api-docs.deepseek.com/zh-cn/guides/kv_cache/";
const KIMI_URL = "https://platform.kimi.com/docs/guide/context-caching";
const KIMI_PRICING_URL = "https://platform.kimi.com/docs/pricing/chat";
const BAILIAN_URL = "https://help.aliyun.com/zh/model-studio/context-cache";
const ZHIPU_URL = "https://docs.bigmodel.cn/cn/guide/capabilities/cache";
const ZHIPU_PRICING_URL = "https://docs.bigmodel.cn/cn/guide/start/pricing";
const XAI_URL = "https://docs.x.ai/developers/advanced-api-usage/prompt-caching";
const MISTRAL_URL = "https://docs.mistral.ai/studio/conversations/advanced/prompt-caching";

// Anthropic 直连的共同部分（按模型细分的行只改读取倍率与最小前缀）
const anthropicTiers = (read: number): Pick<CacheRule, "short" | "long"> => ({
  short: {
    seconds: 300,
    basis: "fixed",
    refreshOnHit: true,
    writeMultiplier: 1.25,
    readMultiplier: read,
    enable: "自动缓存或 cache_control 断点（缺省 5 分钟）",
  },
  long: {
    seconds: 3600,
    basis: "fixed",
    refreshOnHit: true,
    writeMultiplier: 2,
    readMultiplier: read,
    enable: 'cache_control 的 ttl 设为 "1h"',
  },
});
const ANTHROPIC_SOURCES: readonly CacheRuleSource[] = [
  src(
    ANTHROPIC_URL,
    "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used."
  ),
  src(
    ANTHROPIC_URL,
    "using automatic caching or explicit breakpoints with 5-minute or 1-hour TTLs."
  ),
  src(ANTHROPIC_URL, "5-minute cache write tokens are 1.25 times the base input tokens price"),
  src(ANTHROPIC_URL, "1-hour cache write tokens are 2 times the base input tokens price"),
  src(ANTHROPIC_URL, "Cache read tokens are 0.1 times the base input tokens price"),
  src(ANTHROPIC_URL, "4,096 tokens for Claude Haiku 4.5"),
];
const ANTHROPIC_512 = src(
  ANTHROPIC_URL,
  "512 tokens for Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5"
);

// OpenAI GPT-5.6 及以后的共同部分
const openaiNewTier = (read: number): RetentionTier => ({
  seconds: 1800,
  basis: "minimum",
  refreshOnHit: true,
  writeMultiplier: 1.25,
  readMultiplier: read,
  enable:
    "缺省即开（隐式断点在最新一条合格消息末尾）；prompt_cache_options 可改为只用显式断点，ttl 只有 30m",
});
const OPENAI_NEW_SOURCES: readonly CacheRuleSource[] = [
  src(
    OPENAI_URL,
    "A cached prefix remains eligible for reuse for 30 minutes after its most recent write or reuse"
  ),
  src(
    OPENAI_URL,
    "For GPT-5.6 and later, cache writes cost 1.25× the standard, uncached input-token rate."
  ),
  src(OPENAI_URL, "Subsequent reads cost 0.1× that rate"),
  src(
    OPENAI_URL,
    "The minimum cacheable prompt length is 1,024 tokens for GPT-5.6 and later and varies by request settings for earlier models."
  ),
];
const OPENAI_EXTENDED: RetentionTier = {
  seconds: 1800,
  basis: "typical",
  refreshOnHit: "unknown",
  writeMultiplier: 1,
  readMultiplier: "unknown",
  enable: 'prompt_cache_retention 设为 "24h"（支持的模型上非 ZDR 组织缺省即此档）',
};
const OPENAI_EXTENDED_SOURCE = src(
  OPENAI_URL,
  "Extended retention typically keeps entries available for around 30 minutes and can retain them for up to 24 hours."
);

// Kimi 的共同部分（K3 与 K2.6、K2.7 只差写入倍率）
const kimiTier = (seconds: number, write: number | Unknown, enable: string): RetentionTier => ({
  seconds,
  basis: "fixed",
  refreshOnHit: true,
  writeMultiplier: write,
  readMultiplier: 0.1,
  enable,
});
const KIMI_SOURCES: readonly CacheRuleSource[] = [
  src(KIMI_URL, "满足命中条件的前缀会自动写入并尝试复用"),
  src(KIMI_URL, "写入后 1 小时内有效，每次命中后有效期重新计算为 1 小时"),
  src(KIMI_URL, "缓存命中价格是缓存未命中价格的 1/10"),
];
const KIMI_SHORT_ENABLE =
  "缺省即开（Chat Completions、Responses 接口）；Anthropic 接口须带 cache_control 才写入，不带只读";
const KIMI_LONG_ENABLE = "TTL 设为 1h";

const BEDROCK_CLAUDE_PREFIXES = ["", "us.", "eu.", "apac.", "au.", "jp.", "global.", "us-gov."].map(
  (region) => `${region}anthropic.claude`
);

export const CACHE_RULES: readonly CacheRuleRow[] = [
  {
    id: "anthropic",
    servedBy: ["anthropic"],
    rule: {
      mode: "both",
      ...anthropicTiers(0.1),
      minPrefixTokens: { min: 512, max: 4096 },
      sources: [...ANTHROPIC_SOURCES, ANTHROPIC_512],
      note: "最小前缀按模型分 512、1024、2048、4096 四档；时长自写入或读取该条缓存的请求开始时算起",
    },
  },
  {
    id: "anthropic/opus-5.5",
    servedBy: ["anthropic"],
    modelPrefixes: ["claude-opus-5-5"],
    rule: {
      mode: "both",
      ...anthropicTiers(0.05),
      minPrefixTokens: { min: 512, max: 512 },
      sources: [
        ...ANTHROPIC_SOURCES,
        ANTHROPIC_512,
        src(
          ANTHROPIC_URL,
          "Cache hits and refreshes on Claude Opus 5.5 are priced at 0.05x the base input price."
        ),
      ],
    },
  },
  {
    id: "anthropic/fable-mythos-5.1",
    servedBy: ["anthropic"],
    modelPrefixes: ["claude-fable-5-1", "claude-mythos-5-1"],
    rule: {
      mode: "both",
      ...anthropicTiers(0.025),
      minPrefixTokens: { min: 512, max: 512 },
      sources: [
        ...ANTHROPIC_SOURCES,
        ANTHROPIC_512,
        src(
          ANTHROPIC_URL,
          "Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price."
        ),
      ],
    },
  },
  {
    id: "openai/earlier",
    servedBy: ["openai"],
    rule: {
      mode: "auto",
      short: {
        seconds: 300,
        basis: "typical",
        refreshOnHit: true,
        writeMultiplier: 1,
        readMultiplier: "unknown",
        enable: "缺省即开（in_memory；ZDR 组织缺省即此档）",
      },
      long: OPENAI_EXTENDED,
      minPrefixTokens: "unknown",
      sources: [
        src(
          OPENAI_URL,
          "Entries typically remain active for around 5 to 10 minutes of inactivity, up to one hour."
        ),
        OPENAI_EXTENDED_SOURCE,
        src(OPENAI_URL, "No additional cache-write charge"),
      ],
      note: "in_memory 无活动约 5–10 分钟、至多 1 小时；24h 档通常约 30 分钟、最长 24 小时；最小前缀随请求设置而变；读取倍率按模型不同",
    },
  },
  {
    id: "openai/gpt-5.5",
    servedBy: ["openai"],
    modelPrefixes: ["gpt-5.5"],
    rule: {
      mode: "auto",
      short: { ...OPENAI_EXTENDED, enable: '缺省即开，只有 "24h" 一档' },
      minPrefixTokens: "unknown",
      sources: [OPENAI_EXTENDED_SOURCE, src(OPENAI_URL, "No additional cache-write charge")],
      note: "GPT-5.5 与 5.5 Pro 只支持 24h 档：通常约 30 分钟、最长 24 小时",
    },
  },
  {
    id: "openai/gpt-5.6+",
    servedBy: ["openai"],
    modelPrefixes: ["gpt-5.6", "gpt-5.7", "gpt-5.8", "gpt-5.9", "gpt-6"],
    rule: {
      mode: "both",
      short: openaiNewTier(0.1),
      minPrefixTokens: { min: 1024, max: 1024 },
      sources: OPENAI_NEW_SOURCES,
      note: "30 分钟自最近一次写入或复用算起，可能留得更久；1,024 只计可见的输入 token",
    },
  },
  {
    id: "openai/gpt-6.1-sol",
    servedBy: ["openai"],
    modelPrefixes: ["gpt-6.1-sol"],
    rule: {
      mode: "both",
      short: openaiNewTier(0.05),
      minPrefixTokens: { min: 1024, max: 1024 },
      sources: [
        ...OPENAI_NEW_SOURCES,
        src(
          OPENAI_URL,
          "Subsequent reads cost 0.1× that rate on most of these models and 0.05× on GPT-6.1 Sol"
        ),
      ],
    },
  },
  {
    id: "google",
    servedBy: ["google", "gemini"],
    rule: {
      mode: "both",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "隐式缓存：2.5 及以后缺省开，不保证命中",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable:
          "显式缓存（cachedContents，Beta，只限 generateContent）：ttl 可设、缺省 1 小时，按存储时长另收存储费",
      },
      minPrefixTokens: { min: 2048, max: 4096 },
      sources: [
        src(
          GEMINI_URL,
          "Implicit caching is enabled by default for all Gemini 2.5 and newer models."
        ),
        src(
          GEMINI_EXPLICIT_URL,
          "automatically enabled on Gemini 2.5 and newer models, no cost saving guarantee"
        ),
        src(GEMINI_EXPLICIT_URL, "If not set, the TTL defaults to 1 hour."),
        src(GEMINI_EXPLICIT_URL, "billed based on the TTL duration of cached token count."),
      ],
      note: "缓存页只写命中按 reduced rate 计（价格表上多数约为输入价的 10%）；最小前缀 2.5 系 2048、3.x 4096，数字只在表格里",
    },
  },
  {
    id: "google-vertex/gemini",
    servedBy: ["google-vertex"],
    modelPrefixes: ["gemini-"],
    rule: {
      mode: "both",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: 1,
        readMultiplier: 0.1,
        enable: "隐式缓存：缺省开，无存储费",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: false,
        writeMultiplier: 1,
        readMultiplier: 0.1,
        enable: "显式缓存：缺省 60 分钟、最短 1 分钟、无上限，按存储时长另收存储费",
      },
      minPrefixTokens: { min: 2048, max: 4096 },
      sources: [
        src(VERTEX_GEMINI_URL, "There are no storage costs for implicit caching."),
        src(
          VERTEX_GEMINI_URL,
          "you're billed for the input tokens used to create the cache at the standard input token price."
        ),
        src(
          VERTEX_GEMINI_CREATE_URL,
          "The default expiration time of a context cache is 60 minutes after it's created."
        ),
      ],
      note: "命中折扣 2.5 及以后为 90%（2.0 显式为 75%）；最短 1 分钟与最小前缀（Gemini 2 系 2048、3 系 4096）只在表格里",
    },
  },
  {
    id: "google-vertex/claude",
    servedBy: ["google-vertex", "google-vertex-anthropic"],
    modelPrefixes: ["claude-"],
    rule: {
      mode: "explicit",
      short: {
        seconds: 300,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: 1.25,
        readMultiplier: 0.1,
        enable: "cache_control 断点（缺省 5 分钟）",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: 2,
        readMultiplier: 0.1,
        enable: "ttl 设为一小时（3.7 Sonnet、3.5 Sonnet、3 Opus 不支持）",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(
          VERTEX_CLAUDE_URL,
          "By default, the cache has a five-minute lifetime or time to live (TTL)."
        ),
        src(
          VERTEX_CLAUDE_URL,
          "The cache lifetime is refreshed each time the cached content is accessed."
        ),
        src(
          VERTEX_CLAUDE_URL,
          "Cache write tokens with a five-minute lifetime are 25% more expensive than base input tokens."
        ),
        src(
          VERTEX_CLAUDE_URL,
          "Cache write tokens with a one-hour lifetime are 100% more expensive than base input tokens."
        ),
        src(VERTEX_CLAUDE_URL, "Cache read tokens are 90% cheaper than base input tokens."),
      ],
      note: "页面未写最小前缀与自动缓存，其余行为指向 Anthropic 文档",
    },
  },
  {
    id: "amazon-bedrock/claude",
    servedBy: ["amazon-bedrock"],
    modelPrefixes: BEDROCK_CLAUDE_PREFIXES,
    rule: {
      mode: "both",
      short: {
        seconds: 300,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "cachePoint 或 cache_control 断点（缺省 5 分钟）",
      },
      long: {
        seconds: 3600,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: 'ttl 设为 "1h"（3.7 Sonnet、3.5 Sonnet v2 不支持）',
      },
      minPrefixTokens: { min: 512, max: 4096 },
      sources: [
        src(
          BEDROCK_URL,
          "The cache has a Time To Live (TTL), which resets with each successful cache hit."
        ),
        src(
          BEDROCK_URL,
          "Specify the desired ttl value as below, when ttl value not specified the default behavior of 5 minutes caching applies."
        ),
        src(BEDROCK_URL, "Support for each type varies by model and API."),
        src(BEDROCK_URL, "Claude Opus 5 requires at least 512 tokens per cache checkpoint"),
        src(BEDROCK_URL, "Claude Haiku 4.5 requires at least 4,096 tokens per cache checkpoint."),
        src(
          BEDROCK_URL,
          "Depending on the model, tokens written to cache can be billed at a rate that is higher than the standard input token rate."
        ),
      ],
      note: "写入与读取倍率见 Bedrock 价格页，本页未写；Opus 4.7 的最小前缀本页为 4096，Anthropic 文档为 2048",
    },
  },
  {
    id: "deepseek",
    servedBy: ["deepseek"],
    rule: {
      mode: "auto",
      short: {
        seconds: 3600,
        basis: "best-effort",
        refreshOnHit: "unknown",
        writeMultiplier: 1,
        readMultiplier: "unknown",
        enable: "缺省即开，无需改代码",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(DEEPSEEK_URL, "上下文硬盘缓存技术对所有用户默认开启，用户无需修改代码即可享用"),
        src(DEEPSEEK_URL, "缓存系统是“尽力而为”，不保证 100% 缓存命中"),
        src(DEEPSEEK_URL, "缓存不再使用后会自动被清空，时间一般为几个小时到几天"),
      ],
      note: "原文清除时间“一般为几个小时到几天”，秒数取保守下限 1 小时；价格页只有命中与未命中两档、没有写入计费项；缓存前缀单元须完整匹配才命中",
    },
  },
  {
    id: "kimi",
    servedBy: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot", "kimi"],
    rule: {
      mode: "auto",
      short: kimiTier(300, "unknown", KIMI_SHORT_ENABLE),
      long: kimiTier(3600, "unknown", KIMI_LONG_ENABLE),
      minPrefixTokens: "unknown",
      sources: KIMI_SOURCES,
      note: "缓存按块存储，不足一整块的部分不写入（块大小未写）",
    },
  },
  {
    id: "kimi/k3",
    servedBy: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot", "kimi"],
    modelPrefixes: ["kimi-k3", "k3"],
    rule: {
      mode: "auto",
      short: kimiTier(300, 1, KIMI_SHORT_ENABLE),
      long: kimiTier(3600, 2, KIMI_LONG_ENABLE),
      minPrefixTokens: "unknown",
      sources: [
        ...KIMI_SOURCES,
        src(KIMI_URL, "唯一多付的成本是写入费贵 ¥20（¥40 vs ¥20）"),
        src(KIMI_PRICING_URL, "对于 K3 系列模型，缓存写入按 TTL（5min / 1h）单独计费"),
      ],
      note: "K3 输入 ¥20、5 分钟档写入 ¥20、1 小时档写入 ¥40、命中 ¥2",
    },
  },
  {
    id: "kimi/k2.6-k2.7",
    servedBy: ["moonshotai", "moonshotai-cn", "kimi-coding", "moonshot", "kimi"],
    modelPrefixes: ["kimi-k2.6", "kimi-k2.7"],
    rule: {
      mode: "auto",
      short: kimiTier(300, 1, KIMI_SHORT_ENABLE),
      long: kimiTier(3600, 1, KIMI_LONG_ENABLE),
      minPrefixTokens: "unknown",
      sources: KIMI_SOURCES,
      note: "文档点名 kimi-k2.7、kimi-k2.7-highspeed、kimi-k2.6 不支持 Cache Write（不另收写入费）",
    },
  },
  {
    id: "alibaba-bailian",
    servedBy: [
      "alibaba-bailian",
      "bailian",
      "dashscope",
      "qwen-token-plan",
      "qwen-token-plan-cn",
      "qwen-token-plan-individual",
    ],
    rule: {
      mode: "both",
      short: {
        seconds: 300,
        basis: "fixed",
        refreshOnHit: true,
        writeMultiplier: 1.25,
        readMultiplier: 0.1,
        enable: "显式缓存：cache_control 标记 ephemeral（与隐式互斥，单次请求至多 4 个标记）",
      },
      long: {
        seconds: "unknown",
        basis: "best-effort",
        refreshOnHit: "unknown",
        writeMultiplier: 1,
        readMultiplier: 0.2,
        enable: "隐式缓存：缺省即开",
      },
      minPrefixTokens: { min: 512, max: 1024 },
      sources: [
        src(BAILIAN_URL, "通常按输入 Token 标准单价的 125% 计费，后续命中通常仅需支付 10% 的费用"),
        src(BAILIAN_URL, "缓存块的内容最少为 1024 Token。"),
        src(BAILIAN_URL, "对命中缓存的部分，通常按输入 Token 标准单价的 20% 计费"),
        src(BAILIAN_URL, "之间的内容创建为新的缓存块，有效期为 5 分钟。"),
        src(BAILIAN_URL, "不确定，系统会定期清理长期未使用的缓存数据"),
      ],
      note: "倍率原文带“通常”，有例外型号；最小前缀一般 1024，智谱部署的 GLM 与稀宇部署的 MiniMax 为 512",
    },
  },
  {
    id: "zhipu",
    servedBy: ["zhipu", "bigmodel", "zai", "zai-coding-cn"],
    rule: {
      mode: "auto",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "隐式缓存：缺省即开",
      },
      minPrefixTokens: { min: 500, max: 500 },
      sources: [
        src(ZHIPU_URL, "隐式缓存，智能识别重复的上下文内容，无需手动配置"),
        src(ZHIPU_URL, "重复的前缀内容必须足够长（建议 500 Token 以上）"),
        src(ZHIPU_URL, "按优惠价格计费（通常为标准价格的 50%）"),
        src(ZHIPU_PRICING_URL, "缓存存储当前限时免费。本页暂不展示免费期结束后的标准价格"),
      ],
      note: "最小前缀 500 是建议值；命中价缓存页写通常 50%，价格表实际约 22%–25%，以价格表为准；另有缓存存储费（目前限时免费）",
    },
  },
  {
    id: "xai",
    servedBy: ["xai"],
    rule: {
      mode: "auto",
      short: {
        seconds: "unknown",
        basis: "best-effort",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: "unknown",
        enable: "缺省即开；带 x-grok-conv-id（Responses 接口为 prompt_cache_key）可提高命中",
      },
      minPrefixTokens: "unknown",
      sources: [
        src(
          XAI_URL,
          "When consecutive requests share the same starting messages, the xAI API automatically caches them."
        ),
        src(
          `${XAI_URL}/best-practices`,
          "Cache entries can be evicted at any time due to server load or restarts."
        ),
        src(`${XAI_URL}/how-it-works`, "Prompt caching is not 100% guaranteed."),
      ],
      note: "命中按 reduced rate 计，价格页按模型约为输入价的 15%–25%",
    },
  },
  {
    id: "mistral",
    servedBy: ["mistral"],
    rule: {
      mode: "explicit",
      short: {
        seconds: "unknown",
        basis: "unstated",
        refreshOnHit: "unknown",
        writeMultiplier: "unknown",
        readMultiplier: 0.1,
        enable: "请求带 prompt_cache_key（同一 key 提高命中，不保证命中）",
      },
      minPrefixTokens: { min: 64, max: 64 },
      sources: [
        src(
          MISTRAL_URL,
          "Cached prompt tokens are billed at 10% of the standard input token price"
        ),
        src(
          MISTRAL_URL,
          "Set the same prompt_cache_key on requests that are likely to share a prefix."
        ),
        src(MISTRAL_URL, "Cache blocks contain 64 tokens."),
        src(MISTRAL_URL, "Prompts with fewer than 64 prompt tokens do not have cache hits."),
      ],
      note: "命中量为 64 token 的整数倍",
    },
  },
];

// 查不到时的规则：各项未知
export const UNKNOWN_CACHE_RULE: CacheRule = {
  mode: "unknown",
  minPrefixTokens: "unknown",
  sources: [],
};

// 按实际服务方与模型名查表：该服务方下取最长的匹配前缀所在的行，都不匹配取兜底行；查不到为 undefined
export function findCacheRule(
  servedBy: string,
  modelId: string,
  rows: readonly CacheRuleRow[] = CACHE_RULES
): CacheRuleRow | undefined {
  let best: { row: CacheRuleRow; length: number } | undefined;
  for (const row of rows) {
    if (!row.servedBy.includes(servedBy)) continue;
    const length =
      row.modelPrefixes === undefined
        ? 0
        : Math.max(
            -1,
            ...row.modelPrefixes.filter((p) => modelId.startsWith(p)).map((p) => p.length)
          );
    if (length >= 0 && (best === undefined || length > best.length)) {
      best = { row, length };
    }
  }
  return best?.row;
}

// ---- 设置里的覆盖（modelInfo 一节各模型的 cache；schema 在 model-info.ts）----

export interface RetentionTierOverride {
  seconds?: number;
  basis?: RetentionBasis;
  refreshOnHit?: boolean;
  writeMultiplier?: number;
  readMultiplier?: number;
}

export interface CacheRuleOverride {
  // 按哪家服务方的规则查表（经代理或兼容端点访问时指明实际服务方）；缺省为模型的 provider
  servedBy?: string;
  mode?: Exclude<CacheMode, "unknown">;
  short?: RetentionTierOverride;
  long?: RetentionTierOverride;
  minPrefixTokens?: number;
}

const UNKNOWN_TIER: RetentionTier = {
  seconds: "unknown",
  basis: "unstated",
  refreshOnHit: "unknown",
  writeMultiplier: "unknown",
  readMultiplier: "unknown",
  enable: "",
};

// 设置里给了的项逐项盖在查到的规则上（表里没有的档以全未知为底）
export function applyCacheRuleOverride(rule: CacheRule, override: CacheRuleOverride): CacheRule {
  const tier = (
    base: RetentionTier | undefined,
    over: RetentionTierOverride | undefined
  ): RetentionTier | undefined =>
    over === undefined ? base : { ...(base ?? UNKNOWN_TIER), ...over };
  const short = tier(rule.short, override.short);
  const long = tier(rule.long, override.long);
  return {
    ...rule,
    ...(override.mode !== undefined ? { mode: override.mode } : {}),
    ...(short !== undefined ? { short } : {}),
    ...(long !== undefined ? { long } : {}),
    ...(override.minPrefixTokens !== undefined
      ? { minPrefixTokens: { min: override.minPrefixTokens, max: override.minPrefixTokens } }
      : {}),
  };
}
