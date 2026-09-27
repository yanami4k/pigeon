# 跑批器一：固定起点、条件表与题面（决策 193、194、195、198、212、213、215、216、217、191，基线 0fa108b）

范围：把提交流跑批器从延续式改为固定起点；步的范围改为清单里的题按时间接成一条流；条件表改为记忆的 2 × 2 加最简 agent，Pigeon 侧加会话检索开关与推送记忆开关；题面改为提交信息加应通过的测试名单，人在该步新写或改过的测试与测试辅助文件判题时才放入；补 195 的两处缺口（静态检查按人的配置、清掉 Python 启动时自动加载的文件）；加记忆快照接口。基线为 formal-v2 分支 0fa108b，分支 runner-r2。两类用例、部分得分与校准能力不在本段（跑批器二）；会话文件的布局与按文件操作（sessionFilesOf、quarantineSessions、sessions-<seq>.json）不动。

## 一、提交

| 提交 | 内容 |
|---|---|
| 969e2db | headless 加会话检索开关与推送记忆开关 |
| c6f3535 | 跑批器改为固定起点：每步新开容器、题接成一条流、条件表、题面、判题前清理、记忆快照 |

## 二、固定起点（193、212）

- 每一步由 `envs.open(job, { startCommit: step.parent })` 新开容器：同名旧容器先删，由镜像新起，经 bundle 送入人在该步之前的代码并清历史自验；这一步结束（含作废、停止信号）一律删容器。被 git 忽略的文件、/tmp 与家目录都随容器丢弃，跨步只剩作业目录（治理根）里的会话与记忆。
- 作废重做另开容器，不再在同一工作区里回退；续跑按结果行的断点直接从下一题开工，不再需要流历史。
- 每步存一份 agent 的改动：开工写完环境文件后取一次工作区的树，agent 收工、挪回起点后再取一次，两树之差写到作业目录 `diffs/step-<seq>.diff`，结果行 `diff` 记其相对输出目录的路径。取树用临时索引，不动真的暂存区。
- 全量测量改为判题之后就地进行（容器随即丢弃，不再另建测量副本）：先暂存全部改动，再把测试与测试辅助文件同步成人在该步的全部（agent 新建的删掉），跑人写的全部测试。
- 判题沿用本题测试全过即做成。
- 结果行新增 `start`（即 step.parent）、`diff`、`envOpenMs`（开容器耗时）；`head`、`regressions`、`attribution` 列为旧字段只读兼容，新行不写。
- 身份头 core 新增 `stepScope`（固定起点、题接成一条流）与 `promptFormat`；193 之前的身份头缺这两项，续跑即被拒。

去掉的只为延续式存在的部分：`land`、`rollback`、`discardAttempt`、`takeOver`、`exportBundle`、`prepareMeasureCopy`、`clearArtifacts`、`clearTmpDir`、`removeStaleGitLocks` 九个工作区方法与对应用例；JobState（head、agentPassing、maintenanceCreated）；history.bundle 与 passing-<seq>.json；接管残留容器与由流历史重建；回归统计；失败归因模块 stream-attribution（报告里的回归列与失败归因段随之去掉）；运行方式的 `depsLinks`；环境工厂的 `measureRoot` 与 `tmpDir`；参考工作区恢复时带回开工树引用的一行。

## 三、步的范围（215、216）

`chainedTasks(manifest)` 取清单里全部题、按步序接成一条流，流的标识为 `tasks`；维护步、套用步、跳过步与重置步都不跑，重置点不再切分、记忆不清空。CLI 的 `eval stream` 去掉 `--streams`；`--max-steps K` 改为只跑前 K 道题。strands 清单（manifests-v4）按此得 89 道题。

## 四、条件表与检索开关（193、194、217）

| 条件 | agent | 回炉 | 能否检索 | 推送记忆 |
|---|---|---|---|---|
| search-push | Pigeon | 3 轮 | 是 | 是 |
| search-only | Pigeon | 3 轮 | 是 | 否 |
| push-only | Pigeon | 3 轮 | 否 | 是 |
| neither | Pigeon | 3 轮 | 否 | 否 |
| minimal | 最简 agent | 无 | — | — |

no-gate、full、no-memory 与 memory 开关删除；结果行条件枚举、CLI 的 `--conditions`、身份头同步。

