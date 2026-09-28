# trace 补显示审批结果、出错归类与工具级失败分类；Run 级分类事实装配收成一处（基线 66d329c）

范围：在 formal-v2（头 66d329c）上开分支 trace-classes。只改读取与显示，不新增会话条目，也不新增账本记录；不改 `src/eval/`。

依据：账本重构第二段审计的"工具结果消息上的运行面标记"；第三段审计"trace"一条去掉的行，以及"工具级失败分类暂缺"一节；合并二审计衔接一"未接的"一段；第四段审计里"审批决定与错误归类照旧挂在工具结果消息的 details 上"。

## 一、trace 新增的显示内容与字段来源

工具调用下原有"提议参数""结果""代码快照"三行，现在在结果行之后新增三行：

| 行 | 内容 | 来源 | 何时出现 |
|---|---|---|---|
| `审批：<措辞>（<批准来源>）` | 审批闸对这次调用的决定 | 工具结果消息 `details.pigeon.gate`（`outcome` 与 `approvedBy`），经 `state/session-judge.ts` 的 `toolResultMark` 读取；措辞用 `application/format.ts` 的 `approvalVerdict`，与终端界面审批面板同一套 | 结果消息带运行面标记且有审批闸决定 |
| `审批：未经审批闸（上游拦截）` | 上游在审批闸之前拦下的调用（工具名不存在、参数校验失败、输出撞上限） | 同上：有标记而没有 `gate` | 结果消息带运行面标记但没有审批闸决定 |
| `出错归类：域错误` / `出错归类：环境异常` | 工具抛错时运行面捕获的错误归类 | 工具结果消息 `details.pigeon.errorKind`，经 `toolResultMark` 读取 | 标记里有 `errorKind` |
| `分类：<徽章>` | 工具级失败分类 | `SessionView.toolOutcomes`，即 `storeToolOutcomes` 现算的结果（与会话列表、检索的类过滤同一份）；徽章措辞用 `failureBadge`，与 Run 头的分类同一套 | 每个调用都有 |
| `分类：无（所在助手消息以出错或中止收尾，调用未执行）` | 以出错或中止收尾的助手消息里的调用：上游不执行，`storeToolOutcomes` 不给它分类 | `toolOutcomes` 里没有这个调用 | 同左 |

批准来源与措辞的对应（`approvalVerdict`）：`policy:auto` 策略自动放行；`policy:yolo` yolo 批发授权；`human:grant` 人工授权（会话 grant）；`policy:config` 策略放行（固化配置）；`human` 人工批准或人工拒绝；`policy:deny` 策略拒绝（deny 清单与无审批通道两种）。

没有运行面标记的结果（标记上线之前写的会话文件、续跑时补的"结果未知"工具结果）不出审批行与出错归类行，分类行照常出，分类退回 `storeToolOutcomes` 里按消息正文与策略判的旧判据。

字段取法与判据不另写：审批与出错归类只经 `toolResultMark` 读取，分类只读 `toolOutcomes`，trace 里没有自己的判据。已停写的审批理由、执行号、回执等仍不呈现。

附带改动：`approvalVerdict` 的参数从完整的审批决定放宽为只要结果与批准来源（标记里只有这两项）；`tui/approval.ts` 原先为凑齐参数传的占位时间戳随之去掉。

## 二、Run 级分类事实装配：去重前后的调用关系

去重前，Run 级失败分类的事实（停止原因、是否上游合成的失败消息、是否熔断、有无助手消息、有无收尾条目、是否空回复）在两处各装配一次，再交给同一个判据函数 `classifyRunOutcome`：

- `state/session-judge.ts` 的 `storeRunFailure(run)`：判定类读者（成败标签、运行指标、回炉一步）用；
- `state/session-view.ts` 的 `classifyRun(run)`：显示类读者的会话视图（会话列表、检索、trace、replay）用。

去重后：

- `state/session-judge.ts` 新增 `runFailureOf(lastAssistant, end)`，是唯一的装配处；
- `storeRunFailure(run)` 改为 `runFailureOf(本 Run 末条助手消息, run.end)`；
- `session-view.ts` 的 `classifyRun(run)` 改为 `runFailureOf(本 Run 末条助手消息的原始消息, run.end)`，不再直接引 `classifyRunOutcome`。

两处原先的差别与去重后的取法：

| 事实 | 判定类读者（原） | 会话视图（原） | 去重后 |
|---|---|---|---|
| 停止原因 | 本 Run 末条助手消息的 | 收尾条目记的停止原因，没有再取末条助手消息的 | 同会话视图：收尾条目的优先 |
| 上游合成的失败消息 | 按原始消息判（正文须是只含一个空文本块的数组，用量四项为 0） | 按视图消息判（字符串正文也视作一个文本块；用量里缺 `cost` 时视作没有用量） | 按原始消息判 |

两处差别在运行面写出的会话文件上不可达：收尾条目的停止原因由运行面（`pi-runtime/adapter.ts` 的终态判定）取自对话里末条助手消息；本 Run 有自己的助手消息时两者相同，本 Run 没有助手消息时判定直接为未知、不看停止原因。上游消息的正文恒为数组，助手消息的用量恒带 `cost`。差别只能由手写的会话文件构造出来。

