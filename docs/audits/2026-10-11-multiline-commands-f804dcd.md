# 多行命令交给 shell

基线：f804dcd。只提交不推送。范围：决策 413（run_command 把引号外的换行视为 shell 语法，多行命令整条交给 shell 执行；引号内的换行仍是参数的一部分）。

## 一、提交

| 提交 | 内容 |
|---|---|
| 6c2c4db | 413：切分器把引号外、前后都有命令内容的换行判为 shell 语法；需 shell 的原因区分符号类与多行；/bin/sh 平台的工具说明写上多行命令；配置文档补"何时经 shell"一段；测试 |

## 二、改法

- `src/tools/run-command.ts` 的 `parseCommandLine`：引号外遇到 `\n` 时，若此前已有命令内容（当前词未结束或已切出参数），记下"已换行"；其后在引号外再遇到任何非空白字符（含引号起始与 shell 符号）即抛 `ShellSyntaxError`，只读检查据此判为 `shell`。`\r\n` 里的 `\r` 照旧按空白处理，由其后的 `\n` 判定；单独的 `\r` 仍只是分隔。引号内（单引号、双引号）的换行原样留在参数里，判定不变。
- 首尾空白：模型给的命令串在只读检查之前已整体修剪首尾空白（`resolve` 里的 `input.trim()`，含换行），检查、审批面板显示与实际执行的都是修剪后的串，这一点改前即如此。设置 `commands` 一节的短名展开后的命令串不修剪；切分器只在换行前后都有内容时才判多行，因此首尾的空白行不论来自哪里都不会仅因此经 shell。中间的空白行（前后都有内容）照样判多行。
- 一旦判为多行，切分器不再检查其后的内容：例如第一行之后出现未闭合的引号，改前报"引号未闭合"，改后判为经 shell，由 shell 自己报错。
- `ShellSyntaxError` 带 `reason`：符号类为"含管道、重定向、命令串联或命令替换"（与改前相同），多行为"含引号外的换行（多行命令）"。只读检查的 `shellReason` 取自它，审批预览"需要经 shell 运行：……"与未授权时的拒绝理由随之区分两类。
- 经 shell 的命令串仍与审批面板显示的一致，不做改写；审批口径不变（与其他经 shell 的命令同一套：人确认、带 shell 标记的放权、`--yolo`）。
- 行尾的 `\`（续行）：改前在引号外被当成普通字符，单独成为一个参数；改后这类命令含换行即经 shell，由 `/bin/sh` 按续行处理。
- 经 `/bin/sh -c` 的多行命令与 `;` 串联相同：前面的行失败不阻止后面的行，退出码取最后一行。

## 三、各平台经 shell 时用的程序与对多行的处理

`spawnPlan` 按执行端平台分派：

| 执行端 | 经 shell 时 | 多行命令 |
|---|---|---|
| 本机 Linux、macOS | `/bin/sh -c <命令串>`（参数数组，不经命令行拼接） | POSIX sh 把命令串当脚本读，换行即命令分隔，逐行执行 |
| 容器执行端（平台记为 linux） | 同上：命令串作为 `docker exec` 的一个参数传入，容器内的观测脚本经 `setsid`（容器里没有时省去）与 `env --` 以 `"$@"` 原样起 `/bin/sh -c <命令串>` | 同上 |
| 本机 Windows | `%ComSpec% /d /s /c "<命令串>"`（Node 以 `windowsVerbatimArguments` 原样拼命令行） | 只执行第一行，见下 |

本机 Windows 的核对：在 Windows 11 上用 Node 按与 `spawnPlan` 相同的方式（`/d /s /c`、命令串外加一对引号、原样拼命令行）起 cmd.exe：

| 命令串 | 输出 | 退出码 |
|---|---|---|
| `echo one` 换行（LF）`echo two` | 只有 `one` | 0 |
| 同上，换行为 CRLF | 只有 `one` | 0 |
| `echo one` 换行 `echo two & echo three` | 只有 `one` | 0 |
| `echo one & echo two` 换行 `echo three` | `one`、`two` | 0 |
| `echo "a` 换行 `b" & echo after`（换行在引号内） | 只有 `"a` | 0 |
| `echo one` 加结尾换行 | `one` | 0 |

即 cmd.exe `/c` 只执行命令串第一个换行之前的部分，其余各行（含引号内换行之后的部分）不执行、不报错，退出码为第一行的结果。

