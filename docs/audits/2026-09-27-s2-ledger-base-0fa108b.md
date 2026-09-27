# 账本重构第一段：存储底座与双写（决策 176–187、206、210、211，基线 0fa108b）

范围：建新会话存储的写者与只读读取器，在写旧账本的同一处同时写新存储（双写），搭对照工具的框架。旧账本照写照读，本段不改任何读者、不停写旧账本、不删旧代码。基线为 formal-v2 分支 0fa108b，分支 formal-v2。

## 一、新增与改动

| 文件 | 内容 |
|---|---|
| src/state/session-entries.ts | 七种自定义条目的 schema、结束方式与中止原因枚举、会话文件头 metadata、写入面结构类型 |
| src/pi-runtime/session-store.ts | 新存储写者（pi 的 JsonlSessionRepo）、剥 undefined、分叉建分支文件 |
| src/persistence/session-reader.ts | 只读读取器、按目录列会话文件、按会话号定位、分叉点定位 |
| src/persistence/session-lock.ts | 加"按会话文件加锁"入口（锁文件为 `<会话文件>.lock`），加锁逻辑与会话锁共用 |
| src/persistence/dual-write-compare.ts | 双写对照 |
| src/application/session-store.ts | 双写接线：打开写者、故障去重告警、旧写入输入到新条目的转换、授权与 worker 两族的转接、分叉 |
| src/pi-runtime/adapter.ts | 消息、Run 开始、Run 收尾双写；`interrupt` 可带中止原因 |
| src/application/runtime.ts、workers.ts、headless-core.ts、attempt-verify.ts、attempt-group.ts、checkpoints.ts、fork.ts、fork-command.ts、session-runtime.ts，src/orchestration/workers.ts，src/tui/main.ts | 各写入点接线（见第三节） |
| src/state/runtime-events.ts | 导出 GitObjectIdSchema（新条目复用） |
| src/application/session-store-fixtures.ts | 测试夹具：用新存储造会话数据（见第六节） |
| spikes/ledger-migration/ | 双写对照命令行入口、旧转新转换器与样例、说明与预期差异清单 |

测试新增 6 个文件：session-reader.test.ts、session-store.test.ts、adapter-session-store.test.ts、application/session-store.test.ts、dual-write-compare.test.ts、session-store-fixtures.test.ts。

提交 4b0a694，行数（git numstat）：

| 类别 | 新增 | 删除 |
|---|---|---|
| 生产代码：新文件 5 个 | 1,599 | 0 |
| 生产代码：改动既有文件 14 个 | 342 | 81 |
| 测试（新文件 6 个与既有测试的改动） | 1,784 | 0 |
| 测试夹具 | 495 | 0 |
| spikes/ledger-migration | 540 | 0 |
| 合计 | 4,760 | 81 |

## 二、新存储的形状

### 2.1 文件与布局

- 会话根 `.pigeon/sessions`，照 pi 原生布局：`<会话根>/--<工作目录编码>--/<创建时间>_<会话号>.jsonl`（210）。以 Pigeon 自己的会话号创建；工作目录取运行面的工作区根（worker 与分支会话为各自的工作树）。
- 按会话号定位：列会话根下各子目录的文件名、按文件名精确匹配会话号，不读文件内容。会话根下遗留的旧格式平铺文件（`sess_*.jsonl`、`.messages.jsonl`、`.lock`）不在任何子目录里，不被列举；分叉的临时文件 `.jsonl.tmp`、锁文件 `.jsonl.lock` 不匹配文件名格式。
- 写者用 pi 的打开；跨进程单写者锁按会话文件加（181）。不注入 fsync（178）。同进程对同一会话再开写者时共用同一个 pi 会话实例，最后一个关闭才释放锁。
- 消息以 pi 消息条目完整存储，不截断，不写旁置正文文件（179）；写入前剥掉值为 undefined 的键。只写 custom 条目，不写未知的 entry 或 record 类型。
- worker 与分支会话的来历写进文件头：父会话号记在 `parentSessionId`，其余在 `metadata.pigeon`（只在新建与分叉时写一次，177）。

### 2.2 七种自定义条目（184）

customType 统一加 `pigeon.` 前缀；每种数据都带 `version: 1`。

**Run 开始 `pigeon.run-start`**

