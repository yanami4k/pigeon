# run_command 的文件变化排除治理目录（基线 7b0750f）

范围：run_command 报告的执行前后文件变化不再包含工作区根下的治理目录 .pigeon；本地与容器两个执行端的文件清单跳过规则收成一处共用。基线为 formal-v2 分支 7b0750f。冻结标签 formal-run-v1 未动。

## 一、提交

| 提交 | 内容 |
|---|---|
| 63a4c00 | 两个执行端的文件清单跳过工作区根下的 .pigeon，跳过名单共用；新增与改写用例 |

本审计文件在其后单独一个提交，只增加本文件。

## 二、缺陷

run_command 在执行前后各取一次工作区的文件清单（执行端的 listFiles），比对后在工具结果里报"文件变化：新增 / 删除 / 修改"。本地执行端（src/tools/local-host.ts）在任意层级跳过 .git 与 node_modules；容器执行端（src/execution/container-host.ts）的 find 命令里另写了一份同样的名单。两者都不跳过治理目录 .pigeon，而它在运行中持续被写入：会话文件及其锁文件、推送记忆、各项配置；本地 worker 的工作树也建在治理根的 .pigeon/worktrees 下（src/orchestration/worktree.ts）。由此：

- 工具结果里混进与 agent 所做无关的文件；
- 打转检测（305–308）按轮比对调用与结果，同一条命令两轮的结果文字不同，计数晚一轮才开始。

基线代码上的实测（第四节新增的打转用例，pigeon run 每轮同一条 run_command）：第 1 轮报"新增 1 / 删除 0 / 修改 0"，新增为会话文件；第 2 轮报"新增 1 / 删除 0 / 修改 1"，新增为会话文件的 .lock，修改为会话文件。

## 三、改法

- src/tools/workspace-host.ts 新增两份共用名单：`LISTING_SKIPPED_DIRS`（任意层级按名字跳过：.git、node_modules，与改前相同）与 `LISTING_SKIPPED_ROOT_DIRS`（只在工作区根跳过：.pigeon）。`HostFileSnapshot` 的注释改为指向这两份名单。
- 本地执行端：删去自有的 `SKIPPED_DIRS`；遍历时，目录名在第一份名单里，或当前目录是工作区根且目录名在第二份名单里，即不跟进。符号链接与目录联接照旧一律跳过。
- 容器执行端：find 的剪枝条件由两份名单拼出，第一份每项为 `-name <名>`，第二份每项为 `\( -path ./<名> -type d \)`，只匹配工作区根下的那个目录。改后命令为 `find . \( -name .git -o -name node_modules -o \( -path ./.pigeon -type d \) \) -prune -o -type f -exec stat …`。
- 两端对子目录里名为 .pigeon 的文件夹照常列出。
- run_command 的比对与结果格式不变，其他执行端行为不变；run_command 的工具说明文字本次未改。
- 跑批器（eval stream）不另加开关：它经容器执行端运行，今后的实验运行会用到本改动。它的治理根是宿主上的作业目录，只有容器工作区根下存在 .pigeon 目录时，文件变化才与改前不同。冻结的正式跑用标签 formal-run-v1 的代码，不受影响。

## 四、测试

新增夹具 src/tools/listing-fixtures.ts，本地与容器用例共用：工作区根下放 .pigeon/sessions/s.jsonl、sub/.pigeon/keep.txt、a.txt、gone.txt；命令为 node 执行放在工作区外的脚本，执行期间追加会话文件、新建 .pigeon/learned/MEMORY.md、新增 b.txt、追加 a.txt、删除 gone.txt、新增 sub/.pigeon/new.txt、追加 sub/.pigeon/keep.txt。

- src/tools/local-host.test.ts 新增"文件清单跳过工作区根下的 .pigeon……"：执行前清单恰为 a.txt、gone.txt、sub/.pigeon/keep.txt；文件变化恰为新增 b.txt 与 sub/.pigeon/new.txt、删除 gone.txt、修改 a.txt 与 sub/.pigeon/keep.txt、未截断。
- src/execution/container-host.test.ts 新增两条：
  - 替身层"容器执行端（本机执行的假 docker）：……"：以 local-docker-fixtures.ts 的假 docker（命令在本机目录里执行）驱动容器执行端，同一夹具、同样断言；任何机器都跑。
  - 真容器层"文件清单跳过工作区根下的 .pigeon……"：容器内建 .pigeon/sessions/s.jsonl 与 sub/.pigeon/keep.txt，清单里没有以 .pigeon/ 开头的路径、有 sub/.pigeon/keep.txt；经 shell 追加会话文件、新建 .pigeon/learned/MEMORY.md、新增 src/c.txt、追加 sub/.pigeon/keep.txt、新增 sub/.pigeon/new.txt，文件变化恰为新增 src/c.txt 与 sub/.pigeon/new.txt、修改 sub/.pigeon/keep.txt、无删除。
- src/application/loop-guard-run.test.ts：
  - 新增"run_command 的文件变化不含治理目录：……"：pigeon run（真实装配根、假模型），每轮同一条 run_command，只有会话文件在变；提醒、再提醒、叫停的轮数设为 1、2、3。断言以打转结束；会话记录里前两条工具结果逐字相同、不含 .pigeon；第 2 次模型请求里没有打转提醒，第 3 次里有 1 条（第 2 轮与第 1 轮相同即计 1）。
  - 改写"真实形状：每轮两条相同的 run_command……"：注释改为第 1 轮起各轮相同、计到 20 在第 21 轮；上界由模型请求不超过 23、工具调用不超过 44，收紧为不超过 22、42。

