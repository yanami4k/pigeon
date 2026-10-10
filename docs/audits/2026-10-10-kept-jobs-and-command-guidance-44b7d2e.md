# 后台作业的会话结束后保留、前台命令的后台进程说明与超时夹取（决策 409、410、411）施工审计

基线 44b7d2e。提交 0c0e821（411）、017281b（409）、6272b51（410），另加本审计所在的提交。

## 一、超时参数超上限时夹取（决策 411，提交 0c0e821）

- run_command 的 `timeout_seconds` 超过上限（缺省 600 秒，设置 `tools.runCommand.maxTimeoutSeconds`）时按上限执行，不再报错拒绝。
- 结果里另起一行注明给的值、已夹到的上限，并提示更久的命令用 background；命令超时的报错里同样带这一行。执行证据（结果的 details）新增可选字段 `timeoutClamped`（`requestedSeconds`、`appliedSeconds`）。
- 工具说明里上限的写法改为"上限 600 秒（给得更大按上限执行）"（数值随设置代入）。`docs/configuration.md` 的设置表与"单次超时与后台作业"一节随之改写。
- 同时给 `timeout_seconds` 与 `background` 仍然拒绝，不变。

## 二、后台作业的会话结束后保留（决策 409，提交 017281b）

### 参数与说明

- run_command 新增可选参数 `keep_after_session`（布尔），只与 `background: true` 同用，单给即拒绝（域错误）。
- 工具说明在后台作业一段末尾加一句：起服务、守护进程，或判分、使用者在会话结束后还要用到的长时间进程，再加 `keep_after_session: true`，会话结束时不等、不停，进程留着继续跑，输出照样写进那个文件，会话里照常可用 job_output 查看、job_kill 停掉。原句"会话结束时全部停止"改为"会话结束时停止"。
- 启动回执写"已在后台启动作业 j1（会话结束后保留）"；执行证据的 `background` 带 `keep: true`。job_output 与通知里在跑的状态句注明"会话结束后保留"。

### 会话收尾

- 作业表新增 `toSettle()`：在跑且没标保留的作业。`killAll` 只停这些。
- 无人值守收尾（`settleBackgroundJobs`）只等、只停 `toSettle()` 里的作业："仍在跑"的通知不列保留的作业，等待只等没标保留的。headless 与 worker 运行面判断"等作业时被中断"也只看没标保留的。
- 会话结束（`disposeRuntime`：无人值守运行结束、退出终端界面、worker 结束，含出错、中止与撞上限）先 `killAll("aborted")`，再 `detachKept()`：对还在跑的保留作业记一条会话记录 `pigeon.background-job`，`event` 为 `kept`（本机作业带 `pid`）；从作业池的在跑名单里去掉；登记进作业池的保留名单（会话号、作业号、命令、进程号）；关掉 Pigeon 读输出用的描述符；让执行端交出跟踪（本机与容器都对子进程 `unref`，不再拖住 Pigeon 进程退出）。交出之后作业再结束，不记录、不通知。
- 未标保留的作业照决策 365 收尾，行为不变。
- 会话里保留的作业与普通作业相同：计入同时在跑的上限，可用 job_output 查看、job_kill 停掉；在会话结束之前自己结束的，照常记结束、照常通知、全文照常记进落盘索引。
- 会话记录：启动条目新增可选的 `keep: true`；新增 `kept` 条目（`BackgroundJobKeptDataSchema`）。`pigeon trace` 的时间线显示"后台作业保留 ｜ j1 ｜ 进程号 N"，启动行注明"会话结束后保留"。结束条目的 `reason` 取值不变。
- 续跑：启动条目带 `keep: true` 的作业不算丢失（`previousJobsOf`）。
- 沙箱交回前的提示（给人看）：收尾时把没标保留的照旧列为"交回沙箱前停掉"；标了保留的另列一句"交回时仍在跑，交回的改动可能是作业做到一半的样子，容器删除时随之结束"。`/export` 时的提示不变。

### 无人值守结果