| 字段 | 说明 |
|---|---|
| runId、startedAt | |
| model | provider、id、thinkingLevel，可选 maxOutputTokens、temperature、temperatureIgnored |
| policy | allow、deny、approvalMode |
| advertisedTools | 实际广告给模型的工具名单 |
| systemPrompt | 系统提示全文 |
| taskDirective、memory、skills、mcpTools、mcpServers | 同旧 run.started |
| verify、retryOnFail、budget、repairRounds | 可选，同旧 run.started |

不再写：systemPromptHash（有全文即可现算）、stepStart 与 structuredMemory（都已无读者）。

**Run 收尾 `pigeon.run-end`**

| 字段 | 说明 |
|---|---|
| runId、endedAt | |
| ending | completed、turn-limit、wall-clock-limit、token-limit、breaker、aborted、error、empty-reply |
| stopReason、errorMessage | 可选：末条助手消息的停止原因与运行面记下的错误文本 |
| messageCount | 本 Run 追加的消息条数（含中止与上游合成的失败消息） |

结束方式的判定：Run 确以中止收尾时，撞上限的一方随中止请求交来的原因优先，其次熔断，否则为中止；出错与终态不明记为出错；其余为正常完成。empty-reply 只留枚举值，识别另行施工。有开始无收尾即未收尾。

**验证记录 `pigeon.verification`**

字段同旧 attempt.verified（可选 runId、target、command、exitCode、可选 signal、timedOut、可选 error、durationMs、outputBytes、outputHash、output、truncated、workspace、verdict、verifiedAt、可选 steps）。steps 的每一步在旧的各步结论上预留可选的 `toolFault: true`（工具故障标记；识别口径为各检查工具公开的非正常退出码、重跑一次仍崩则标记，整体结论只看其余步；识别另行施工）。

**代码快照 `pigeon.checkpoint`**

| 字段 | 说明 |
|---|---|
| runId、toolCallId | 发起改动的那次工具调用 |
| ref、commit、tree | 快照引用、提交与树 |
| baseCommit | 可选：本会话首个快照的改前基线 |

条目位于发起调用的助手消息之后、该调用的工具结果消息之前；旧记录的 afterRunSeq 由位置取代，不再写。

**worker 派出与收尾 `pigeon.worker`**

| event | 字段 |
|---|---|
| spawned | 可选 runId、childSessionId、name、role、task、policy、limits、workspace、spawnedAt |
| settled | 可选 runId、childSessionId、name、status、可选 error、可选 result（可选 branch、可选 changedFiles、summary、summaryTruncated）、turns、settledAt |

不再写：taskKey 与结果里的 structured（无读者）、receiptIds（回执随 184 停写）。

**分叉 `pigeon.fork`**（写在来源会话文件里）

| 字段 | 说明 |
|---|---|
| runId、forkedAt | |
| branchSessionId、forkPoint（runId、runSeq）、checkpoint（ref、commit）、trigger | 同旧 session.forked |
| forkEntryId | 可选：分叉点在本文件里对应的消息条目号 |

**授权建立与撤销 `pigeon.grant`**

| event | 字段 |
|---|---|
| created | 可选 runId、grantId、tool、可选 pathPrefix、command、shell、firstCall（toolCallId、args）、createdAt |
| revoked | 可选 runId、grantId、revokedAt |

**会话文件头 `metadata.pigeon`**：version；worker 会话带 worker（可选 parentRunId、name、role、workspace、startedAt）；分支会话带 branch（sourceSessionId、forkPoint、checkpoint、workspace、trigger、startedAt）。

## 三、双写覆盖的写入点

新存储的每一次写都在旧账本那一次写之后。

