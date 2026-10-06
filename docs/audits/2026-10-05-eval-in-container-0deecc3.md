# 对比评测：两组 agent 进题目容器（eval-in-container）审计

- 基线：0deecc3（含决策 394）
- 分支：eval-in-container（只提交，未推送，未并入 main）
- 范围：决策 380、385、389、390、392（对比评测的两组 agent 都在题目容器里跑，经同一网关与判题）
- 冻结标签 formal-run-v1 未动；原跑法原样可复现（新行为全部走新参数：--governance-root、--pigeon-bundle、--pigeon-node-runtime、pigeon-docker 条件）

## 一、现状（动手前）

- 外部 agent 条件已在 main：agent 进程在题目容器里跑，容器接只通网关的内部网络，工具目录只读挂载，diff 可排除路径（stream-external.ts）。
- Pigeon 各条件是进程内跑批：Pigeon 进程在宿主、执行端注入容器（pigeonStepAgent），worker 因此派不了（宿主上没有题目代码的 git 仓库）。
- 实验镜像（strands）里没有 node：node 不在 PATH（docker run 实测 exec 失败）；镜像为 Debian 12、glibc 2.36，用户 stream（uid 10001）。
- 跑批器已有会话跨题保留机制（决策 210、144）：治理根=作业目录，每步会话清单 sessions-<seq>.json，作废移出 voided/，续跑按清单恢复。

## 二、改法（八个提交）

1. `3bd9da9` 产品侧两个改动：`pigeon run --governance-root <目录>`——设置三层、项目 `.mcp.json` 与程序状态锚到治理根，
   工作区只是代码（缺省=工作区根，行为不变；不与 --sandbox 同用）；打包脚本额外出 `dist/deepseek-stream-fn.mjs`
   （自带 DeepSeek 接入的自包含产物，容器里 --stream-fn 指向它）。
2. `8c1cae0` 新内置条件 `pigeon-docker`（stream-pigeon-docker.ts）：dist/ 只读挂载进题目容器（/opt/pigeon-bundle），
   容器里跑产品缺省 `pigeon run --yolo --no-web --json --thinking high`；治理根为每作业一个宿主目录（作业目录下的
   .pigeon/），挂到容器 /pigeon-gov/.pigeon——题目仓库自带的 .pigeon/ 设置与 .mcp.json 不生效，程序状态不进工作区
   的 diff 与判题；作业目录宿主布局与进程内条件一致，每步会话清单、作废移出、续跑原样生效（决策 389：同作业跨题
   保留，作业之间互不相通）。终态判定与进程内条件同一口径（拒答与确定性错误判题，其余 failed 作废重做）；工作方式
   指令与题面拼成任务文本（CLI 无单独指令入口，与启动器协议的先例一致）。身份头 agents.pigeonDocker 记产物摘要、
   自报版本与逐项设置。
3. `56b188d` 外部 agent 配置加可选 settings（自由键值）：原样记进身份与结果行的 agentSettings，设置不同续跑即
   判为不同条件。入库代码保持通用，不含任何 agent 的名字。
4. `fb54565` 路径边界修正（.pigeon 字面量收口到 paths.ts）与真容器测试（见下）。
5. `5d09ee1` Node 运行时只读挂载（/opt/pigeon-node，宿主目录含 bin/node）：实验镜像没有 node，两组都需要；
   挂载不改镜像身份（工具目录只读挂载的同一先例）。pigeon-docker 条件必给 --pigeon-bundle 与
   --pigeon-node-runtime，身份头记 node 的自报版本。网关上游可用 PIGEON_EVAL_GATEWAY_UPSTREAM 改指
   （只供不调真模型的假上游小试）。
6. `8b40a9a` 治理目录权限：作业容器以镜像用户（非宿主用户）写治理目录——宿主侧建目录时放开 0777，容器内运行
   加 umask 000，宿主的作废移出与清理才能动容器写下的会话文件。
7. `9710e11` 启动器的 report 原样进结果行（agentReport）；真容器测试的作废用例断言修正（两题各留一条会话）。
8. `7e748d7` 跑批器条件表用例补上 pigeon-docker；真容器用例的镜像选择器独立（PIGEON_DOCKER_TEST_IMAGE，缺省
   strands——没有 node 正是要测的，与其余套件用的缺省镜像脱钩）；realDockerSkip 可按镜像判；configuration.md
   补 --governance-root 一段。

## 三、测试

按 docs/testing.md：单元层测行为与契约，真容器用例只测容器特有行为。

- 单元（src/eval/stream-pigeon-docker.test.ts，11 项）：容器参数（网络、三个挂载、治理目录宿主布局与
  sessionsDirOf 的契约）、挂载来源路径拒逗号/引号/换行、身份段逐项设置与摘要随内容变化、一步的运行契约
  （提示拼装、--yolo --no-web --json --thinking high、--governance-root、环境映射经网关、HOME 每步隔离、
  产物布局 try-N 不覆盖）、终态判定五分支（completed、empty-reply、拒答判题、infrastructure 与其余 failed
  作废）、没有结果 JSON 作废、墙钟到点杀进程、report 透传。
- 单元（src/cli/run-cli.test.ts 加 1 项）：--governance-root 后会话落在治理根、工作区没有 .pigeon/state、
  工作区自带的须确认配置不生效（不给参数时报错的对照仍在）、与 --sandbox 同用报错。
