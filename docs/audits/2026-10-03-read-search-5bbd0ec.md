# 工作区外只读与 grep、glob 读档工具 审计

- 基线：5bbd0ec
- 分支：read-search
- 范围：决策 355（工作区外只读）、决策 368（grep 与 glob 读档工具）。两组提交，每组一件：4acee69（一）、18a03f8（二）。

## 一、工作区外只读（决策 355）

现状：`read_file` 经执行端的 `resolveExisting` 解析路径，解析后越出工作区根即拒（本机按 realpath，容器里按 `readlink -f`）；读档工具在非放手模式下自动放行；没有禁读名单。

改法：
- `tools/read-deny.ts`：内置禁读名单 `BUILTIN_READ_DENY`——`~/.ssh`、`~/.aws`、`~/.azure`、`~/.config/gcloud`、`~/.kube`、`~/.docker/config.json`、`~/.netrc`、`~/.git-credentials`、`~/.npmrc`、`~/.pypirc`，以及 Pigeon 存放凭据之处：用户级设置 `~/.pigeon/settings.json`（经 `state/paths.ts` 的 `userPigeonRel` 取写法；mcp 一节里服务的 `env` 可能带令牌，key 本身只走环境变量）。判定按符号链接解析后的真实路径：目标的真实路径等于某一项或落在其下即拒；每一项取展开 `~` 后的字面路径，它存在时另取其真实路径。拒读抛 `ReadDeniedError`（`WorkspacePathError` 的子类，归模型侧的域错误）。工作区内外一律生效。
- 执行端接口加两个可选方法：`resolveForRead(inputPath, deny)` 给出真实路径与是否落在工作区根之外；`readDenyWithin(deny)` 给出名单里落在工作区根之内的部分（相对写法，工作区根本身在名单内时为 `.`）。本机实现的家目录可注入（缺省 `os.homedir()`）；容器实现一次 exec，经 `trustedShell` 运行固定脚本（参数传入、输出以 NUL 分隔），`~` 按容器内的 `$HOME` 展开，判定用 posix 口径。没有实现这两个方法的执行端，读档只限工作区（照 `resolveExisting`），不判禁读名单。
- `read_file`：改经 `resolveForRead` 解析；工作区以外的读取须由治理层按调用授予（`authorizeOutsideRead`，一次一用），未授予即抛 `OutsideReadNotApprovedError`（`WorkspacePathError` 的子类，文案保留"路径越出工作区根"）。新增只读检查 `inspectOutsideRead`（解析后在工作区外时给出真实路径；在工作区内、不存在、禁读或解析不了时不给）。说明按审批状态生成（`OutsideReadMode`）：放手为"读取文本文件。……工作区以外的文件也可读（用绝对路径），只读、不能改；凭据目录（如 ~/.ssh）不可读。"；非放手为同一句加"须经人批准（可按目录放权）"；无人值守时说明原文不变。
- 策略（`tools/policy.ts`）：`evaluateToolPolicy` 加第 5 个参数 `context.outsideWorkspaceRead`；为真时 read 档在 prompt 模式下不自动放行，改为要人工批准。排律前几档（拒绝名单、放权、免审批、yolo）不变。
- 治理（`application/governance.ts`）：审批之前做只读检查，结果交给策略；放行的各条途径——放权（会话与配置）、yolo、PreToolUse 钩子放行、人工批准——都按调用授予工具（与需经 shell 的命令同一口径，钩子放行算批准）；没有审批通道时拒绝，理由为"读工作区以外的文件须经人批准，本次运行没有审批通道，拒绝：<路径>"；审批请求带 `outsidePath`。
- 审批面板：`ApprovalRequest.outsidePath`；命令行与终端界面的面板各加一行"工作区以外（只读）：<真实路径>"（`approvals/handler.ts` 的 `outsidePathLine`）。放权照现有写档方式：`[y]` 单次、`[d]` 按调用所在目录（`dirname`，目录包含按 realpath 判，绝对路径同样匹配）、`[a]` 按工具；容器工作区不提供 `[d]`（原有规则）。
- 设置：`permissions.readDeny`（字符串数组，须 `~` 开头或绝对路径，schema 的 pattern 校验）；三层并集（`mergeSettingsLayers` 收进 `merged.readDeny`），`readDenyOf` 取值。只能往内置名单上加，不能删减；只收紧不放权，不进配置确认。
- 装配（`application/runtime.ts`）：本机执行端带 `deps.homeDir`；`read_file` 的 `outsideReads` 按审批状态取（放手为 allowed、有审批通道为 approval、无审批通道为 refused），`readDeny` 取设置。
- 写与编辑：不改，仍经 `resolveForWrite` 限工作区。
- `docs/configuration.md`：合并规则一句补 `readDeny` 的并集；各节表 `permissions` 一行补 `readDeny`；新增"读档工具：工作区外只读与禁读名单"一节，写明禁读名单只管读档工具，`run_command` 经 shell 读文件不在此列（由命令审批把关）。