| 内容 | 写入点 |
|---|---|
| 消息 | pi-runtime/adapter.ts `#recordAndForward` 的 message_end 分支：旧 appendEntry 之后写同一条消息的完整深拷贝 |
| Run 开始 | adapter.ts `#recordRunStart`，紧随旧 run.started（MCP 附加摘要每个 Run 取一次，两边共用） |
| Run 收尾 | adapter.ts `#recordRunEnded`，在 `#runWith` 等到空闲、判定终态之后。中止原因经 `interrupt(原因)` 交来：application/headless-core.ts 的撞上限、orchestration/workers.ts 的 worker 撞上限，application/workers.ts 的运行面把原因转给 Adapter |
| 验证记录 | application/attempt-verify.ts `verifyAttempt`，旧记录写入之后（旧记录写失败时照写）。调用方：运行面挂的尝试验证、headless 回炉循环、headless 收尾后补验（运行面已释放，按会话号重开写者）、并行同任务派发（宿主会话，tui/main.ts 传入） |
| 代码快照 | application/checkpoints.ts，旧 workspace.checkpoint 之后 |
| worker 派出与收尾 | application/workers.ts 给编排器的父会话落盘口套转接：先写旧账本、写不进即抛（不派）且新存储不写 |
| worker 与分支会话来历 | application/workers.ts `openBundle` 把会话头交给装配根，新建文件时写进文件头 |
| 分叉 | application/fork.ts `prepareFork`：旧分叉记录之后在来源文件记分叉条目；建好工作树后用 pi 的 fork 把分叉点（含）之前的历史复制进分支会话的新文件。来源写者在本进程时（手动分叉、运行面内的失败自动分叉重试）先落盘再读；来源不在本进程时（headless 收尾后的失败自动分叉重试）按会话号打开来源文件并持锁到分支文件建好 |
| 授权建立与撤销 | application/runtime.ts 给会话授权存储的落盘口套转接：先写旧账本、写不进即抛（授权不生效）且新存储不写 |
| 打开与关闭 | application/runtime.ts `buildRuntime` 在配置校验之后打开（已有文件即续写，否则新建）；`disposeRuntime` 最后关闭 |

不双写（184 停写清单）：运行事件五种、llm.request、skill.loaded、intent、decision、receipt、resolution；run.limit-hit 与 breaker 并入 Run 收尾的结束方式；session.header 与 branch.header 改记在文件头。

新存储的任何失败（定位、打开、加锁、每一条写入、分叉）都是内部故障：写者自身从不抛，经告警口向标准错误输出一行，同一个运行面里同一动作只报一次，文案为"新会话存储告警：……（新存储缺这一条；旧账本照常写入，运行不受影响）"；不新增账本记录族。打开失败后该写者不再写任何东西。Adapter 对写入面仍兜一层 try/catch，异常只进内部错误清单。

## 四、只读读取器

- 逐行解析文件头（pi v4）与各条变更（entry、record、lane、fact），按 seq 重放出条目、通道、会话名与标签；从不写文件。
- 不完整的末行跳过、不告警；合法但缺换行的末行照常读入。
- 不认识的条目类型、record 类型、变更种类与事实种类记告警并跳过这一条；被跳过的条目从树上摘掉，以它为父的条目改接到它的父条目，指向它的通道回退到它的父条目。中段坏行、seq 不递增、条目号重复同样告警跳过。
- 空文件、文件头写了一半、版本不是 4 的文件返回"不是会话"；只有文件头的是空会话。
- 另给分支路径（根到某条目）与分叉点定位（Run 开始条目之后按消息条数数到第 runSeq 条）。

## 五、对照工具

### 5.1 双写对照

`src/persistence/dual-write-compare.ts`，命令行入口 `spikes/ledger-migration/compare-dual-write.ts`。给定一个会话，用读取器读新存储、用现有物化读旧账本，输出差异清单。覆盖：

- 消息：条数、顺序、角色、所属 Run 与 Run 内序号；正文按旧账本自己的抽取口径（同样的 64 KiB 截断与思考持久化选项）处理新存储里的完整消息，重算的内容哈希须与旧条目回指的哈希一致；
- Run 开始：Run 先后与配置各字段，系统提示全文按旧记录的哈希核对；
- Run 收尾：有无收尾、结束方式（由旧账本的收尾事件、撞上限与熔断记录、末轮停止原因推出）、消息条数；
- 验证记录：条数、顺序与各项结论。

分支会话跳过文件开头从来源复制的历史。代码快照、worker、分叉、授权四类未覆盖。

### 5.2 旧转新转换器

`spikes/ledger-migration/convert-legacy.ts`：只依赖旧代码里一直存在的模块（物化、正文读取、会话树的消息投影，这几个文件在 455d88d 与 0fa108b 之间没有改动）与上游 JsonlSessionRepo，可在只读旧版工作树里运行；新条目按 v1 schema 内联写出。`spikes/ledger-migration/sample.ts` 跑通一条样例：假模型一次带思考、工具调用、代码快照、验证与失败分叉重试的运行，来源会话双写文件与转换结果各 9 条（消息 4、Run 开始 1、代码快照 1、Run 收尾 1、验证 1、分叉 1），转换结果全部通过 v1 schema 校验，差异只落在预期清单的三类：时间 5 处、工具结果 details 1 处、条目号 1 处；清单外差异 0。

