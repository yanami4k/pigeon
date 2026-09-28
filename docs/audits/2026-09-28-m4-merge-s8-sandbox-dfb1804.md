# 合并四：推送记忆前半段与日常沙箱并入 formal-v2（基线 dfb1804）

范围：在 formal-v2（头 dfb1804：合并三及其审计之后）上依次合并 push-memory-s8、sandbox-daily，解决冲突，并在两段交汇处补测试。两次都是普通合并提交（`--no-ff`），不变基、不压缩。两条分支都从 dfb1804 开出。交汇处四项在合并后的代码里已经成立，没有改生产代码，只新增了一个测试文件。

## 一、合并的分支与提交

| 次序 | 合并的分支 | 分支头 | 合并提交 | 文本冲突 |
|---|---|---|---|---|
| 1 | push-memory-s8（推送记忆前半段：记忆文件与 update_memory、推送段、收尾与压缩前复盘、开关与跑批器接线、worker 带记忆工具） | d6645d5 | e6bec40 | 无 |
| 2 | sandbox-daily（日常沙箱：一次性容器、交回、联网档、通用镜像、审批档与 [d] 判定、沙箱不启动 MCP） | 14042a7 | ecc6549 | 5 个文件 |
| — | 交汇处测试 | — | ae768d3 | — |

第一次合并改动 42 个文件（新增 3380 行、删除 123 行），第二次合并相对第一次合并的结果改动 33 个文件（新增 2782 行、删除 92 行），交汇处测试新增 1 个文件 325 行。

## 二、第二次合并（sandbox-daily）的冲突文件与解决方式

五处冲突都是两段在同一位置各加一段，解决方式都是两边都保留。

| 文件 | 冲突内容 | 解决方式 |
|---|---|---|
| `src/application/launch-flags.ts` | ① 无取值开关名单：推送记忆加 `--no-pushed-memory`，沙箱加 `--sandbox`，沙箱另在其后新增审批档常量与 `SandboxLaunch`。② `ParseLaunchFlagsOptions`：推送记忆加 `pushedMemory?`，沙箱加 `sandbox?` | ① 名单为 `--yolo`、`--no-persist-thinking`、`--no-pushed-memory`、`--sandbox` 四项，沙箱新增的常量与接口保留（biome 按行宽把名单折成多行）。② 两个选项都保留 |
| `src/application/session-runtime.ts` | import：推送记忆从 `runtime.ts` 多引 `LearnedMemoryConfig`，沙箱从 `mcp.ts` 多引 `noMcpSession` | 两个都引 |
| `src/application/headless-core.ts` | `runHeadlessOnce` 开头：推送记忆加推送开关、记忆上限与复盘上限的校验，下接旧护栏注释；沙箱改写护栏注释（会话验证命令经执行端在容器里执行，不再拒绝） | 保留推送记忆的四行校验，护栏注释取沙箱的写法。护栏只拒绝失败自动分叉重试与分支会话（沙箱的代码），推送记忆拆掉的"推送记忆尚未实现"挡板不再出现 |
| `src/cli/index.ts` | ① `pigeon resume` 与新开命令行对话的参数说明：推送记忆在逐项列出的说明里加两个参数，沙箱把说明改为共用常量 `SESSION_FLAGS_HINT`，并在新开对话的参数解析之前加 `pigeon sandbox list \| clean` 子命令。② 三个入口（`pigeon resume`、`pigeon run`、新开命令行对话）的 `parseLaunchFlags` 选项：各加 `pushedMemory: true` 与 `sandbox: true`。③ `pigeon run` 的用法：两边各加自己的参数 | ① 用共用常量，常量里在 `--no-persist-thinking` 之后补 `--no-pushed-memory / --memory-limit`；`pigeon sandbox` 子命令保留。② 两个选项都给。③ 用沙箱的两行写法，在 `--wall-clock` 之后补 `[--no-pushed-memory] [--memory-limit <字符数>]` |
| `src/tui/main.ts` | ① import：推送记忆从 `session-runtime.ts` 多引 `pushedMemoryRunOptions`，沙箱新增 `sandbox-session.ts` 的四个符号。② 用法说明：两边各加自己的参数。③ `parseLaunchFlags` 选项：`pushedMemory: true` 与 `sandbox: true` | ① 两处 import 都保留。② 用沙箱的写法，在 `--no-persist-thinking` 之后补推送记忆的两个参数。③ 两个选项都给 |

由 git 自动合并、合并后核对过的交汇位置：

