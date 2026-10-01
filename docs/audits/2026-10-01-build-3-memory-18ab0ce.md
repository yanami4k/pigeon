# 记忆改取向（基线 18ab0ce）

范围：决策 328–332 的施工（写满被拒的文字、两层一行一条、取向与文字、写入的入口与提示、删除复盘、人写说明改读 AGENTS.md），基线为 claude/build-1-settings 的 18ab0ce。本段未做完即中断，进度见最后一节。

## 一、提交

| 提交 | 内容 |
|---|---|
| 7fe12f3 | 删除收尾复盘、压缩前复盘、终端界面启动时补做（含租约与三道闸）、复盘模型配置、复盘指令及其版本、退出快照；旧会话里的复盘与退出条目照常可读；跑批器结果行的复盘字段恒为 null |
| 768ec7a | 学到的记忆分项目级与用户级两层、一行一条；update_memory 加层级参数、两种被拒文字分开；只给终端界面与 --line；settings 增加 memory 一节；终端界面 /memory；写入后提示一行 |
| b22df12 | 人写说明改读 AGENTS.md（逐层拼接、CLAUDE.md 回退、32 KiB 截断与提示）；删除常驻 Memory 与 --memory-budget |

## 中断时的进度

### 对照施工说明"要做的事"

1. 写满被拒的文字（328）：已完成。新增被拒与替换被拒分开写，数字为当前用量、该条字数（含工具补上的编号、日期、来源与会话编号）、还差 / 被替换条目现有字数、新内容字数、替换后总数、超出多少，附现有条目编号与各条字数；替换后不比替换前长一律放行（"写满时新增或改长都会被拒绝"）。文字记为记忆文字 v2（`MEMORY_TEXT_VERSION`，随 Run 开始条目的 pushedMemory 与跑批器身份头的 memoryTextVersion 落盘）。用例与变异验证见下。
2. 两层、一行一条（332）：已完成。项目级 `.pigeon/state/memory.md`、用户级 `~/.pigeon/state/memory.md`（路径走 state/paths.ts）；行格式 `- [P3] 内容 〔2026-10-01 · 终端界面 · 会话 sess_…〕`，〔〕一段可缺（人手加的条目），编号前缀 P/U 须与层相符；update_memory 增 layer 参数；settings 增 memory 一节（projectLimitChars、userLimitChars，缺省各 4,000，未知键报错、按键逐层合并）；冲突提示加问"只在这个项目还是所有项目"。**未做**：migrate-config 把旧的 learned 目录改名备份、启动检查列为旧文件（见第 5 项一起做）。
3. 取向与文字（329）：已完成重写（推送段、工具说明、"被纠正时记下"、两种被拒文字、写入提示行），旧的代码引用、[L编号] 要求已去掉。**未做**："待过目的文字"一节尚未整理进审计（全文在下方"已写好的待过目文字"里给出了位置与原文出处）。
4. 写入的入口与提示（331）：已完成。update_memory 与写入说明只在带写入配置时注册（终端界面主会话含沙箱会话、--line 与 `pigeon resume`）；pigeon run、worker（roles.ts 去掉了 update_memory）、/fork 与失败重试分支、跑批器只推送；写入不审批，写入后终端界面消息区与 --line 各打印一行 `[记忆] 已记下（项目级 P3）：…`；终端界面 /memory 查看两层（位置、用量、原文、格式坏了指出行号），`/memory edit project|user` 复制到同目录编辑稿、用 $VISUAL/$EDITOR 打开（界面暂停）、存盘后校验格式与上限、在锁内换掉原文件，不合格或编辑期间原文件被改则保留原内容、编辑稿留给人取回；没有编辑器给出文件路径。`/memory edit` 运行中拒绝，`/memory` 运行中可用。
5. 删除复盘（331）：代码已删净（`grep -rni review src` 只剩读旧条目的兼容：state/learned-memory.ts 的 MemoryReviewTagSchema、session-entries.ts 的 memoryReview 字段、session-family/session-cost/recent-sessions/session-tree 对旧复盘会话的显示与花费归属，以及跑批器结果行与报告里恒为 null 的 review 字段；其余是 preview 等无关同名词）。**未做**：migrate-config 新增步骤（memory-review.json 改名备份、补做复盘记录目录改名备份）与启动检查把 memory-review.json 列为旧文件；trace 读含复盘条目的旧会话的专门用例（/resume 与会话树已有用例覆盖：tui-exit.test.ts"旧会话里的退出条目照常可读"、session-tree.test.ts、continue-flags.test.ts）。
6. AGENTS.md（330）：读取已完成（memory/agents-md.ts；用户级在前，仓库根到工作目录逐层，CLAUDE.md 回退，不越过仓库根，不在 git 里只读工作目录；32 KiB 按 UTF-8 字节，截断时推送末尾与终端各一行；会话开始冻结；worker 读自己工作树；沙箱读宿主工作区即治理根；跑批器 agentsMd: false）。**未做**：migrate-config 两步（preferences.md → ~/.pigeon/AGENTS.md，目标已存在报错不覆盖；.pigeon/memory/ 改名备份并提示并入 AGENTS.md）与启动检查列为旧文件；拼接与截断的变异验证。
7. 功能测试"记下纠正、下次照做"：**未做**。
8. 使用说明 docs/configuration.md：**未做**。

