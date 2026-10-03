# 模型信息通路 审计

- 基线：5bbd0ec
- 分支：model-info
- 范围：决策 362（模型信息通路，性能调优第一波 1b）。pi 依赖锁定 0.84.4，不侵入其内部（决策 364）。两组提交：缓存规则表与出处检查脚本（bf646cd）；模型信息的声明、逐项取值、DeepSeek 价格、会话记录与查询（8cdac8d）。

## 现状

- 核心只看到占位模型：身份 custom/custom（`launch-flags.ts` 的 `DEFAULT_MODEL_PLACEHOLDER`）；`adapter.ts` 交给 Agent 的占位模型价格、窗口与输出上限均为 0，`runtime.ts` 给压缩摘要与网页提炼的占位模型价格为 0、输出上限未配置时为 0；`--provider`、`--model` 只是写进记录的标签。
- 真实模型对象在接入模块里构造。自带的 DeepSeek 接入（`deepseek-model.ts`、`deepseek-stream.ts`、`gateway-stream.ts`）的模型对象价格全为 0；花费由 `model-pricing.ts` 的官方人民币价目另算。`session-cost.ts` 靠"DeepSeek 回复的 `usage.cost` 为 0"改按人民币价目与高峰时段计；`script-host.ts` 以 `usage.cost.total > 0` 判定脚本预算为美元；trace 把 `usage.cost` 显示为 $。
- pi-ai 0.84.4 自带模型目录（`providers/all` 的 `getBuiltinModel(provider, id)`），有美元价格、上下文窗口与输出上限，没有缓存保留时长；目录里没有 deepseek-flash。

## 一、接入模块声明模型信息

- 接入模块可选地具名导出 `modelInfo`，与默认导出的 StreamFn 并存。字段取 pi-ai 模型对象的那一套：`provider`、`id`、`cost`（`input`、`output`、`cacheRead`、`cacheWrite`，每百万 token，另加 `currency`，缺省 USD）、`contextWindow`、`maxTokens`，各项可缺省；对象非严格，直接导出 pi-ai 模型对象也可（`state/model-info.ts` 的 `ModelInfoDeclarationSchema`）。
- `runtime.ts` 的 `loadStreamFn`：取出 `modelInfo` 并校验，不合规即报错并指出字段（`pi-runtime/model-access.ts` 的 `parseModelInfoDeclaration`）；不导出的老模块照常可用。声明与目录查询随 StreamFn 登记（`registerModelAccess`，按函数对象的 WeakMap）；装配运行面时按 `deps.streamFn` 取出，worker、续接与 `/reload` 重建拿到的是同一个函数，不逐层传参。没登记的 StreamFn（测试夹具等）两样都没有。
- pi-ai 目录只在声明没给全价格、窗口与输出上限时才动态加载（`loadCatalogLookup`）。目录模块的说明符经变量给出：它的类型声明引用 JSON 不带 import 属性，在本仓库的 tsc 设置（`skipLibCheck` 关闭）下报 TS1543，故不让 tsc 解析其类型。目录里窗口或上限不是正整数的项当作没给。
- 跑批网关接入（`gatewayStreamFn`）返回的 StreamFn 登记与自带 DeepSeek 接入同一份声明，`modelMaxTokens` 给了即替换声明的输出上限。

## 二、逐项取值与设置

- `resolveModelInfo`：价格、窗口、输出上限逐项取，设置 > 声明 > 目录 > 未知；价格的四个数与币种算一项，整体取自同一来源。目录只在前两层没给全时查。
- 身份：声明了 `provider` 或 `id` 即用声明的（`identity: "declared"`），否则用启动参数的标签（`identity: "launch"`）；设置与目录都按这个身份匹配。
- 设置新增 `modelInfo` 一节（`SETTINGS_SECTIONS`、`SettingsFileSchema`、`MergedSettings`，取值口 `modelInfoSectionOf`）：`models` 的键为 `"<provider>/<模型名>"`，不合格式的键报错（`Type.Record` 带 `additionalProperties: false`，pattern 才对键生效）；值可写 `cost`（四个价格与 `currency` 须写全：三层按键合并，币种必填才不会沿用低层的币种）、`contextWindow`、`maxTokens`、`cache`（见第三节）。三层照常按键覆盖。
- `docs/configuration.md`：各节表加 `modelInfo` 一行；新增"模型信息"一节（优先级、接入模块的声明、设置的覆盖值、缓存规则表与检查脚本）。

