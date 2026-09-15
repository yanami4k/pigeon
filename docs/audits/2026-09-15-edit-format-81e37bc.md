# 编辑格式对照施工审计与验证证据（基线 81e37bc）

- 日期：2026-09-15
- 施工位置：工作树 `.claude/worktrees/edit-format-compare`（分支 worktree-edit-format-compare），自 81e37bc 开出；裁决文档（decisions.md 061、docs/decisions/edit-format-decisions.md）与代码同一工作树
- 依据：决策 061 及两条同日修订，切片 S0–S3
- 按 decisions.md 047 入库，只追加不覆盖

## 变异反向验证方法

沿用 M6.5 审计的执行器：本地临时脚本（不入库）把工作树的 src、package.json、tsconfig.json、biome.json、.dependency-cruiser.js 复制到一次性目录，目录联接挂 node_modules，施加单点变异（每处补丁的原文必须恰好命中一次，否则不执行并报告）后跑 `node --test --test-timeout=120000 "src/**/*.test.ts"`，解析变红用例，结束拆联接；工作树不被触碰。"精确变红"的判读口径同前：变红集合里每一条都能由该变异直接解释，且不含与该机制无关的用例。

## 依赖与基线

- 工作树以目录联接挂主检出的 node_modules。
- hashline 基线的会话账本（M6.5 冒烟目录下被忽略的 `.pigeon/`，150 个文件）原样拷进工作树同一相对路径使用，源目录不改。
- 基线 verify：biome 一条改动前已有的 noUnusedImports 警告（tui/main.ts）；tsc 零错；node --test 534/534；dependency-cruiser 256 模块 1746 依赖零违规。

## 测试先行

| 切片 | 首次红运行 | 红因 |
|---|---|---|
| S0 | tmp/ef-s0-red.txt | `eval/process.ts`、`eval/compare.ts` 不存在（2 个文件红）；`application/runtime-edit-mode.test.ts` 两例首次运行即绿——它守的是"缺省编辑模式下发给模型的 system prompt 与工具描述逐字不变"，施工前的现状即是基准 |
| S1 | tmp/ef-s1-red.txt | `tools/replace-edit.ts` 不存在（2 个文件红）；read_file 无 replace 输出（1 例红） |

## S0 编辑模式与 Eval 基础设施

### 改动

- 新建 `src/tools/edit-mode.ts`：`EditMode = "hashline" | "replace"`，缺省 hashline。
- `src/application/runtime.ts`：`editMode` 参数，按模式注册与装配 edit_file（工具名两种模式都叫 edit_file，策略、grant、角色清单不变），切换 read_file 的输出与描述、system prompt 里讲编辑的那一句；hashline 分支与 061 之前逐字一致。`application/headless.ts` 与 `application/workers.ts` 透传编辑模式。
- Event Log schema 未改：区分编辑模式靠结果行，以及 run.started 已有的 system prompt 哈希与工具集摘要。
- 新建 `src/eval/process.ts`：`summarizeProcess` 从会话账本（事件日志加内容文件）汇总单次运行的过程指标——各工具的调用数与报错数、撞输出上限的轮数、编辑报错分类计数；`classifyEditError` 按报错文案的稳定前缀分类。runner 写结果行与复算基线用同一个函数。
- `src/eval/results.ts`、`src/eval/runner.ts`：运行键扩为（任务、条件、编辑模式、第几次）；结果行新增 `editMode`、`harnessRef`（Pigeon 仓库 HEAD 短号与是否有未提交改动）、`process`；旧行没有 editMode 的读取时按 hashline 补齐，没有 process 的由对照报告复算补上。`src/orchestration/worktree.ts` 新增 `describeHead`。
- 新建 `src/eval/compare.ts`；`src/cli/index.ts` 新增 `pigeon eval compare --baseline <目录> --candidate <目录> [--condition none] [--out <文件>]`（缺省写到候选目录下的 compare.md），`pigeon eval` 与 `pigeon run` 加 `--edit-mode hashline|replace`。报告含两种编辑模式的汇总表、逐任务对比表与自动写出的"已知局限"段，只写目录名，不写本地绝对路径。
- `src/eval/report.ts` 报告头加一行编辑模式。

