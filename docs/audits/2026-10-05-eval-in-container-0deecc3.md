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

## 九、续：worker、合并与小试

- 基线：7708e32；合并进 2cd847a（会话检索 v2、网关逐请求留存与高峰暂停、缺省开思考、DeepSeek 允许空签名）
- 依据：决策 380、385、389、390、392、395–397；测试照 docs/testing.md（决策 370）；不侵入 pi 的内部（决策 364）

### 1. 提交

1. `89db2c3` 假上游改指（PIGEON_EVAL_GATEWAY_UPSTREAM）只认回环地址，报错不回显地址；用了即在身份头核心记
   gatewayUpstreamOverride: loopback，与真跑不是同一身份、互不续跑。
2. `7708e32` 环境探测的"工作区是 git 仓库"改探工作区根：给了 --governance-root 时治理根不是代码仓库，
   派 worker 一组与 orchestrate 原先不注册。
3. `c1a3f1f` 治理根与工作区根分开时 worker 可用（见 2）。
4. `5c21ef3` 合并 2cd847a（见 3）。
5. `6765c14` `pigeon eval stream` 登记 --pigeon-node-runtime（见 4）。
6. `bf3717c` 打包脚本加 --out；worker 的真容器用例（见 5）。

### 2. 一份未提交改动（5 个文件）的处理

- 意图：spawn_worker 派出前的 git 检查改看工作区根（--governance-root 时治理根不是 git 仓库，派出被拒为 not-git）。
- 问题：只改了调用方的传参，接口里仍要求治理根（类型检查不过）；且只覆盖派出前检查——起点快照、建工作树与分支、
  explorer 的就地工作区、范围路径查验、take_worker 的叠回与受保护路径仍按治理根，两根分开时同样走不通
  （快照与叠回对着非 git 目录，explorer 读的是治理目录）。
- 处理：修正后保留并补全（`c1a3f1f`）。编排器另收工作区根（git 仓库，缺省同治理根）：快照、建工作树与分支、
  explorer 的就地工作区、范围路径、叠回与 git 检查走工作区根；会话、设置、沙箱镜像与工作树目录（治理根的
  .pigeon/state/worktrees）仍在治理根下。派 worker 的工具槽与 take_worker 只用得到工作区根，接口里只留它。
  脚本编排同一处理（开跑前检查、主目录快照、收回叠加与收回请示走工作区根，会话与沙箱镜像走治理根）。
  两根相同（终端界面、日常 pigeon run）时行为不变。

### 3. 合并

- 冲突两处：eval stream 的自有参数表（--pigeon-bundle 与留存、高峰暂停的参数并存）；stream-experiment.ts 的
  导入与网关之后的装配（留存与高峰暂停先开，内部网络在有外部 agent 条件或 pigeon-docker 条件时建）。
  stream-identity.ts 自动合并（会话检索版本与 info 的留存、高峰两项都在）。
- 留存与高峰放行不分条件：每步的 retainStep 与放行（limits.acquire）都在跑批器每步的公共路径上
  （runAdmittedAgent 及其前一行），pigeon-docker 与外部 agent 条件同样经过；小试实测两组都有逐步留存、
  都等过高峰放行（见 6）。
- 思考档位：容器里的 pigeon run 仍显式给 --thinking high（产品缺省现在也是 high），身份段 settings 照记
  command 与 thinking: high；源码注释改为现状。

### 4. 另修

- `pigeon eval stream` 读取 --pigeon-node-runtime 的值，但没把它登记为本命令的自有参数，该参数被当作模型参数
  交走，命令行起不了 pigeon-docker 条件（5d09ee1 起即如此）。登记并写进用法；顺带删去一个未用的导入。

### 5. 测试

- 单元（spawn-worker-headless.test.ts 加 1 项）：治理根与工作区根分开时，implementer 的工作树建在治理根下、
  起点快照的引用在工作区仓库里删掉、take_worker 叠回工作区；explorer 读到工作区的文件；工作区里没有 .pigeon/。
  其余既有用例只随接口改名。
- 真容器（stream-pigeon-docker-docker.test.ts 加 1 项）：打包脚本加 --out，用例按当前源码打一份真产物到临时
  目录；假上游按请求带的工具分辨主 agent、implementer 与只读 explorer，按会话进展回话（派出两个 → 通知到了
  take_worker → 收尾）。断言：主 agent 注册了 spawn_worker 与 take_worker；判题 passed；diff 含 src/a.txt、
  不含 .pigeon、worktrees 与治理挂载点；作业治理目录的工作树目录下只有 w1 一项、属主为镜像用户（与镜像里
  id -u 一致）、内有 worker 写的文件；explorer 的工具结果是工作区里起点就有的文件内容（不建工作树）。
- 变异：工具环境探针的 git 工作区判定改回探治理根 → 该用例在"主 agent 注册派 worker 的工具"一条变红（主 agent
  的工具表里没有 spawn_worker、take_worker）；还原后 git diff 无输出，整个文件 4 项全绿。