### 对照"验收要点"

- 两种被拒文字的数字（新增、替换、替换后变短、两层分别计）：有用例（src/memory/update-memory-tool.test.ts），变异验证已做（下表）。
- 入口：pigeon run、worker、跑批器无 update_memory 与写入说明，终端界面与 --line 有：用例在 src/application/runtime-pushed-memory.test.ts（入口、worker 三角色）与 src/eval/stream-agents.test.ts（推送格工具清单）。
- 复盘删净：已删；旧会话 trace 的专门用例未补。
- AGENTS.md：逐层顺序、CLAUDE.md 回退、不越过仓库根、32 KiB 截断与提示、中途改文件不生效均有用例（src/memory/agents-md.test.ts、src/application/runtime-memory.test.ts）；变异验证未做。
- 迁移新增各步与启动检查：未做。
- 审计"待过目的文字"：未整理。
- verify：最后一次全量 `npm test` 在 b22df12 之前一个状态为 1481 条、失败 4（3 条为已知现象，另 1 条 runtime-roots.test.ts 已在 b22df12 修好并单独跑通过）；lint 通过（1 条警告未查）、check 通过；b22df12 上未再跑全量 verify 与 deps。

### 当前代码状态

- b22df12 能编译（tsc 0 错误）、biome 无错误（1 条警告）。
- 已知失败：eval/stream-profiles.test.ts 两条（Node 22）、eval/stream-workspace.test.ts 一条（root 运行），与本段无关。
- 迁移命令现状的注意事项：`LEGACY_STATE_ENTRIES` 仍会把旧 `.pigeon/learned`、`.pigeon/learned.lock`、`.pigeon/review-backfill` 挪进 `.pigeon/state/` 对应位置（第一段的行为）；挪进去后不再被任何代码读取。

### 下一步顺序

1. migrate-config 追加步骤（application/migrate-config.ts 的 MIGRATION_STEPS；MigrationContext 需加 homeDir 以处理用户级）：
   - 旧学到的记忆：`.pigeon/learned/` 与 `.pigeon/state/learned/`（连同 learned.lock）改名到 `stateBackupDirOf(root)`（`.pigeon/state/backup/`，路径模块里已加）下，目标已存在即拦阻；同时从 `LEGACY_STATE_ENTRIES` 去掉 learned、learned.lock、review-backfill，免得两步对同一项各算一遍（各步的 plan 在任何 apply 之前算出）。
   - memory-review.json 改名备份到 `.pigeon/state/backup/memory-review.json`；补做复盘记录（`.pigeon/review-backfill`、`.pigeon/state/review-backfill`）改名备份到 `.pigeon/state/backup/review-backfill`（取舍：一律改名备份不删除，不丢人的数据）。
   - `~/.pigeon/preferences.md` 改名为 `~/.pigeon/AGENTS.md`，目标已存在即拦阻并说明；`.pigeon/memory/` 改名备份到 `.pigeon/state/backup/memory`，打印"把其中内容并入项目的 AGENTS.md"。
   - 第一段在并行中把迁移备份统一放到 `.pigeon/state/` 下的备份目录，合并时以那边的目录名为准，把 `stateBackupDirOf` 对齐过去。
2. persistence/legacy-layout.ts：启动检查加 memory-review.json、`.pigeon/memory/`、`~/.pigeon/preferences.md`、旧 learned（两处）为旧文件；文件头注释与 persistence/settings.test.ts"旧布局…memory-review.json 不算"一条随之改。用例：migrate-config.test.ts 各步、目标存在不覆盖。
3. 功能测试（第 7 项）：用 openSessionRuntime 带 memoryWrite、脚本模型第一会话调 update_memory 记下纠正，第二会话检查系统提示里有这一条、层级、来源"终端界面"、日期与第一会话编号。仓库里没有接真模型、缺 key 时跳过的测试写法（需再确认后在审计里说明）。
4. 变异验证：AGENTS.md 拼接顺序、CLAUDE.md 回退、仓库根边界、截断字节数；迁移各步。
5. docs/configuration.md 补 memory 一节、两层位置与上限、/memory、AGENTS.md 规则与 32 KiB、迁移新增步骤；docs 与注释跑一遍规定的扫描。
6. 审计补全：改动清单、用例增删数、verify 结果、"待过目的文字"逐字全文、待确认的取舍、顺带发现。