### 编辑报错分类口径

按 toolResult 报错文案的稳定前缀判定，内容文件里找不到报错正文的调用归"其他"：

| 类目 | 适用模式 | 文案前缀 |
|---|---|---|
| 输出上限截断 | 两种 | `Tool call "edit_file" was not executed: the response hit the output token limit` |
| 无变化 | 两种 | `编辑没有产生任何实际变化` |
| 参数校验失败 | hashline | `Validation failed for tool "edit_file"` |
| 锚点未命中 | hashline | `edits[i] 的 anchor` 或 `endAnchor` 后接 `未命中` |
| 行号越界 | hashline | `edits[i] 的 anchor` 或 `endAnchor` 后接 `越界` |
| 原文未找到 | replace | `未找到 old_string` |
| 原文不唯一 | replace | `old_string 不唯一` |
| 其他 | 两种 | 以上都不匹配（如快照过期、畸形锚点、范围重叠、replace 侧的参数校验失败） |

各工具调用数与报错数按 tool.settled 计（上游拦截、没有执行的调用同样落定并计入）；撞输出上限的轮数按 turn.completed 的 stopReason 为 length 计。

### 测试

| 测试文件 | 用例 |
|---|---|
| src/application/runtime-edit-mode.test.ts（缺省与显式 hashline：system prompt、edit_file 与 read_file 的描述和参数逐字不变） | 2 |
| src/eval/process.test.ts（构造的会话账本上各工具调用与报错、撞输出上限轮数、hashline 六类报错计数精确且只计指定 Run；replace 侧分类） | 2 |
| src/eval/compare.test.ts（汇总表、逐任务表、报错分类，旧行按 hashline 读并由账本复算 process，已知局限自动写出） | 1 |

runner 的结果行字段机检沿用 `EVAL_RESULT_FIELDS` 遍历，新增三个字段登记进清单即覆盖。

## S1 replace 式编辑工具

### 改动

- 新建 `src/tools/replace-edit.ts`：参数 `{ path, old_string, new_string }`，只能改已存在的文件，old_string 不能为空。匹配前文件内容与参数都按 LF 规整，精确匹配、不做空白宽松；出现 0 次拒绝并提示"未找到 old_string：请重新 read_file 核对原文，含缩进与空白，不要带行号前缀"；出现多次拒绝并写明出现次数与各处起始行号、提示加上下文；新旧相同拒绝。写回复用 hashline.ts 的 splitContent / joinContent，保留 BOM、行尾风格与末尾换行。不带快照参数。写档、串行执行、工作区路径围栏；实现审批预览 diff 与内容证据（改前哈希、预期改后哈希），与执行共享同一段预检；成功回执"已在 X 应用 1 处替换（+a −b 行）"，不回传 diff 或锚点。+a −b 由改前改后行数组去掉公共前缀与公共后缀后计算。错误对象带 domain 归类标记。
- `src/tools/read-file.ts`：replace 模式下输出头为 `[路径] 共 N 行（窗口 a-b）`，每行 `行号| 内容`，不带行标签与快照标签；工具描述写明编辑时不要带行号前缀。

### 测试

| 测试文件 | 用例 |
|---|---|
| src/tools/replace-edit.test.ts（唯一替换与回执；未找到、不唯一、无变化、缩进不同即未找到；CRLF 与 BOM 保留、无末尾换行保持；路径越界、文件不存在、old_string 为空；预览与内容证据一致） | 5 |
| src/tools/read-file-replace.test.ts（replace 输出、窗口截断、空文件；缺省 hashline 输出不变） | 1 |
| src/application/replace-edit-e2e.test.ts（经治理层：工具与 prompt 随模式切换，yolo 下 intent 预期改后哈希与 receipt 实测改后哈希一致；崩溃恢复哈希自动确证 not-executed 与 executed，零重放） | 2 |

