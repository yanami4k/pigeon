# 撞上限续跑与流式重复检测 审计

- 基线：5bbd0ec
- 分支：runaway-guard
- 范围：决策 367（性能调优第一波 1c）：撞上限续跑、流式重复检测、两项的设置与跑批参数。pi 依赖仍为 0.84.4，未改其内部，改动在 Pigeon 的适配层与装配层

## 一、现状

- 一条回复以 `stopReason: "length"` 结束且没有工具调用时，上游循环直接结束，`adapter.ts` 的 `#judgeTerminal` 判为 completed。截断里带工具调用的，上游把调用判为未执行、补出错的工具结果并接着下一轮（`output-limit-truncation-e2e.test.ts` 覆盖）。
- 决策 347 之后，未配置单轮输出上限时按模型上限发，一次逐字循环可以写到模型上限才停。
- 打转检测（决策 305–308）看整轮的工具调用，不看正文；没有流式的重复检测。
- 空回复重试（决策 170 ②）已有"暂扣 agent_end、从 Agent 状态去掉末条消息、同一个 Run 里接着跑"的做法；它不动会话树，恢复时空回复仍在上下文里。
- 恢复（`pigeon resume`、终端界面 `/resume`、worker 续做）与分叉都按会话文件的主分支（main 道从根到叶）用 pi 的 `buildSessionContext` 还原上下文（`restoreSessionContext` / `sessionContextMessages`）；轮间压缩后的还原、压缩时的摘要输入同样读主分支。

## 二、撞上限续跑

改法（`pi-runtime/adapter.ts`、`pi-runtime/session-store.ts`、`state/session-entries.ts`）：
- Adapter 新选项 `truncationContinuation: { maxConsecutive, maxPerRun }`，不给即不续跑（Adapter 层缺省关，由装配根按设置传入，见第四节）。
- 判定 `isTruncatedWithoutTools`：停止原因为 length 且内容里没有工具调用块。agent_end 到来时，若配置了续跑、两个上限都没到、本 Run 没来过中止请求、钩子没要求停止，且末条消息满足判定，即暂扣这次 agent_end（与空回复重试同一处，一个 Run 仍只发一次 run.ended）。
- 原 `#retryEmptyReply` 改为循环 `#resumeDeferredRunEnd`：每次取出暂扣的 agent_end，末条是空回复走空回复重试，否则走续跑；接着跑的那次又被暂扣时继续循环；来过中止请求即补发暂扣的 agent_end 并结束。空回复的判定与次数不变。
- 续跑 `#continueTruncated`：本 Run 续跑次数与连续次数各加一；从 Agent 状态去掉末条截断的回复；会话存储里调用 `dropTruncatedReply`，再写一条 `pigeon.continuation` 条目（截断的来由 output-limit / repetition、本 Run 第几次、连续第几次、时间）；本 Run 内轮间压缩过时先按会话树还原成压缩后的上下文（Agent 的消息按 message_end 累积全量，不还原的话续跑请求会带上压缩前的全部消息）；然后以 `prompt` 追加一条用户消息（`TRUNCATION_CONTINUE_PROMPT`：上条回复被截断，未执行任何工具；不要重复前文，简短说明下一步并直接发出一个工具调用）接着跑。提示消息照常走 message_end，写进会话、占条目序号；续跑那一轮照常发事件、计轮与计预算。
- 计数：连续次数在任何一条不满足判定的助手回复（正常停止、带工具调用、出错、中止）的 message_end 清零；合计次数每个 Run 开始时清零。与打转检测的计数无关。用尽即不再暂扣，照原样收尾（终态 completed、停止原因 length，与现状一致）。
- 截断里带工具调用的：上游补出错的工具结果并接着下一轮，不会以这样的回复收尾，行为不变；这类回复在 message_end 时同样让连续次数清零。

上下文去掉截断回复的做法与恢复时的行为：
- 写者的 `dropTruncatedReply`（排在此前的写入之后，同一写入队列）：从主分支的叶子往根找到最后一条消息条目，须是停止原因为 length 的助手回复，用 pi 公开的 `Session.moveLane("main", 它的 parentId)` 把主分支的叶子退回它之前。这条回复留在会话文件里，成为一条不在主分支上的分支；此后的写入（续跑条目、提示消息、之后的回复）接在它的父条目下。叶子与它之间若有自定义条目（例如同一时刻落盘的 worker 收尾条目），按原样重写到退回后的叶子上；有其他种类的条目、或末条消息不是撞上限的回复时不动，按写入失败报告（只进内部故障告警，不影响运行）。
- 会话文件里多一条 pi 原生的通道变更记录（lane），pi 与 Pigeon 的只读读取器都已支持（读取器按记录移动 main 道的叶子）。
- 恢复与分叉按主分支还原，自然不含截断的回复：主分支上依次是截断回复之前的消息、续跑条目、提示消息、续跑后的回复。测试按恢复的同一条路径（`loadStoreSession(...).main` → `restoreSessionContext`）断言还原的消息不含截断的内容、角色序列为 user、user（提示）、assistant。
- 会话原生视图、trace、replay 按主分支投影，不显示截断的回复；Run 收尾条目的 `messageCount` 仍按追加的消息计（含截断的回复），比主分支上该 Run 的消息多出续跑的次数。