## 三、缓存规则表

`src/state/cache-rules.ts`：TS 常量表 `CACHE_RULES`，纯数据，不依赖任何包。每行有行标识、实际服务方（pi-ai 的 provider 名与常见别名）、可选的模型名前缀，以及规则：缓存方式（auto、explicit、both、none）；`short`、`long` 两档（较短或缺省的一档、较长或须另开的一档），每档记秒数或未知、依据类别（fixed、minimum、typical、best-effort、unstated）、命中是否续期、写缓存倍率、命中倍率、如何开启；最小可缓存前缀（区间或未知）；出处（URL、取用日期 2026-10-03、原文短引，可多条）；补充说明。写缓存倍率 1 表示不另收写入费。

- 查找（`findCacheRule`）：按实际服务方筛，同一服务方下取最长的匹配前缀，都不匹配取该服务方没有前缀的兜底行；查不到为 undefined，规则记为全未知（`UNKNOWN_CACHE_RULE`），由用到它的功能各自保守处理。按服务方定键，不按接口格式：经 Anthropic 兼容端点访问的 DeepSeek 查 DeepSeek 的行。
- 设置的覆盖（`modelInfo.models.<键>.cache`）：`servedBy` 指明按哪家服务方查表（经代理或兼容端点访问时用）；`mode`、`minPrefixTokens` 与两档的 `seconds`、`basis`、`refreshOnHit`、`writeMultiplier`、`readMultiplier` 逐项盖在查到的规则上（`applyCacheRuleOverride`，表里没有的档以全未知为底）。
- 首批 19 行：Anthropic 直连（兜底、Opus 5.5、Fable 与 Mythos 5.1）；OpenAI（更早的模型兜底、GPT-5.5、GPT-5.6 及以后、GPT-6.1 Sol）；Gemini API；Vertex 上的 Gemini 与 Claude（同一服务方按 `gemini-`、`claude-` 前缀分）；Bedrock 上的 Claude（按带地区前缀的 `anthropic.claude` 分）；DeepSeek；Kimi（兜底、K3、K2.6 与 K2.7）；阿里云百炼（含 pi-ai 的 qwen-token-plan 三个 provider）；智谱（含 pi-ai 的 zai、zai-coding-cn）；xAI；Mistral。

与决策 362 所列首批说法不符或查不到的条目（以官方页面为准）：

