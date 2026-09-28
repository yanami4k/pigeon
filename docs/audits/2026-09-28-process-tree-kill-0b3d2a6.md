# 本机子进程整树终止（process-tree-kill，基线 formal-v2 0b3d2a6）

## 现象与原因

本机（不开沙箱）拉起子进程、超时或中止时要终止它，原有做法在多处只终止直接子进程；由它再起的进程（`/bin/sh -c` 里的 node、`npm test` 起的 `node --test`、pytest 等）成为孤儿继续运行。

1. `src/execution/check-command.ts` 的 killTree：注释称"超时终止整棵进程树"，实际只有 Windows 用 `taskkill /T /F`；Linux 与 macOS 只对直接子进程 SIGKILL。已有宽限计时，判决不会无限等待，但孙进程残留。可观察证据：其超时用例以 `hang.mjs`（`setInterval` 永不退出）作被测命令，每跑一次全量测试就漏下一个 `node hang.mjs`，其工作目录是已删除的临时目录。
2. `src/tools/local-host.ts` 的 runLocalProcess（run_command 在本机执行走这里）：超时与中止都只 `child.kill()`，所有平台都只终止直接子进程；且只在 close 事件决议、没有宽限——孙进程占着输出管道时 close 不来，这次工具调用会一直挂到孙进程自己退出，超时形同虚设。
3. `src/mcp/transport.ts`：Windows 已用 `taskkill /T`；其他平台只对直接子进程 SIGTERM（经 npx 等启动的 MCP server 可能残留）。

容器执行端（`container-host.ts`）超时会重启容器、整树终止，不在本段范围。

## 改法与副作用的处理

抽出共用模块 `src/tools/process-tree.ts`，上述三处改用它：

- 整树终止 `killProcessTree`：非 Windows 以负 pid 对整个进程组发信号（`process.kill(-pid, 信号)`），组已不在或无权时回退到直接子进程；Windows 用 `taskkill /pid <pid> /T /F` 递归终止整棵树，拉不起 taskkill 时回退到直接子进程。
- 独立进程组 `processGroupSpawnOptions`：非 Windows 以 `detached` 拉起，子进程成为进程组组长（pgid = pid），终止时对整组发信号即可覆盖孙进程。Windows 不设 detached（会另开控制台窗口，且整树终止走 `taskkill /T` 不依赖进程组）。
- 各处信号选择保持原意：check-command 与 run_command 的超时/中止用 SIGKILL——判决已定或已中止，无需给孙进程善后机会，决胜要快；MCP 关闭保持先礼后兵——先关 stdin 让 server 自行退出，宽限内不退再对整组发 SIGTERM。

副作用的处理：

- 独立进程组后，终端的 Ctrl-C 不再直接送到子进程组。run_command 的中止路径不依赖终端信号传导：abort 信号触发时显式对整组发信号（`onAbort` 走整树终止），与超时同一条收尾路径。
- Pigeon 进程正常退出时仍在跑的子进程组也要终止（尽力而为）：共用模块登记在跑的子进程（`trackChild` / `untrackChild`），装一个进程退出钩子，退出时对仍在跑的子进程组发 SIGKILL，不留孤儿。退出钩子只能做同步收尾，Windows 上退回直接子进程。
- `local-host.ts` 补宽限：终止后若 close 在宽限（5000 ms）内不来，销毁输出管道、按超时或中止收尾，与 check-command 的做法一致。

## 测试与变异

- 三处各有用例（`process-tree.test.ts` / `check-command.test.ts` / `local-host.test.ts` / `transport.test.ts`）：子进程再起一个孙进程，孙进程把自己的 pid 写进文件、并继承 stdout 占着输出管道；超时或中止（MCP 为关闭）后断言孙进程在宽限内已不存在（非 Windows 用 `kill(pid, 0)` 抛 ESRCH，Windows 用 tasklist 查）。
- run_command 用例另断言：孙进程占着管道时，工具调用在"超时加宽限"内返回；并有中止用例（abort 信号收尾）。
- 共用模块另有 `killProcessTree` 与退出兜底 `killTrackedChildren` 的直接用例，以及"解除跟踪后兜底不再终止它"的用例。
- 用例自己起的进程在 finally 里按 pid 兜底清理，测试本身不再漏进程。
- 变异反向验证（Linux，服务器）：把共用模块的整树终止退回"只杀直接子进程"（去掉进程组与 taskkill）后，四个用例文件里依赖整树终止的断言各自精确变红：`process-tree.test.ts` 的 killProcessTree 与"解除跟踪后自己收尾整组"两例失败（孙进程残留），`check-command.test.ts` 的超时整树用例失败，`local-host.test.ts` 的超时与中止两例失败，`transport.test.ts` 关闭挂起（孙进程占着管道，close 不来）到超时被判失败；其余不依赖整树终止的用例仍通过。还原后与提交版本逐字一致（git 校验工作树无差异）。宽限自身的作用另由 run_command"孙进程占管道时调用在超时加宽限内返回"这一（真实代码下通过的）断言覆盖。
- Windows 路径（taskkill）在本机只跑相关的几个用例文件，均通过；Linux 的进程组路径在服务器上验证。

## verify 的实际运行情况

- 机器：阿里云实例 pigeon-verify，8 vCPU、约 31 GB 内存，Linux，Node 24.12.0。
- 提交：分支 process-tree-kill，实现与测试在提交 095f180（基线 formal-v2 0b3d2a6），verify 即在该提交上运行；本审计为其后的文档提交。
- 测试步在受控 TMPDIR 下运行；并发按当时服务器负载取（本次无其他测试批次在跑，取 6）。
- 结果：
  - check（`tsc --noEmit`）：通过。
  - test（`node --test`，全量 `src/**/*.test.ts`）：1145 个用例，1143 通过、2 跳过、0 失败。
  - deps（dependency-cruiser）：无依赖违规（420 模块、2873 依赖）。
  - lint（`biome check .`）：报 1 处错误，位于 `eval/analysis/tests/fixtures/runner-sample.json` 的格式化。该错误在基线 0b3d2a6 即已存在（单独核对：检出基线版本的该夹具，biome 同样报该错），与本段改动无关，本段未触及该文件（工作树无关于该文件的改动）。
- 遗留进程核对：测试步跑完，统计工作目录位于本次受控 TMPDIR 下的 `hang.mjs` 残留为 0，即本次运行不新增遗留进程。（服务器上另有历史运行、旧做法留下的 `hang.mjs` 孤儿，不计入本段口径。）
