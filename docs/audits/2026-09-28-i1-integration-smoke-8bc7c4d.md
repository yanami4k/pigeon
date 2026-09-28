# 大服务器装环境与集成冒烟（I1，基线 8bc7c4d）

范围：新机 pigeon-run 装环境、从 pigeon-verify 传入实验镜像与基线、全量 verify；在 pigeon-run 上用真实 DeepSeek 跑四格加最简 agent 的集成冒烟（花费上限、续跑、花费核对）；在 pigeon-verify 上用假模型跑沙箱并行冒烟。冒烟代码为 formal-v2 的 0bc6e6a；分析脚本读冒烟输出时的代码为 formal-v2 的 8bc7c4d（相对 0bc6e6a 只多 eval/analysis 与审计，`src/` 无差异）。时间均为 UTC。

## 一、新机环境

- 规格：阿里云 ecs.g9ae.4xlarge，16 vCPU（AMD EPYC 9T95，每核 1 线程），64 GiB 内存，Ubuntu 24.04.5 LTS，内核 6.8.0-139。
- 系统盘 40 GiB；数据盘 200 GiB（`lsblk` 确认为空盘）格式化为 ext4、卷标 pigeon-data，挂到 `/data`，按 UUID 写入 `/etc/fstab`，选项 `defaults,nofail`；用 `mount -a` 验证能挂上，未重启。
- Docker 29.8.1（阿里云 docker-ce 源），containerd v2.3.6；`/etc/docker/daemon.json` 设 `data-root` 为 `/data/docker`，`docker info` 的 Docker Root Dir 为 `/data/docker`；登录用户已加入 docker 组。
- Node v24.12.0（npmmirror 的 Node 镜像，与 pigeon-verify 同版本），npm 11.6.2，git 2.43.0。
- 工作目录全部在 `/data/pigeon` 下：`code`（代码）、`baseline`（基线）、`inputs`（清单与人的 strands 仓库）、`mini-venv`（最简 agent）、`analysis-venv`（分析脚本）、`smoke`（冒烟输出）。
- 最简 agent：系统 Python 3.12.3 建虚拟环境，mini-swe-agent 2.4.6、litellm 1.102.1。国内 PyPI 镜像没有这两个版本，官方源下载超时，改为另机下载 manylinux wheel 后离线安装。`run_mini.py --identity` 输出的版本与模型参数与此前审计记录一致。
- 分析脚本：deadsnakes 源装 Python 3.13.15，按 `eval/analysis/requirements.txt` 钉死的版本安装（国内镜像缺 pytz 2026.4，同样改用离线 wheel）。
- DeepSeek key 文件：由项目负责人放置；只用 `test -s` 确认存在且非空，运行时 `set -a; . <文件>; set +a` 读入，未打印、未拷贝。

## 二、传输

旧机到新机的内网直传需要本机转发 ssh 代理，这种做法在本次操作权限内未获准，因此全部改由本机中转（旧机 `docker save`/`tar` → zstd 压缩 → 本机 → 新机解压、`docker load`/`tar -x`）。旧机上只做只读导出，未删改任何文件。

| 内容 | 耗时 | 核对 |
|---|---|---|
| `pigeon-stream-pigeon:v4` | 27 秒 | 镜像 ID 8a6ff93dc0a4 与旧机一致；`imageIdentityOf` 两机均为 `layers:sha256:5ee7a7a8…` |
| `pigeon-stream-strands:v6` | 340 秒 | 镜像 ID 6f3dbdd2cb48 与旧机一致；`imageIdentityOf` 为 `layers:sha256:ebe5a527…`，与 `STRANDS_V6_LAYERS` 一致 |
| 基线目录（268 个文件）、清单 `strands.json`、人的 strands 仓库 | 11 秒 | 基线全部文件的摘要汇总、清单 sha256 两机一致；仓库 HEAD fec042766，工作区干净 |
| `busybox:latest`（真容器测试用） | 数秒 | 载入成功 |

代码：本机从 formal-v2 打 git bundle，传入后检出 0bc6e6a，`npm ci`（257 个包）；做分析那一项前 fetch 并检出 8bc7c4d。两次检出后 `git status --porcelain` 均为空。