- `HeadlessRunResult` 新增可选字段 `keptJobs`：本次运行（主会话与它派出的 worker，按 worker 编排器列出的会话号筛）结束时保留下来的作业，每项为 `sessionId`、`jobId`、`command`，本机作业另有 `pid`；没有即不出这个字段。取自整次运行共用的作业池的保留名单。`pigeon run --json` 原样打印。
- 不带 `--json` 的 `pigeon run` 与终端界面不出文字提示。
- `pigeon run --sandbox` 的结果去掉 `keptJobs`：沙箱容器随收尾删除，里面保留的作业随之结束。

### 清理路径的核对

| 清理路径 | 位置 | 保留的作业 |
| --- | --- | --- |
| 会话结束时停掉全部作业 | `disposeRuntime` → `SessionJobs.killAll` | `killAll` 只停 `toSettle()`，跳过 |
| 无人值守收尾的等待与总时限到后停掉 | `settleBackgroundJobs` | 只等、只停 `toSettle()`，跳过 |
| 本机组长退出后清扫组里的子孙（Linux/macOS 按进程组，Windows 按进程树） | `startLocalJob` 的 exit 处理 → `sweepProcessGroup` | 不清扫，组长退出即结束 |
| 容器里组长退出后清扫（按组与标记） | `JOB_SCRIPT` | 新增第二个参数，非空时组长退出即以它的退出码结束，不清扫 |
| Pigeon 进程退出时的兜底终止 | `process-tree.ts` 的 `killTrackedChildren`（exit 事件） | 启动时不登记（`trackChild`） |
| Windows：Node 把非分离启动的子进程放进"父进程退出即终止"的作业对象 | 进程启动（libuv） | 各平台都分离启动（`detached: true`），不进该作业对象 |
| 崩溃后下次启动按记录清理 | `cleanupOrphanedJobs`（`.pigeon/state/jobs/`） | 启动时不写记录文件，清理碰不到 |
| 前台命令超时与中止的整组终止、容器里按标记查杀 | `runLocalProcess`、容器执行端的 `killMarked` | 只针对那条命令自己的进程组与标记，保留的作业不在其中 |
| Pigeon 退出后输出管道断开 | 原先两路输出经管道交回 Pigeon | 两路输出直接写进输出文件（见下），不经管道 |
| 沙箱容器删除 | 沙箱收尾 | 容器里的进程随之结束 |

job_kill 照常停掉保留的作业：本机按进程组（Windows 按进程树），容器里按组与标记。

### 输出

- 保留的作业的标准输出与标准错误是落盘目录里同一个输出文件的另一个描述符：以追加方式打开，打开后核对设备号与 inode 与 Pigeon 新建的那份一致，交给进程后 Pigeon 关掉自己这一份。容器作业把 docker exec 客户端的两路输出接到这个描述符。
- Pigeon 读输出仍用自己新建时打开的描述符，按文件当前大小算新增输出。单个文件的大小上限不管保留的作业，不砍前面。
- 会话结束后文件留在落盘目录里原处（临时名），进程继续往里写。

## 三、前台命令里的后台进程（决策 410，提交 6272b51）

- 判定与超时行为不改：前台命令仍以输出全部关闭为结束，超时整组终止。
- 工具说明在末尾加一段：命令要等输出全部关闭才算结束，命令里用 `&`（Windows 为 `start /b`）放到后台、又没把输出重定向走的进程会一直占着输出，命令要等到超时才结束，连同那个进程一起被终止；一直运行的进程用 `background: true` 作为后台作业启动（服务、会话结束后还要用的进程再加 `keep_after_session: true`）；非放到后台不可时，先把输出重定向到文件（`命令 > 文件 2>&1 &`，Windows 为 `start /b 命令 > 文件 2>&1`）。本会话不能开后台作业时只写重定向一种。
- 本机执行端：`runLocalProcess` 记下直接子进程的 exit 事件；超时那一刻它已经退出的，结果带 `outputHeldAfterExit: true`（`HostExecResult` 新增可选字段）。run_command 的超时报错在第一行之后另起一行："命令本身已经退出，是它放到后台的进程仍占着输出，命令才没有结束。"接上面的两种做法。其余超时的报错照旧。
- 容器执行端不改。按代码，命令本身退出后观测脚本照常做命令后的取证并结束，子孙占着输出时，客户端在辅助调用的限时到点后按标记杀掉子孙、按正常结束交回，不算超时，因此不出这一行。
- `docs/configuration.md` 的"单次超时与后台作业"一节加了这一段。