预期差异清单（转换结果对双写新文件）：正文截断、思考签名、api 记为 unknown、图片占位、用量停止原因与错误文本取自 turn.completed、工具调用参数取自 tool.proposed、工具结果 details 缺失、条目时间戳与记录时刻、条目号沿用旧 EntryId、系统提示全文每个运行面只存一次、结束方式推不出空回复异常结束且无 run.ended 不写收尾、分支会话不含复制段、停写字段不转。逐条说明见 spikes/ledger-migration/README.md。

## 六、测试夹具：用新存储造会话数据

`src/application/session-store-fixtures.ts`，供账本重构后续各段的测试共用（不从任何桶文件导出）。经真实写者写出与生产同一格式的文件，读回即可测读者。放在 application 层，因为它要同时用 pi-runtime 的写者与 persistence 的读取器。

- `createFixtureSession({ sessionsDir, cwd?, sessionId?, parentSessionId?, metadata?, existingPath? })`：开一个会话。方法：
  - `startRun({ runId?, task?, config? })`：写 Run 开始（配置可覆盖），给 task 即紧跟一条用户消息，返回 runId；
  - `user(text)`、`assistant({ text?, thinking?, toolCalls?, stopReason?, errorMessage?, usage? })`（返回工具调用号）、`toolResult({ toolCallId, toolName, text, isError? })`；
  - `toolTurn({ name, args?, result?, isError?, checkpoint? })`：助手发起一次调用、可选代码快照、工具结果，顺序同生产；
  - `endRun({ ending?, stopReason?, errorMessage? })`：结束方式缺省 completed，消息条数自动取本 Run 已写的条数；
  - `checkpoint`、`verification({ verdict, target?, exitCode?, steps? })`（步上可带 toolFault）、`grantCreated` / `grantRevoked`、`workerSpawned` / `workerSettled`、`append(任意自定义条目)`；
  - `close()`：落盘并返回 `{ sessionId, path }`，写入有故障即抛。
- `spawnFixtureWorker(parent, { sessionsDir, name, role?, task, cwd? })`：父会话记派出，返回子会话（文件头记父会话号与来历）；收尾由调用方在父会话上写 `workerSettled`。
- `forkFixture({ sessionsDir, sourceSessionId, runId, runSeq, trigger?, cwd? })`：在已关闭的来源会话里记分叉条目，用 pi 的 fork 建分支文件，返回在分支文件上续写的夹具。
- `tearTail(path, partial?)`：在已关闭的文件末尾追加半截变更；`appendRawLine(path, 行)`：追加任意一行（不认识的条目类型、record 类型等）。

## 七、上游能力的实测

- 值为 undefined 的键：上游 agent-loop 构造工具结果消息时恒带 `usage` 键（`usage: finalized.result.usage`），Pigeon 的工具不报用量即为 undefined；上游写入前的可序列化检查拒绝任何值为 undefined 的键，不剥掉则每一条工具结果消息都写不进。写者在写入前统一剥掉，数组里的 undefined 按 JSON 语义记为 null。
- 长路径（Windows）：工作目录 213 个字符时，编码后的子目录名随之变长，会话文件全路径 351 个字符，超过 260；pi 的新建与续写、锁文件、按目录定位与读取器均正常（测试里断言全路径超过 260）。工作目录越深，文件路径约为它的两倍再加会话根长度。
- 列举：pi 的 `list` 只看会话根下的子目录、逐个读首行；读取器只按文件名列举。会话根下的旧格式平铺文件对两者都不可见。
- `Session.appendEntry` 须显式给通道名，缺省不是 main。

## 八、测试与变异

### 8.1 新增测试