基线代码上：新增的四条与改写的一条全部变红——本地与两条容器用例的执行前清单里出现 .pigeon/sessions/s.jsonl；新增打转用例的两轮工具结果不同（见第二节）；真实形状用例模型请求 23 次。

## 五、变异反向验证

对 src/tools/local-host.test.ts、src/execution/container-host.test.ts、src/application/loop-guard-run.test.ts、src/tools/run-command.test.ts、src/tools/run-command-text.test.ts、src/tools/workspace-host.test.ts 进行，共 35 个用例（真容器层照常执行、未跳过），真实代码下全部通过。每次只植入一处变异，跑完还原，还原后按 sha256 与改后代码比对。

| 编号 | 变异 | 结果 | 还原 |
|---|---|---|---|
| A | 共用名单 `LISTING_SKIPPED_ROOT_DIRS` 清空（两端都不跳过 .pigeon） | 35 个中 5 个变红：本地、容器替身层、真容器层三条清单用例，新增的打转用例，真实形状用例 | 逐字一致 |
| B | 本地执行端去掉"工作区根下跳过第二份名单"的判断 | 3 个变红：本地清单用例、新增的打转用例、真实形状用例（pigeon run 走本地执行端）；两条容器清单用例照常通过 | 逐字一致 |
| C | 容器执行端的剪枝条件去掉第二份名单 | 2 个变红：容器替身层与真容器层两条清单用例；本地与打转用例照常通过 | 逐字一致 |
| D | 本地执行端改为任意层级按名字跳过 .pigeon | 1 个变红：本地清单用例，执行前清单缺 sub/.pigeon/keep.txt | 逐字一致 |
| E | 容器执行端的第二份名单改为 `-name .pigeon`（任意层级） | 2 个变红：容器替身层与真容器层两条清单用例 | 逐字一致 |

以上在 Node 24.12.0 下运行。

## 六、verify 的实际运行情况

在 Linux 容器上跑，不是验证服务器：4 vCPU，Node 24.12.0，npm 11.6.2；依赖按锁定文件 `npm ci`；本机 docker 守护进程可用，测试镜像 busybox:latest 在本地，真容器层照常执行。对象为 63a4c00 的工作区内容。

- lint：`biome check .` 通过，525 个文件。
- check：`tsc -p tsconfig.json --noEmit` 通过。
- test：`node --test "src/**/*.test.ts"`，1,480 个用例，1,471 通过、1 失败、0 取消、8 跳过，255 秒。
  - 失败的是 src/eval/stream-workspace.test.ts 的"家目录下的用户级文件删不掉（所在目录不可写）……"：该环境以 root 运行测试，目录不可写挡不住删除；同一用例在基线 7b0750f 上同样失败。同文件里另两条依赖权限的用例在 root 下跳过（"以 root 运行，……挡不住……"），这一条没有同样的跳过。
  - 跳过的 8 个：仅 Windows 的 .cmd 启动器 2 个；本地没有所需镜像 4 个（pigeon-sandbox 通用镜像、pigeon-stream-pigeon:v4 两个、带 git 的镜像）；以 root 运行而跳过 2 个。
  - 同一环境的第一次全量运行中，src/application/closeout-fixes.test.ts 的"分叉复用运行面已挂的快照器……"另失败一次（来源会话的快照 ref 为 2 个，期望 3 个）。该用例经 edit_file 与 git 快照，不经过 listFiles（listFiles 只由 run_command 调用）；第二次全量运行通过；单独运行该文件 5 次，5 个用例全部通过。
- deps：测试步失败使 verify 在 deps 之前停下，另行执行 `npm run deps`：552 个模块、3,922 条依赖、无违规。

## 七、工具说明与验证服务器上的 verify（2026-09-30 追加）

- 提交 ac472a9 改了 run_command 的工具说明：结果一句末尾加"（不含 Pigeon 自己的治理目录 .pigeon）"，src/tools/run-command-text.test.ts 的三处逐字断言同步改。第三节"工具说明文字本次未改"指 63a4c00，以本节为准。系统提示与登记描述两处文字不提文件变化，未改。
- 在验证服务器上以 ac472a9 跑 verify：8 vCPU（AMD EPYC 9T24）、31 GB 内存，Node 24.12.0；依赖按锁定文件 `npm ci`；以普通用户运行；测试步为 `node --test --test-concurrency=6 "src/**/*.test.ts"`，运行时无其他测试并发。
  - lint：`biome check .` 通过，525 个文件。
  - check：`tsc -p tsconfig.json --noEmit` 通过。
  - test：1,480 个用例，1,478 通过、0 失败、0 取消、2 跳过（仅 Windows 的 .cmd 启动器用例），113 秒。第四节新增的本地、容器替身层、真容器层三条清单用例与打转用例均实际执行并通过；第六节因缺镜像跳过的 4 个用例在此实际执行并通过；第六节以 root 运行而失败的 src/eval/stream-workspace.test.ts 那一条在此通过。
  - deps：`npm run deps`，552 个模块、3,922 条依赖、无违规。
- 交付以本节的 verify 为准。