## 四、测试

| 提交 | 产品代码 | 测试 |
| --- | --- | --- |
| 0c0e821（411） | +31 −9 | +22 −4 |
| 017281b（409） | +300 −54 | +181 −12 |
| 6272b51（410） | +30 −2 | +35 −3 |

- `tools/run-command.test.ts`：
  - 超时参数超上限按上限执行，结果与超时报错都注明夹取，并按上限到时终止（411）。
  - 原有的超时用例加断言：命令本身没退出的超时不出"仍占着输出"一行（410）。
  - 命令本身已退出、放到后台的进程继承输出：到时报错带原因与重定向做法（410）。
- `tools/run-command-text.test.ts`：说明写明后台作业与 `keep_after_session`、重定向写法；不能开后台作业时不提 `keep_after_session`；Windows 写 `start /b`（409、410）。
- `tools/background-jobs.test.ts`：
  - 原"timeout_seconds 超过上限即拒绝"的断言删去（411）。
  - 新增一项（只在 POSIX 上跑）：保留的作业组长退出后子孙留着；`killAll` 不停它；`detachKept` 记"保留"并带进程号；调用 `killTrackedChildren` 之后进程仍在；没有记录文件；交出之后输出文件仍在增长（409）。
- `application/background-jobs.test.ts`：
  - 替身执行端一项：收尾只等没标保留的，"仍在跑"不列保留的，收尾与 `killAll` 都不停它，`detachKept` 记"保留"、进保留名单（409）。
  - 续跑一项加一条：启动条目带 `keep: true` 的不算丢失（409）。
  - 装配一项（真进程，各平台都跑）：headless 运行里标了保留的作业不进收尾轮（模型只被调用两次），结果的 `keptJobs` 列出会话号、作业号、命令与进程号，进程在运行结束后仍在，会话记录为 started、kept（409）。
  - 工作区删除改为删不掉时稍后重试（至多 5 秒）：Windows 上刚停掉的进程放开工作目录要一会儿。
- `execution/container-round-trips.test.ts`：原"组长退出后子孙清掉"一项（只在 Linux 上跑）加一段：标了保留的作业，包装脚本不清扫，子孙仍在（409）。

## 五、变异

本机逐个改坏、只跑对应测试文件（或其中的用例），全部变红，还原后与改坏前逐字一致：

| 改坏的判定 | 改法 | 变红的用例 |
| --- | --- | --- |
| 超上限夹取（411） | 改回超上限即拒绝 | run-command：超上限按上限执行 |
| 保留的作业不等不停（409） | `toSettle()` 交回全部在跑的 | 收尾只等没标保留的一项 |
| 会话结束交出保留的作业（409） | `disposeRuntime` 不调 `detachKept` | 装配：保留的作业一项 |
| 结果列出保留的作业（409） | 结果不带 `keptJobs` | 装配：保留的作业一项 |
| 未标保留的照旧收尾（409） | `toSettle()` 交回空 | 收尾三项（"仍在跑"一轮、总时限按运行各自计、总时限为 0） |
| 只在命令本身已退出时出提示（410） | 一律不判已退出 | run-command：命令本身已退出一项 |
| 同上 | 一律判已退出 | run-command：原有的超时一项 |

另做过一次：只把收尾里取作业的一处改回"全部在跑的"、`killAll` 不改。这时收尾总时限到后 `killAll` 停不掉保留的作业，收尾循环不再让出事件循环，用例一直不结束（没有变红而是挂住）。产品代码里这两处取的是同一份（`toSettle()`）。