## 三、流式重复检测

改法（新文件 `pi-runtime/repetition-guard.ts`；Adapter 构造时包在 streamFn 外层）：
- `guardRepetition(streamFn, { mode, params, onHit })`：内层请求用自己的中止口（与调用方的中止信号以 `AbortSignal.any` 合并）；外层流逐个转发内层事件，`text_delta` / `thinking_delta` 喂给正文与思考各自的检测器，`text_end` / `thinking_end` 时补查不足一个检查间隔的尾巴与未切出的段；工具调用的事件不看。
- 逐字周期：最近 `windowChars` 个字符的末尾，对反转的尾部求 Z 数组（按下标从末尾取字符，不另建反转串），一次线性扫描得到每个周期长度 p 的重复跨度 p + reach[p]；从小到大找第一个满足门槛的 p（单元不超过 `shortPeriodChars` 用短周期门槛，否则用长周期门槛；单元须含字母、汉字等文字或表情符号）。每收到 `checkIntervalChars` 个新字符扫一次。
- 段落相似度：按空行切段，无空行时到 `segmentMaxChars` 强制切；段内标题行与整行粗体标题去掉；切词时中日韩文字逐字成词，其余按字母数字连写成词，不含字母的词去掉；规范化后短于 `segmentMinChars` 的段不计；与最近 `segmentWindow` 段比较词三元组的 Jaccard 相似度，达 `similarity` 算近似；攒满 `minSegments` 段后近似段（含本段）达 `minCluster` 即命中。
- 掐断（abort）：命中即中止内层请求，外层发一个 `done`（reason length），消息为命中处的内容：命中块之前的块照取，命中块的文字取包装层已转发的增量（事件积压时 partial 对象可能已走在前面），之后的块不要；不带 errorMessage（不会被判成上游合成的失败消息）。Adapter 据此按撞上限交给续跑，续跑条目的来由记 repetition（命中时记下被掐断的回复将占的条目序号，续跑时对照）。
- 只记录（log）：照常转发，回复原样收尾；本条回复里同一通道的同一判据只报第一次。
- 每次报告写一条 `pigeon.repetition` 条目：模式、判据（cycle / paragraph）、通道（text / thinking）、周期长度（逐字周期为单元长度，段落为命中段长度）、重复次数（逐字周期为完整遍数，段落为近似段数）、起点（逐字周期为窗口内重复跨度的起点，段落为最早一个近似段的起点）、触发位置（该通道已收到的字符数）与时间。位置为本条回复里该通道的字符偏移，按 UTF-16 码元计。命中发生在回复流式期间，条目落在这条回复之前，续跑移出主分支时它留在主分支上。
- 与 omp（oh-my-pi `packages/ai/src/utils/thinking-loop.ts`）的对照：常量取自其 `EXACT_TAIL_WINDOW` 4096、`EXACT_MAX_UNIT` 1024、`EXACT_CHECK_STRIDE` 128、短周期 60 字以内 4 遍且 180 字、长周期 3 遍且 1024 字，`SEGMENT_SIMILARITY` 0.8、`SEGMENT_CHAR_CAP` 700、`SEGMENT_MIN_NORM_CHARS` 60、`SEGMENT_WINDOW` 16、`SEGMENT_MIN_COUNT` 8、`SEGMENT_MIN_CLUSTER` 4。不同之处：omp 的切词只留 ASCII 字母数字（中文段落整段被忽略），这里中日韩文字逐字成词；omp 的段落判据只对部分模型开启，这里对所有模型开启；omp 的第三种判据（词汇新颖度停滞）不在决策 367 的两种判据之内，未实现；omp 命中后以空内容、出错收尾并重采样，这里以截至命中处的内容、length 收尾交给续跑。段落判据照 omp 的"最近若干段内的近似簇"口径，不限于相邻两段。
- 本条回复被掐断时，消息的 usage 取自命中时的 partial；服务商在流末才报用量的，被掐断回复的输出 token 可能计少。