测试：
- `src/tools/read-deny.test.ts`（2 项，本机执行端）：工作区内外的解析结果；禁读的直接命中、经工作区里的符号链接、禁读项本身是符号链接时的指向处都拒；设置追加项生效、不追加时同一文件可读；内置项总在；工作区就是家目录时工作区内的禁读同样拒，`readDenyWithin` 给出相对工作区根的前缀。
- `src/application/outside-read.test.ts`（4 项，真实 pi-agent-core Agent + 审批闸）：放手模式工作区外读取自动放行并读到内容、禁读文件拒、`edit_file` 改工作区外文件被围栏拒绝且文件未变；非放手模式工作区内不问人、工作区外问人（面板带真实路径）、拒绝即不读、`[d]` 后同目录不再问（记 `human:grant`）；PreToolUse 钩子放行记 `policy:hook` 且不问人；无人值守时记 `policy:deny`、理由带路径、工具不执行，工作区内照常。
- `src/execution/container-read.test.ts`（真容器 busybox，1 项）：容器内路径判工作区外；禁读名单按容器内的家目录展开，直接命中、经工作区里的链接、`~/.aws` 是链接时的指向处都拒；`readDenyWithin` 为空；未授予拒读，授予一次读到内容。

变异（服务器，提交 18a03f8，逐个改坏、只跑对应测试文件，均还原后工作树干净）：

| 变异 | 结果 |
| --- | --- |
| M1 禁读项本身是链接时不取其真实路径 | `read-deny.test.ts` 1 项变红 |
| M2 本机按字面路径判禁读（不解析链接） | `read-deny.test.ts` 1 项变红 |
| M3 容器里按字面路径判禁读 | `container-read.test.ts` 1 项变红 |
| M4 策略层对工作区外读取照样按只读工具自动放行 | `outside-read.test.ts` 3 项变红（非放手、钩子放行、无人值守） |
| M5 治理层不报工作区外读取 | `outside-read.test.ts` 3 项变红（同上） |

## 二、grep 与 glob 读档工具（决策 368）

现状：没有专门的搜索工具，模型用 `run_command` 跑 grep、find；非放手模式下每条命令要审批，本机 Windows 走 cmd.exe，没有 grep。