## S2 基线复算与真实链路

### 基线复算核对

对 docs/audits/eval/2026-09-14-8e76567 中条件为 none 的 24 行，用 `summarizeProcess` 从会话账本复算：edit_file 调用 66、报错 16、撞输出上限 0，与预期一致。报错分类：参数校验失败 7、锚点未命中 7、行号越界 2。同一次复算里 read_file 调用 78、报错 0，run_command 调用 145、报错 1。同一函数复算另两个条件：candidate edit_file 调用 71、报错 12、撞输出上限 0；approved 调用 72、报错 17、撞输出上限 2；三个条件合计调用 209、报错 45、撞输出上限 2，与决策 061 事实段记录的 M6.5 冒烟全量数一致。

### 真实链路：pigeon run 的 replace 模式

`pigeon run --edit-mode replace --stream-fn spikes/real-stream-fn.mjs --provider kimi-coding --model kimi-for-coding --yolo --json --max-turns 8`，任务为改临时工作区里一个文件的一行并读回确认：退出码 0，status completed、failure null、4 轮、工具调用 3 次（read_file、edit_file、read_file）、需审批 1 次；文件内容正确。trace 的启动快照为 yolo，edit_file 的参数为 `{ path, old_string, new_string }`，intent 记改前与预期改后哈希，receipt 实测改后哈希与预期一致。

### replace 组正式运行（docs/audits/eval/2026-09-15-81e37bc/）

`pigeon eval eval/tasks --out docs/audits/eval/2026-09-15-81e37bc --runs 3 --conditions none --edit-mode replace --stream-fn spikes/real-stream-fn.mjs --provider kimi-coding --model kimi-for-coding --yolo`，以独立进程运行，一次跑完未被终止；预算沿用任务定义（30 轮、墙钟 15 分钟）。24 行结果按（任务、条件、编辑模式、第几次）恰为 8×1×1×3，无重复、无缺行；每行 editMode 为 replace、harnessRef 为 81e37bc（有未提交改动）、process 字段齐全；结束后主仓库无残留工作树与 `pigeon/*` 分支。session-day-groups 第 2、3 次撞 30 轮上限被中止（31 轮；run_command 分别 17 次与 25 次，edit_file 分别 7 次报错 1 次与 2 次报错 0 次，未撞输出上限），此时工作区改动已使验证通过，判决为通过。results.jsonl、report.md 与对照报告 compare.md 入库，实验会话在该目录 `.pigeon/` 下不入库。

对照报告：`pigeon eval compare --baseline docs/audits/eval/2026-09-14-8e76567 --candidate docs/audits/eval/2026-09-15-81e37bc --condition none`，写到候选目录的 compare.md；基线行没有 process 字段，由同一汇总函数从保留的会话账本复算。

## 对照结果（条件 none，Kimi For Coding）

| 指标 | hashline（基线） | replace（候选） |
|---|---|---|
| 运行数 | 24 | 24 |
| 成功率 | 24/24 | 24/24 |
| 误报 | 0 | 0 |
| 编辑调用数 | 66 | 64 |
| 编辑报错数 | 16 | 3 |
| 编辑报错率 | 24.2% | 4.7% |
| 报错分类 | 参数校验失败 7、锚点未命中 7、行号越界 2 | 原文未找到 3 |
| 平均轮次 | 12.8 | 14.3 |
| 平均输出 token | 3890.6 | 3829.5 |
| 撞输出上限次数 | 0 | 0 |
| 撞 30 轮上限次数 | 0 | 2 |
| 平均耗时（秒） | 120.0 | 134.2 |
| 总 token | 2,892,200 | 3,330,607 |