Pigeon 侧：RuntimeDeps、headless 选项（含失败自动分叉重试的透传）与无父会话运行面加 `sessionSearch`（缺省开着，日常使用逐字不变）。关掉时 search_sessions 与 read_session_entry 不注册、不进工具清单与策略，系统提示去掉提到它们的那一句，其余逐字不变；模型硬调时按未注册的工具拒绝。`pushedMemory` 只定义并透传，打开时 headless 在装配前报"推送记忆尚未实现"，不发模型请求；跑批器里推送格的作业因此停下并记下原因。

## 五、题面与扣下的文件（198、213）

- 题面由跑批器现拼：提交信息原文，其后一行英文说明与应通过的测试文件路径（每行一个），不附测试内容。清单里出清单时拼好的旧题面保留在清单中，跑批器不再使用。
- 给用例名的写法留了接口与开关：`--prompt-format test-cases` 与 `RunStreamsOptions.shouldPassCases`。没接上要做到的用例即在读清单、写身份头之前拒绝开跑。
- 开工时只写人在该步的环境文件；人在该步新增或修改的测试文件与测试辅助文件（conftest、夹具等）都不写，判题前随恢复人写测试一并写入。
- 回炉验证前的保护改取 step.parent 的树：`humanTestFiles`、`humanTests`、`humanTree` 都按起点。

## 六、防迎合验证的补口（195 的直接推论）

运行方式新增 `judgeHygiene`（只给 strands），判题前在恢复人写测试之后执行：

- 启动钩子：工作区里（含被忽略的文件）名为 `sitecustomize`、`sitecustomize.*`、`usercustomize`、`usercustomize.*` 的文件或目录，不在人在该步树里的一律删掉。
- 静态检查配置：工作区里名为 pyproject.toml、ruff.toml、.ruff.toml、mypy.ini、.mypy.ini、setup.cfg 的文件，不在人树里的删掉，人树里有的写回人在该步的版本。ruff 与 mypy 的质量计数因此按人的配置运行。
- 家目录：删掉容器里执行用户家目录下的 `.local/lib`（用户级 site-packages）、`.config/ruff`、`.config/mypy` 与 `.mypy.ini`；删不掉按访问障碍作废这一步。只在跑批器起的作业容器里执行（与清进程同一闸门）。

判题命令走镜像 PATH、不带 PYTHONNOUSERSITE，用户级 site-packages 与其中的 usercustomize 在判题时会被加载，故家目录一并清理。

## 七、记忆快照接口（191）

`snapshotOrRestoreLearned(jobDir, seq)`：每步开工前（每次尝试之前）调用。还没有第 seq 步的快照即把 `.pigeon/learned/` 整体复制到 `learned-snapshots/step-<seq>/`（记忆目录不存在也取，记下"没有"）；已有即把记忆目录恢复成它。作废重做与崩溃后续跑都走恢复这一支，与会话的隔离同一时机。快照先写临时目录再改名。

## 八、改写测试时回看的断言

stream-runner.test.ts 的延续式用例逐个按固定起点重写，对照检查了按旧落点或旧时序查证、可能变成恒真的断言：

- 原"落地的历史里被篡改的测试已恢复"改为查第 1 步全量测量的通过数（3/3）：篡改没被还原时 keep 测试失败、通过数变 2/3。
- 原"跳过步沿用上一步的测量""跳过步不落地"随跳过步不再跑而删除。
- 原"测量副本里没有 agent 的测试文件"按 cwd 区分判题与测量；就地测量后两者都不带 cwd，改为按测试清单区分（全量测量含 keep 测试），否则断言恒真。
- 原"下一步开始时判题报告与测量副本都已清空"改为"每步的环境目录用完即删"，直接查环境目录为空。
- 原"停止信号时在途作业的容器留着"语义反转为"照样丢弃"，断言随之改为已丢弃。
- 原"作废重做前丢掉那次尝试在库里的痕迹"保留：新开环境后重做时 reflog 与对象库里都找不到作废尝试的提交。

## 九、开容器耗时粗测

本机 Docker、strands v6 镜像与 strands 仓库，取 89 道题中的第 1、45、89 道（步序 3、126、195）各开一次：

| 步序 | 起点 bundle | 宿主打 bundle | 开容器（含打 bundle、送入、清历史自验） | 删容器 |
|---|---|---|---|---|
| 3 | 32.3 MiB | 6.4 秒 | 22.4 秒 | 2.7 秒 |
| 126 | 33.5 MiB | 4.9 秒 | 23.0 秒 | 3.2 秒 |
| 195 | 34.6 MiB | 8.1 秒 | 30.4 秒 | 1.7 秒 |

