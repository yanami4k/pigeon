# 文件工具写工作区以外与 grep 输出分组

基线：f25e621。只提交不推送。范围：决策 407（放权模式下文件工具可写工作区以外）与 408（grep 输出分组与字数预算）。

## 一、提交

| 提交 | 内容 |
|---|---|
| 5364ac2 | 407：write_file 与 edit_file（两种编辑模式）在放权时接受工作区以外的路径；配置文档随之更新 |
| f446462 | 408：grep 内容结果按文件分组、列出部分设字数预算，超出的全文存进会话落盘目录；配置文档随之更新 |

## 二、407 改法

- 放权在工具层的来源：装配根（`application/runtime.ts`）本就按本会话的审批状态算出 `approval`——委派策略在场时取其审批模式，否则取 `--yolo` 旗标（沙箱缺省的放手审批档在启动参数解析时并入该旗标）。写工具的选项 `outsideWrites` 取 `approval === "yolo"`，与决策 355 的工作区外读取同一来源，没有另设开关。交互逐条询问（`prompt`）与无人值守又未放权（`none`）时为假。
- `tools/paths.ts`：新增 `WritePathOptions`（`outside`）、`WriteToolOptions`（`outsideWrites`）与说明句 `OUTSIDE_WRITE_SENTENCE`。`resolveWorkspaceWritePath`、`resolveWorkspaceCreatePath` 接受路径选项，`outside` 为真时不判工作区边界；路径含控制字符拒写、模型给的路径本身是符号链接拒写、不写版本库元数据（`.git`）、写入前复核都不变。`resolveWorkspacePath` 行为不变，读文件、grep、glob 的路径规则与禁读名单未动。
- 执行端接口（`tools/workspace-host.ts`）的 `resolveForWrite`、`resolveForCreate` 加可选的路径选项。本机实现转交上面两个函数；容器实现在检视结果的取用与新建路径的解析两处按它跳过工作区边界判定，容器里的写入脚本（复核后截断重写、补建目录后 noclobber 新建）不变。
- 三件写工具（`write_file`、hashline 与 replace 两版 `edit_file`）加选项 `outsideWrites`，审批预览与执行用同一份路径选项。说明：放权时写明"工作区以外的文件也可写（用绝对路径）"，并去掉"限工作区内""工作区内"的限定；未放权时说明原文不变。`WRITE_FILE_DESCRIPTION`、`REPLACE_EDIT_DESCRIPTION` 两个常量改为按选项生成的函数 `writeFileDescription`、`replaceEditDescription`。
- `read_file` 放手档（`allowed`）的说明去掉"只读、不能改"（放手档的写工具已可写工作区以外）；经人批准档与拒绝档原文不变。
- 改动统计：装配根把写工具的成功结果记作后台作业期间的前台改动（作业结束时从期间变化里扣除）；落在工作区以外的路径现在不记。原先会记成以 `../` 开头的相对路径（Windows 跨盘符时为绝对路径），与作业按工作区相对路径取的文件变化比对不中，不出错但无用。worker 的改动文件按它工作树里的 git 取、checkpoint 快照只含工作区，都不受影响。
- 治理层未改：受保护路径判定对工作区以外的路径按治理根的 `.pigeon` 判；worker 的作用范围（越界一律拒绝）与 worker 在自己工作树内写的默认放行（只认工作区内的路径）照旧。
- 未改的已知点：写工具预检失败时以 `resolveExisting` 刷新检视后重试一次（决策 349）；工作区以外的路径在 `resolveExisting` 照旧报越界，因此不重试、直接报原错误。本机执行端每次现读，结果与重试相同；容器执行端只在"检视之后文件被别处改动、预检因此失败"这一种情形少一次重试，模型重读后可再改。
- 文档：`docs/configuration.md` 读档工具一节把"写与编辑仍限工作区"改为放权时可写工作区以外的说明；本机模式风险一节注明放手模式下改文件工具不查工作区边界。

## 三、408 改法

