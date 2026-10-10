# 撤掉读档工具的凭据禁读名单

基线：92408e5。只提交不推送。范围：决策 412（撤掉读档工具的凭据禁读名单及为它而设的路径判定），决策 355 里工作区内外的区分、工作区外读取在非放手模式须审批、无人值守时拒绝的部分不动。

## 一、提交

| 提交 | 内容 |
|---|---|
| 526cbe4 | 412：撤掉禁读名单、设置追加项的生效与为名单而设的路径判定；余下的读档路径解析改名为 `tools/read-paths.ts`；旧设置的 `permissions.readDeny` 照常加载、不再生效；配置文档随之更新 |

## 二、删掉的

- `tools/read-deny.ts` 里：内置名单 `BUILTIN_READ_DENY`、`readDenyList`、名单项的展开与解析（`expandDenyEntry`、`ResolvedDenyEntry`、`resolveDenyEntriesLocal`）、判定 `deniedEntry`、报错文案 `readDeniedMessage`、`ReadDeniedError`；为名单而设的 Windows 写法判定 `unsupportedWindowsPathForm` 与 `UnsupportedPathFormError`（设备前缀 `\\?\`、`\\.\`、`\??\` 与数据流写法直接拒读），以及工作区外 UNC 路径的拒读 `uncOutsideWorkspace`；结果分类里的 `"denied"`。
- 执行端接口（`tools/workspace-host.ts`）：`resolveForRead` 与 `classifyReadPaths` 去掉名单参数，说明随之改。
- 本机执行端（`tools/local-host.ts`）：`LocalHostOptions.homeDir`（只用于名单里 `~` 的展开）及对 `os.homedir()` 的引用。
- 容器执行端（`execution/container-host.ts`）：名单在容器里的展开脚本 `DENY_ENTRIES_SCRIPT`、读档时先判名单再检视的 `READ_INSPECT_SCRIPT` 与其退出码 `EXIT_DENIED`、`inspectForRead`、`denyEntriesOf`，以及执行端侧对同一份名单的复核；结果分类脚本 `CLASSIFY_SCRIPT` 不再先输出名单各项，解析从第 0 段起。
- `read_file`、`grep`、`glob`：`readDeny` 选项与名单传递；`read_file` 放手档与经人批准档说明末尾的"凭据目录（如 ~/.ssh）不可读。"。
- `tools/search-backend.ts`：`Omitted.denied` 与其计数、"已按禁读名单略去 N 个文件"一句；`searchStart`、`screenFiles`、`runGrep`、`runListing` 去掉名单参数。`GrepDetails`、`GlobDetails` 去掉 `deniedOmitted`（全仓没有读它的地方）。
- 装配根（`application/runtime.ts`）：`readDenyOf` 的两处接线；本机执行端改为只按工作区根创建。
- 设置（`state/settings.ts`）：合并结果里的 `readDeny`、三层并集的收集与 `readDenyOf`。

## 三、保留与挪动的

- 与名单无关、仍在用的部分留在原模块并改名为 `tools/read-paths.ts`（git 记为删除加新增）：`ReadTarget`、`ReadPathClass`（只剩 `"ok"`、`"outside"`）、`PathRules`、`LOCAL_PATH_RULES`、`POSIX_PATH_RULES`、`containedIn`、`resolveLocalReadPath`（按 `realpathSync.native` 的真实路径判工作区内外，目标不存在报 `WorkspacePathNotFoundError`）、`classifyRealPath`（只按包含关系分类）、`ReadPathClassification`、`classifyLocalReadPaths`。引用处（本机与容器执行端、执行端接口、`read_file`）随之改引入路径。写工具的路径判定未动。
- 容器执行端的 `resolveForRead` 改用与 `resolveExisting` 相同的检视（`INSPECT_SCRIPT`），每次读档仍只进容器 1 次；不存在、解析不了、真实路径含控制字符的报错与改前相同（经 `inspectedPath`，`outside` 为真即不判工作区边界），工作区内外照旧按 `insideRoot` 判定。检视在判定之前即留作最近一次检视，与 `resolveExisting` 一致；改前只在通过名单判定后才留。
- 工作区内外的区分、工作区外读取的审批（放手放行、非放手经人批准、无人值守拒绝、设置里固化的 `read_file` 放权照样放行）、grep 与 glob 只搜工作区之内（`path` 落在工作区外即拒、结果里经链接指向工作区外的略去）都不变。

## 四、旧设置兼容

- 设置的校验对顶层与节内的未知键一律报错（`permissions` 一节的 schema 不允许多余属性）。仓库里没有"节内某键退役后照常加载"的先例（已退役的 `verify.json` 是整文件挪进备份，不是键），因此按"保留该字段的 schema、注明已不生效"处理：`state/grants.ts` 的 `PermissionsSectionSchema` 照旧含 `readDeny`（项的写法约束不变：`~` 开头或绝对路径），注释写明决策 412 后不再生效；合并时不再收集，任何地方都不读它。写了 `permissions.readDeny` 的设置文件照常通过校验与加载、不报错、不生效。

## 五、UNC 与设备前缀写法撤掉后的走向（核对）

本机（Windows）用临时目录建工作区与工作区外的文件，经本机执行端的 `resolveForRead` 与 `read_file` 逐项核对：

| 写法 | 解析后的真实路径 | 工作区内外 |
|---|---|---|
| `\\?\`、`\\.\`、`//?/` 加盘符路径 | 去掉前缀的普通盘符路径 | 按普通路径判：指向工作区内的为内，其余为外 |
| `文件::$DATA` | 文件本身的路径 | 同上 |
| `文件:流名`（备用数据流） | 带流名的路径 | 按所在目录判；工作区外的为外 |
| `\\localhost\C$\…` 与以地址写主机名的同类 UNC | 仍为 UNC 写法 | 工作区以本机盘符路径打开时一律为外（指向工作区里的文件也是）；工作区以同一 UNC 写法打开时，其内为内 |