## 三、verify（pigeon-run，0bc6e6a，测试并发 8）

- 第一次：lint、tsc、depcruise 通过；测试 1133 条，1128 通过、1 失败、4 跳过。失败为 `src/application/fork-session.test.ts` 的"/fork 命令：解析 --at 与新输入…"：`Run 号前缀 … 不唯一（2 个）`。跳过的 4 条中 2 条因本机没有 busybox，2 条为仅 Windows 的 `.cmd` 用例。
- 补载 busybox 后第二次全量：lint、tsc、depcruise 通过；测试 1138 条，1136 通过、0 失败、2 跳过（仅 Windows 的 `.cmd` 用例）。测试步用时约 67 秒，全程约 80 秒。
- `/fork` 那条失败单独重跑 20 次，全部通过。原因：Run 号由单调 ULID 生成（`src/state/ids.ts` 的 `monotonicUlid`），两次 Run 在同一毫秒内开始时，后一个只在随机段末位加一；该用例取"去掉末 2 位"作为前缀，两次 Run 就落在同一前缀下。满载并发时快机器更容易让两次 Run 落在同一毫秒。这是测试写法对时序的依赖，不是新机环境问题（见第八节）。

## 四、集成冒烟（pigeon-run，真实 DeepSeek，代码 0bc6e6a）

### 4.1 四格加最简 agent

命令要点：`pigeon eval stream --manifest <清单> --repo <人的仓库> --image pigeon-stream-strands:v6 --out <main> --baseline <基线目录> --conditions search-push,search-only,push-only,neither,minimal --tasks 1,2,6 --concurrency 5 --max-turns 300 --wall-clock-min 60 --compact-threshold 30000 --compact-keep 10000 --spend-limit-cny 10 --mini-python <mini-venv 的 python>`。题 1、2、6 分别为步 3、8、21（要做到的 16、49、22 条）。第 4.3 节的中断续跑也在这个目录里完成。

结果行（15 行，每格每题一行；分数为要做到的通过数 / 总数，不许挂为挂掉数 / 总数）：

| 格 | 步 | 要做到的 | 不许挂 | 部分得分 | status | costCny | reviewCostCny | peakInputTokens | 复盘（收尾/压缩前） |
|---|---|---|---|---|---|---|---|---|---|
| search-push | 3 | 11/16 | 0/5470 | 0.6875 | completed | 0.2923 | 0.2245 | 29910 | 1 / 5 |
| search-only | 3 | 11/16 | 0/5470 | 0.6875 | completed | 0.4025 | null | 29591 | — |
| push-only | 3 | 0/16 | 0/5470 | 0 | completed | 0.2160 | 0.0969 | 29868 | 1 / 3 |
| neither | 3 | 10/16 | 0/5470 | 0.625 | completed | 0.2306 | null | 30015 | — |
| minimal | 3 | 0/16 | 0/5470 | 0 | failed | 0 | null | 0 | — |
| search-push | 8 | 0/49 | 0/5477 | 0 | completed | 0.2476 | 0.1952 | 30072 | 1 / 4 |
| search-only | 8 | 0/49 | 0/5477 | 0 | completed | 0.5796 | null | 29878 | — |
| push-only | 8 | 0/49 | 0/5477 | 0 | completed | 0.3721 | 0.2724 | 31289 | 1 / 5 |
| neither | 8 | 0/49 | 0/5477 | 0 | completed | 1.3214 | null | 30054 | — |
| minimal | 8 | 0/49 | 0/5477 | 0 | failed | 0 | null | 0 | — |
| search-push | 21 | 4/22 | 0/5549 | 0.1818 | completed | 0.4617 | 0.4827 | 31351 | 1 / 8 |
| search-only | 21 | 10/22 | 1/5549 | 0.4545 | completed | 1.1956 | null | 30096 | — |
| push-only | 21 | 4/22 | 0/5549 | 0.1818 | completed | 0.2866 | 0.2005 | 29482 | 1 / 5 |
| neither | 21 | 7/22 | 0/5549 | 0.3182 | completed | 0.7468 | null | 30088 | — |
| minimal | 21 | 0/22 | 0/5549 | 0 | failed | 0 | null | 0 | — |

逐项核对：