- 单元（src/eval/stream-external.test.ts 加 1 项）：settings 解析、进身份段、非对象拒绝、续跑时设置不同即拒绝。
- 真容器（src/eval/stream-pigeon-docker-docker.test.ts，3 项， strands 镜像 + 挂载的 Node 运行时 + 假打包产物 +
  假上游）：两题两遍——经网关记轮数、判题 passed、diff 无程序状态、同作业第 2 题看到第 1 题的会话、两遍互不
  相通；作废的题会话移出 voided/、治理目录只留重做的、后面的题检索不到作废那次；--version 自报（产品与 node）。

## 四、变异验证（关键判定，均精确变红、还原逐字一致）

- 程序状态不进 diff：运行脚本去掉 --governance-root → 真容器用例的"diff 无程序状态"断言变红（其余两题照跑）。
- 跨作业隔离：治理目录改为全批共享（不挂作业目录）→ "两遍互不相通"断言变红。
- 作废移出：quarantineSessions 改为不移 → 作废用例"治理目录只留重做的会话"变红。
- 身份设置：externalAgentIdentity 不记 settings → settings 用例变红（本机验证）。

## 五、小试（服务器，假上游，两道 toy 题，两组各一遍）

两组真身（真打包产物、真外部 agent 与启动器）经 runStreams 全流程：4 行结果全 passed；轮数按网关请求数
（pigeon-docker 每题 2，外部组每题 3——它每会话多一次取标题的辅助请求）；diff 干净（无程序状态）；pigeon 组
第 2 题的请求里注册会话检索工具、第 1 题没有（跨题保留生效，作业间互不相通——真容器用例已覆盖两遍隔离）；
外部组每题家目录独立（两题产物里的会话记录互不包含），zstd 会话日志拷进每题产物目录；pigeon 组每步的结果与
标准错误拷进产物目录；治理目录保留两条会话。

外部组启动器与配置（本地，不入库）：锁当时最新发布的精确版本（0.2.1-alpha.1，2026-10-03 发布）；每题独立家目录
（随步新建）；家目录补丁关联网工具（24 件 → 22 件，探测实测）；遥测关；模型地址与占位 key 由启动器从跑批器给的
环境变量映射；落盘会话日志（zstd）拷进每题产物目录；终态按最后的事件判（它收到 SIGTERM 也返回 0）。

## 六、verify

- 本机（Windows）：lint、check（tsc）全绿；快档 1493 项中 1489 通过——4 项失败均为基线既有
  （三个负载敏感的计时用例、一个 Windows 符号链接权限用例，在基线提交上同样失败，与本段改动无关）。
- 服务器（8 vCPU、31 GB，Node 24.12.0）：verify:full 于头提交跑四遍（并发 6 一遍、3 一遍、2 两遍），
  均为 1865 项中 1857 通过、7 跳过、1 失败。唯一失败项是 container-host.test.ts 的"超时与后台作业的停止"
  真容器用例（既有用例，本段未动 execution/）：失败时作业登记为 running 而容器里实际没有它的进程（ps 无
  spawn.sh 与 sleep）；同一时刻在基线提交（0deecc3）单独跑该文件同样失败（连跑三次皆然），手工在容器里
  起后台进程正常；当天早些时候该用例在本分支上单独跑通过过两次。判定为共享验证机的环境性失败，与本段
  改动无关，留待排查。本段新增的全部用例（真容器 3 项、单元若干）在四遍全量中均通过。

## 七、已知边界

- 外部 agent 无条件读工作目录的 .env（无开关），但只填未设置的变量：启动器显式 export 全部条件相关变量，
  .env 覆盖不了；若题目仓库的 .env 声明了启动保留变量，它响亮报错（该题判负，照实）。strands 题目仓库全部
  提交都没有 .env、.pigeon/、.mcp.json，本题集无实际输入。
- 设计笔记里外部 agent 的包名是占位名（npm 上该名是保留占位包）；真包在另一个 scope 下，latest 标签与最新
  发布与笔记一致（rc.2 / 2026-10-03 的 alpha.1）。
- 决策笔记里的权限环境变量在该版本源码里不存在（无人值守 profile 缺省即全放行，探测实测工具不经审批直接
  执行）；配置里照写该变量（无害，备未来版本）。
- 工作方式指令从系统提示段（进程内条件）改为与题面拼成任务文本（容器条件，两组同法）：CLI 没有单独的指令入口。

## 八、回报（转交）

分支 eval-in-container，头提交为本审计的提交；审计 docs/audits/2026-10-05-eval-in-container-0deecc3.md。改法：①--governance-root 与接入模块产物；②pigeon-docker 条件：产物与 Node 运行时只读挂进容器，产品缺省跑法加 --thinking high，治理根挂出题仓（隔离设置与状态、会话按作业保留）；③外部组零入库改动，仅 settings 字段。测试全绿，四处变异变红；小试两组全过；verify 服务器 1865 项仅 1 项既有用例失败（基线同挂，环境性）。裁决：①外部 agent 锁 alpha.1 或 rc.2？②权限变量该版没有（缺省全放行），照写？③指令拼进任务文本？