每步开加删约 25–33 秒；89 道题每遍约 40–50 分钟花在开容器上。本机当时 CPU 平均占用约 64%，数值偏大，服务器上需另测。

## 十、变异反向验证

在验证服务器上基于 c6f3535 逐个植入，每次只改一处，跑相关测试文件（并发 2），记下变红的用例后以 `git checkout` 还原；14 次还原后工作区均干净，HEAD 仍为 c6f3535。

| 变异 | 位置 | 相关测试文件结果 | 变红的用例 |
|---|---|---|---|
| M1 起点取 step.commit | stream-runner.ts | 49 过 3 败 | 固定起点总用例；全量测量被杀；人写测试改名 |
| M2 每步不丢弃环境 | stream-runner.ts | 50 过 2 败 | 固定起点总用例；停止信号时在途容器照样丢弃 |
| M3 开容器前不删同名旧容器 | stream-runner.ts（dockerStreamEnvs） | 2 过 1 败 | 每步新开干净容器 |
| M4 题面用清单里的旧题面 | stream-runner.ts | 51 过 1 败 | 固定起点总用例 |
| M5 开工写入人在该步的全部文件 | stream-runner.ts | 51 过 1 败 | 固定起点总用例 |
| M6 回炉保护取 step.commit 的树 | stream-runner.ts | 50 过 2 败 | conftest 不影响判题与测量；交给 agent 的人写测试集按起点 |
| M7 判题前不清理 | stream-runner.ts | 51 过 1 败 | 判题前清理（195 补口） |
| M8 启动钩子不看人树 | stream-runner.ts | 51 过 1 败 | 判题前清理（195 补口） |
| M9 静态检查配置不写回 | stream-runner.ts | 51 过 1 败 | 判题前清理（195 补口） |
| M10 不取或恢复记忆快照 | stream-runner.ts | 51 过 1 败 | 记忆快照（191） |
| M11 清家目录不看闸门 | stream-workspace.ts | 21 过 1 败 | 闸门：不在作业容器里不动家目录 |
| M12 检索开关失效 | runtime.ts | 28 过 2 败 | 会话检索开关；Pigeon agent（neither）工具清单 |
| M13 步 agent 不交检索开关 | stream-agents.ts | 26 过 1 败 | Pigeon agent（neither）工具清单 |
| M14 推送记忆不报错 | headless-core.ts | 28 过 2 败 | headless 推送记忆报错；推送格的步 agent 报错 |

M3 的相关测试为 stream-envs.test.ts；M11 为 stream-workspace.test.ts；M12、M14 为 session-search-switch.test.ts 与 stream-agents.test.ts；M13 为 stream-agents.test.ts；其余为 stream-runner.test.ts。

## 十一、verify 的实际运行情况

- 服务器：8 vCPU、31 GB 内存，Node 24.12.0，有 Docker 与 busybox 镜像、无实验镜像（需要实验镜像的真容器用例自动跳过）。在 c6f3535 上依次跑 lint、类型检查、`node --test --test-concurrency=2 "src/**/*.test.ts"`、分层检查：全部通过；测试 1017 个，通过 1013，失败 0，跳过 4，测试步 125 秒；分层 386 个模块无违规。
- 同一提交单跑 stream-agents.test.ts：29 个，通过 27，跳过 2。
- 本机（Windows，CPU 被其他进程争用）：stream-runner.test.ts 51 个全部通过、跳过 1；stream-agents.test.ts 与跑批器测试同时跑时有 9 个失败，单看其中一个为用例里的 `sleep 60` 在用例跑到 71 秒时已自然退出（机器过慢所致），同一文件在服务器上全部通过。正式结论以服务器结果为准。

## 十二、待裁决

1. 题面里名单前那一行说明的措辞（现为英文，说明名单里的测试是新写或改过的、最终版本不在工作区里、检查时才放入）：是否保留这层说明、是否定稿后冻结。
2. 报告的终点值与补跑提示（146）仍按延续式口径计算，固定起点下终点只是最后一题的全量通过率；是否留到跑批器二随 196、201 的计分一并重做。
3. 每步开容器约 25–33 秒（本机粗测）：是否接受；或另做"按提交缓存 bundle、预热容器"等加速。
4. 家目录清理只删用户级 site-packages 与 ruff、mypy 的用户级配置；是否再扩到 `PYTHONSTARTUP` 指向的启动文件一类（这类只在交互式解释器生效，判题不走）。