| 文件 | 用例 | 覆盖 |
|---|---|---|
| persistence/session-reader.test.ts | 10 | 按 seq 重放；不完整末行跳过且不改文件；缺换行的合法末行；不认识的条目类型告警跳过并改接子条目与通道；不认识的 record 与变更种类；中段坏行；空文件、文件头不完整、版本不对、只有文件头；会话名与标签；分叉点定位；按目录列举与定位、旧格式平铺文件与临时文件、锁文件不被列举 |
| pi-runtime/session-store.test.ts | 39 | pi 契约测试套件 30 例接新存储的仓库；布局、文件头与 metadata、pi 自己的打开可读；完整消息不截断与剥 undefined；续写已有文件；一条写不进只报一次故障、后续照写；锁被另一存活进程持有时不打开不写、持锁进程退出后可接管；同进程共用实例；fork 建分支文件；长路径 |
| pi-runtime/adapter-session-store.test.ts | 7 | Run 开始的配置与系统提示全文、完整消息与 transcript 一致（含上游工具结果的 undefined usage 键）、Run 收尾；三种撞上限原因与无原因中止；中止原因不跨 Run；出错；熔断；写入面抛错不影响运行、旧账本与对外事件；接真实写者与旧账本同序同数 |
| application/session-store.test.ts | 7 | 失败自动分叉重试端到端（来源与分支两个文件的消息、Run 起止、快照、收尾后补写的验证、分叉条目与分支文件）；手动分叉时来源写者在本进程；撞轮数上限；授权建立与撤销、worker 来历写进文件头；转接在旧账本失败时不写新存储；建不起文件时只告警一次、运行与旧账本不受影响；双写之前的旧会话续跑不建新文件、只写旧账本、不告警 |
| persistence/dual-write-compare.test.ts | 2 | 分叉重试来源会话、分支会话、撞上限会话零差异；正文被改、收尾缺失、验证结论不同各自报出 |
| application/session-store-fixtures.test.ts | 4 | 夹具造出的一次 Run 顺序同生产、自定义条目全部通过 v1 schema；worker 子会话；分叉；撕裂末行与不认识的条目 |

另改动的既有测试：migration-completeness.test.ts 登记新的版本常量 SESSION_ENTRY_VERSION（七种条目共用，当前即 v1）；runtime.test.ts 等 8 个只关旧账本、不走运行面释放的测试文件在收尾处补关新存储（否则新存储排队中的写入落在已删除的临时目录上，被告警接住，用例本身通过）。

### 8.2 变异反向验证

每次只植入一处，跑相关测试文件，记下变红的用例，还原后按字节比对源文件哈希，第一个提交 10 处、第二个提交 1 处，全部逐字一致。

| 变异 | 精确变红的用例 |
|---|---|
| M1 读取器去掉末行豁免（不完整末行也告警） | 读取器：不完整的末行跳过、不告警，文件一个字节都不改 |
| M2 读取器跳过未知条目时不改接子条目 | 读取器：不认识的条目类型记告警并跳过，其子条目接到它的父条目上，通道指向随之回退 |
| M3 读取器遇到未知条目类型整个文件读失败 | 同 M2 那一例 |
| M4 message_end 不写新存储 | 双写端到端（失败自动分叉重试）；双写对照零差异；双写对照篡改报差异；Adapter：Run 开始、消息与 Run 收尾；Adapter：写入面抛错不影响运行；Adapter：接真实写者同序同数（6 例） |
| M5 Adapter 对新存储写入面不隔离异常 | 双写：新存储写入面抛错不中断运行、不影响旧账本 |
| M6 Run 收尾忽略中止原因 | 撞轮数上限（application）；双写对照零差异；Adapter：撞上限原因写全；Adapter：中止原因不跨 Run（4 例） |
| M7 headless 撞上限不把原因交给运行面 | 撞轮数上限（application）；双写对照零差异（2 例） |
| M8 打开已有会话文件时不取锁 | 写者：会话文件被另一个存活进程持锁时不打开、不写 |
| M9 授权转接先写新存储 | 转接：旧账本写不进时抛出且新存储不写 |
| M10 写者不剥 undefined 键 | 双写端到端；授权与 worker 来历；Adapter 接真实写者；写者：完整存储与剥 undefined；剥 undefined 单测（5 例） |
| M11 打开写者时不判定双写之前的旧会话（第二个提交） | 双写：双写之前就存在的旧会话续跑时不在新存储里建文件 |

M5 第一次植入时没有变红：Adapter 事件入口外层另有一层兜底，Run 照样完成，但同一事件的归一化、旧账本运行事件与对外转发被跳过，原断言没有覆盖。补上"旧账本运行事件与对外事件一个不缺"的断言后重做，精确变红上表一例。

## 九、verify 的实际运行

### 9.1 服务器（交付依据）