## 四、设置与装配（各入口）

- `state/runaway-config.ts`（纯类型与缺省）：settings.json 新增两节。`truncationContinuation`：`enabled`（缺省 true）、`maxConsecutive`（2）、`maxPerRun`（5）。`repetitionGuard`：`enabled`（true）、`mode`（abort / log，缺省 abort）、`preset`（omp / wide，缺省 omp）与十四项参数，节里单独给的覆盖档位；`windowChars` 小于 `maxPeriodChars × minRepeats` 时报问题（合并后校验 `mergedSettingsProblems` 报出，启动时响亮失败）。
- 两档参数：omp 档即上节常量。wide 档：单元最长 16,384、至少 3 遍、重复段至少 2,000 字（"窗口不少于 2,000 字符"按重复段覆盖的字符数取）、不分短周期，`windowChars` 放到 49,152（恰好容得下最长单元重复 3 遍），段落参数同 omp 档。
- `state/settings.ts`：两节进 `SETTINGS_SECTIONS` 与文件 schema（合并、未知键检查、`/reload` 的比对随之生效），取值函数 `truncationContinuationOf`、`repetitionGuardOf`。
- 装配根 `application/runtime.ts` 的 `buildRuntime`：`RuntimeDeps` 新增两项生效设定（显式给出的优先，否则取设置快照），开着的才传给 Adapter。`buildRuntime` 是生产代码里唯一构造 Adapter 的地方；终端界面、`--line`、`pigeon resume`、`/resume`、`/reload` 经 `openSessionRuntime`，`pigeon run`、worker、`/fork`、跑批经 `openRuntimeSurface` / `runHeadless`，都把设置快照交给它（worker 与 `/fork` 用派出它的会话的快照），各入口行为一致。`headless-core.ts`、`workers.ts` 的选项各加两项透传（目前只有跑批器显式给出）。
- `docs/configuration.md`：各节表加两行；新增"撞上限续跑与流式重复检测"一节（行为、会话记录、两档参数表、示例、跑批参数）。

## 五、跑批器

- `pigeon eval stream` 新增参数：`--continuation on|off`、`--continuation-max-consecutive <n>`、`--continuation-max-per-run <n>`、`--repetition-guard on|off`、`--repetition-mode abort|log`、`--repetition-preset omp|wide`；没给的取产品缺省。用法串与 `evalStreamMain` 上方的注释补上（docs 里没有单独说明跑批参数的文档，参数说明另写进 `docs/configuration.md` 新节的末段）。
- 只对 Pigeon 条件生效：`stream-agents.ts` 的 Pigeon agent 把两项生效设定显式交给 `runHeadless`（不依赖设置快照的缺省）。最简 agent 条件是外部的 mini-swe-agent 启动器，不经 `buildRuntime`，身份头的 minimal 段不记这两项（与打转检测在该段的现状一致）；外部 agent 条件不经 `buildRuntime`，不写。
- 身份头与结果行的 Pigeon 一段（`effectivePigeonSettings`、`stream-identity.ts` 的类型）新增 `truncationContinuation`（开关与两个上限）与 `repetitionGuard`（开关、模式、档位与全部参数）。加这两项之前写下的身份头没有它们，在这些输出目录上续跑即判为不同条件，不做兼容。

## 六、测试

新增（471 行，新增产品代码 928 行）：
- `pi-runtime/repetition-guard.test.ts`（6 项）：逐字周期的命中与单元长度、遍数、起点、触发位置（只在检查点上判）；长单元不到 3 遍、不到 1,024 字各不命中，都到了即命中；纯标点单元不命中；中文段落的近似簇命中（起点为最早的近似段）、各不相同的段落不命中；掐断模式以 length 收尾、内容截至命中处、内层请求被中止；只记录模式原样收尾、同一判据只报一次、不中止内层请求；思考里的重复命中并标明通道，工具参数里的重复不看。
- `pi-runtime/adapter-continuation.test.ts`（5 项）：截断且无工具调用即续跑（第二次请求的上下文去掉截断回复、末尾是提示，只发一次 run.ended）；连续上限；合计上限与连续次数清零（截断与调工具交替）、下一个 Run 重新计数；接真实写者时截断回复留在文件里、主分支的条目序列、续跑条目的内容、按恢复路径还原的上下文不含截断内容；重复检测掐断交给续跑，命中与续跑条目各一条、来由为 repetition。
- `state/runaway-config.test.ts`（1 项）：缺省、wide 档加单项覆盖、窗口过小报问题并经合并后校验报出。
- `application/runaway-wiring.test.ts`（1 项，装配层冒烟，经 `runHeadless`）：没有设置时撞上限即续跑；设置关掉续跑、检测改只记录时截断即收尾、重复只记一条且不掐断。
- `eval/stream-experiment.test.ts` 新增 1 项：给了非缺省的参数（续跑关、wide 档只记录），身份头记下的是传入的值。