停止原因的取法：先按判定类读者的取法（只看末条助手消息）收口时，全量测试里 `cli/replay.test.ts` 的"七种自定义条目原位呈现"一例变红。该例夹具的末条助手消息停止原因为 toolUse，收尾条目写 wall-clock-limit 与 stopReason=aborted，期望 Run 头为"stopReason=aborted ｜ 分类：取消"。改为收尾条目优先后该例恢复，现有用例不需要改动；trace 与 replay 的 Run 头显示的停止原因本就取收尾条目优先，分类与显示值一致。判定类读者因此在上面那种手写形状上改变（由正常变为取消），在运行面写出的文件上不变。合成失败消息按原始消息判，会话视图在字符串正文、缺 `cost` 两种手写形状上改变，现有用例没有覆盖这两种形状。

## 三、测试

测试先行：新增与改动的用例先在改动前的代码上跑，trace 的四例为红（新文件三例、主用例一例），Run 级一致性断言为绿（去重前两处结果本就相同，这条断言守的是去重后不变）。"收尾条目的停止原因优先"一种情形在停止原因取法定下后加入，在改动前的判定类读者上为红（旧取法得正常）。

| 测试文件 | 用例 | 内容 |
|---|---|---|
| `cli/trace-classes.test.ts`（新增） | 3 | ① 九种带标记的调用（自动放行、会话放权、固化规则、人工批准并出域错误、yolo 下环境异常、人工拒绝、策略拒绝、上游拦截、人工批准后判不出）逐个核对审批行、出错归类行、分类行；② 没有标记的结果不出审批与出错归类，分类退回旧判据（成功、deny 清单拒绝、判不出），以中止收尾的助手消息里的调用标"无"，悬空调用为未知；③ 同一会话里 trace 每个调用的分类行等于 `toolOutcomes` 的徽章，trace 里出现的失败徽章集合等于会话列表摘要的失败分类 |
| `cli/trace.test.ts`（改一例） | 1 | 真实运行（经真实 Adapter 写进会话存储）的主用例：原断言"审批："不再出现，改为断言三次调用依次为策略自动放行（policy:auto）、人工批准（human）、人工拒绝（human），没有出错归类行，三个分类行都为正常；已停写的"拒绝理由"仍断言不出现 |
| `state/session-judge.test.ts`（改一例） | 1 | Run 级失败分类：原九种情形加一种"收尾条目的停止原因优先"（末条助手消息 toolUse，收尾条目 wall-clock-limit 与 aborted，期望取消）；在原有的判定类读者断言之后，加同一会话经会话视图读出的逐 Run 分类与期望一致 |

## 四、变异反向验证

在服务器专属目录里逐个植入，每次只植入一处，跑 `cli/trace-classes`、`cli/trace`、`cli/trace-workers`、`cli/trace-mcp`、`cli/replay`、`state/session-judge`、`persistence/session-list` 七个测试文件（共 37 例），记下变红的用例，再以 `git checkout` 还原。七次还原后源文件 sha256 都与植入前一致。

| 编号 | 植入 | 变红（其余通过） |
|---|---|---|
| M1 | trace 去掉审批行 | 2 例：trace-classes"审批结果与出错归类照……标记显示"；trace"真实运行"主用例 |
| M2 | trace 去掉出错归类行 | 1 例：trace-classes"审批结果与出错归类照……标记显示" |
| M3 | trace 不接工具级分类（每个调用都当作没有分类） | 4 例：trace-classes 三例全部；trace"真实运行"主用例 |
| M4 | trace 另写判据（出错即业务失败、否则正常） | 4 例：同 M3 |
| M5 | 共享装配 `runFailureOf` 丢掉熔断事实 | 1 例：session-judge"Run 级失败分类……会话视图逐 Run 一致" |
| M6 | 会话视图调共享装配时把收尾条目的结束方式改为 completed（不走共享装配的收尾事实） | 2 例：session-judge"Run 级失败分类……"（会话视图一侧的一致性断言）；trace"空回复异常结束分类为业务失败……" |
| M7 | 共享装配不看收尾条目的停止原因 | 2 例：replay"七种自定义条目原位呈现"；session-judge"Run 级失败分类……" |

M3 与 M4 都打红"trace 与会话列表同口径"一例：trace 的分类行若不取 `storeToolOutcomes` 的结果，就与会话列表的失败分类对不上。M5 与 M6 分别打红共享装配本身与会话视图对它的调用，两处都有用例守住。

## 五、verify 的实际运行情况

全部在服务器上跑：云主机 8 vCPU、31 GB 内存，Node 24.12.0，没有实验镜像。代码头 8681a13。

`npm run verify` 的四步依次跑：`npm run lint`（biome，检查 401 个文件，无问题）→ `npm run check`（tsc，通过）→ 测试步 `node --test --test-concurrency=3 "src/**/*.test.ts"`（同时另有一个测试批次在跑，并发取 3）→ `npm run deps`（417 个模块、2858 条依赖，无违规）。退出码 0。

测试：1131 例，通过 1129，失败 0，取消 0，跳过 2（Windows `.cmd` 启动器两例，只在 Windows 上跑），耗时约 163 秒。

同一台机器上在收口停止原因取法之前跑过一次全量，1131 例中失败 1 例（第二节所述 replay 一例），据此改为收尾条目优先。
