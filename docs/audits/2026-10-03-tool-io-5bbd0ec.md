# 工具输入输出（第二波 2c）审计

- 基线：5bbd0ec
- 分支：tool-io
- 范围：决策 356（命令输出头尾保留与全文落盘）、357（read_file 安全上限）、358（write_file 与命令长度）、366（编辑效率）。每件一组提交：356 为 c3070f2，357 为 b48aa24，358 为 451d415 与 32841ff（跑批条件的期望工具清单），366 为 d931253；前四个提交各自 `npm run lint` 与 `npm run check` 通过。

## 一、命令输出头尾保留与全文落盘（356，c3070f2）

现状：run_command 的输出由执行端的收集器（`tools/local-host.ts` 的 `createHeadCollector`，本地与容器实现共用）只留开头 32 KiB，其余丢弃，字节数与哈希按全量计；结果末尾注明"输出已截断：共 N 字节，保留前 M 字节"。

改法：
- 收集器加两个可选项（`HostExecOptions` 的 `tailBytes`、`fullOutput`）：给了 `tailBytes` 另留末尾、另计总行数；给了 `fullOutput` 且输出超过开头加末尾两段时，从超过的那一刻起把全量输出（含此前留在内存里的部分）写进宿主上的文件，至多 `fullOutput.maxBytes` 字节，超过即只写前面部分并标明。不给这两项时行为与原来一致（钩子、跑批器等其他调用方不受影响）。容器实现的输出同样在宿主一侧收集与落盘。
- run_command：缺省保留开头 8 KiB 与末尾 24 KiB（总量仍为 32 KiB）；只给了旧口径 `maxOutputBytes` 的调用方照旧只留开头。截断时结果为开头（截在最后一个换行处）、省略标注（共多少字节与行，保留开头几行与末尾几行，中间省略几行、几字节）、末尾（从第一个换行之后起）；存下了全文即另起一行写明总行数与虚拟路径 `pigeon://outputs/<编号>`，可用 read_file 按 offset 读取。执行证据加 `outputTail`、`outputLines`、`savedOutput`。
- 落盘目录：`.pigeon/state/outputs/<会话号>/<编号>.log`（`state/paths.ts` 的 `sessionOutputsDirOf`），随会话保存；编号接着目录里已有的最大编号，没截断不建文件。`tools/command-output.ts` 的 `CommandOutputStore`：写成一份后按总量上限从最旧的删起（刚写的不删），缺省每会话 200 MiB。
- read_file：路径以 `pigeon://` 开头即在路径判定之前处理，不经执行端、工作区内外与禁读判定，直接读会话落盘目录；只认 `pigeon://outputs/` 加正整数编号，其余写法（`..`、绝对路径、子路径、别的前缀、带扩展名）一律拒绝（`OutputPathError`，域错误）；编号不在（已被清理）同样报错并写明可能原因。
- 设置：新建 `tools` 一节（`state/tools-config.ts` 的 `ToolsSectionSchema`，小驼峰、按工具分子键），本件加 `tools.runCommand.outputHeadBytes`、`outputTailBytes`、`savedOutputsMaxBytes`；`settings.ts` 的 `runCommandOutputLimitsOf`。装配根为每个运行面建本会话的落盘目录，交给 run_command 与 read_file。
- 工具说明：run_command 说明里"输出（超长截断）"改为写明输出过长时自动保留开头与结尾、中间注明省略的行数、全文存为 `pigeon://outputs/<编号>` 可用 read_file 按需读取、不必自己用 tail、head 截取。
- `docs/configuration.md`：各节表加 `tools` 一行，新增"工具的上限"一节。

## 二、read_file 安全上限（357，b48aa24）

现状：read_file 一次至多 2000 行，没有字节上限与单行长度上限。

改法：逐行排版，累计正文字节超过上限即停（至少给一行），提示写明已达字节上限并照原有翻页提示给出续读的 offset；单行超过上限字符数即只显示前面部分（不切断代理对）并注明本行原长。缺省 50 KiB 与 2000 字符，可在 `tools.readFile.maxBytes`、`maxLineChars` 配置（`settings.ts` 的 `readFileLimitsOf`）。没碰到上限的读取输出与原来一致。details 在发生时另带 `truncatedLines`、`byteLimited`。hashline 模式下行标签仍按整行计算。