逐任务（编辑调用/报错；平均轮次）：

| 任务 | hashline | replace |
|---|---|---|
| args-summary-surrogate | 5/2；10.3 | 13/0；13.7 |
| candidate-evidence | 7/0；11.0 | 9/2；14.0 |
| fmt-duration | 4/0；6.3 | 4/0；7.3 |
| insert-after-diff | 13/3；17.7 | 7/0；14.7 |
| path-dotdot-name | 6/0；10.7 | 10/0；12.7 |
| session-day-groups | 8/0；14.3 | 13/1；26.3 |
| skill-block-scalar | 13/8；19.3 | 4/0；17.3 |
| tool-error-codes | 10/3；13.0 | 4/0；8.0 |

## 结论（只陈述数据）

- 成功率两组都是 24/24，任务集对该模型触顶，成功率上未测出差异；误报两组都是 0。
- 编辑报错：hashline 66 次调用 16 次报错（24.2%），replace 64 次调用 3 次报错（4.7%）；hashline 的报错集中在参数校验失败与锚点未命中（各 7），replace 的 3 次都是原文未找到。编辑调用总数相近，报错数与报错率的差距明显。
- 其余过程指标：平均轮次 hashline 12.8、replace 14.3（多 1.5 轮）；平均输出 token 3890.6 与 3829.5（相近）；平均耗时 120.0 秒与 134.2 秒；总 token 2,892,200 与 3,330,607（replace 多约 15%）；两组都没有撞输出上限。replace 组有 2 次撞 30 轮上限，都在 session-day-groups，两次的轮次主要花在 run_command（17 次、25 次）上，编辑报错各 1 次与 0 次。
- 逐任务方向不一：insert-after-diff、skill-block-scalar、tool-error-codes 上 replace 的编辑报错与轮次都更少；args-summary-surrogate、path-dotdot-name、session-day-groups 上 replace 的编辑调用与轮次更多。
- 每组每任务只有 3 次，样本小，且两组 harness 版本与运行时间不同，不下"更好或更差"的定论。编辑工具的缺省是否改为 replace，留给项目负责人按上述数据裁决。

## 已知局限

- harness 版本不同：hashline 基线为 M6.5 冒烟时的工作树（结果行未记录 harnessRef），replace 组为 81e37bc 加本轮未提交改动；两组之间除编辑工具外还有本轮新增的过程指标与编辑模式装配代码。
- 时间先后：基线运行于 2026-09-14 19:52 至 21:31（UTC），replace 组运行于 2026-09-15 14:47 至 15:41（UTC），两组先后运行、没有交错，模型服务随时间的变化会混入对比。
- 单一模型（kimi-coding/kimi-for-coding），结论不外推到其他模型。
- 样本量：每组 24 次、每任务 3 次，只做描述性对比，不做显著性检验（Wilson 与 McNemar 不在本轮范围）。
- 编辑报错分类依赖报错文案的稳定前缀；报错文案改动时分类口径需同步更新。
- 过程指标按 tool.settled 计，一次调用无论报错与否都计一次；撞轮次上限的运行里模型花在 run_command 上的轮次不属于编辑摩擦，但会拉高平均轮次。

## 门禁（最终）

`npm run verify`：biome 仅一条改动前已有的 noUnusedImports 警告（tui/main.ts）；tsc 零错；node --test 547/547；dependency-cruiser 266 模块 1826 依赖零违规。

## 变异反向验证（精确变红）

S0、S1 全部落地后一次跑完，每处变异跑全量 547 条测试：