- 审批：`tools/policy.ts` 的"免审批的写档工具自动放行"一档（推送记忆）与 `approvals/handler.ts` 的 `offersDirectoryGrant`、放权落点的 `pathScoped`（沙箱）都在；`cli/approval-ui.ts` 与终端界面审批面板按 `offersDirectoryGrant` 决定是否显示 [d]。update_memory 调用不带路径参数，不会出现 [d]。
- headless：推送记忆的收尾复盘与压缩前复盘、沙箱的"收尾验证经执行端"、`sandbox-session.ts` 的 `runHeadlessInSandbox` 都在。
- 装配根 `runtime.ts`：推送段、update_memory 注册与压缩前复盘（推送记忆），`pathScopedGrants` 与放权存储的 `pathScoped`（沙箱）。
- 跑批器 `eval/stream-agents.ts`、`eval/stream-experiment.ts` 只有推送记忆改动，沙箱没有改动这两个文件。

## 三、两段交汇处

### 3.1 收尾顺序

- `pigeon run --sandbox`：`runHeadlessInSandbox` 先 `await runHeadless(...)`，再 `closeSandbox`（交回、删除容器）。`runHeadlessOnce` 在最后一次验证（回炉关着时为运行面释放后补做的那次，经执行端在容器里执行）之后、返回之前 `await` 收尾复盘。合并后的顺序因此为：最后一次验证 → 收尾复盘 → 交回分支 → 删除容器。
- 交互沙箱会话（命令行对话、终端界面、`pigeon resume --sandbox`）：推送记忆前半段不含交互会话正常退出时的复盘，本次合并也未新增。交互会话里的复盘只有压缩前复盘，它在会话进行中触发，容器此时一直在。退出时的顺序为释放运行面 → 交回 → 删除容器。

### 3.2 复盘运行面接容器、不启动 MCP

- 收尾复盘经 `createDetachedRuntime` 重开运行面，装配参数取本次运行的同一份 `surface`，其中带 `workspaceHost`（容器执行端）与 `startMcp`。`runHeadlessInSandbox` 传入的 `startMcp` 是 `noMcpSession`，收尾复盘因此用同一个容器执行端、不按配置另起 MCP。
- 压缩前复盘在装配根内经 `reviewRuntimeDeps` 再装一次，参数取来源的 `deps` 去掉验证、回炉、失败重试、压缩前回调、会话来历、预算与初始消息，`workspaceHost` 与 `mcp`（来源的 MCP 会话；沙箱里是 `session-runtime.ts` 注入的空会话）照原样保留。

### 3.3 记忆写在宿主

update_memory 以装配根的 `governanceRoot`（宿主治理根）构造，经本地文件系统与跨进程锁读写 `.pigeon/learned/MEMORY.md`，不经执行端，与会话存储同一口径。

### 3.4 worker

沙箱里不派 worker：终端界面在沙箱里不挂 worker 编排器（`/spawn`、`/cancel`、`/workers` 给出不支持的原因），命令行对话的 `/fork` 与失败自动分叉重试同样拒绝。推送记忆在 `orchestration/roles.ts` 的 `deriveWorkerPolicy` 给三种角色加的 update_memory 不受沙箱影响（非沙箱会话照常），`runtime-pushed-memory.test.ts` 的 6 条 worker 用例在合并后照常通过。

### 3.5 测试

新增 `src/application/sandbox-pushed-memory.test.ts`（2 条，假 docker、工作区为真 git 仓库、假模型按请求分派干活、复盘与摘要）：

1. `pigeon run --sandbox` 开着推送：agent 用 run_command 在容器里写 `inside.txt`，验证命令 `test -f inside.txt`。断言复盘指令里的验证结论为"通过"（验证在复盘之前）；复盘的两次请求时容器都在、宿主上还没有沙箱分支；复盘 read_file 读到的是容器里的内容（宿主上没有这个文件）；返回后沙箱分支含该文件、容器已删除；宿主 MEMORY.md 有复盘写的一条，容器工作区里没有 `.pigeon/learned`；配置的 MCP 服务（启动即写标记文件）没有被启动。
2. 交互沙箱会话开着推送与压缩：agent 在容器里写 `inside.txt` 并调用 update_memory，随后轮间压缩触发压缩前复盘。断言压缩前复盘做了、期间容器在、复盘 read_file 读到容器里的内容；宿主 MEMORY.md 有 agent 写的一条，容器里没有；MCP 服务没有被启动；交回后容器删除。

合并后没有改动已有测试。

### 3.6 变异反向验证

在服务器上逐条植入、只跑 `sandbox-pushed-memory.test.ts`，以 `git checkout` 还原后 `git diff --quiet` 核对，5 次均逐字一致。

| 编号 | 植入 | 精确变红的用例 | 变红的断言 |
|---|---|---|---|
| V1 | 收尾复盘不等完成就返回（复盘落到交回、删容器之后） | 用例 1 | 结果里没有收尾复盘 |
| V2 | 收尾复盘的运行面不注入容器执行端 | 用例 1 | 复盘的 read_file 回"路径不存在或不可读：inside.txt" |
| V3 | 压缩前复盘的运行面不注入容器执行端（`reviewRuntimeDeps` 去掉 `workspaceHost`） | 用例 2 | 同上 |
| V4 | 收尾复盘按配置另起 MCP（`startMcp` 置空） | 用例 1 | MCP 标记文件被写出 |
| V5 | update_memory 改写容器执行端的工作区 | 用例 1、用例 2 | 宿主上没有 MEMORY.md |