- `tools/grep.ts` 内容结果按文件分组：每个文件先写一行路径，其下逐行"行号: 内容"（匹配行）与"行号- 内容"（上下文行），同一文件里不相连的段之间仍用 `--`，文件之间空一行；分组正文与末尾的说明之间空一行。排序（按路径、文件内按行号）与按匹配条数的上限（`tools.grep.maxResults`）不变：先按条数上限取出要列的部分，再按预算截。
- 字数预算：常量 `GREP_OUTPUT_BUDGET = 16_000`，按字符计列出的部分，不含末尾的说明。依据：`grep.maxResults` 缺省 200 条、每条约 80 字（常见代码行宽加行号前缀），不带上下文、行宽正常的搜索只受条数上限约束；带上下文或行很长的宽泛搜索（决策 408 记录的单次 4–13 万字、超过 1.2 万字的输出占 grep 总字数 39% 的那一类）在这里截住；约为 run_command 结果保留量（开头 8 KiB 加末尾 24 KiB）的一半。
- 超出预算时：结果里只放预算内的整行（路径行与它的第一行一起放，截在文件中途时这个文件只列已放下的行，末尾不留段间的 `--`）；末尾写明总匹配条数与有匹配的文件数（输出过大未统计完时写"至少"）、实际列出的文件数与条数，提示"宽泛的搜索请先用 files_only 只列文件，或缩小 path，再按文件细查"；条数上限以内的全文存进会话落盘目录，给出 `pigeon://outputs/<会话号>/<编号>` 与读法（条数上限截过时写明是前多少条匹配的全文）；存不成时写明原因。禁读、工作区外链接等略去的文件数照常注明。
- 存档复用 `tools/command-output.ts` 的 `CommandOutputStore.save`（决策 356 的会话落盘目录，决策 361 裁剪补落盘用的同一入口），装配根把 run_command 用的同一个 `outputStore` 经 `createSearchTools` 交给 grep（新增 `GrepToolOptions.outputs`）。没给落盘目录时（只在单元测试里）超出预算照样截断，只是不存全文。读法、身份核对与落盘总量上限都沿用原机制。
- `files_only` 的输出逐字不变（每行一个路径，说明紧随其后）。
- `GrepDetails` 新增 `files`（有匹配的文件数）、`overBudget`、`savedOutput`；`shown` 为结果里实际列出的匹配条数。上下文裁剪按 `total === 0` 认零命中，不受影响。
- `tools/search-backend.ts` 把略去文件数的说明拆成 `omittedNotes`，`resultNotes` 行为不变（glob 照用）。
- 工具说明改写结果格式的一句，加预算一句与"宽泛的搜索先用 files_only 只列文件，再按文件细查"。
- 文档：`docs/configuration.md` 的 `tools.grep.maxResults` 一行注明另有字数预算，读档工具一节末尾加分组格式与预算的说明。

## 四、测试与变异

测试照 `docs/testing.md`：测行为与契约、文案只测关键片段；变异只做关键判定。

- 407（`tools/write-file.test.ts` 新增一条，本机执行端）：未放权时 `write_file` 新建、replace 与 hashline 两版 `edit_file` 改写工作区以外的文件都报 `WorkspacePathError` 且带"越出工作区根"，什么也不建、不改；三件工具的说明只在放权时含 `OUTSIDE_WRITE_SENTENCE`；放权时新建（含中间目录）、本工具写过后覆盖、两版编辑都写到工作区以外。
- 407（`execution/container-write.test.ts` 新增一条，经本机执行的替身容器，仅 POSIX）：未放权时越出即拒、不建目录；放权时新建、覆盖、replace 编辑工作区以外的文件。
- 407 装配冒烟：`application/runtime-edit-mode.test.ts` 原有的"缺省 replace"一条在 `--yolo` 下运行，`edit_file` 的说明改为与 `replaceEditDescription(true)` 相等。
- 408（`tools/search.test.ts` 新增两条）：分组——每组首行为路径、路径各出现一次且有序，其余行均为"行号: 内容"，30 处匹配的文件一组 31 行，`files_only` 的输出等于各路径以换行相连；预算——3 个文件 300 处、每行约 100 字、条数上限 250：列出部分不超过预算，`total`、`files`、`overBudget` 为 300、3、真，列出条数少于 250，说明含"300 条匹配、3 个文件"与 `files_only`，给出的虚拟路径经 `readWindow` 读回的全文以列出部分开头、含 250 行匹配。
- 原有用例改到新格式：`tools/search.test.ts` 的三种后端一致性（逐字比对的上下文结果改为 `src/a.ts\n1- alpha foo\n2: beta\n3- foo:bar` 等）与文件名带冒号一条；`execution/container-search.test.ts` 的 busybox 降级一条。