| 编号 | 变异 | 结果 |
|---|---|---|
| 1 | `eval/process.ts` 汇总时漏计 isError 的调用（报错数不累加） | 精确 2 红：「过程指标：构造的会话账本上各工具调用与报错……计数精确」、「编辑模式对照报告：……旧行按 hashline 读并由账本复算 process……」（基线旧行的过程指标由同一函数复算，编辑报错数变 0） |
| 2 | `eval/runner.ts` 结果行漏写 editMode | 精确 1 红：「Eval runner：……results 行字段齐全……」（字段机检遍历 EVAL_RESULT_FIELDS） |
| 3 | `tools/replace-edit.ts` old_string 多处匹配时直接改第一处 | 精确 1 红：「replace 编辑：未找到、不唯一（出现次数与各处起始行号）、新旧相同一律拒绝，文件逐字节不变」 |
| 4 | `tools/replace-edit.ts` 写回时行尾一律写 LF | 精确 1 红：「replace 编辑：CRLF 与 BOM 保留……」 |
| 5 | `tools/read-file.ts` replace 模式下仍输出行标签 | 精确 2 红：「read_file replace 模式：每行 `行号| 内容`……」、「replace 模式经治理层：……」（断言模型收到的 read_file 结果为 `2| beta`） |

## S4 缺省编辑模式改为 replace（决策 062）

### 改动

- `src/tools/edit-mode.ts`：缺省编辑模式 `DEFAULT_EDIT_MODE` 改为 replace；新增 `LEGACY_RESULT_EDIT_MODE`（hashline），专用于没有 editMode 字段的旧 Eval 结果行。cli、tui、headless、worker、`pigeon run` 与 `pigeon eval` 不指定编辑模式时一律走 replace，`--edit-mode hashline` 仍可用。
- `src/eval/results.ts`、`src/eval/runner.ts`（运行键）、`src/eval/compare.ts`、`src/eval/report.ts`、`src/cli/index.ts`（进度行）：旧结果行缺 editMode 时按 `LEGACY_RESULT_EDIT_MODE` 补齐，不跟随缺省值。
- `src/application/workers.ts`：worker 运行面工厂（`createWorkerRuntimeFactory` 与 `createSessionWorkers`）接受可选编辑模式并透传，缺省走 replace。
- Event Log schema 未改；resume 沿用当前缺省值。
- 复核裁决引用的"至少出一次编辑错误的运行"：用过程指标汇总函数从账本计数，hashline 9/24、replace 2/24，与裁决一致。

### 测试

- `src/application/runtime-edit-mode.test.ts` 改为两条：显式 hashline 时 system prompt、edit_file 与 read_file 的描述和参数与决策 061 之前逐字一致；缺省为 replace（装配出 replace 版 edit_file 参数与描述、read_file 描述写明不带行号前缀、system prompt 不含 N#TAG）。
- 首次红运行 tmp/ef-s4-red.txt：缺省值改为 replace 后全量 547 条中 10 条变红，全部是剧本按 hashline 参数编辑、却走缺省装配的测试（headless 两条、装配根两条、worker 两条、`pigeon run` 两条、Eval runner 一条、编辑模式缺省一条）。除编辑模式测试按裁决改写外，其余 9 条改为显式传 hashline，断言不改、不删测试。

### 变异反向验证

| 编号 | 变异 | 结果 |
|---|---|---|
| 6 | `tools/edit-mode.ts` 缺省编辑模式改回 hashline | 精确 1 红：「编辑模式缺省为 replace：不传编辑模式时装配出 replace 版 edit_file 与 read_file」 |

### 门禁

`npm run verify`：biome 仅一条改动前已有的 noUnusedImports 警告（tui/main.ts）；tsc 零错；node --test 547/547；dependency-cruiser 266 模块 1829 依赖零违规。

### 已知边界

- resume 的编辑模式切换：Event Log schema 不改、不追溯原会话用的编辑模式，旧会话的历史里有 hashline 格式的读取输出，resume 后模型拿到的是 replace 版工具。
- `eval/skills/pigeon-coding-pitfalls/` 第 1 节讲的是 hashline 用法（锚点、快照、op 种类），在新缺省下已不适用；为保持 candidate 与 approved 与 M6.5 冒烟时逐字节一致，本轮不改。