- Anthropic：读 0.1 倍只是标准倍率，Opus 5.5 为 0.05 倍，Fable 5.1 与 Mythos 5.1 为 0.025 倍（Opus 5.5、Fable 与 Mythos 5.1 按模型前缀另列两行）；最小前缀分 512、1024、2048、4096 四档；时长自写入或读取该条缓存的请求开始时算起。
- OpenAI GPT-5.6 及以后：隐式与显式缓存都支持，缺省为隐式（断点在最新一条合格消息末尾），只用显式须另设，缓存方式记 both；30 分钟原文另说可能留得更久（依据记 minimum）；读 0.1 倍有例外，GPT-6.1 Sol 为 0.05 倍（另列一行）；最小 1,024 只计可见的输入 token。
- OpenAI 更早的模型：GPT-5.5 与 5.5 Pro 只支持 24h 档（另列一行），in_memory 只适用于更早的模型；最小前缀随请求设置而变（记未知）；读取倍率按模型不同（记未知）。
- Gemini API：缓存页只写命中按 reduced rate 计，未给 0.1 倍（记未知；价格页上多数模型约为输入价的 10%）；"按小时收存储费"只在价格页；最小前缀 2048、4096 只在表格里，没有纯文本引句；显式缓存标为 Beta，只限 generateContent；caching 页缺省显示 Interactions API 版，显式缓存的内容在 generate-content/caching 页。
- Vertex 上的 Gemini：最短 1 分钟与最小前缀只在表格里；显式缓存的写入同样按标准输入价（原文对隐式与显式都如此），另按存储时长收存储费；命中折扣 2.5 及以后为 90%，2.0 的显式为 75%；文档已迁到 Gemini Enterprise Agent Platform 的路径。
- Bedrock 上的 Claude：1 小时档 3.7 Sonnet 与 3.5 Sonnet v2 不支持；页面称隐式与显式两种都支持、按模型与接口而定（缓存方式记 both）；Opus 4.7 的最小前缀此页为 4096、Anthropic 页为 2048，两页不一致。
- Vertex 上的 Claude：页面未写最小前缀与自动缓存（缓存方式记 explicit、最小前缀未知）；1 小时档 3.7 Sonnet、3.5 Sonnet、3 Opus 不支持。
- DeepSeek：缓存页未写写入费，价格页只有命中与未命中两档、没有写入计费项（写入倍率记 1）；清除时间原文"一般为几个小时到几天"，秒数取保守下限 3600、依据记 best-effort；最小前缀未写。
- Kimi：走 Anthropic 接口时不带 cache_control 只读不写；K2.x 原文只点名 kimi-k2.7、kimi-k2.7-highspeed、kimi-k2.6 不支持 Cache Write（按这几个前缀列行，其余 Kimi 模型写入倍率记未知）；最小前缀未写（只说按块存储，块大小未写）；K3 价格页的表格须浏览器渲染，引句取自同页的纯文本。
- 阿里云百炼：倍率原文带"通常"，有例外型号；隐式缓存的最小前缀同为 1024，智谱部署的 GLM 与稀宇部署的 MiniMax 为 512（区间记 512–1024）。
- 智谱：缓存页写命中"通常为标准价格的 50%"，价格表上实际约 22%–25%，两页不一致（命中倍率记未知，以价格表为准）；价格表另有缓存存储费（目前限时免费）；"建议 500 Token 以上"是建议值，不是硬性下限。
- xAI：文档地址已变；命中按 reduced rate 计，价格页按模型约为输入价的 15%–25%（记未知）。
- Mistral：原文要求设置同一 `prompt_cache_key` 来开启缓存，同时说 key 只提高命中机会，页面未明说不带即不缓存（缓存方式记 explicit）；少于 64 token 无命中（最小前缀记 64）；文档地址已变。

## 四、出处检查脚本

`scripts/check-cache-rule-sources.ts`，手动运行，不进 CI：逐个抓取出处页面，去掉 script、style 与注释，标签换成空格（另试换成空串），解码 HTML 实体，连续空白折成一个空格后找引句子串；不在的行标为"需复核"并列出清单，有需复核的行时退出码为 1。

- Node 的 fetch 不读 HTTPS_PROXY，经代理上网时须另设 `NODE_USE_ENV_PROXY=1`。
- Google 的页面不带 `?hl=en` 时会被转到别的语言版本，表中 Google 的地址一律带 `?hl=en`。
- 2026-10-03 运行：19 行全部通过。

## 五、自带 DeepSeek 补上价格

- `deepseek-model.ts` 新增 `deepseekModelInfo(modelId, maxTokens)`：身份、窗口与输出上限同模型对象；价格取 `model-pricing.ts` 的非高峰价，币种 CNY：`input` 为未命中价 1、`output` 4、`cacheRead` 为命中价 0.02、`cacheWrite` 按未命中价 1（Anthropic 兼容端点的 `cache_creation_input_tokens` 出现时按未命中价计，同 `model-pricing.ts`）。高峰加价由计费另算，不影响命中与未命中的价格比。入口模块 `deepseek-stream-fn.ts` 具名导出 `modelInfo`。
- 分工：价格只放在声明里，交给 pi-ai 的模型对象价格仍为 0。pi-ai 按 `model.cost` 算每条回复的 `usage.cost`，现有的会话花费、状态栏、脚本预算的币种判定与 trace 都依赖 DeepSeek 回复的 `usage.cost` 为 0；模型对象带上价格会使这些判定改变。模型对象价格为 0 的那一处加了注释说明。查询接口与 Run 开始条目用声明里的价格，价格带币种；命中价、未命中价、写缓存价三者的比值与币种无关。

## 六、会话记录

- Run 开始条目加可缺省的 `modelInfo`（`session-entries.ts` 的 `RunStartDataSchema`，形状为 `model-info.ts` 的 `RunModelInfoSchema`）：`provider`、`id`、`identity`；`cost`、`contextWindow`、`maxTokens` 各为 `{ source, value }`（source 为 settings、declared 或 catalog）或 `{ source: "unknown" }`；`cacheRule` 记按哪家服务方查（`servedBy`）、命中的表行（`row`，查不到不写）与是否有设置覆盖（`overridden`）。加法式，不升版本；注入快照不变。
- `buildRuntime` 解析一次，经 adapter 的新选项 `modelInfo` 写进每个 Run 的开始条目；运行面（`RuntimeBundle`）另带解析结果 `modelInfo`。