提交 4b0a694，阿里云 8 vCPU、31 GB 内存、Ubuntu 24.04、Node 24.12.0，专属目录从本机 git bundle 克隆后 `npm ci`。跑前确认服务器上没有别的测试进程。

- lint 通过（检查 381 个文件，0.5 秒）；
- check 通过（16.5 秒）；
- 测试：`node --test --test-concurrency=6 "src/**/*.test.ts"` 整份运行 93.0 秒，1087 个用例，1083 通过、0 失败、4 跳过（同基线：2 个作业容器真容器用例缺实验镜像、2 个仅 Windows 的 .cmd 用例）。用例数比基线多 69：新增 6 个测试文件共 68 例，迁移完整性表多登记 1 例；
- 单个测试进程的最大常驻内存约 0.53 GB；整机已用内存按秒采样，最高约 1.3 GB（采样在测试开跑约 40 秒后才开始，不完整）；
- deps 通过（398 个模块、2735 条依赖、无违规）。

### 9.2 服务器（第二个提交：旧会话不建新文件）

同一台机器、同一专属目录，在 4b0a694 上换入第二个提交改动的两个源文件（与提交内容逐字一致，按哈希核对），跑前确认没有别的测试进程：lint 通过（381 个文件）；check 通过（16.2 秒）；测试整份运行 93.0 秒，1088 个用例，1084 通过、0 失败、4 跳过（同上）；deps 通过（398 个模块、2737 条依赖、无违规）。

### 9.3 本机（开发过程中，Windows）

本机同时另有两批 stream 跑批器测试在跑，CPU 争用严重：

- 除 `src/eval/stream-*` 以外的 180 个测试文件（并发 2）：888 例，885 通过、2 跳过，1 例失败为迁移完整性表未登记新版本常量，登记后通过；
- stream 各文件：stream-runner 的"延续式跑批"一组子用例并发执行、各起本地假容器，在本机撞 300 秒超时；stream-agents 的若干容器回炉用例在并发下失败（报"容器里的进程清理不净"或回炉结果为空）。对照："一步期间来了限额信号"一例在基线 0fa108b 的临时工作树里同样条件下同样报进程清理不净；按用例名单独串行跑时，四个容器回炉用例本分支与基线都通过，"开工前已来了限额信号"一例两边都撞 300 秒超时，"延续式跑批"里单取一个子用例在本分支 51 秒通过。服务器全量里这些用例全部通过；
- lint、check、deps 本机亦通过；
- 新增的 6 个测试文件与变异验证均在本机跑。

## 十、双写期间的已知情况

- 跑批器按作业把会话目录里的文件移到隔离目录（作废重做时）：它按文件名列会话根，新存储的会话文件在子目录里，子目录第一次出现之后的作废尝试不会被移走。本段没有读新存储的读者，不影响测量；跑批器文件操作改读新存储在后续段施工。
- 新存储只放双写开始后创建的会话。双写之前就存在的旧会话（新存储里没有文件、旧账本已有记录）续跑或补写验证时，不在新存储里建文件，过渡期只写旧账本，也不告警；停写旧格式之后，旧会话只由只读的旧版代码读。判定在打开新存储写者时做：按会话号找不到新文件，且旧账本文件已有内容。本段最初的实现会为这类会话新建一个只含续跑之后记录的文件，经裁决改掉（第二个提交）。
- 分叉时来源会话在新存储里没有文件（双写之前的旧会话）则告警一次，分支会话是双写开始后新建的会话，文件由分支运行面新建，不含来源历史。
- 新存储的写入不等待落盘，Run 返回时可能还有排队的写入；运行面释放时关闭写者会等它们落盘。只关旧账本、不走运行面释放就删掉临时目录的测试会在删除后收到告警（已在 8 个这样的测试文件里补关新存储）。

## 十一、基线 0fa108b 在 Linux 服务器上的全量 verify

- 环境：阿里云 8 vCPU、31 GB 内存、Ubuntu 24.04、Node 24.12.0。
- lint 通过（检查 369 个文件）。
- check 通过（15.5 秒）。
- 测试：`node --test --test-concurrency=4` 整份运行 89.3 秒，1018 个用例，1014 通过、0 失败、4 跳过（2 个作业容器真容器用例缺实验镜像、2 个仅 Windows 的 .cmd 用例）；内存峰值约 1.5 GB。
- deps 通过（385 个模块、2609 条依赖、无违规）。
