# 截断续跑按原因分开审计

- 基线：fa3b9f4（main，含记录决策 376 的提交）
- 分支：truncation-split
- 范围：决策 376（修改 367），并给落盘输出的虚拟路径补一句提示。共三个工程提交：
  - a1637da 截断续跑按原因分开
  - f343564 跑批身份头记录续跑行为的版本
  - 357cae4 虚拟路径提示：pigeon:// 路径只能用 read_file 读取

## 一、现状（改动前）

- `src/pi-runtime/adapter.ts` 的 `#continueTruncated`：末条回复因输出上限截断且没有工具调用时（含被流式重复检测掐断的），
  不论原因一律从 Agent 状态去掉截断的回复，会话存储里调 `dropTruncatedReply` 把它移出主分支（文件里照留），记一条续跑条目
  （`cause` 已区分 `output-limit` 与 `repetition`，带 `droppedUsage`），再追加同一句提示 `TRUNCATION_CONTINUE_PROMPT`
  （"不要重复前文，简短说明下一步并直接发出一个工具调用"）。
- 统计：`src/state/session-judge.ts` 每条续跑条目加一轮、加回 `droppedUsage`；`src/state/session-view.ts` 的合计只加
  `droppedUsage`。
- 次数上限：`#shouldContinueTruncated` 连续 2 次、每次运行合计 5 次（缺省），中间有一条回复没触发续跑即清零连续次数。
  截断里带工具调用的回复不走续跑（判未执行、提示重发），在别处处理。
- 跑批身份头（`src/eval/stream-identity.ts`、`stream-experiment.ts` 的 `effectivePigeonSettings`）只记续跑的设定
  （`enabled`、`maxConsecutive`、`maxPerRun`），没有版本字段。
- 落盘输出的虚拟路径（`pigeon://outputs/<会话号>/<编号>`）在 run_command 的截断输出、后台作业的输出去向、
  上下文裁剪的命令占位三处出现，都只说"可用 read_file 读取"，没说 shell 命令里用不了。

## 二、改法

### 续跑按原因分开（a1637da）

- `#continueTruncated` 先按原因定 `drop`（`cause === "repetition"`）：
  - 重复检测掐断的：照旧——去掉截断的回复、移出主分支、续跑条目带 `droppedUsage`，提示 `TRUNCATION_CONTINUE_PROMPT`。
  - 单纯撞输出上限的：截断的回复留在 Agent 状态与主分支上（不调 `dropTruncatedReply`），续跑条目带 `replyKept: true`、
    不带 `droppedUsage`，提示改为新增的 `TRUNCATION_RESUME_PROMPT`（"上条回复因长度上限被截断；从断处接着写，不要重复已写的内容"），
    不要求工具调用。
- 上限与计数、暂扣 agent_end 的条件、中止处理、轮间压缩后按会话树还原的路径都不变。保留的回复已在主分支上，按会话树还原时
  自然在内，续跑请求与按主分支还原的上下文一致。
- 上游 pi-ai 的消息转换只剔除 stopReason 为 error、aborted 的助手消息，stopReason 为 length 的回复照常发出；
  截断在思考块中途、缺签名的思考块由上游按既有规则转成正文。不改上游。
- 续跑条目 `ContinuationDataSchema` 加可选的 `replyKept`（字面量 true）。决策 376 之前写下的条目没有这一项，一律按移出主分支读。
- 记账：`session-judge.ts` 遇到 `replyKept` 的续跑条目不再加一轮（那条回复已按主分支上的消息计过轮与用量）；
  `session-view.ts` 只加 `droppedUsage`，保留的条目没有它，不需改。即保留的那段不再算丢弃。
- 回看历史（`src/application/history.ts`）把两句提示都显示成程序提示行。
- `TurnRoundNotice.truncated` 的注释改为不再说"从上下文去掉"；打转检测照旧不把截断轮算作一轮。

### 跑批身份头（f343564）

- `runaway-config.ts` 新增 `TRUNCATION_CONTINUATION_VERSION = "v2"`（v1 即 367 的一律去掉）。
- `effectivePigeonSettings` 总记 `continuationVersion`（与 `statusBlockVersion` 同样无条件记录），身份头类型加这一项。
- 后果：此前写下的身份头没有 `continuationVersion`，续跑即判为不同。旧身份头的跑批不能用新代码续上。

### 虚拟路径提示（357cae4）