- **结果行与判题**：每格每题都有一行；判题按要做到的与不许挂两类给出，部分得分为要做到的通过比例；没有撞每步上限的行（`hitStepBudget` 均为 false）。
- **题 2（步 8）四格均为 0/49**：人的测试文件 `test_audio.py` 在模块顶层导入人在同一提交里新建的模块 `strands.experimental.bidi.audio`。四格的改动都只改了 `bidi/io/audio.py` 和文档，没有建这个模块，整文件收集失败，49 条全部判失败。智能体自己的验证门判 pass（`finalVerdict: pass`）。这是模型的真实结果，不是判题缺陷。
- **计费**：`gateway.costCny`、`reviewCostCny`、`peakInputTokens` 均为真实值；推送两格每行的 `reviewCostCny` 都大于 0，非推送格为 null。各步 `peakInputTokens` 在 29482 到 31351 之间，与 3 万的压缩触发点相符。
- **复盘**：推送两格每步都有一次收尾复盘，另有压缩前复盘；`review.failures` 为空，没有撞复盘上限。session 文件里，run-start 条目带 `memoryReview` 的分叉复盘文件：push-only 为收尾 3 个、压缩前 13 个；search-push 为收尾 3 个、压缩前 17 个。
- **MEMORY.md**：写在各作业治理根的 `.pigeon/learned/MEMORY.md`，push-only 6 条（4226 字符），search-push 8 条（3910 字符）。格式为文件头加每条三行（`- [L<编号>] 事实：…`、`  引用：…`、`  理由：…`）；结果行 `memoryAtEnd.entries` 逐步增长（search-push 为 4 → 7 → 8）。
- **压缩**：session 文件里的 `compaction` 条目数为 neither 26、search-only 26、push-only 63、search-push 98，推送格每步都有多次真实压缩。推送格的压缩前复盘在压缩之前执行，留有分叉复盘文件，结果行 `review.preCompaction` 大于 0。
- **工具清单**（各格 agent session 文件 run-start 的 `advertisedTools` 合集）：
  - search-push：`edit_file, read_file, read_session_entry, run_command, search_sessions, update_memory`
  - search-only：`edit_file, read_file, read_session_entry, run_command, search_sessions`
  - push-only：`edit_file, read_file, run_command, update_memory`
  - neither：`edit_file, read_file, run_command`
  - 两件检索工具只出现在检索两格；各格都没有派 worker 的工具。formal-v2 在 0bc6e6a 与 8bc7c4d 都未并入派 worker 的一段，代码里没有该工具。
- **最简 agent**：三步都是 `status: failed`，`exitStatus: BadRequestError`，1 轮，用量为 0，没有正常交卷。原因见第八节第 1 条，已知缺陷，另行修复。
- **身份头**（`identity.json`）：
  - `info.harness` 为 `{commit: 0bc6e6a, dirty: false}`，各结果行的 `harnessRef` 相同。
  - 压缩配置为窗口 1000000、预留 16384、保留 10000、触发点 30000；记忆上限 12000 字符；复盘模板 v1，复盘上限 40 轮、15 分钟。
  - 模型为 deepseek-flash，温度 0，关思考，单次输出上限 16384；最简 agent 为 mini-swe-agent 2.4.6、litellm 1.102.1；每步上限 300 轮、60 分钟；选题 `{method: list, tasks: [1, 2, 6]}`，题面格式 test-files。
  - 身份头里没有"派 worker 关"一项（代码里没有该字段，原因同上）。
- **分析脚本**：代码 8bc7c4d，`python -m pigeon_analysis calibration --results <main>/results.jsonl --out <calibration>` 退出码 0，读入结果行 15 条，写出 `report.md` 与 `result.json`。报告各节（难度关、花费、上下文峰值、每步宽上限、记忆上限、复盘上限、设计灵敏度、临时值核对）均有输出。由于最简 agent 失败，报告里 C_M 为 0。

### 4.2 花费上限

另起输出目录，命令为 `--conditions neither --tasks 1 --max-steps 1 --concurrency 1 --spend-limit-cny 0.02`，其余参数同上。

