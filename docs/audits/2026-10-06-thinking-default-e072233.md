# 审计：缺省开思考（决策 390）

基线：origin/main e072233（头提交含决策 390）。分支 worktree-agent-a5c6a9561acd1881f。

## 现状（改前）

- 推理档位只有两个来源：启动参数 `--thinking` 与 worker 的角色档位；都没给即 off（`src/pi-runtime/adapter.ts` 的 `DEFAULT_THINKING_LEVEL`），注入快照里不写档位，Run 开始条目记 off。自带 DeepSeek 接入的模型对象 `reasoning` 为真，off 时 pi-ai 显式发 `thinking: {"type":"disabled"}`。
- 装配层"开了思考就不下发温度"的判断只看启动参数给的档位。
- 模型信息（决策 362）不含"是否支持推理"。
- 跑批身份头的 `thinking` 记 `pigeon.thinking ?? off`；`temperature` 记给的值（跑批缺省 0），不论是否下发。

## 改法

1. 模型信息加"是否支持推理"（`reasoning`）：接入模块声明 > pi-ai 自带目录 > 未知，设置里不覆盖。声明的 schema 接受 `reasoning`；目录查询取模型对象的 `reasoning`；声明缺 `reasoning` 即算没给全，会去查目录。Run 开始条目的 `modelInfo` 加 `reasoning`（带来源；旧记录没有这一项，照常读取）。自带 DeepSeek 接入与跑批网关接入共用的 `deepseekModelInfo` 声明 `reasoning: true`，与模型对象一致。
2. 新增 `src/state/thinking-config.ts`：设置的 `thinking` 一节（`level`，七档之一）与取值函数 `resolveThinkingLevel`——启动参数（含 worker 角色档位、跑批显式给的）> 设置 `thinking.level` > 按模型信息（支持推理即 high，不支持或未知即 off）。
3. `buildRuntime` 在得到模型信息之后取一次档位，结果总写进注入快照与 Run 开始条目；温度是否下发改按取定的档位判断（不是 off 就不下发，Run 开始条目记 `temperatureIgnored`）。终端界面、`--line`、`pigeon run`、`pigeon resume`、分叉、沙箱会话、worker、脚本编排与跑批的进程内条件都经 `buildRuntime` 装配，取法一致；worker 没有角色档位也没有启动参数时，用派出方的设置快照与自己所用模型的信息取同样的缺省。
4. `DEFAULT_THINKING_LEVEL` 保留为 off，只作快照缺档位时的兜底（直接构造的适配器与旧快照），注释改写。
5. 跑批身份头（`effectivePigeonSettings`）：档位用同一个 `resolveThinkingLevel`，模型信息取网关接入登记的 `deepseekModelInfo`（跑批不读设置），没给即 high；温度只在档位为 off 时记给的值，否则记 null。身份头结构不变；以前写下的身份头缺省条件记的是 off 与 0，续跑即判为不同。
6. 最简 agent 的同源检查（`stream-mini-settings.test.ts`）去掉"Pigeon 缺省 off"一句，只查 `run_mini.py` 自己显式关思考；`run_mini.py` 未改。
7. `docs/configuration.md`：新增"推理档位（思考）"一节（缺省、档位、关闭方法，对花费、等待、温度与输出上限的影响，DeepSeek 上档位的区分），设置表加 `thinking` 一行，模型信息一节补"是否支持推理"。
8. 终端界面没有显示思考档位的地方（状态栏只显示模型、上下文用量与花费），未改。

## 温度

- pi-ai 0.84.4 的 anthropic-messages 线路请求了推理时 `buildParams` 不写 `temperature`；Pigeon 装配层在档位不是 off 时也不把温度交下去（不套 `fixTemperature`），Run 开始条目记 `temperatureIgnored`（请求值与原因 `reasoning-enabled`）。
- 用真的 `streamSimple` 加假 fetch 捕获网关接入的请求体：缺省（high）时 `thinking` 为 `{"type":"enabled","budget_tokens":16384,"display":"summarized"}`、没有 `temperature`；`--thinking off` 加温度 0 时 `thinking` 为 `{"type":"disabled"}`、`temperature` 为 0。
- 压缩摘要与 `web_fetch` 的提炼是另发的请求，用占位模型（`reasoning` 为假），不请求推理，对 DeepSeek 照旧显式关思考，温度照旧下发（压缩摘要用给定温度，提炼固定 0）。
- 跑批身份头的温度：开思考记 null。

## 历史推理回传（只查清，未改）

### 现状

每次请求的链路：Agent 持有的消息含每条助手回复的思考块（`thinking`，签名 `thinkingSignature` 取自流里 `content_block_start` 的 `signature` 与 `signature_delta`）→ `convertToLlm`（助手消息原样保留）→ 上下文裁剪（只换工具结果正文，不碰思考）→ pi-ai `buildParams` 里的 `transformMessages` 与 `convertMessages`。