- 落在工作区外的，`read_file` 的 `inspectOutsideRead` 交回其真实路径，治理层据此照工作区外读取的规则处理：非放手模式请人批准，无人值守拒绝，放手模式放行；没有授权时工具本身报 `OutsideReadNotApprovedError`。四种写法（UNC、`\\?\`、`\\.\`、`::$DATA`）指向工作区外的文件时，逐项核对到 `inspectOutsideRead` 交回真实路径、未授权即报该错误；治理层的三种处理由 `application/outside-read.test.ts` 覆盖，它只看 `inspectOutsideRead` 的结果，不看路径写法。
- `grep`、`glob` 的 `path` 用这些写法指向工作区外时，照普通路径报"路径越出工作区根"。
- 原名单里的位置（如家目录下 `.ssh` 里的文件）在放手模式下 `read_file` 照常读到；工作区包含它们时 `grep`、`glob` 照常搜到、列出。

## 六、测试与变异

测试照 `docs/testing.md`：只测名单的用例删掉；测工作区内外区分与工作区外审批的用例保留，借名单项构造场景的改写成不依赖名单。

- `tools/read-paths.test.ts`（由 `read-deny.test.ts` 改名改写）：删掉名单命中、追加项、名单项本身是链接、名单下的大小写与 8.3 短名、设备前缀与数据流拒读、UNC 拒读等只测名单的部分；保留并合并为——本机读档按真实路径判内外（绝对路径、`..`、经工作区里的链接）与结果逐条分类；包含关系的大小写口径与 Windows 口径下 UNC 真实路径的内外；Windows 上 UNC、设备前缀与数据流写法照真实路径判内外（工作区在本机管理共享上时其内照常；管理共享不可用时注明未测）；辅助程序不从工作区里找（原样保留）。
- `application/outside-read.test.ts`：放手模式一条把家目录指到临时目录（`HOME`、`USERPROFILE`，结束时还原），读其下 `.ssh` 里的文件改为读到内容（覆盖原名单位置在放手模式下 `read_file` 可读）；其余三条只去掉 `homeDir`。
- `tools/search.test.ts`：上限一条改为工作区即家目录（同样临时改 `HOME`、`USERPROFILE`）时 `.ssh` 下的文件照常被 `grep`（`path` 指向 `.ssh`）搜到、`glob` 列出，`files_only` 总数随之为 6（覆盖原名单位置 `grep`、`glob` 照常列出）；文件名带冒号或换行一条去掉 `.ssh` 与指向它的链接，只测归属与换行名的略去；替身执行端与 2 万上限两条随接口改参数。
- `state/settings.test.ts`：permissions 一条的用户级加上 `readDeny`，照常通过校验与合并（覆盖旧设置兼容）。
- `application/explorer-in-place.test.ts`：去掉禁读一项，作用范围与工作区外审批照测。
- `execution/container-read.test.ts`（真容器）：名单拒读改为容器内家目录下的 `.ssh` 与经工作区链接指向它的路径都按工作区外交回真实路径，结果分类里该链接为 `outside`；超时与授权读取照旧。
- `execution/container-search.test.ts`（真容器）：按批取真实路径一条不再传名单，指向工作区外的链接分类为 `outside`。

测试量（按增删行计）：测试增 130 行、删 282 行；产品代码增 66 行、删 373 行。

变异（每项改一处、跑对应文件，再拷回改前的副本，以 `git diff` 为空核对逐字一致）：

| 编号 | 改动 | 结果 |
|---|---|---|
| D1 | 把名单接回本机读档解析与结果分类（`os.homedir()` 下 `.ssh` 落在其内即拒、即略去） | `outside-read.test.ts` 放手模式一条、`search.test.ts` 上限一条变红，其余照过 |
| D2 | 从 `permissions` 一节的 schema 里去掉 `readDeny` | `settings.test.ts` permissions 一条变红（报"permissions 一节里的未知键 readDeny"），其余照过 |

## 七、本机验证

- Vitest 只跑改动涉及的文件（`--maxWorkers=2`）：`tools/read-paths.test.ts`、`search.test.ts`、`read-file.test.ts`、`read-file-limits.test.ts`、`read-file-replace.test.ts`、`workspace-host.test.ts`、`local-host.test.ts`，`application/outside-read.test.ts`、`explorer-in-place.test.ts`、`search.test.ts`、`runtime-tool-text.test.ts`、`grants-settings.test.ts`，`state/settings.test.ts`，`persistence/settings.test.ts`，`execution/container-read.test.ts`、`container-search.test.ts`、`container-round-trips.test.ts`、`container-write.test.ts`：18 个文件中 14 个通过、3 个整文件跳过（两件真容器用例本机没有 Docker，`container-write.test.ts` 仅 POSIX），83 项里 65 项通过、17 项跳过、1 项失败。失败的是 `container-round-trips.test.ts` 的"受保护路径判定检视到的是符号链接"一条，在测试准备阶段建文件符号链接即报 `EPERM`（本机账户没有建符号链接的权限），未进入被测代码；同文件的"读文件 1 次"一条（读档改用 `INSPECT_SCRIPT` 后的进容器次数）通过。`read-paths.test.ts` 的 Windows UNC 一条本机管理共享可用，各项都已执行。
- `npm run check`（tsc）通过；`biome check` 对改动的 18 个源文件与测试文件通过；`npm run deps`（dependency-cruiser）无违规（601 个模块）。
- 未跑 `verify:full` 与真容器验收。

## 八、遗留字样

全仓（不含依赖目录）搜 `禁读`、`readDeny`、`read-deny`：

- 产品与文档的现行内容里只剩旧设置兼容的说明：`docs/configuration.md` 两处（`permissions` 一节的表格、读档工具一节）、`src/state/grants.ts`（保留的 schema 与注释）、`src/state/settings.test.ts`（兼容用例）。
- `docs/roadmap/decisions.md`（不在本次范围）与 `docs/audits/` 下 7 份既有审计（只追加的历史记录）照旧含这些字样；本审计记述撤掉的内容，也含这些字样。
- 另搜 `ReadDenied`、`deniedOmitted`、`UnsupportedPathForm`、`uncOutsideWorkspace`：产品代码、测试与现行文档里没有（只在审计里出现）。

## 九、回报

分支 worktree-agent-a813b9ba99cd89879，代码 526cbe4，审计另提交。
删：内置名单与 readDeny 生效、设备前缀/数据流/外部 UNC 拒读、容器内名单检查、denied 计数与说明句。
留：真实路径判内外与结果分类，改名 read-paths.ts。
兼容：无退役键先例，保留 readDeny 的 schema、注明不生效。
核对：UNC、设备前缀、数据流写法落在工作区外即走工作区外读取规则。
新测覆盖原名单位置可读可搜与旧设置兼容，变异 2 项精确变红；本机仅一条建符号链接 EPERM（环境）失败，tsc、biome、depcruise 通过。
服务器补跑：读档与搜索两件真容器用例、冒号换行一条、verify:full。
拿不准：UNC 写法指向工作区内文件也算工作区外。