- 开跑约 10 秒后，累计达到 ¥0.0222（10 个请求，含开跑前探测），日志打印 `[限额] 模型花费累计 ¥0.02，已到上限 ¥0.02：跑批停下，不再发请求…`。在途的步 3 作废，session 移入 `voided/tasks-neither-1/`，作业日志为"完成到第 — 步；停止：模型花费累计…"，退出码 3，没有残留容器。
- 作废的步不写结果行，因此该目录没有 `results.jsonl`，花费只记在 `gateway-spend.json`。
- 同一目录再跑一次：开跑前即报 `模型花费累计 ¥0.02 已到上限 ¥0.02：拒绝开跑（调高上限后续跑）`，退出码 1，没有新增请求。

### 4.3 中断与续跑

- 在主冒烟四格都跑到步 8 中途时（12:01:10），向跑批进程发 SIGTERM（跑批只处理 SIGTERM）。
- 日志：各作业"停止：收到 SIGTERM：在途的步作废，跑批停下…"，四个在途的步 8 作废，移入 `voided/tasks-<格>-1/step-8-attempt-1`；各作业"完成到第 3 步"；退出码 3；容器全部移除。此时累计花费 ¥1.8763（535 个请求）。
- 同一输出目录重跑：各作业从步 8 开始，步 3 不重做；代码版本核对放行（不打日志，未报错）。之后跑完步 8、21，退出码 0，各作业"完成到第 21 步"。

### 4.4 花费核对

- 主目录 `gateway-spend.json`：累计 ¥8.2388，1630 个请求（含两次开跑前探测和作废的步 8 的请求）。结果行 `costCny` 合计 ¥6.3529，`reviewCostCny` 合计 ¥1.4722，两项共 ¥7.8251；与累计值相差的 ¥0.41 为作废的步 8 与探测请求的花费，这部分不进结果行。
- 花费上限目录：¥0.0222，10 个请求。
- 冒烟总花费：¥8.2610，未超过 ¥15。
- 请求时刻：网关不记逐请求日志；以各 session 文件里 assistant 消息的时间戳为准，共 3123 条，首条 11:52:53、末条 12:26:19。每分钟条数：11:52 71、11:53 387、11:54 192、11:55 110、11:56 62、11:57 31、11:58 4、11:59 6、（12:01 中断）、12:02 329、12:03 205、12:04 155、12:05 160、12:06 86、12:07 77、12:08 45、12:09 113、12:10 176、12:11 181、12:12 218、12:13 158、12:14 99、12:15 36、12:16 10、12:17 16、12:18 49、12:19 50、12:20 20、12:21 20、12:22 27、12:23 12、12:24 3、12:25 14、12:26 1。另外，花费上限测试的请求在 12:02:38 到 12:02:50 之间；最简 agent 被上游拒收的请求不计费，不在上述计数内。

## 五、沙箱并行冒烟（pigeon-verify，假模型，代码 0bc6e6a）

- 在专属目录里建一个小仓库（一个提交），用通用镜像 `pigeon-sandbox:30145c7527e6`（未重建），同时起 3 个 `pigeon run --sandbox --verify-command "test -f smoke-<X>.txt" --json`。
- 假模型按请求分派：干活时用 run_command 在容器里写 `smoke-<X>.txt`，收尾复盘时用 update_memory 写一条。不调用真实模型接口。
- 3 个运行退出码均为 0，`status: completed`，验证 pass，各有一次收尾复盘（completed，2 轮）。
- 3 条 `pigeon/sandbox-<session 号>` 分支都已交回，各含本运行的 `smoke-<X>.txt`（内容分别为 made-A、made-B、made-C），没有串写。宿主工作区只多出 `.pigeon/`。
- 宿主 `.pigeon/learned/MEMORY.md` 有 L1、L2、L3 三条，分别来自 B、C、A，编号不重复，每条三行格式完整，没有写乱。
- 结束后 `docker ps -a --filter label=pigeon.sandbox` 为空，`pigeon sandbox list` 报告"没有残留的沙箱容器"。

## 六、提交号

- 冒烟与 verify：0bc6e6a（formal-v2，无未提交改动）。
- 分析脚本读冒烟输出：8bc7c4d（formal-v2，无未提交改动）。

## 七、未做或偏离说明