### 6. 小试（服务器，假上游，假 key）

- 两组各两道 toy 题跑 runStreams 全流程：合并后头提交打的真产物（pigeon-docker）、真外部 agent 与启动器；
  网关按 runStreamExperiment 的同一接法开留存（缺省上限）与高峰暂停；高峰判定换成"开跑后约半分钟内算高峰"
  （余量 0），使两组的第 1 题都要等放行。
- 结果：4 行全 passed；diff 无程序状态；轮数 pigeon-docker 每题 2、外部组每题 3；两组作业目录每题都有
  gateway/step-N/try-1/，请求与回复行数都等于轮数；两组第 1 题都等放行约 57 秒，peak-pauses.jsonl 记暂停、
  恢复各一条；pigeon 组第 2 题注册会话检索、第 1 题没有，治理目录保留两条会话；外部组两题的会话日志拷进产物目录。
- 留存里的鉴权头与 key：对两组的 gateway/ 用 grep -l（明文）与 zgrep -l（gz）查 x-api-key、authorization、
  账号 key 与占位 key：pigeon 组无命中；外部组两个 requests.jsonl 命中 authorization，是外部 agent 请求体里
  组件清单中的一个包名，不是请求头或 key。整个输出目录查账号 key 与 x-api-key 无命中。输出目录随后删除。

### 7. 小试的 key 与日志

- 此前的两份小试脚本（两组小试、未跑完的 worker 小试）都在进程内起网关，账号 key 是脚本里写死的假值，没有
  载入任何 key 文件；假上游只在内存里记请求体，不记请求头，不写日志文件。本次小试同样。
- 服务器上本分支的三个工作目录用 grep -l 查 x-api-key、authorization 与 api key 一类字样（排除 node_modules、
  src 与 .git）：命中都是入库的源码与文档、打包产物、Node 发行包自带的文件、外部 agent 启动器脚本与锁文件，
  没有记录请求头的日志或数据文件，无需删除。此前小试的临时输出目录已不在。

### 8. 外部 agent 的本地配置（不入库）

- 去掉第七节所说该版本源码里不存在的权限环境变量，连同 settings 里与之对应的权限模式一项（不记没生效的设置）；
  该版本无人值守缺省即全放行，行为不变，身份段随之与上次小试不同。

### 9. 磁盘估算

- strands 题目仓库：区间起点 2290 个跟踪文件、22.4 MiB，终点 2516 个、24.9 MiB；检出到 ext4 上实占 30 MB、
  33 MB（按提交解包实测）。
- 一个干活的 worker（implementer、tester）的工作树约 33 MB；只读 explorer 不建。工作树目录里只有检出的文件与
  一个 .git 指针文件，索引与工作树元数据在容器里的仓库 .git 下、随容器删除；worker 运行中生成的文件（构建产物、
  缓存）另计；只通网关的网络下下载不了依赖。
- 一条流（一个作业）79 题，按产品行为不自动清理（作废重做的步留下的也不清），按每题派出的干活 worker 数 k：
  k=1 约 2.6 GB，k=3 约 7.8 GB，k=8（一次派满同时在跑的上限）约 21 GB。产品不设每次运行的派出总数上限
  （决策 300），没有硬上界。同一磁盘上的多个 Pigeon 作业（两遍、多条流）相加；另有网关留存每作业至多 512 MiB。
  验证机系统盘余量约 25 GB：k≥3 时单个作业即占去三成以上。

### 10. verify

- 服务器（8 vCPU、31 GB，Node 24.12.0）于 bf3717c 跑 verify:full（测试并发 6，给了 Node 运行时目录，真容器
  用例实际运行）：lint 无错误（3 条警告均为既有）、check 通过；329 个测试文件、1891 项中 1884 通过、7 跳过、
  0 失败；deps 无违规。第六节那条 container-host 真容器用例本次通过。
- 本机（Windows）：check 通过；只跑改动涉及的测试文件（application 下 12 个文件 70 项、stream-experiment.test.ts
  11 项），全过。

### 11. 回报

头提交为本审计的提交（代码 bf3717c）。补丁意图是两根分开时派 worker 看工作区根，不完整，补全后保留（c1a3f1f：
快照、工作树、explorer、叠回走工作区根）。合并 2cd847a：两组每步经留存与高峰放行，容器仍显式 --thinking high。
另修 --pigeon-node-runtime 未登记。worker 真容器用例全绿，撤 7708e32 变红。key：小试只用假 key，无 key 文件与
请求头日志，未删。磁盘：工作树约 33 MB，一条流每题 k 个约 2.6×k GB，无硬上界。小试两组 4 题全过，留存无鉴权头
与 key。verify:full 服务器全绿。待裁决：工作树占盘——A 维持，试跑后定；B 判完即删；C 放数据盘。
