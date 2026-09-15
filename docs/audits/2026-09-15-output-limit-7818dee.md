# 失控止损施工审计与验证证据（基线 7818dee）

- 日期：2026-09-15
- 施工位置：隔离 git 工作树（分支 worktree-output-limit），自 7818dee 开出
- 来源：decisions.md 063（失控止损裁决，详情 docs/decisions/output-limit-decisions.md）
- 按 decisions.md 047 入库，只追加不覆盖

## 方法

- 测试先行：先写 5 份测试（输出上限包装、装配与 run.started、worker 继承、两种编辑模式的截断引导、截断与熔断端到端），跑一次确认为红再改代码。
- 开推理时实际发出的 max_tokens 用本地探针确认：直接调用 pi-ai 的 `streamSimple`，在 `onPayload` 里取请求体后抛错终止，不发网络请求（脚本与输出在本地 tmp/，不入库）。
- 变异反向验证沿用既有执行器：本地临时脚本把工作树的 src 与配置文件复制到一次性目录，目录联接挂 node_modules，施加单点变异（补丁原文必须恰好命中一次）后跑 `node --test --test-timeout=120000 "src/**/*.test.ts"`，解析变红用例。"精确变红"指变红集合里每一条都能由该变异直接解释，且不含无关用例。

## 首次红运行

| 范围 | 输出（本地 tmp/，不入库） | 结果 |
|---|---|---|
| 新增与改动的 5 份测试（9 条） | tmp/ol-red.txt | 8 红：包装模块不存在 1、装配与 run.started 3、worker 继承 1、截断引导 2、截断与熔断端到端 1；"编辑模式缺省为 replace"首次即绿 |

截断与熔断端到端那条首次红在"模型调用次数为 3"的断言上（实际 4），原因见下文"截断与熔断核实"，断言按事实改写。

## 改动

### S0 单轮输出上限

- `src/pi-runtime/output-limit.ts`：`DEFAULT_MAX_OUTPUT_TOKENS = 16_384`；`limitOutputTokens(streamFn, limit)` 返回包装后的 streamFn，调用时以 `{ ...options, maxTokens }` 传入，调用方已传的其他选项（signal、reasoning 等）原样保留；传入的 model 带有效上限（大于 0）时取两者中更小的那个。
- `src/application/runtime.ts`：`RuntimeDeps.maxOutputTokens`（缺省 16,384，非正整数构造期拒绝）；交给 Adapter 的 streamFn 换成包装后的版本；注入快照 model 段写入 `maxOutputTokens`。
- `src/pi-runtime/snapshot.ts`：注入快照 v4 → v5，model 段新增可选 `maxOutputTokens`（正整数），`migrateInjectionSnapshotV4toV5` 纯版本推进；`src/migration-completeness.test.ts` 与 `src/pi-runtime/snapshot.test.ts` 登记 v4 → v5。
- `src/state/runtime-events.ts`、`src/pi-runtime/adapter.ts`：run.started 的 model 摘要新增可选 `maxOutputTokens`，取冻结快照值。Event Log 不升版：与决策 050 给 run.started 加 `thinkingLevel` 同一做法，属可选字段加法，旧记录逐字有效，决策 063 之前的记录无此字段。
- 配置入口：`pigeon`（REPL）、`pigeon resume`、`pigeon run`、`pigeon eval` 与 tui 均新增 `--max-output-tokens <n>`（正整数）；headless API 与 `runEval` 选项新增 `maxOutputTokens`；`openRuntimeSurface` 与 `createDetachedRuntime` 透传。
- worker 继承：`createSessionWorkers` 在未显式传入时取父运行面冻结快照的 `model.maxOutputTokens`，交给 worker 运行面工厂。

已知边界：Adapter 交给上游的 model 是快照身份占位，`maxTokens` 为 0，真实模型元数据在 streamFn 插件里，因此包装层实际只传配置值；"模型定义值更小时取更小者"由包装层对传入 model 生效（单元测试覆盖），真实 provider 侧由 pi-ai 在请求时再按真实模型处理（见下文实测）。

### S1 截断后拆小引导

- `src/application/runtime.ts` 导出 `TRUNCATION_GUIDANCE`："工具调用若因输出上限未执行，把改动拆成几次较小的调用重发，不要原样重发；单次编辑只改需要改的那一段。" 两种编辑模式都拼在编辑句之后、"写操作可能需要人工批准。"之前。静态文本。
- `src/application/runtime-edit-mode.test.ts`：hashline 逐字断言改为"hashline 编辑句不变并追加截断引导"（原断言保留，期望文本加入引导句）；新增"两种编辑模式的 system prompt 都包含截断后拆小引导"。

### S2 截断与熔断核实

- `src/pi-runtime/fixtures.ts`（测试脚手架）：fake 回复可指定 `stopReason: "length"`，模拟撞输出上限。
- `src/application/output-limit-truncation-e2e.test.ts`：每轮回复都以 length 停止并带一条本可成功的 `edit_file` 调用，headless、yolo、replace 模式、轮次上限 10。

## 开推理时实际发出的 max_tokens