改动的现有测试：`eval/stream-experiment.test.ts` 的"身份头与结果行记 Pigeon 实际生效的参数"一项对 `effectivePigeonSettings` 做整体相等比较，身份头新增两项后在两个期望对象里各补这两项的缺省值，其余不动。

用假模型（`pi-runtime/fixtures.ts` 的 `createFakeStreamFn`，`stopReason: "length"` 造截断、`chunkSize` 分片造流式重复），不发真实请求。现有用例里经装配根的最长重复回复为 8 字单元重复 20 遍（160 字），低于短周期门槛，缺省开启检测后行为不变；Adapter 层的现有用例不传两项配置，行为不变。

## 七、变异

在服务器上逐个改坏后跑对应测试文件，全部变红，还原后与提交内容一致：
- 续跑触发不看停止原因（`=== "length"` 改为 `!== "error"`）
- 连续上限判定失效
- 合计上限判定失效
- 连续次数不清零
- 截断回复不移出主分支（去掉 `dropTruncatedReply` 调用）
- 逐字周期不看覆盖字符数
- 逐字周期不看遍数（第一轮未被测出，补了"两遍 1,220 字"的用例后变红）
- 段落相似度不看相似度门槛
- 段落相似度不看近似段数
- 只记录模式也掐断

未做的变异："续跑判定不看工具调用"——撞上限且带工具调用的回复后上游必接着下一轮，agent_end 时不会以它收尾，这一改动在可达路径上与原代码等价；该路径的现有端到端用例照旧通过。

## verify 的实际运行情况

- 机器：服务器 pigeon-verify，8 vCPU、31 GB 内存，Docker 29.8.1，Node v24.12.0。
- 提交 f181eee：`npm run lint`、`npm run check`、`node --test --test-concurrency=2 "src/**/*.test.ts"`、`npm run deps` 在一条前台命令里依次全过（服务器上另有会话的测试在跑，并发取 2），用时 226 秒。测试 1,641 项：通过 1,639，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：578 个模块，无违规。
- 含本审计的提交上另跑一次 verify，结果追加在下一节。

## 补记：trace 与 replay 显示两种新条目

改法（提交 ebaf2cb）：
- 会话原生视图（`state/session-view.ts`）的时间线条目加两种：`continuation`（`pigeon.continuation`）与 `repetition`（`pigeon.repetition`），按数据里的 runId 归属 Run，数据不合 schema 照旧记告警并跳过。
- `application/format.ts` 加两个一行的格式化函数，trace 与 replay 共用：续跑为"续跑第 n 次：上条回复撞输出上限被截断，未执行工具"（来由为重复检测时写"被重复检测掐断"）；重复检测为"重复检测命中：判据（通道）｜ 周期（段落相似度写段长）｜ 重复次数 ｜ 已掐断或只记录"。
- `cli/trace.ts`：Run 一节在验证、钩子之后各列一行。`cli/replay.ts`：时间线的条目类型名与条目摘要各加两种。
- 会话检索（`state/session-search-text.ts`）只取视图里的消息，自定义条目本来不进检索，未改动；续跑时追加的提示是主分支上的一条用户消息，照常进检索。

测试：`cli/runaway-display.test.ts`（1 项）：会话里写一条重复检测命中与一条续跑条目，trace 与 replay 的输出里各有一行续跑（次数与来由）、一行重复检测命中（判据、周期、重复次数、已掐断）。

## 含本审计的提交上的 verify

- 提交 c2f7845（在 f181eee 之上只加本审计文件）上的复跑：ssh 连接中途被对端重置，未取到结果。
- 提交 ebaf2cb（在 c2f7845 之上加 trace 与 replay 的显示），同一台服务器：`npm run lint`、`npm run check`、`npm run deps` 全过（deps：579 个模块，无违规）；测试按目录分两批运行（服务器上另有会话的测试在跑，并发取 2）：eval 以外 1,326 项，通过 1,324，失败 0，跳过 2（两项只在 Windows 上运行的用例）；eval 316 项全部通过。合计 1,642 项，两批覆盖全部 286 个测试文件。
- 本节所在的提交在 ebaf2cb 之上只改本审计文件。