- 本次只完成切分判定（各平台相同）。本机 Windows 上多行命令因此改为经 cmd.exe 运行，只执行第一行（改前为拼成一条直接执行，如 `pip install a pip install b`）；两种都不报错。Windows 上多行命令的处理另行裁决，可选做法：（A）本机 Windows 上拒绝多行命令，报错说明只会执行第一行，请改成单行串联、分次运行或写成脚本文件；（B）交给 cmd.exe 之前把引号外的换行改写成 `&&` 或 `&`（改写命令串，审批面板须显示改写后的串）；（C）把命令串写成临时 `.cmd` 批处理文件再经 cmd.exe 运行（批处理与 `/c` 的语义有差别，如 `for` 变量写法、`%` 的处理；临时文件的位置与清理要避开工作区的文件变化报告）；（D）Windows 上经 shell 改用别的 shell（PowerShell 或 Git Bash），牵动所有经 shell 的命令与说明。
- 改前即存在的同类情形：Windows 上本就含 shell 符号的多行命令、以及 `.cmd` / `.bat` 带含换行的参数退到经 shell 时，cmd.exe 同样只执行第一行。
- Windows 宿主上的容器执行端：命令串经 Windows 上的 docker 客户端传入容器，含换行的参数在 Windows 命令行上的传递未实测。

## 四、说明文字

- `runCommandTexts`：平台不是 win32 时，工具说明的 shell 一句写"管道、重定向、&& 串联、多行命令（逐行执行）等需要 shell 的命令……"，系统提示与开工状态块的一句写"含管道、重定向、&& 串联或多行的命令经 /bin/sh -c 执行"；win32 的文字不变（不写多行命令）。登记描述（"需要 shell 语义的经 …… 执行"）不变。
- `docs/configuration.md`："工具的上限"一节在命令长度一段之前加"run_command 何时经 shell"一段：引号外的管道、重定向、串联、命令替换与换行经 shell，引号内的换行是参数的一部分，首尾空白与换行不因此经 shell；Linux、macOS 与容器经 `/bin/sh -c` 逐行执行，本机 Windows 经 cmd.exe 只执行第一行、其余不执行也不报错。
- 未改：worker 命令前缀范围（`tools/tool-scope.ts`）本就把命令串里任何换行（含引号内）判为越界；脚本编排的"同类"放行（`application/script-approvals.ts`）本就不给含换行的命令同类。二者行为不变。

## 五、测试与变异

测试照 `docs/testing.md`：测判定与执行结果，文案只核对片段。

- `tools/run-command.test.ts`：新增一条——引号外的 LF、CRLF 换行（含第一行以引号结尾的情形）抛 `ShellSyntaxError`；单、双引号内的 LF 与 CRLF 原样留在参数里；首尾带空白换行的命令串切成正常参数。
- `tools/run-command-shell.test.ts`：新增一条——两行命令只读检查为 `shell`、需 shell；首尾多出换行的单行命令为 `direct`；平台有 `/bin/sh` 时授权后执行，执行证据为经 shell，输出为两行各自的输出拼接（拼成一条执行时只会有第一行的输出）。本机 Windows 上执行部分跳过。
- `tools/run-command-text.test.ts`：linux 自动批准一条加核对系统提示、审批一句与工具说明都含"多行"。

测试量（按增行计）：测试增 44 行；产品代码 `run-command.ts` 增 46 行、删 24 行。

变异（只做关键判定）：把记下"已换行"的赋值改为 `false`（等于去掉换行判定），跑上述三个测试文件：`run-command.test.ts` 的新增一条与 `run-command-shell.test.ts` 的新增一条变红，其余 18 项照过；还原后文件的 sha256 与改前一致。

## 六、本机验证

- Vitest（`--maxWorkers=2`）：`tools/run-command.test.ts`、`run-command-shell.test.ts`、`run-command-text.test.ts`、`tool-scope.test.ts`、`application/runtime-tool-text.test.ts`，29 项中 26 项通过、3 项跳过（新增一条的 `/bin/sh` 执行部分在 Windows 上跳过；`tool-scope.test.ts` 两条因本机账户不能建符号链接跳过）。
- `npm run check`（tsc）通过；`biome check` 对改动的 4 个源文件与测试文件通过。
- 未跑 `verify:full` 与真容器验收。

## 七、回报

分支 worktree-agent-a59c15b9b3e8a7d1b，代码 6c2c4db，审计另提交。改法：引号外换行（前后有内容）判经 shell，引号内换行留在参数里，首尾空白换行不算。核对：Linux、macOS、容器经 sh -c 逐行执行；Windows 经 cmd.exe 实测只执行第一行、不报错，待裁决（拒绝、改写成 &&、临时 .cmd、换 shell）。测试增 44 行，去掉换行判定两条精确变红；本机测试、tsc、biome 通过。服务器补跑 sh 逐行一条与 verify:full。未测：Windows 宿主经 docker 传多行。