## 四、verify 的实际运行情况

服务器：阿里云实例，8 vCPU、31 GB 内存，Linux，Node 24.12.0，有 Docker，已载入 `pigeon-stream-strands:v6`、`pigeon-stream-pigeon:v4`、`pigeon-sandbox:30145c7527e6` 与 busybox。专属目录经 git bundle 取合并后的头 ae768d3 检出（工作树无改动）；依赖锁文件与上次检出时相同，沿用已装的依赖。跑前确认服务器上没有别的测试进程，测试步并发 6：

- lint：通过（400 个文件）；
- check：通过；
- 测试：`node --test --test-concurrency=6 "src/**/*.test.ts"`，1128 个用例，1126 通过、0 失败、0 取消、2 跳过（只在 Windows 上跑的 .cmd 启动器两例），用时 161.0 秒。需要实验镜像的真容器用例与沙箱的两条真容器用例都实际运行并通过；
- deps：无违规（416 个模块、2845 条依赖）。

本机（Windows）在每次合并后只跑类型检查与 biome，都通过。

## 五、真镜像验收

在同一台服务器上，用合并后的头 ae768d3 的代码，按合并三的做法跑 1 道题的基线与判分。验收输入（清单、人的 strands 仓库、之后一侧的人的基准）从合并三的验收目录只读复制到本次的验收目录，基线缓存与输出都从空开始；之前一侧与两类用例现算。

- 镜像 `pigeon-stream-strands:v6`，身份经 `imageIdentityOf` 按内容层取得，为 `layers:sha256:ebe5a527…`，与合并三一致；
- 题号 1（步序 3，提交 913714954，起点 e09d4d63f）；参考容器 1 个，作业容器内存上限 2 GB。

两类用例预计算：要做到的 16 条（不在本题测试文件里的 0 条），不许挂的 5470 条，时过时不过排除 0 条，用时 4.2 分钟；没有出错的题，也没有建不成基线的题。

判分：两个作业并行。参照 agent 把人在该步改过的源代码写进容器，走 neither 格；空 agent 什么都不做，走 minimal 格。两者都走完整的跑批流程。

| 条件 | 步序 | 结果 | 要做到的 | 不许挂的失败 | 做成 | 得分 | baselineUnavailable | review | 开容器 | 整步 |
|---|---|---|---|---|---|---|---|---|---|---|
| 参照 | 3 | passed | 16/16 | 0/5470 | 是 | 1 | null | null | 3.6 秒 | 3.0 分 |
| 空 | 3 | failed | 0/16 | 0/5470 | 否 | 0 | null | null | 3.6 秒 | 3.1 分 |

两个作业共 3.1 分钟，结束后作业容器与参考容器都已删除。两类用例条数与判分结果和合并三在同一道题上的验收一致。两个格子都不推送，结果行的 `review`、`hitReviewBudget` 为 null；验收不经模型网关与 Pigeon agent，推送格的复盘计量与身份头三项由单元测试覆盖。

## 六、沙箱加推送冒烟

同一台服务器，合并后的头 ae768d3 的代码，通用镜像 `pigeon-sandbox:30145c7527e6`（已在服务器上，未重建）。假模型，不调用真实模型接口；小仓库（一个提交），不配参数，推送记忆按缺省开着。

`pigeon run --sandbox --verify-command "grep -q container-made smoke.txt" --json`：agent 用 run_command 在容器里写 `smoke.txt`（内容 `container-made`）；收尾复盘调用 read_file 读 `smoke.txt` 与 update_memory 新增一条。假模型在每次复盘请求到达时记下外部状态：

- 退出码 0；结果 `status` 为 completed，验证判 pass，`reviews` 为一次收尾复盘（completed，2 轮），`sandbox` 带分支与提交、`changed` 为 true；
- 两次复盘请求时：复盘指令的验证结论行为"验证门的最终结论：通过"；`docker ps --filter label=pigeon.sandbox` 列出本次的容器；宿主上还没有 `pigeon/sandbox-*` 分支；容器里 `/workspace/.pigeon` 不存在；第二次请求里 read_file 的结果为容器里的 `container-made`；
- 返回后：交回分支里的 `smoke.txt` 为 `container-made`，宿主工作目录没有该文件；宿主 `.pigeon/learned/MEMORY.md` 有 L1 这一条；
- 结束后 `docker ps -a --filter label=pigeon.sandbox` 为空，`pigeon sandbox list` 报告没有残留的沙箱容器。