变异（每项改一处、跑对应文件、再拷回原文件并以 `cmp` 核对逐字一致）：

| 编号 | 改动 | 结果 |
|---|---|---|
| M1 | `paths.ts` 解析已存在目标时忽略 `outside`（照旧判边界） | 407 新用例变红（放权时覆盖报越界） |
| M2 | `paths.ts` 新建路径忽略 `outside` | 407 新用例变红（放权时新建报越界） |
| M3 | `paths.ts` 解析已存在目标时去掉边界判定 | 407 新用例与 `edit-file.test.ts` 的路径逃逸一条变红 |
| M4 | `paths.ts` 新建路径去掉边界判定 | 407 新用例变红（POSIX 上另有原有的"新建越出工作区根拒写"一条，本机跳过） |
| M5 | 装配根 `outsideWrites` 恒为假 | `runtime-edit-mode.test.ts` 的 replace 一条变红 |
| G1 | 分组时每行前重复路径 | 分组、预算两条新用例与三种后端一致性一条变红 |
| G2 | 去掉预算判定 | 预算一条变红 |
| G3 | 不存全文 | 预算一条变红 |
| G4 | 说明里的总条数改用列出条数 | 预算一条变红 |
| G5 | `files_only` 的路径之间加空行 | 分组一条变红 |

测试量（按新增行计）：407 测试 84 行（其中替身容器一条 28 行），产品代码 166 行；408 测试 79 行，产品代码 202 行。

## 五、本机验证

- Vitest 只跑改动涉及的文件（`--maxWorkers=2`）：`tools/write-file.test.ts`、`edit-file.test.ts`、`replace-edit.test.ts`、`read-file.test.ts`、`search.test.ts`、`read-deny.test.ts`、`command-output.test.ts`，`application/runtime-edit-mode.test.ts`、`outside-read.test.ts`、`background-jobs.test.ts`，`pi-runtime/context-prune.test.ts`，`orchestration/roles-tools.test.ts`，`execution/container-write.test.ts`、`container-search.test.ts`，在 f446462 上一次跑完：14 个文件中 12 个通过、2 个整文件跳过，83 项通过、18 项跳过，没有失败。
- 本机（Windows）跳过、未经本机验证的：`execution/container-write.test.ts` 全文件（仅 POSIX，含 407 的替身容器新用例）、`search.test.ts` 里文件名带冒号一条（Windows 文件名限制）、不在仓库时 rg 与 `grep -r` 的一致性一条（本机没有 `grep -r` 后端）、`grep -r` 降级按 `/proc` 复核一条（本机没有 `/proc`）、`execution/container-search.test.ts` 的真容器用例（本机没有 Docker），以及 `write-file.test.ts` 里两条 POSIX 用例。
- `npm run check`（tsc）通过；`biome check` 对两次提交改动的 17 个源文件与测试文件通过，没有需要修的格式或规则问题。
- 未跑 `verify:full` 与真容器验收。

## 六、回报

分支 worktree-agent-aff7e93e97e880f32，代码 5364ac2（407）、f446462（408）。
407：yolo 时写工具不判工作区边界（本机与容器），余下规矩与报错不变。
408：按文件分组；预算 16,000 字（200 条×80 字）；超出截整行、给总条数与文件数、提示先只列文件，全文存落盘目录。
新测 4 条，变异 10 项变红；相关测试、tsc、biome 通过。
拿不准：替身容器用例本机未跑；replace 回执会带出工作区外文件两行（禁读名单不管写）。
