# M6.5 开工裁决（2026-09-14 起）

- 定位：M6.5 Eval 冒烟（046 已定方向）开工前六件小口径：1 headless 运行入口、2 任务目录格式、3 验证器接口、4 手写 Skill 候选与保留任务集、5 结果落哪、6 会话数膨胀是否前置。逐件盘、逐件裁决
- 裁决：项目负责人；基线 8e76567（M5.7 收口与文档入库）
- 随首个代码提交顺手做：源码注释的口语化措辞统一为中性措辞；架构审计建议的迁移完整性测试

## 第 1 件：headless 运行入口 = C 进程内 API 加 `pigeon run` 薄壳（索引 056）

### 事实

- cli 现有 trace / replay / sessions / resume 四个子命令，运行参数 --root、--stream-fn、--yolo、--thinking、--provider、--model；cli 主体是交互式 REPL（读一行、执行、打印、等下一行），tui 是全屏面板，两者都要有人在场
- M5.5 的 createWorkerRuntimeFactory 能在进程内不经任何 Actor 装出完整运行面并跑到收尾，带轮次与墙钟上限；无审批通道时 fail-closed 拒绝（006）已存在

### 三个子项

| 子项 | 选项 | 取 |
|---|---|---|
| 入口形态 | A 新子命令 / B 只做进程内 API / C 两者，子命令是 API 的薄壳 | C |
| 无人值守下的审批 | 只允许 yolo / prompt 但一律 fail-closed / 固化规则加 yolo | 三种都合法由参数决定，缺省 prompt 加 fail-closed，Eval 任务显式 --yolo |
| "本该审批几次" | 不算 / 从回执反推 | 从回执反推：write 与 exec 档且 approvedBy 为 policy:yolo 的调用数 |

### 先例与复杂度

- Claude Code `claude -p`、Codex `codex exec`：一段提示、跑完退出、可选 JSON 输出
- API 约 80 行、壳约 120 行、测试约 150 行

## 第 2 件：任务目录格式（索引 057）

- 先例：Terminal-Bench 一任务一目录（说明、测试脚本、环境声明、可选解法）；SWE-bench 一张总表（仓库提交号加测试补丁）；共同点是说明、快照、验证器三件套
- 四个子项：目录布局（一任务一目录 / 总表 → 目录，放 eval/tasks/<id>/ 入库）；快照（复制目录 / git 引用 / 镜像 → git 引用经 WorkspaceProvider）；元数据字段（id、说明、repo 与 ref、预算、验证器命令与超时、tags、holdout）；验证器怎么跑（模型经 run_command / runner 收工后独立跑 → runner）
- 写死两条：验证脚本只看工作区最终文件；每个任务自带 README 记来源与许可

## 第 3 件：验证器接口（索引 058）

- 三个子项：返回形状（只看退出码 / 退出码加 JSON → 退出码三值为主、JSON 可选）；误成功定义（不定义 / 自报完成但验证失败 / 违反任务约束 → 两层，M6.5 做第一层留第二层接口）；验证器自身证据（不记 / 记进账本 → eval.verified 观察族）
- 自报完成取账本现成信息：末轮 assistant 正常 stop 且无未闭合工具错误，不造特殊标记
- 先例：SWE-bench / Terminal-Bench 退出码加测试日志；误成功是路线图自提指标

## 第 4 件：手写 Skill 候选与保留任务集（索引 059）

- 澄清两点：手写 = 由人写、不经自动管线，内容从审计里的真实失败提炼；M6.5 不做自动提炼是 §5 既定顺序，M6 Reviewer 出候选、M7 蒸馏紧接其后，runner 与任务集是它们共用的设施
- 四个子项：候选放哪（独立暂存目录 / 同目录加 status → 暂存目录）；三条件怎么切（手工改目录 / headless 传 skillRoots → skillRoots）；Skill 内容来源（凭空 / 真实失败提炼 → 真实失败）；任务集与保留集（全用 / 留 2 到 3 个 holdout → holdout）
- 每任务每条件 3 次，5 到 10 任务共 45 到 90 次运行

## 第 5、6 件：结果落哪与会话数膨胀（索引 060）

- 三个子项：结果表（入库 / 本地 → 入库 results.jsonl）；报告（入库 / 本地 → 入库 report.md，M6.5 只做三元结果与 pairwise delta）；会话文件（混在日常 .pigeon/sessions / 独立治理根 → 该目录下独立 .pigeon/，本地不入库）
- 第 6 件被顺带解决：实验会话不进日常列表，015 重审推迟到日常会话数真实变多
- runner 输出目录参数决定三样落点，工作区仍是任务快照开出的工作树

## 施工核对后的两条修订（2026-09-14）

- 施工细节两条（不裁决）：runner 把仓库根与治理根分开传，WorkspaceProvider 的 plan / create 加 baseRef，worker 名带条件与序号并在跑完后清理工作树与分支；每个工作树挂 node_modules 目录联接
- 058 修订：验证资产由 runner 在验证前从任务目录回填工作区，防 yolo 下 agent 改测试骗过验证器；选项对比：回填（SWE-bench 同款，约 30 行）/ 按路径 deny（新治理语义）/ 提前做反向断言（事后发现），取回填
- 059 修订：Eval 用的 Skill 放入库的 eval/skills/<name>/{candidate,approved}/，skillRoots 直接指向，memoryRoots 为空；.pigeon/candidates/skills/ 仍是日常暂存区约定