pi-ai 0.84.4 的 `streamSimple` 先取 `options.maxTokens ?? model.maxTokens` 并按上下文窗口收紧；随后分两类处理推理：

| 模型类型 | 推理档位 | 请求体 max_tokens（配置 16,384） | 请求体 max_tokens（配置 4,096） | 推理字段 |
|---|---|---|---|---|
| 自适应推理（Kimi For Coding，`compat.forceAdaptiveThinking`） | off | 16,384 | 4,096 | thinking disabled |
| 同上 | low / medium / high | 16,384 | 4,096 | thinking adaptive、output_config.effort 为对应档位 |
| 预算制推理（同一模型定义去掉自适应标记作对照） | off | 16,384 | 4,096 | thinking disabled |
| 同上 | low（预算 2,048） | 18,432 | 6,144 | 预算与上限相加 |
| 同上 | medium（预算 8,192） | 24,576 | 12,288 | 同上 |
| 同上 | high（预算 16,384） | 32,768 | 20,480 | 同上，并以模型定义值 32,768 封顶 |

结论：Kimi For Coding 开推理时推理与正文共用配置的上限，发出的 max_tokens 就是配置值；预算制模型上 pi-ai 会在配置值之上加推理预算（以模型定义值封顶），正文可用额度仍约为配置值。上游行为未改。

## 截断与熔断核实结论

端到端测试的事实（全部断言通过）：

- a. 工具不执行、文件不变：3 轮 `edit_file` 调用均未执行，文件内容逐字不变，账本无 intent 与 receipt。
- b. 被截断的调用计入上游拦截熔断：每次截断产生一条 isError 的 tool.settled 且无治理记录，同一工具连续 3 次后 Run 以 aborted 收尾，留下 1 条 breaker 记录（scope intercepted、toolName edit_file、count 3），失败分类为治理熔断。熔断在第 3 次 settle 时发出中止信号，此时上游循环已发起第 4 次模型调用，该调用随中止收尾、不带工具调用，所以 turn.completed 的停止原因依次为 length、length、length、aborted，模型调用 4 次。
- c. 过程指标：`outputLimitTurns` 为 3，`edit_file` 调用 3 次、报错 3 次，编辑错误分类 `output-limit` 计 3。

熔断阈值与判据未改。

## Kimi 真链路

`pigeon run`，Kimi For Coding（kimi-for-coding），yolo，在一次性 git 仓库中改一行文本；本地取证用的 streamFn 沿用 `spikes/real-stream-fn.mjs` 的接入，另以 `onPayload` 记录每次请求体的 max_tokens 与推理字段（不记密钥与正文）。

| 运行 | 参数 | 结果 | run.started 的 model 摘要 | 请求体 |
|---|---|---|---|---|
| 1 | 缺省上限，不开推理 | completed，4 轮，工具调用 3 次，目标行已改 | thinkingLevel off，maxOutputTokens 16384 | 4 次请求均 max_tokens 16,384，thinking disabled |
| 2 | 缺省上限，`--thinking medium` | completed，3 轮，工具调用 2 次，目标行已改 | thinkingLevel medium，maxOutputTokens 16384 | 3 次请求均 max_tokens 16,384，thinking adaptive，effort medium |

真链路未做小上限截断演示；截断行为以端到端测试为准。

## 变异反向验证（精确变红）

全部改动落地后逐处施加单点变异，每处跑全量 575 条测试：

| 编号 | 变异 | 结果 |
|---|---|---|
| 1 | `pi-runtime/output-limit.ts` 包装层不往选项里传 maxTokens | 精确 4 红：「输出上限包装：缺省 16,384；配置值覆盖……」、「输出上限装配（缺省）……」、「输出上限装配（配置 4096）……」、「worker 继承父运行面的输出上限……」 |
| 2 | `application/runtime.ts` 注入快照 model 段不写 `maxOutputTokens` | 精确 4 红：「输出上限装配：注入快照 model 段写入 maxOutputTokens……」、「输出上限装配（缺省）……」与「输出上限装配（配置 4096）……」（run.started 取自快照）、「worker 继承父运行面的输出上限……」（继承取自父运行面快照） |
| 3 | `application/runtime.ts` system prompt 不追加截断引导 | 精确 2 红：「两种编辑模式的 system prompt 都包含截断后拆小引导」、「编辑模式显式 hashline：……system prompt 的 hashline 编辑句不变并追加截断引导」 |
| 4 | `application/workers.ts` worker 不继承父运行面快照里的输出上限 | 精确 1 红：「worker 继承父运行面的输出上限……」 |

首轮变异执行时每处都多出同样两条红：`pi-runtime/snapshot.test.ts` 里仍按 v4 断言的「v4 快照 JSON 往返」与「v1 → v4 迁移链」，与变异无关，属于快照升 v5 时漏改的既有测试。补改为 v5（往返校验含 `maxOutputTokens`、非正整数输出上限被拒绝、迁移链登记 v4 → v5 且旧快照缺省该字段）后整轮重跑，上表为重跑结果。

## 门禁

`npm run verify`：biome 仅一条改动前已有的 noUnusedImports 警告（tui/main.ts）；tsc 零错；node --test 575/575；dependency-cruiser 276 模块 1889 依赖零违规。