改法：
- 后端（`tools/search-backend.ts`）：依次探测 ripgrep（本机先试随包附带的二进制，再试 PATH 上的 `rg`；容器里只用容器自己的）、git（`git rev-parse --is-inside-work-tree` 为 true 时）、grep（`grep -V` 判是否 GNU）；一次会话内探测一次，grep 与 glob 共用。经执行端的 `exec` 运行，环境变量用 `run_command` 的白名单（`allowedEnv`），参数一律以数组传递、`verbatim` 为 false，不经 shell；模式以 `-e` 给出，路径放在 `--` 之后，git 用 `:(literal)` 路径，find 的起点加 `./`（以 `-` 开头的目录名不被当成表达式）。
- 各后端的参数：rg 为 `--no-config --hidden --glob !.git --no-heading --with-filename --line-number --null --color never --no-messages`；git 为 `-c core.quotepath=off grep --no-color -I --untracked -E -n -z`，内容模式加 `--column`（`-z` 下匹配行与上下文行都以 NUL 分隔，靠列号字段区分）；GNU grep 为 `-r -n -H -s -E -I -Z --exclude-dir=.git`；不支持 `-Z` 的 grep（busybox）为 `-r -n -H -s -E`，输出按"路径:行号:内容"解析，结果另滤 `.git`。glob 的文件清单依次用 `rg --files`、`git ls-files -z --cached --others --exclude-standard`、`find … -name .git -prune -o -type f -print`。
- `.gitignore`：rg 与 git 只在 git 仓库里遵守；不在仓库里时三种后端都不按它过滤（rg 缺省如此），口径一致。
- rg 的 `-g` 会盖过忽略规则（实测 `-g '*.log'` 搜出被 `.gitignore` 忽略的文件），故只在模式末段是简单文件名时用 `--type-add` 预筛（不盖过忽略规则），只为提速。
- 统一处理（后端只给候选与原始匹配）：文件名模式（`tools/glob-match.ts`：`*` 不跨目录，`**` 跨任意层，`?`、`[...]`、`[!...]`、`{a,b}`、`\` 转义）；禁读名单（`readDenyWithin` 的前缀，滤掉并在末尾注明"已按禁读名单略去 N 条"）；排序；上限；单行截到 2,000 字符（注明"本行截断"）。有上下文时段与段之间的 `--` 由工具按行号重建，不依赖后端。
- `grep`：参数 `pattern`、`path`（限工作区，经路径围栏）、`glob`（不含 `/` 比文件名，含 `/` 比相对 `path` 的路径）、`context`（0–50）、`files_only`、`ignore_case`；结果按路径排序，每行"路径:行号:内容"（上下文行用 `-`）；上限取 `tools.grep.maxResults`（缺省 200，`files_only` 时计文件数），超出给出总数并提示缩小范围；输出超过 8 MiB 时注明"超过 N 条匹配（输出过大，未统计完）"；降级到 git grep 或 grep -r 时结果开头注明"本次用 git grep / grep -r 搜索（扩展正则）"；说明末尾写明 pattern 用扩展正则（ERE）写法最稳，`\d`、`\w` 可写成 `[0-9]`、`[A-Za-z0-9_]`。
- `glob`：`pattern` 相对 `path`（缺省工作区根，须是目录）匹配；按修改时间从新到旧，同一时间按路径；修改时间取自新增的可选执行端方法 `fileMtimes`（本机 `fs.stat` 分批；容器经标准输入以 NUL 分隔交给 `xargs -0 stat -c '%Y %n'`）；上限取 `tools.glob.maxResults`（缺省 100）。Windows 本机没有 rg 与 git 时不降级到 find（那里的 find 是另一个程序），报环境错误。
- 错误归类：模式有误、`path` 不是目录为 `SearchToolError`（域），没有搜索程序、超时、后端出错为 `SearchEnvironmentError`（环境），以 `pigeonToolErrorKind` 标记。
- 登记（`tools/search-tools.ts`）：`READ_ONLY_SEARCH_TOOLS` 为只读工具的登记点（tier `read`、`executionMode` `parallel`、`pathConfinement` `workspace`），两件共用一次后端探测；`runtime.ts` 在 `run_command` 之后注册并广告。worker 角色的预设清单未加。跑批里的 Pigeon agent 四个条件都带这两件；身份头的 core 不记工具清单或其摘要，未加；跑批器代码版本记在 `info.harness`，代码冻结后续跑时版本不符即拒绝（`checkHarness`）。
- 设置：新节 `tools`（`state/tools-config.ts`：`grep.maxResults`、`glob.maxResults`，整数且不小于 1），`searchLimitsOf` 取值；按对象逐层合并。
- 依赖：`@vscode/ripgrep` 1.18.0（MIT；按平台拆成可选依赖，平台子包同为 MIT，内含 ripgrep 15.0.0 的二进制，ripgrep 上游为 MIT 或 Unlicense）。核实：主包与平台子包的 package.json 都没有 `scripts`；主包只按平台解析二进制路径（平台子包缺失时导入即抛错，Pigeon 捕获后降级）；锁文件里这组条目没有 `hasInstallScript`；服务器上在断网（`--network none`）的容器里，按只含该依赖的锁文件从缓存 `npm ci --offline`（安装脚本照常开着）装上主包与 linux-x64 子包，`rg --version` 正常。
- `docs/configuration.md`：各节表加 `tools` 一行；读档一节补禁读路径在 grep、glob 结果里的过滤与条数说明，另加一段后端与 `.gitignore` 的口径。

测试：
- `src/tools/search.test.ts`（4 项）：后端一致性两项——git 仓库里 rg 与 git grep、不在仓库里 rg 与 grep -r，7 个 grep 查询与 3 个 glob 查询的结果逐字一致；隐藏文件在、以 `-` 开头的目录在、`.git` 不在、`.gitignore` 只在仓库里生效；上下文输出；带 shell 特殊字符（`;`、`>`、反引号、`$(`）的模式命中原行且没有执行任何命令；以 `-` 开头的模式与目录；glob 按修改时间。上限与总数提示一项（grep、`files_only`、glob），连同禁读路径滤掉与条数（工作区即家目录）。文件名模式语义一项。机器上缺后端时跳过。
- `src/execution/container-search.test.ts`（真容器，2 项）：busybox 的 grep -r 与 find 降级；带 rg 与 git 的镜像里，git 仓库的 rg 与 git grep、不在仓库的 rg 与 grep -r；结果都与本机同一棵树上 rg 的结果逐字一致。
- 夹具 `src/tools/search-fixtures.ts`：本机与容器共用的文件树、查询与取结果的辅助（容器里建树时路径与内容以参数传入，修改时间用 `touch -t`）。

变异（同上）：

| 变异 | 结果 |
| --- | --- |
| M6 后端参数拼成一条 shell 命令串交给 `sh -c` | `search.test.ts` 2 项变红（两项一致性） |

## 改动过的现有测试

- `src/application/runtime-edit-mode.test.ts`：`HASHLINE_READ_DESCRIPTION` 的逐字基准。该文件的运行为放手模式，`read_file` 说明开头由"读取工作区内文本文件。"改为"读取文本文件。"，末尾加工作区外的一句。
- `src/eval/stream-agents.test.ts`：`PIGEON_STREAM_TOOLS` 四个条件都加 `glob`、`grep`。

其余现有测试未改。

## verify 的实际运行情况

在服务器 pigeon-verify（8 vCPU、31 GB；Node 24.12.0、git 2.43.0、Docker；镜像 `busybox:latest` 与通用沙箱镜像只读使用）上运行：

- 提交 18a03f8：`npm ci` 后，`npm run lint` 无问题；`npm run check` 无错误；`node --test --test-concurrency=3 "src/**/*.test.ts"`：1,640 项，通过 1,638，失败 0，跳过 2（两项只在 Windows 上运行的用例）；`npm run deps`：586 个模块，无违规。四步合计 167 秒。真容器用例实际运行，未跳过。
- 提交 4acee69 单独检出：`biome check`、`tsc --noEmit`、`depcruise` 通过；第一件相关的 6 个测试文件 29 项全部通过。
- 变异均在提交 18a03f8 上运行，见上两表；运行后测试建的容器均已删除。

## 验收修复（提交 6d7a5e3）

### 禁读名单的路径归一（决策 355）

现状：本机按 JS 版 `realpathSync` 取真实路径、按字符串 `relative` 判包含。Windows 上 `\\?\C:\…\.ssh\id_rsa`（`relative` 得到绝对路径，判成不在名单内）、8.3 短名（`SSH~1\id_rsa`）、数据流写法（`.netrc::$DATA`）可绕过禁读名单；包含关系区分大小写。

改法（`tools/read-deny.ts`）：
- 本机取真实路径改用系统的 realpath（`realpathSync.native`），目标、工作区根与名单各项同一口径；Windows 上短名、大小写与 `\\?\` 前缀归一到同一写法。
- 包含关系按执行端的比较口径判定（`PathRules`）：本机在 Windows 与 macOS 上不分大小写（`LOCAL_PATH_RULES`），容器按 posix、区分大小写（`POSIX_PATH_RULES`）。
- Windows 上设备前缀（`\\?\`、`\\.\`、`\??\`，正反斜杠都算）与数据流写法（盘符之后再出现冒号）不经解析直接拒绝，抛 `UnsupportedPathFormError`（`WorkspacePathError` 的子类）。

### grep、glob 的路径与结果过滤（决策 355、368）

现状：`path` 参数只经路径围栏；结果按"名单落在工作区内的前缀"做区分大小写的前缀比对（`readDenyWithin`、`underDeniedPrefix`）。工作区包含家目录时，`path` 写成 `.SSH`、`SSH~1` 可把私钥内容搜出；busybox 的 `grep -r` 跟随指向文件的符号链接，能读出工作区外与禁读的文件。

改法：
- `searchStart` 照读档的规则解析 `path`（`resolveForRead`：真实路径、禁读名单、Windows 写法），落在禁读名单内（`ReadDeniedError`）或工作区外即拒。
- 每条结果按真实路径分类：执行端新增可选方法 `classifyReadPaths(relPaths, deny)`，返回 `ok`、`denied`、`outside`（取不到真实路径的不在结果里）。本机逐条 `realpathSync.native`；容器一次 exec：经 `trustedShell` 运行固定脚本，名单各项照前解析，待查路径经标准输入以 NUL 分隔交给 `xargs`，逐条 `readlink -f`。三种后端的结果一律经 `screenByRealPath` 过滤：禁读的计入 `deniedOmitted`，经链接落在工作区外的计入新增的 `outsideOmitted`，末尾分别注明"已按禁读名单略去 N 条""已略去指向工作区以外的 N 条"。删去 `readDenyWithin`、`denyWithinRoot`、`underDeniedPrefix`。

### 搜索后端的执行通道（决策 368）

现状：后端经 `host.exec` 运行，即 agent 命令的执行通道：容器里程序按镜像的 PATH 解析，git 读系统、全局与仓库配置，ripgrep 读 `RIPGREP_CONFIG_PATH`。

改法：
- 执行端新增可选方法 `execHelper(program, args, options)`，供 Pigeon 自己的只读辅助程序使用。本机：环境经 `helperEnv` 处理（系统目录放到 PATH 最前，Windows 照旧；去掉 `RIPGREP_CONFIG_PATH`；`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`）。容器：经 `trustedShell`（系统目录在前，屏蔽 git 的全局与系统配置）运行固定脚本 `unset RIPGREP_CONFIG_PATH; exec "$@"`，程序与参数按位置传入。两路输出各自留到 `maxOutputBytes`（内部函数加分流上限参数，`exec` 的行为不变）。`SYSTEM_PATH` 移到 `tools/workspace-host.ts`，容器执行端改为引用。
- 本机的 ripgrep 只用随包二进制的绝对路径，不再退到 PATH 上的 `rg`；容器里用系统 PATH 上的 `rg`。
- git 的每次调用加 `-c core.fsmonitor=`（仓库配置里的 fsmonitor 会执行程序）。
- 探测后端时退出码 126、127 按"程序不存在"处理（容器里经 shell 包装执行，找不到程序为 127）。
- 执行端没有 `execHelper` 时 grep、glob 报环境错误。

### 其余正确性

- ripgrep 加 `--no-ignore-dot` 与 `--no-ignore-global`：不读 `.ignore`、`.rgignore` 与全局 gitignore，与 git（不读全局配置）的口径一致。
- 结果只解析 stdout（此前解析的是 stdout 与 stderr 按到达顺序合并的输出），错误信息取自 stderr。
- 文件名模式写错（如 `[z-a]`）抛 `GlobPatternError`（归模型侧的域错误），不再抛 `SyntaxError`；grep 与 glob 在运行后端之前先编译模式。

### 文档

`docs/configuration.md`：写明无人值守运行时，设置里固化的 `read_file` 放权照样放行工作区外读取（它就是人事先给的批准，与写档的放权同一口径）；写明本机用系统 realpath、Windows 与 macOS 不分大小写、Windows 的设备前缀与数据流写法直接拒绝；`grep`、`glob` 的 `path` 落在名单内即拒、结果逐条按真实路径过滤；硬链接无法一般地识别，是已知限制；搜索后端不走 agent 执行通道的做法。

### 测试

- `src/tools/read-deny.test.ts`：第二项改为测逐条分类（可读、禁读、经链接落在工作区外、已删除的不在结果里）。新增一项比较口径的纯函数测试（不分大小写时，`.SSH` 下的文件算落在 `~/.ssh` 之内，区分大小写时不算），任何平台都运行。新增一项 Windows 专项：大小写写法、8.3 短名（卷上开着短名时）、`\\?\`、`\\.\`、`//?/` 前缀、`::$DATA` 与 `:stream` 写法；grep 的 `path` 写成 `.SSH` 即拒，搜整个家目录时 `.ssh` 下的结果逐条滤掉并计数。别处显式跳过，跳过原因"只在 Windows 上有这些路径写法"。
- `src/tools/search.test.ts`：上限一项改测 `details` 的 `total`、`shown`、`deniedOmitted`，不逐字测文案；加"`path` 经链接指向禁读目录即拒"；git 仓库的夹具在 `.git` 下放一个含 `foo` 的文件，断言搜不到（此前的"没有 .git"在没有这类文件时恒真）；加非法模式归 `GlobPatternError`。
- `src/application/outside-read.test.ts`：面板文案的逐字比对改为断言审批请求里的 `outsidePath`。
- `src/execution/container-read.test.ts`：`readDenyWithin` 的断言改为测容器里的逐条分类。
- `src/execution/container-search.test.ts`：新增 busybox 跟随链接一项——工作区里放指向禁读文件与工作区外文件的链接、`.git` 下放含 `foo` 的文件，`grep -r` 的结果只剩工作区内的一条，`deniedOmitted` 与 `outsideOmitted` 各为 1。

变异（提交 6d7a5e3，逐个改坏、只跑对应测试，均还原后工作树干净）：

| 变异 | 运行处 | 结果 |
| --- | --- | --- |
| M7 本机取真实路径换回 JS 版 `realpathSync` | Windows 本机 | Windows 专项变红 |
| M8 不拒收设备前缀与数据流写法 | Windows 本机 | Windows 专项变红 |
| M11w grep、glob 的结果不逐条按真实路径过滤 | Windows 本机 | Windows 专项变红 |
| M9 不分大小写的平台照样区分大小写 | 服务器 | 比较口径一项变红 |
| M10 grep 的 `path` 不判禁读 | 服务器 | `search.test.ts` 上限一项变红 |
| M11 grep、glob 的结果不逐条按真实路径过滤 | 服务器 | busybox 跟随链接一项变红 |

原有的 M1–M6 同在提交 6d7a5e3 上重跑，均照旧变红（M3 的改动点改为 `POSIX_PATH_RULES` 的写法，M6 改为经 `execHelper` 交给 `sh -c`）。

### verify

- 服务器 pigeon-verify，提交 6d7a5e3：`npm run lint` 无问题；`npm run check` 无错误；`node --test --test-concurrency=3 "src/**/*.test.ts"`：1,643 项，通过 1,640，失败 0，跳过 3（两项只在 Windows 上运行的 `.cmd` 用例与本节的 Windows 专项）；`npm run deps`：586 个模块，无违规。四步合计 209 秒。真容器用例实际运行，未跳过。
- Windows 本机（Node 24.12.0）：只运行 `read-deny.test.ts` 的 Windows 专项，通过；8.3 短名一项实际测到（卷上开着短名）。

## 复核修复（提交 f59afc7）

### 输出无歧义与结果归属（决策 368）

现状：busybox 的 `grep -r` 输出没有 NUL 分隔，按第一处"冒号数字冒号"切出路径：名为 `a.txt:1:x`、指向私钥的链接被跟随读到时，私钥内容记到 `a.txt` 名下、按 `a.txt` 判成可读而交出；文件名带换行时，按行切分同样错位。

改法（`tools/search-backend.ts`，取结果与筛选集中到 `runGrep`、`runListing`）：
- rg：内容搜索用 `--json`（路径、行号、内容各为 JSON 字段；非 UTF-8 的文件名按不安全的名字处理），只列文件名用 `--null`。
- git：先以 `git ls-files -z` 列出范围内的文件，名字含换行或控制字符的以 `:(exclude,literal)` 排除在搜索之外并计数；`git grep -z` 的输出因此不含这类路径。
- grep -r 降级改为两段式：`find -print0` 列出普通文件（不列链接）→ 按文件名模式与 `.git` 过滤 → 按真实路径筛 → 允许的文件经标准输入逐行交给固定脚本，逐个 `grep -h`（GNU 另加 `-I`）；每个文件前输出一行分隔（`\x01`、本次 8 字节随机数的十六进制、空格与文件名），归属按分隔行记，文件内容伪造不了分隔行。
- 三种后端的结果都经 `screenFiles`：文件名含换行或控制字符的略去，计入 `unsafeOmitted`；超出 20,000 个或检查超时、中止而未经检查的略去，计入 `uncheckedOmitted`；禁读的与经链接落在工作区外的分别计入 `deniedOmitted`、`outsideOmitted`。略去一律按文件计；末尾说明为"已按禁读名单略去 N 个文件""已略去经链接指向工作区以外的 N 个文件""已略去文件名含换行或控制字符的 N 个文件""N 个文件未及按真实路径检查（文件过多或检查超时），已略去，结果不完整"。git 与 grep -r 计入范围内所有名字不安全的文件，rg 计入其中有匹配的。
- 执行端没有 `resolveForRead` 或 `classifyReadPaths` 时，grep、glob 报环境错误（失败即拒），不再照路径围栏解析或不过滤。
- 识别 GNU grep 改为匹配 `(GNU grep)`；Windows 本机不用 grep -r 降级（要 `/bin/sh`）。
- 文件名里的反斜杠只在 Windows 执行端上按分隔符处理。

### UNC 路径（决策 355）

现状：`\\localhost\C$\…\.ssh\id_rsa` 经系统 realpath 后仍是 UNC 写法，名单比对不中，只判成工作区外，放手模式下读出。

改法（`tools/read-deny.ts`）：Windows 上以两个斜杠或反斜杠开头的写法（UNC 与设备前缀）一律拒收，抛 `UnsupportedPathFormError`；解析后的真实路径为 UNC 写法的同样拒读；grep、glob 的结果分类时记作工作区外。

### 辅助程序的解析（决策 368）

现状：本机 `execHelper` 把裸程序名交给进程启动，由 PATH 查找。实测：Node 在 Windows 上以 `shell: false` 启动程序时不在当前目录查找（只放在当前目录里的程序报 ENOENT）；PATH 里的相对目录（如 `.`）或落在工作区之内的目录，会让工作区里放好的同名程序被执行。

改法（`tools/local-host.ts` 的 `resolveHelperProgram`）：启动前在 PATH 的绝对目录里把程序解析成绝对路径，跳过空项、相对目录与真实路径落在工作区之内的目录；Windows 只认 `.exe`、`.com`；找不到按程序不存在（`ENOENT`）处理。给了绝对路径的照用（随包的 ripgrep、`/bin/sh`）。

### 检查的批量、超时与上限

- 容器：分类脚本按 500 个一批；有 GNU `realpath -z -m` 时整批一次，没有时（busybox）逐个 `readlink -f`；输出带批标记，按批对齐。超时或输出被截断时标明不完整，未查到的计入 `uncheckedOmitted`，不再静默丢弃。
- 本机：分类改为异步（`fs/promises` 的 realpath，与系统 realpath 同一语义），每批 64 个并发，批与批之间看中止信号；20,000 个的上限由 `screenFiles` 统一施加。
- `classifyReadPaths` 加中止信号参数，返回 `{ classes, incomplete }`；`execHelper` 可带标准输入。

### 文档

`docs/configuration.md`：补 UNC 拒收、逐个文件过滤与各类略去、20,000 个的检查上限、辅助程序先解析成绝对路径、三种后端的无歧义输出。

### 测试

- `src/tools/read-deny.test.ts`：Windows 专项补 `\\localhost\…`、回环地址的 UNC 写法、`//localhost/…` 三种 UNC 写法；新增 Windows 一项——PATH 最前放 `.` 与工作区目录，工作区里放一个同名 `git.exe`（系统 `where.exe` 的副本），解析结果不在工作区内，后端探测仍认出真正的 git；分类一项跟着新的返回形态改。
- `src/tools/search.test.ts`：新增"文件名带冒号或换行"一项，rg、git、grep -r 三种后端各跑一遍（工作区即家目录，含名字带冒号的普通文件、名字带冒号且指向私钥的链接、名字带换行的文件）：结果行归属准确，私钥与换行文件的内容不出现，`total`、`unsafeOmitted`、`deniedOmitted` 分别为 2、1、1；新增"rg 不读 .ignore"一项。
- `src/execution/container-search.test.ts`：busybox 一项改为两段式的场景——名字带冒号、指向私钥的链接，指向工作区外的链接，`.git` 里的文件，名字带换行的文件；结果只有 `a.txt:1:foo here`，`total` 为 1，`unsafeOmitted` 为 1。
- `src/execution/container-read.test.ts`：分类断言跟着新的返回形态改。

变异（提交 f59afc7，逐个改坏、只跑对应测试，均还原后工作树干净）：

| 变异 | 运行处 | 结果 |
| --- | --- | --- |
| M12 不拒收 UNC 路径（输入与解析后两处一并去掉） | Windows 本机 | Windows 专项变红 |
| M13 本机辅助程序不解析成绝对路径 | Windows 本机 | 辅助程序一项变红 |
| M14 grep -r 降级不按真实路径筛就逐个搜 | 服务器 | 冒号与换行一项变红 |
| M15 不识别文件名里的换行与控制字符 | 服务器 | 冒号与换行一项、busybox 一项变红 |

前两轮的 M1–M11（含 Windows 本机的 M7、M8、M11w）同在提交 f59afc7 上重跑，均照旧变红；M10 的改动点改为解析 `path` 时传空名单，M11 与 M11w 改为一律放行。

### verify

- 服务器 pigeon-verify，提交 f59afc7：`npm run lint` 无问题；`npm run check` 无错误；`node --test --test-concurrency=2 "src/**/*.test.ts"`（服务器上另有两路测试在跑）：1,646 项，通过 1,642，失败 0，跳过 4（两项只在 Windows 上运行的 `.cmd` 用例与两项 Windows 专项）；`npm run deps`：586 个模块，无违规。四步合计 315 秒。真容器用例实际运行，未跳过。
- Windows 本机：只运行 `read-deny.test.ts` 的两项 Windows 专项，通过（PATH 里有 git，8.3 短名一项实际测到）。