## 三、write_file 与命令长度（358，451d415）

现状：edit_file 只能改已存在的文件，没有建文件的工具；run_command 的命令最长 4000 字符。

改法：
- `tools/write-file.ts`：write_file（参数 `path`、`content`），新建文件或整体覆盖，内容原样写入。登记为写档、工作区围栏、串行（`runtime.ts`），受保护路径（项目 `.pigeon`）与写档审批随之按现有治理判定；加进主会话的工具清单。审批预览与执行共用同一段预检，给出改前改后的 diff（结果 details 带 `diff`，终端界面按此显示）。
- 读取记录（`tools/read-tracker.ts` 的 `FileReadTracker`）：按执行端解析后的规范路径，记最近一次成功读取时整个文件的 sha256 与字节数；任何一次成功读取（含分段读取）都算读过。覆盖已存在的文件须本会话读过，且现有内容的哈希与记录相同；不符即拒，回话写明"在你读过之后被改过（例如被命令改了），请先重新读取"。edit_file（两种模式）与 write_file 成功后按写成的内容更新记录。另有 `hasRead`、`forget` 供之后的上下文裁剪接上。记录只在运行面内存里，续接会话后须重新读取才能覆盖。
- 执行端：接口加两个可选方法（手拼的测试执行端可不实现，此时 write_file 报不支持）。`resolveForCreate`：目标已存在同 `resolveForWrite`（目标本身是符号链接即拒写）；不存在时按路径上最深的已存在一层的真实路径（须是目录）拼上其余各段，须仍在工作区根内。`createText`：照 334 复核路径上最深的已存在一层的真实路径仍是它自己，补建中间目录，以"不存在才建"写入，检查之后被别人建了即拒写、不覆盖。本地实现在 `tools/paths.ts`，容器实现为两段容器内脚本（`set -C` 写入）。覆盖已存在的文件走原有 `writeText`（334 的写前复核）。
- run_command 的命令长度上限 4000 改为 65536 字符（`RUN_COMMAND_MAX_CHARS`）。
- 会话检索的"改动过的文件"把 write_file 成功写入的 path 也算进去（`state/session-search-text.ts`）。
- 工具说明：新建或整体覆盖（限工作区内）；覆盖前须先在本会话用 read_file 读过且读后文件没有被改过，只改一部分用 edit_file；目录不存在会自动创建；目标是符号链接时拒写。系统提示未改。

合并时要接的点（本段未接）：
- worker 作用范围登记表（限路径，worker-tools 分支）：write_file 与 edit_file 一样登记限路径。现有的 implementer 角色工具清单（`orchestration/roles.ts`）与 worker 在自己工作树内写文件默认放行的名单（`application/governance.ts` 的 `OWN_WORKSPACE_WRITE_TOOLS`）也未加 write_file。
- 上游逐工具并行标记（tool-lock 分支）：write_file 标为串行。
- 设置的 `tools` 一节与 read-search 分支的同名一节（`grep`、`glob` 子键）合并；read_file 对 `pigeon://` 的识别须保持在 read-search 分支改过的路径判定之前。

## 四、编辑效率（366，d931253）

改法（只在缺省的 replace 模式）：
- edit_file 说明末尾加：对同一文件或几个文件的多处修改，可以在同一次回复里连发几个 edit_file，会按顺序执行；回执给出这处改动在新文件里的行区间与上下各两行。
- 回执在原有"已在 X 应用 1 处替换（+a −b 行）"之后写明新文件里的行区间，附上下各两行带行号（同 replace 模式 read_file 的 `行号| 内容`）的内容；改动多于 8 行时改动部分只列头尾各三行；纯删除写明删去处在新文件第几行之前并给出前后两行。

hashline 模式（非缺省）的说明与回执不变：其说明有"与决策 061 之前逐字一致"的测试。

## 跑批条件