## 七、查询接口

`state/model-info.ts` 的 `modelProfile(info)`：返回解析后的模型信息、缓存规则，以及每百万 token 的命中价、未命中价、写缓存价与币种，取不到的标 `unknown`。约定：命中价取 `cacheRead`，为 0 视为没给；未命中价取 `input`；写缓存价取 `cacheWrite`，为 0 表示不另收写入费，取未命中价；价格全为 0（pi-ai 自定义模型的写法）或价格未知时三者都未知。

本段不改裁剪、压缩或输出上限的行为：占位模型、压缩配置与输出上限的取值未动。现有测试未改动。

## 测试

- `src/state/model-info.test.ts`（6 项）：逐项取值（设置、声明、目录各给一项，没人给的为未知）；价格整体取（设置的价格连同币种盖掉声明的，声明不写币种按 USD，前两层给全时不查目录）；身份（声明优先于启动标签，设置与目录按它匹配）；缓存规则按实际服务方查（DeepSeek 查 DeepSeek 的行，设置指明服务方并逐项覆盖，查不到为全未知）；查询的三价与币种（写入不另收费取未命中价，全 0 或未知即三者未知）；设置节的校验（键格式、价格须带币种）。
- `src/state/cache-rules.test.ts`（3 项）：查找规则（服务方筛、最长前缀、兜底、别家同名前缀不串行、查不到）；首批表的细分落行（DeepSeek、Anthropic、OpenAI、Bedrock）；表的每行行标识唯一、至少一条出处、档位的数在合理范围。
- `src/application/runtime-model-info.test.ts`（3 项）：`loadStreamFn` 取出声明、不导出照常可用并备好目录查询、不合规即报错指出字段；经 `runHeadless` 的 Run 开始条目记下模型信息与每一项的来源（设置盖过声明、没人给的记未知）；DeepSeek 声明的人民币价与 `model-pricing.ts` 一致、模型对象价格仍为 0、网关接入登记同一份声明并带上输出上限的替换。
- 新增产品代码约 1,320 行（其中缓存规则表的数据约 700 行），新增测试 279 行。

变异（服务器，只做关键判定）：
- 优先级合并：设置与声明换位 → 2 项变红；跳过设置层 → 3 项变红；目录排在声明之前 → 1 项变红。
- 按实际服务方查缓存规则：忽略设置指明的服务方 → 1 项变红；查表不按服务方筛 → 3 项变红；首个匹配即取、不取最长前缀 → 2 项变红；前缀不匹配的行也收 → 2 项变红。
- 均还原后逐字一致。

## verify 的实际运行情况

服务器 pigeon-verify（8 vCPU、31 GB 内存、Node 24.12.0），提交 8cdac8d，一条前台命令依次跑完：`npm run lint`、`npm run check`、`node --test --test-concurrency=6 "src/**/*.test.ts"`（运行前无别的测试在跑）、`npm run deps`，全过，全程约 110 秒。测试 1,639 项：通过 1,637，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：578 个模块，无违规。

## 补记：验收修正