- 旧机到新机的传输未走内网直传，改由本机中转（原因见第二节）；镜像身份、基线与输入的核对均通过。
- 最简 agent 一格未能验证"正常交卷"（见第八节第 1 条）。
- 身份头里的"派 worker 关"一项无从核对：formal-v2 尚未并入派 worker 的一段。

## 八、发现的问题

1. **最简 agent 的请求被 DeepSeek 拒收（代码缺陷，另开修复）**
   - 现象：litellm 1.102.1 经 anthropic 线路发出的请求里，工具带 `"type": "custom"`，DeepSeek 的 Anthropic 兼容端点返回 400：`tools[0]: unknown variant 'custom', expected 'web_search_20250305' or 'web_search_20260209'`。litellm 退避重试 4、8、16、32、60 秒后放弃，结果为 `exitStatus: BadRequestError`，三步都失败。
   - 复现：在装有上述版本的解释器下，带 DeepSeek key 跑 `pigeon eval stream --conditions minimal --tasks 1 --max-turns 5 --mini-python <解释器>`。
   - 另外，litellm 启动时去 GitHub 拉价目表超时，退回本地备份，只是警告。
2. **`/fork` 解析用例依赖时序（测试缺陷）**
   - 现象：`fork-session.test.ts` 的"/fork 命令：解析 --at…"在满载并发下偶发失败，单独重跑 20 次全过。
   - 原因：两次 Run 在同一毫秒内开始时，单调 ULID 只差末位，用例取"去掉末 2 位"作为前缀，前缀就不唯一。
   - 复现：让两次 `adapter.run` 落在同一毫秒内（例如把时钟固定），再用 `slice(0, -2)` 的前缀调用 `resolveForkPoint`。
3. **新机镜像层落在系统盘（环境问题，已处理）**
   - 现象：Docker 29 缺省用 containerd 镜像存储，`data-root` 只管 `/data/docker`，镜像层实际在 `/var/lib/containerd`（17 GiB），系统盘已用 20 GiB / 40 GiB（54%）。
   - 影响：再载入镜像或积累容器可写层会占满系统盘。
   - 处理（12:44:09 至 12:45:29 前后，经项目负责人授权另行执行）：
     - 迁移前确认没有容器和跑批进程在跑，记录三个镜像的 Id 与 RootFS 各层摘要。
     - 停 `docker.socket`、`docker`、`containerd`，用 `rsync -aHAX --numeric-ids` 把 `/var/lib/containerd` 复制到 `/data/containerd`（17 GiB，耗时 37 秒）。
     - 在 `/etc/containerd/config.toml` 顶部加 `root = "/data/containerd"`，原文件备份在 `/data/migrate`；`containerd config dump` 显示 root 已生效。
     - 起服务后核对：三个镜像（`busybox:latest`、`pigeon-stream-pigeon:v4`、`pigeon-stream-strands:v6`）的 Id 与各层摘要和迁移前逐一一致；三个镜像各起一次容器均正常（Python 3.13.15、Node v24.12.0）。核对无误后删除旧目录。
     - 结果：系统盘已用 20 GiB → 3.5 GiB（54% → 10%），`/data` 已用 2.1 GiB → 19 GiB。跑批器不往 `/tmp` 写大文件；主目录下 npm 与 pip 缓存约 160 MB，留在原处。
4. **作废的步的花费不进结果行（记录）**：中断或撞上限作废的步所发请求计入 `gateway-spend.json`，但不写结果行。本次两者相差 ¥0.41。按结果行汇总花费会低于网关累计值。
5. **验证命令超时只终止直接子进程（产品缺陷，正式跑不受影响）**
   - 现象：`src/execution/check-command.ts` 的超时终止在非 Windows 平台只杀直接子进程 `sh`，`sh` 再起的进程成为孤儿继续运行（Windows 用 `taskkill /T` 整树终止）。
   - 表现：`check-command.test.ts` 的超时用例每次全量 verify 都会漏下一个 `node hang.mjs`，其工作目录是已删除的 `/tmp/pigeon-check-*`。pigeon-run 上两次 verify 留下 2 个，未清理。
   - 影响范围：正式跑不受影响，因为容器执行端超时会重启容器，整棵进程树一并终止。只影响不开沙箱、验证命令在本机执行的用法。冻结后在产品线修。