跑批器的 Pigeon 条件经产品装配，实验条件跟随产品：各条件的工具清单多了 write_file；命令输出的头尾保留与全文落盘、read_file 的上限、编辑回执的行区间与上下文这几项行为同样随产品进入跑批条件。

## 现有测试的改动

- `src/tools/run-command-text.test.ts`：三处 run_command 工具说明的逐字断言改为测关键片段（shell 与审批的说法），随说明改写。
- `src/tools/replace-edit.test.ts`：两处回执的逐字断言改为测开头一段，随回执加行区间。
- `src/eval/stream-agents.test.ts`：四种 Pigeon 条件的期望工具清单补上 write_file（只改期望值）。

## 测试

- `src/tools/command-output.test.ts`（4 项）：超长输出留开头与末尾、省略的行数与留下的行数之和等于总行数、写明全文路径与总行数，read_file 按虚拟路径读到中间的一行，没超过的输出原样且不落盘；容器执行端（本机执行的替身容器）同样落在宿主的落盘目录并读回；虚拟路径的越界写法（含指向工作区根 `secret.log` 的 `..` 写法）一律拒绝；落盘总量满了删最旧的、留刚写的。
- `src/tools/read-file-limits.test.ts`（2 项）：到字节上限即停、按提示续读能把全部行各读到一次；超长行截断并注明原长，其余行照常，没碰到上限的读取没有续读提示。
- `src/tools/write-file.test.ts`（4 项）：新建含中间目录、之后可直接覆盖；覆盖须读过（分段读也算）、读后被改拒写、重读后可写；目标是符号链接拒写、链接与目标不变；4000 字符以上的命令照常执行。
- `src/application/write-file-protected.test.ts`（1 项）：配置放权在场、没有审批通道时，write_file 写 `.pigeon` 下的文件被拒，写普通文件照常。
- `src/tools/edit-receipt.test.ts`（2 项）：回执的行区间与上下两行；纯删除与改在文件开头。
- `src/application/edit-batch.test.ts`（1 项）：同一次回复里连发的两个 edit_file 按顺序生效，后一个基于前一个的结果。

变异（服务器，只做关键判定）：虚拟路径只查非空、不查编号格式 → 1 项变红；write_file 不查读过 → 1 项变红；不查读后未变 → 1 项变红；write_file 登记为读档 → 1 项变红；run_command 不留末尾 → 3 项变红；省略行数少减末尾行数 → 1 项变红；均还原后逐字一致。

## verify 的实际运行情况

服务器 pigeon-verify（8 vCPU、31 GB 内存、Node 24.12.0），提交 32841ff，一条前台命令依次跑完 `npm run lint`、`npm run check`、`node --test --test-concurrency=2 "src/**/*.test.ts"`（运行前另有六个测试进程在跑）、`npm run deps`，全过，全程约 276 秒。测试 1,641 项：通过 1,639，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：582 个模块，无违规。

## 补记：验收修正（44a7bee）

安全：
- 写类工具（edit_file 两种模式、write_file）的路径参数含换行或其他控制字符一律拒写（`tools/paths.ts` 的 `assertWritePathText`）。容器的两段新建脚本拆路径只用参数展开（`${d%/*}`、`${d##*/}`），不用命令替换；`readlink -f` 的结果补一个点再去掉以保住结尾换行，输出以 NUL 分隔；解析结果含控制字符即拒绝。此前 `$(basename …)`、`$(dirname …)` 会吃掉结尾换行，路径写成 `.pigeon` 加换行再加 `/x` 时，治理判为不受保护，脚本却写进 `.pigeon/x`。
- 容器的 `resolveForCreate` 不再按词法折叠 `..`：模型给的路径原样交给容器，最深的已存在一层用 `readlink -f` 按内核顺序解析，与受保护路径的容器判定同一口径；尚不存在的各段含空段、`.` 或 `..` 即拒绝。此前有链接 `l→a/b` 时，`l/../.pigeon/x` 被判在 `a/.pigeon` 下，实际却写进 `.pigeon/x`。本机实现照旧词法先行，与本机的受保护路径判定一致。
- 落盘目录：从治理根的 `.pigeon` 起到落盘文件逐级 lstat，任何一级是链接即拒绝读写；读落盘文件用 `O_NOFOLLOW` 打开；收集器新建落盘文件用独占创建（`O_CREAT | O_EXCL`，另加 `O_NOFOLLOW`）。落盘目录不可用时命令照常执行，结果注明全文未能保存及原因。