改法（提交 6399dee）：
- 价格全为 0 的一层在合并时就当作没给价格，继续往下层取（`model-info.ts` 的 `given`），会话记录的来源即实际取到的那一层；查询不再单独判全 0。
- pi-ai 目录加载失败（导入出错或没有 `getBuiltinModel`）：`loadCatalogLookup(warn, importModule)` 告警一行并返回 undefined，各项按未知处理，接入模块照常启动；`loadStreamFn` 加可选的告警出口（缺省标准错误输出）。
- 跑批网关接入给的输出上限不是正整数时（如 0），`deepseekModelInfo` 不声明 `maxTokens`（按未知处理），Run 开始条目不再出现违反最小值 1 的值。
- 实际服务方：设置的 `cache.servedBy` > 声明的 `servedBy` > 声明的 `baseUrl` 主机名查已知服务方（`cache-rules.ts` 的 `SERVED_BY_HOSTS`，一处常量：DeepSeek、Anthropic、OpenAI、Gemini API、Vertex、Bedrock、Moonshot 与 Kimi、百炼（DashScope 与 MaaS）、智谱、xAI、Mistral 的接口主机，整段匹配）> provider 标签。Run 开始条目的 `cacheRule` 加 `servedByFrom`（settings、declared、host、provider）。声明加 `baseUrl`、`servedBy` 两个字段；自带 DeepSeek 的声明写明 `servedBy` 为 deepseek（端点根改指转发代理或经跑批网关时也是）。
- 声明仍非严格；既不是 pi-ai 模型字段（0.84.4 的 `Model`）、也不是 modelInfo 字段的顶层键，加载时告警一行并忽略（`DECLARATION_KEYS`）。
- 缓存规则表：行可列精确型号（`models`），匹配度为精确型号 > 最长前缀 > 兜底行。OpenAI 的"5.5 之前"一行改为逐个列出（`gpt-5` 精确，`gpt-3.5`、`gpt-4`、`gpt-5-`、`gpt-5.1` 至 `gpt-5.4`、`chatgpt-4o`、`o1`、`o3`、`o4` 前缀），OpenAI 下没有兜底行，未列出的型号（如 gpt-7）为未知。Vertex 上的 Gemini 分为 2.5 及以后（`gemini-2.5`、`gemini-3` 前缀，命中 0.1 倍）与 2.0（显式命中 0.25 倍，隐式未知）两行，补原文引句；其余 Gemini 型号为未知。Kimi 不另收写入费的一行只列文档点名的 kimi-k2.7、kimi-k2.7-highspeed、kimi-k2.6（精确型号），kimi-k2.7-code 等落到兜底行（写入倍率未知）。DeepSeek 的写入倍率改记未知（价格页只有输入的命中、未命中与输出三项，未写写入费），补价格页按输入输出 token 计费的引句。智谱的最小前缀改记未知（"建议 500 Token 以上"是建议值），删去"以价格表为准"的说法，命中倍率仍记未知。
- 出处检查脚本于 2026-10-03 重跑：20 行全部通过。
- `docs/configuration.md` 的"模型信息"一节补上全 0 价格、目录加载失败、`servedBy` 与不认识字段的告警、服务方的取法与没有兜底行的服务方。

测试：
- `cache-rules.test.ts`（4 项）：查找的匹配度（精确型号、最长前缀、兜底、不串行、查不到）；首批表的细分（含 gpt-7 与 Vertex 上的 gemini-flash-latest 为未知、kimi-k2.7-code 落兜底行、Vertex 的 2.0 与 2.5+ 分行）；主机名判定（整段匹配，带后缀的冒名主机与回环地址不判），主机表里的服务方在规则表里都有行；表的每行有出处，依据类别为 unstated 时秒数未知、为 fixed、minimum、typical 时秒数已知，长档不短于短档，已知的写入倍率不小于 1、命中倍率小于 1。原"档位的数不小于 0"一项删去。
- `model-info.test.ts`（8 项）：新增全 0 价格逐层跳过；服务方一项改为声明真实的 `baseUrl`，依次验主机名、声明、设置三层的优先与回落到 provider 标签；设置逐项覆盖与查不到为全未知单列一项。
- `runtime-model-info.test.ts`（4 项）：加载时 pi-ai 模型字段不告警、不认识的顶层键告警；目录查询的解析（美元、窗口为 0 当作没给）与导入失败、没有查询函数时的告警与兜底；Run 开始条目带 `servedByFrom`；自带 DeepSeek 声明服务方，网关输出上限为 0 时不声明。

变异（服务器）：设置与声明换位 → 2 项变红；全 0 价格不跳过 → 1 项变红；声明的服务方不生效（主机名先于声明）→ 1 项变红；不看主机名 → 1 项变红；设置的服务方不生效 → 2 项变红；精确型号不优先 → 2 项变红；前缀不匹配的行也收 → 2 项变红；查表不按服务方筛 → 4 项变红；均还原后逐字一致。

verify：服务器 pigeon-verify，提交 6399dee，一条前台命令依次跑完 `npm run lint`、`npm run check`、`node --test --test-concurrency=2 "src/**/*.test.ts"`（运行前另有两家的测试在跑）、`npm run deps`，全过，全程约 245 秒。测试 1,643 项：通过 1,641，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：578 个模块，无违规。