- `src/state/paths.ts` 新增共用一句 `VIRTUAL_PATH_HINT`："pigeon:// 路径只能用 read_file 读取，shell 命令里用不了"。
- run_command 截断输出的"已存为"一句、后台作业的输出去向两句（在跑、已存）、裁剪占位里命令输出的恢复说明，各在末尾以"；"接上这一句。
  放在 state 层，pi-runtime 与 tools 都可依赖，不新增跨层依赖。
- 裁剪占位只对新裁的结果带这一句：已应用的裁剪续跑时按会话记录里存下的占位原样重放（`pruneSeedFromEntries`），
  跨这次升级续跑的会话前缀不变。

## 三、测试与变异

所有用例用仓库的假模型（`createFakeStreamFn`）与合成消息，不发真实请求。

- `src/pi-runtime/adapter-continuation.test.ts`：
  - 删去原"截断即续跑、去掉截断的回复"用例与原"会话文件"用例，合并为按原因参数化的一组（`describe.each`，两种原因各一）：
    第二次请求的上下文里截断正文留与不留、末条提示为各自的常量且不是另一句；会话文件照留截断的回复；主分支布局
    （单纯撞上限：用户、助手、续跑条目；重复检测：用户、命中条目、续跑条目）；续跑条目的 `cause`、`replyKept` 与
    `droppedUsage` 有无；按主分支还原的上下文以第二次请求的上下文为前缀（逐条比对角色与内容）；轮数与用量与逐轮事件一致。
  - "本 Run 轮间压缩过"一条改为断言续跑请求带着截断的正文、末尾是接续提示（同时覆盖压缩后按会话树还原时保留的回复在内）。
  - 重复检测命中一条去掉与参数化组重复的来由断言，只留命中记录的判据、通道、模式。
  - 连续上限、合计上限、中止、还原期间中止、移出时尾随条目重写各条不变。
- `src/application/runaway-rounds.test.ts`：回看历史的提示行改为两句提示各测一次。
- `src/eval/stream-experiment.test.ts`：生效参数的期望值加 `continuationVersion: "v2"`。
- 虚拟路径提示三处各加一条片段断言（含 `VIRTUAL_PATH_HINT`），放在已检查该段文字的用例里：
  `command-output.test.ts`（截断输出）、`background-jobs.test.ts`（输出超上限的作业）、`context-prune.test.ts`（命令占位）。
- 测试行数：产品代码增 60 行、删 21 行；测试增 142 行、删 131 行（净增 11 行，少于产品代码净增的 39 行）。
- 本地只跑改动涉及的六个测试文件（并发 2）：续跑、回看历史、身份头三个文件 20 个全部通过；虚拟路径三个文件 31 个通过、
  9 个为非本平台用例跳过。改动文件的 biome 检查与 `tsc --noEmit` 无错。

变异（每次只改一处，跑 `adapter-continuation.test.ts`，结束后还原，核对工作区差异与变异前逐字一致）：

| 变异 | 结果 |
|---|---|
| M1 单纯撞上限也去掉（`drop` 恒真） | 2 个变红：参数化组的 output-limit、轮间压缩一条 |
| M2 重复检测掐断也保留（`drop` 恒假） | 1 个变红：参数化组的 repetition |
| M3 两种情况用同一句提示（恒用工具调用提示） | 2 个变红：参数化组的 output-limit、轮间压缩一条 |
| M4 去掉连续上限判定 | 1 个变红：连续上限 |
| M5 去掉合计上限判定 | 1 个变红：合计上限 |
| M6 保留时仍把回复移出主分支（Agent 状态保留，重放前缀不一致） | 2 个变红：参数化组的 output-limit（主分支布局先触发）、轮间压缩一条（按会话树还原后不含截断正文） |
| M7 保留的续跑条目仍加一轮（`session-judge.ts`） | 1 个变红：参数化组的 output-limit（轮数与逐轮事件不一致） |

## 四、verify

- 在验证服务器（8 vCPU、31 GB 内存，Linux 6.8，Node 24.12.0）上对提交 357cae4 跑 `TEST_CONCURRENCY=6 npm run verify:full`，
  当时没有别的测试在跑：退出码 0。lint、check 通过；快档与慢档 323 个测试文件，1825 个通过、7 个跳过（`background-jobs` 2、
  `read-deny` 3、`run-command-shell` 2，均为只在 Windows 或 macOS 上运行的用例）；依赖检查无违规（656 个模块）。墙钟 1 分 37 秒。
- 本审计的提交只加文档，不改代码与测试。