正确性：
- 收集器的建目录、打开、写入、关闭出错时停止落盘、关掉文件，照常给出开头与末尾，结果带 `fullOutputError`，run_command 结果注明"全文未能保存（原因），只有上面的开头与末尾"（执行证据 `savedOutputError`）；本机与容器共用这一处。
- 命令长度：参数的字符上限（65536）之外，执行前按执行端与平台判能否交给进程（`commandTooLong`）：非 Windows 执行端按 UTF-8 至多 124 KiB（Linux 单个参数 128 KiB），宿主或执行端为 Windows 时命令行至多 32000 字符、经 cmd.exe 至多 8000 字符；超出即给模型明确的工具错误（域错误），建议先用 write_file 写成脚本再运行，不拉进程。
- 虚拟路径带会话号：`pigeon://outputs/<会话号>/<编号>`；read_file 只认本会话与分叉来源一路往上的会话（沿会话文件头的父会话，遇到 worker 会话即停，至多 20 层，用到时才查），别的会话的编号明确报错。工具说明与 `docs/configuration.md` 随之写成带会话号的形式。
- read_file 在 offset 校验通过、读取成功后才记读取；读取记录对文件字节算 sha256（执行端接口加可选的 `readBytes`，两个实现都有）。write_file 的审批预览按行比对（`lineDiff`：去掉公共首尾后按最长公共子序列分段，中间段过大时整段算一处），分散的改动各成一段。开头与末尾按字节截取后对齐 UTF-8 字符边界。分页读落盘文件时流式读、只留需要的那段行（全文哈希同时算出）。超长行截断的注明写明其余部分可用 run_command 按字符截取。

测试：
- `src/tools/command-output.test.ts`（7 项）：在原有各项上改用带会话号的虚拟路径；另验别的会话的编号报错、分叉来源的可读；落盘目录被换成链接时读取拒绝、下一次长输出注明未能保存且链接目标不被写，落盘文件本身是链接时读取拒绝；淘汰后剩下的总量不超过上限；收集器在分块到达、首次超限发生在第 5 块时落盘内容与输出逐字节一致，超过写入上限时只写前面部分并标 partial；落盘打不开时照常给出头尾与原因，头尾不含 U+FFFD。
- `src/tools/write-file.test.ts`（另加 5 项）：路径含换行、制表符、NUL 拒写且什么也不建；新建越出工作区根拒写，检查之后被别人建了不覆盖，检查之后路径上的目录被换成链接拒写；失败的读取不算读过，不同的非法字节之间的改动看得出；逐行比对把分散的两处改动分成两段；超出执行端长度的命令给出提到 write_file 的工具错误且未执行，Windows 经 cmd.exe 与直接执行的上限判定。
- `src/execution/container-write.test.ts`（4 项，替身容器）：新建含中间目录与读后覆盖；`l/../.pigeon/x` 落在 `a/.pigeon/x`，已存在的 `l/../f.txt` 解析到 `a/f.txt`，`new/../x` 拒绝；路径含换行拒绝且什么也不建；检查之后被别人建了不覆盖，路径上的目录被换成链接拒写。

变异（服务器）：write_file 不查控制字符 → 1 项变红；容器不查解析结果的控制字符 → 1 项变红；容器按词法折叠 `..` → 1 项变红；落盘目录不查链接 → 1 项变红；均还原后逐字一致。

verify：服务器 pigeon-verify，提交 44a7bee，一条前台命令依次跑完 `npm run lint`、`npm run check`、`node --test --test-concurrency=2 "src/**/*.test.ts"`（运行前另有两个测试进程在跑）、`npm run deps`，全过，全程约 222 秒。测试 1,653 项：通过 1,651，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：583 个模块，无违规。