### 已做的取舍（待确认）

1. 来源只分入口：终端界面 / 命令行对话（沙箱会话按所在入口记）；`pigeon resume` 归命令行对话。
2. 编号带层前缀并存进文件（P/U + 正整数，新编号取现有最大加一，删除最大编号后可能复用）；不再有 next-id 文件。理由：行内可读、replace/remove 不受推送冻结后编号位移影响。
3. 上限计整行（含编号与〔〕来处），因为推送的是整行；被拒文字写明"含工具补上的编号、日期、来源与会话编号"。
4. 替换后不比替换前长一律放行，即使该层已超上限（人手改出来的），不卡住整理记忆。
5. 冲突处理按是否可写入取文字：可写入（终端界面、--line 主会话）用交互版；其余（含终端界面续开的 worker 会话）用无人值守版。LearnedMemoryConfig 去掉 conflict 字段。
6. 只推送的入口两层都没有条目时不推推送段；可写入的入口照样推（让 agent 知道记什么、记在哪层）。
7. worker 的冲突处理为无人值守版、不带工具（原先沿用父会话的填法）。
8. 删除启动参数 --memory-limit（日常入口；上限在设置里）与 --memory-budget（常驻 Memory 随之删除，AGENTS.md 上限固定 32 KiB）；跑批器的 --memory-limit 保留，改为项目级上限（缺省 4,000）。
9. 跑批器只推项目级记忆、不读用户级记忆，不读 AGENTS.md（agentsMd: false，沿用原 memoryRoots: [] 的意图）；记忆快照改为复制 `.pigeon/state/memory.md`，快照目录 `memory-snapshots/`；身份头去掉复盘模板版本与复盘上限，加 memoryTextVersion。
10. 删除退出快照与退出条目（只供补做读代码）；refs/pigeon/exit/ 下已有的引用不清理。
11. 注入快照升到 v14：去掉 memoryReview，learnedMemory 改为 pushedMemory（层清单 + 文字版本）；Run 开始条目新增 pushedMemory，旧的 learnedMemory、memoryReview 字段留着供读旧会话。
12. /memory edit 用同目录的编辑稿（`memory.md.edit.md`），不合格时编辑稿保留供人取回；编辑期间原文件被改即不覆盖。
13. 运行中被拒的提示改为直接用命令表里的命令名（"/grants save""/memory edit"两词命令一并适用），原先只特判 grants save。
14. AGENTS.md 的 32 KiB 按 UTF-8 字节计（照 Codex 的字节上限），截断不劈开字符；超出后的文件整份不放入，清单记 included=false。

### 已写好的待过目文字（原文所在，逐字）

- 工具说明、参数说明、各返回文字、两种被拒文字、写入提示行：src/memory/update-memory-tool.ts 的 `UPDATE_MEMORY_DESCRIPTION`、`UpdateMemoryParamsSchema`、`UPDATE_MEMORY_TEXTS`、`memoryWriteNoticeLine`；用例 src/memory/update-memory-tool.test.ts 逐字断言了说明与两种被拒文字的完整句式。
- 推送段开头、"被纠正时记下"说明、两种冲突处理、各层小标题：src/memory/pushed.ts 的 `PUSHED_MEMORY_INTRO`、`MEMORY_WRITE_GUIDANCE`、`MEMORY_CONFLICT_TEXTS`、`pushedLayerSection`；用例 src/memory/pushed.test.ts 逐字断言。
- 各层文件头：src/memory/learned.ts 的 `MEMORY_FILE_HEADERS`。

### 变异验证（已做）

| 变异 | 结果 |
|---|---|
| 新增被拒的"还差"改为 limit - used | update-memory-tool.test.ts"新增被拒（328）…"精确变红 |
| 替换后总数不扣被替换条目（used + newChars） | "替换被拒（328）…"与"替换后变短或等长一律放行…"两条变红 |
| 改短也拦（去掉 afterChars > used） | "替换后变短或等长一律放行…"精确变红 |
| 两层共用项目级上限 | "两层分别计…"精确变红 |
| 各条字数只算内容（不含编号与来处） | "新增被拒""替换被拒""两层分别计"三条变红 |
| 替换被拒的"超出"按替换前用量算 | "替换被拒（328）…"精确变红 |

### 顺带发现

- session-search-switch.test.ts 原有一条 runHeadless 用例没给 homeDir，推送记忆开着时会读真实主目录下的用户级记忆；已改为给临时目录。