只在 Linux 上跑的用例相关的四项没有在本机做：本机组长退出后改回清扫、改回登记兜底终止、保留的作业照写记录文件、容器包装脚本去掉不清扫的一行。

## 六、本机验证

本机 Windows：

- `npm run check`（tsc）通过；biome 检查改动所在的目录无问题。
- 跑过的测试文件：`tools/run-command.test.ts`、`tools/run-command-text.test.ts`、`application/runtime-tool-text.test.ts`、`tools/background-jobs.test.ts`、`application/background-jobs.test.ts`、`cli/replay.test.ts`、`execution/container-round-trips.test.ts`、`application/headless.test.ts`、`application/sandbox-session.test.ts`、`application/tui-exit.test.ts`、`application/workers-start.test.ts` 与 `src/state` 下的测试。除下面一项外全部通过，只在 POSIX 或 Linux 上跑的用例跳过。
- `execution/container-round-trips.test.ts` 的"受保护路径判定检视到的是符号链接"一项失败：本机建符号链接报 EPERM（没有建链接的权限），与本次改动无关。
- 本机单文件用时：`tools/run-command.test.ts` 约 17 秒，其中"命令本身已退出"一项约 6.6 秒（Windows 上后台子进程分离启动，超时后整树终止碰不到它，要等 5 秒宽限销毁管道），在 Linux 上它留在命令的进程组里随整组终止。

## 七、需要在验证服务器上补跑

- `npm run verify:full`。
- 只在 Linux 上跑的用例：`tools/background-jobs.test.ts` 的保留作业一项、`execution/container-round-trips.test.ts` 的组长退出一项。
- 上一节列出的四项变异。
- `tools/run-command.test.ts` 与 `application/background-jobs.test.ts` 的单文件墙钟（`--concurrency 1`）。

## 八、已知局限

- 保留的作业的输出文件不设大小上限。
- 保留的作业在会话里结束、它留下的子孙仍往同一个文件写时，文件内容与落盘索引记下的身份对不上，read_file 按虚拟路径读会被拒绝。
- Windows 本机：保留的作业分离启动，没有控制台；经 cmd.exe 起的控制台程序可能另开一个控制台窗口（本机没有验证窗口是否出现）。
- 沙箱会话里保留的作业随容器删除结束，结果里不列出。
- `pigeon run` 被信号直接终止时不走会话收尾（与决策 365 相同），保留的作业此时没有"保留"记录，续跑时也不算丢失。

## 回报

提交 0c0e821（411 夹取）、017281b（409）、6272b51（410）。409：保留作业输出直写文件、分离启动、不登记退出兜底、不清扫子孙、不写崩溃记录，收尾与会话结束不等不停、记"保留"，--json 出 keptJobs。410：说明加两种做法，超时时主进程已退出即点明。清理路径逐条核对均已跳过。本机 tsc、biome、相关测试过（既有符号链接一项除外），七项变异全红。服务器补跑 verify:full、两项 Linux 用例、四项变异。拿不准：沙箱提示新增一句、Windows 或弹窗、容器不出 410 提示。

## 服务器补验（追加）

- 并入集成线后（b6193cd，含 407、408、412 的施工）在 Linux 服务器上跑 verify:full：lint、check、298 个测试文件（1550 通过，6 项按平台跳过）、依赖检查全部通过。
- 只在 Linux 上跑的两项用例（`tools/background-jobs.test.ts` 的保留作业一项、`execution/container-round-trips.test.ts` 的组长退出一项）实际执行并通过。
- 四项变异：改回清扫子孙、改回登记退出兜底终止、容器包装脚本去掉不清扫的一行，三项都让对应用例变红，还原后检出干净。
- "保留的作业照写记录文件"一项起初未被发现：记录在作业启动后异步取进程信息才写，用例在交出作业后立即查记录目录，查在写之前，断言恒真。把记录目录的断言挪到等输出增长之后；修正后用例连跑 3 次通过，该变异连跑 3 次都变红。
