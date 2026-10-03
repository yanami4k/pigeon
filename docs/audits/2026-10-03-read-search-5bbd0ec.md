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