- 同一模型（助手消息的 provider、api、model 与请求的模型对象相同）的历史回复，思考块全部保留：
  - 签名非空：作为 `thinking` 块（带 `signature`）回传。
  - 签名为空：模型对象没设 `compat.allowEmptySignature`（Pigeon 的 DeepSeek 模型对象没设），思考正文改作普通 `text` 块回传。
- 换了模型的历史回复：思考正文改作 `text` 块。
- 出错或中止的助手回复整条不回传（pi-ai 跳过 stopReason 为 error、aborted 的消息）；撞上限续跑（决策 367）去掉的截断回复不在上下文里。
- 压缩之后：被摘要的那段历史连同其中的思考换成摘要，保留段照旧回传。
- 续接：会话存储缺省保存思考（`--no-persist-thinking` 时写入前剥去），续接从会话记录还原，缺省续接后照旧全回传；关了持久化的会话续接后，之前各轮没有思考可回传。

结论：现状即"每条历史回复的推理整段回传"——回传未被压缩掉的全部历史回复，每条整段，范围与对照 harness 的做法相同。差别只可能在形式：DeepSeek 的 Anthropic 兼容端点回的思考块是否带非空签名，决定 Pigeon 以 `thinking` 块还是以普通文字回传；未发真实请求，没有核实。用假 fetch 确认了两种形式的请求体：带签名为 `thinking + tool_use`，不带签名为 `text + tool_use`。

### DeepSeek 文档的相关条目（2026-10-06 查）

- Anthropic 兼容接口（api-docs.deepseek.com/guides/anthropic_api）：`thinking` 为 "Supported (`budget_tokens` is ignored)"；`output_config` 为 "Only `effort` is supported"；消息内容的 `thinking` 块 "Supported"、`redacted_thinking` "Not Supported"；页面没有提到 signature。
- 思考模式（api-docs.deepseek.com/guides/thinking_mode）：思考模式缺省开，缺省强度 high；不支持 temperature 等参数，设了不报错也不生效；请求不带 tools 时以前的 `reasoning_content` 不需回传、回传也被忽略；带 tools 时以前各轮的 `reasoning_content` 要全部回传并拼进上下文，没有正确回传返回 400。该条以 OpenAI 格式的 `reasoning_content` 写成，Anthropic 兼容端点对 `thinking` 块是否同样要求未核实。

### 选项与对花费、缓存的影响

DeepSeek 价目：缓存命中 0.02、未命中 1、输出 4 元/百万 token，命中价为未命中价的 1/50。Pigeon 的请求恒带 tools。

- 全回传（现状）：以前的思考作为输入每次都发；它们在不变的前缀里，除首次外按命中价计；上下文涨得快，压缩更早触发；符合 DeepSeek 文档对带 tools 请求的要求。
- 只回传最近一轮：按"最近一条助手回复"算时，每走一步都要删掉上一条回复的思考，前缀在那条回复处改变，从那里到末尾每次按未命中价重算，省下的是以前思考按命中价的那份——以前思考的总量不到每步改写段的约 50 倍时反而更贵；按"最近一条使用者消息以来"算时，无人值守一题只有一条使用者消息，等同全回传。与 DeepSeek 带 tools 时的回传要求冲突（对 Anthropic 端点未核实）。
- 不回传：输入最少，前缀里从不含思考，缓存稳定；模型在各步之间看不到自己以前的推理；与 DeepSeek 带 tools 时的回传要求冲突（同上，可能 400）。

## 档位与输出上限的其他事实

- pi-ai 对没有 `forceAdaptiveThinking` 的模型按档位换算 `budget_tokens`（minimal 1,024、low 2,048、medium 8,192、high 及以上 16,384），不发 `output_config.effort`。DeepSeek 忽略 `budget_tokens`，故 off 以外各档在 DeepSeek 上都是服务端缺省强度 high。
- 跑批进程内条件没配置输出上限时以 16,384 作模型上限；开思考后实际请求为 `max_tokens` 16,384、`budget_tokens` 15,360，思考与回答共用 16,384。
- 日常使用配置了单轮输出上限 n 时，开思考后实际 `max_tokens` 为 n 加档位预算（不超过模型上限），例如 n = 8,000、high 时为 24,384；没配置时仍为模型上限 393,216。

## 测试

- `runtime-thinking.test.ts`：取法七种情形（不知道、声明不支持、声明支持、`--thinking off`、设置 off、设置 low、启动参数盖过设置），看交给上游的 `reasoning` 与 Run 开始条目；经网关的 DeepSeek 接入用真 pi-ai 加假 fetch 看请求体与 Run 开始条目（缺省开思考、不发温度并记未生效；off 时 thinking disabled 与温度 0）；worker 角色覆盖、继承全局、无全局时按模型信息。
- `model-info.test.ts`、`runtime-model-info.test.ts`：`reasoning` 的逐层取值与记录、目录查询取 `reasoning`、DeepSeek 声明与模型对象一致。
- `stream-experiment.test.ts`：身份头缺省记 high 与 null；温度只在 off 时记给的值。
- 变异验证（每条改掉判定、确认相应用例变红，还原后工作区干净）：
  - 支持推理的模型缺省改成 off：`runtime-thinking` 3 条、`stream-experiment` 2 条变红。
  - 不知道是否支持推理时也开：情形"不知道是否支持推理"变红。
  - 声明不支持推理也开：情形"声明不支持推理"变红。
  - 忽略启动参数：情形"--thinking off"等 3 条变红。
  - 忽略设置：情形"设置 thinking.level off"变红。
  - 温度改成总是下发：`sampling-e2e`"推理开启时温度不生效"变红；改回只看启动参数的写法：`runtime-thinking` 的网关用例变红。
  - 身份头档位改回缺省 off、温度改回记给的值：`stream-experiment` 各 2 条变红。
  - DeepSeek 声明的 `reasoning` 改为假：`runtime-thinking` 网关用例与 `stream-experiment` 2 条变红。

## 附带小修：建锁原子性用例

- 原因：父进程启动读锁的子进程后不等它，400 次取放可能在子进程开始读之前做完，防空转检查判失败。
- 改法：子进程开始读之前写就绪文件，读到 20 次时写够数文件；父进程等就绪文件出现再取放，取放持续到够数文件出现，两处等待各以 15 秒为上限；防空转检查改为至少读到 20 次；用例中途失败时杀掉子进程。
- 变异：子进程延迟 3 秒启动并去掉两处等待（改回固定 400 次）：防空转检查变红（读到 0 次）；只延迟子进程、保留等待：通过；还原后通过，工作区干净。

## 提交

- 399f288 Resolve whether the model supports reasoning in model info
- 57909cb Default the thinking level to high for reasoning models
- 9e07979 Record the effective thinking level and sent temperature in the stream identity
- 704892e Document the thinking default, its setting and its costs
- 40bd329 Align the lock atomicity test on signals from the reader process
- a433dc1 Check the recorded temperature on the default thinking path

## verify 的实际运行情况

- 本机：只跑改动涉及的测试文件（`--maxWorkers=2`），全部通过；`npm run check` 通过。
- 验证服务器（8 vCPU、31 GB 内存、Node 24.12.0），提交 a433dc1，`TEST_CONCURRENCY=6`（开跑前服务器上没有别的测试在跑）：`npm run verify:full` 退出码 0——lint 通过，check 通过，测试 325 个文件、1854 通过、7 跳过，deps 无违规。

## 需要裁决的问题

1. 历史推理回传：A 维持全回传（现状）；B 只回传最近一轮；C 不回传。
2. DeepSeek 思考块的签名：A 试跑时从网关留存的回复核对 signature，为空再定；B 预先给 DeepSeek 模型对象设 `compat.allowEmptySignature`，空签名也以 `thinking` 块回传。
3. 跑批进程内条件的输出上限：开思考后思考与回答共用 16,384。A 维持；B 调整。
4. 最简 agent 的思考开关：A 维持关（决策 203）；B 随决策 390 开。
5. DeepSeek 上的档位：A 维持（各档同为服务端缺省 high）；B 按档位发 `output_config.effort`。

## 回报

分支 worktree-agent-a5c6a9561acd1881f，代码头 a433dc1，其上为本审计提交；审计 docs/audits/2026-10-06-thinking-default-e072233.md。改法：模型信息加 reasoning；档位按 --thinking＞设置 thinking.level＞模型信息（支持推理即 high）取定；开思考不发温度；跑批身份头记 high、温度 null；锁用例按信号对齐。历史推理：现状全回传（空签名时以文字回传，DeepSeek 给不给签名未核实）；选项全回传／最近一轮／不回传。服务器 verify:full 全绿。待裁：回传方式、签名、跑批 16,384 共用、最简 agent 思考、DeepSeek effort。

## 补充：空签名

- 改法：DeepSeek 的模型对象（`src/pi-runtime/deepseek-model.ts` 的 `deepseekModel`，自带 DeepSeek 接入与跑批网关接入共用）加 `compat: { allowEmptySignature: true }`。签名为空、正文非空的历史思考块由 pi-ai 以 `{"type":"thinking","thinking":…,"signature":""}` 回传，不再改作普通 `text` 块；有签名的思考块不受影响。网关接入替换输出上限时展开同一个模型对象，开关随之生效。`docs/configuration.md` 推理档位一节的"花费"一条补一句。
- 测试：`deepseek-stream.test.ts` 新增一条，用真 pi-ai 加假 fetch，历史里放一条签名为空的思考块加工具调用，分别经自带接入与网关接入（16,384 上限）发出，断言请求体里该块仍是 thinking 块、signature 为空串；原有的模型对象逐项比对补上 `compat`。
- 变异：去掉这个开关，新用例（自带接入）与模型对象比对两条变红；还原后通过，工作区干净。
- verify：本机只跑 `deepseek-stream.test.ts`（`--maxWorkers=2`）通过，`npm run check` 通过。验证服务器（8 vCPU、31 GB 内存、Node 24.12.0），提交 442c722，`TEST_CONCURRENCY=6`（开跑前没有别的测试在跑）：`npm run verify:full` 退出码 0——lint 通过，check 通过，测试 325 个文件、1855 通过、7 跳过，deps 无违规。
