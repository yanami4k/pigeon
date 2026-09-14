# 架构健康审计（基线 d99d693，M5.5 收口后）

- 日期：2026-09-14
- 范围：src/ 的分层边界、规模热点、测试覆盖、版本化 schema 与迁移、防护纪律、债务登记
- 方法：只读度量（wc、grep、dependency-cruiser 规则文件），不改代码；数字以本次度量为准

## 总体判断

健康。分层边界机检零违规且无生产代码豁免，上游导入收口在三处，Adapter 经 049 搬家后从 1048 行降到 600 行，代码里零 TODO（债务全部登记在路线图与索引），测试行数是源码的 1.34 倍。需要在 M6 之前处理的只有三件：tui/shell.ts 的持续膨胀、迁移完整性缺一条机检、会话数膨胀对会话列表的影响（015）。

## 度量

### 规模（源码行 / 测试行 / 源码文件 / 测试文件）

| 目录 | 源码 | 测试 | 源码文件 | 测试文件 |
|---|---|---|---|---|
| state | 2878 | 1847 | 18 | 10 |
| tools | 1588 | 1412 | 11 | 13 |
| persistence | 1285 | 2486 | 9 | 10 |
| approvals | 291 | 172 | 4 | 2 |
| execution | 81 | 0 | 2 | 0 |
| pi-runtime | 948 | 3943 | 7 | 11 |
| application | 2017 | 2249 | 14 | 18 |
| orchestration | 585 | 482 | 4 | 5 |
| memory | 710 | 580 | 4 | 3 |
| skills | 303 | 403 | 3 | 3 |
| cli | 1350 | 2274 | 5 | 11 |
| tui | 1625 | 2790 | 5 | 10 |
| 合计 | 14004 | 18783 | | |

### 最大文件

| 文件 | 行 | 备注 |
|---|---|---|
| src/tui/shell.ts | 937 | 消息流、审批面板、历史渲染、worker 视图、/search 全在一个文件，M5 与 M5.5 各加了约 100 行 |
| src/tools/run-command.ts | 682 | 命令串解析、启动器判定、清单差异、证据暂存四件事在一起 |
| src/persistence/event-log.ts | 638 | 22 个记录族的写盘与幂等索引 |
| src/state/materialize.ts | 602 | 冷物化与缺口派生 |
| src/application/governance.ts | 602 | 049 搬入的治理编排 |
| src/pi-runtime/adapter.ts | 600 | 搬家前 1048 |

无文件超过 1000 行。

### 分层与边界

- dependency-cruiser 15 条规则全部 error 级，207 模块 0 违规。规则覆盖：无环、上游只经 pi-runtime 与 tools/wrap.ts 与 tui、state 叶子、persistence / tools / approvals / pi-runtime / execution / application / orchestration / memory / skills 各自的允许依赖集、Actor 不触达 execution 与 persistence 写侧。
- 22 处 pathNot 全部是测试文件豁免或"允许依赖集"的写法，无生产代码的临时豁免。
- 上游包实际导入点：src/pi-runtime 下 5 个文件、src/tools/wrap.ts、src/tui 下 3 个文件，与规则一致；registry.ts 只在注释中提及上游。

### 版本化 schema 与迁移

- 11 个版本常量：Event Log v7（22 记录族）、Receipt v4（053 将升 v5）、InjectionSnapshot v4、message content v1、grants v1、commands v1、candidate v1、tool-execution v1、envelope v1、旧账本 intent / decision v1。
- 迁移注册表实例 3 处（event-log、receipt、legacy-migration），各自维护；没有一条机检证明"每个版本化 schema 都存在 v1 到当前版本的完整迁移链"。到目前全部升级是加法式恒等迁移，尚未出过问题，但族数与版本数都在涨。

### 防护纪律

- 自包 try/catch：adapter 11 处、governance 10 处、workers 7 处，与"listener 与 hook 绝不毒化 Run"的口径一致。
- 代码内 TODO / FIXME / 记账的债 / 过渡豁免：0 处。债务只在 ROADMAP 与 decisions.md 登记。

### 测试覆盖的分布

- pi-runtime、persistence、cli、tui 测试行数是源码的 2 到 4 倍，承重层覆盖厚。
- execution 目录 81 行零直接测试，recoverSession 由 pi-runtime/adapter-persistence.test.ts 间接覆盖；目录本身是 Durable Executor 的占位（§3.6），M8 前不会长大。
- approvals 291 行对 172 行测试，审批 handler 的行为主要由 cli 与 tui 的面板测试覆盖。

## 发现与建议（按优先级）

1. **tui/shell.ts 膨胀**（937 行，每个里程碑加约 100 行）。M6 的 Reviewer 视图与候选审批面板还要往里加。建议在 M6 开工前拆成消息流、审批与模态、worker 与会话视图三个文件，行为零变化，现有 10 个 tui 测试文件不改断言。不拆则 M6 后破千行。
2. **迁移完整性缺机检**。建议加一条测试：枚举全部版本化 schema，对每个从 v1 起构造最小文档逐级迁移到当前版本并通过 schema 校验；三处注册表可以保持分散，测试集中即可。约 60 行，一次性。
3. **会话数膨胀**（M5.5 潜在瓶颈第 1 条）。每个 worker 一个会话，会话列表对全部会话整读物化。建议 M5.7 之后、M6.5 之前盘 015 的修订：列表只读文件头尾摘要或补可重建的摘要缓存。Eval 会再把会话数抬一个量级。
4. **run-command.ts 可拆**（682 行）。命令串解析与启动器判定是纯函数，清单差异是 IO，证据暂存是状态，三者拆开测试更直接。不紧急，随 048 修订之后的下一次触碰做。
5. **persistence/event-log.ts 与 state/materialize.ts** 随记录族线性增长，现在 22 族各 600 行左右可接受；到 30 族时考虑按族拆写盘与物化的分派表。记为观察项。

## 不构成问题的

- 两个 Actor（cli 1350 行、tui 1625 行）没有互相依赖，共享逻辑都在 application（history、search、workers-commands、format、resume），025 的方向一直守住。
- 运行时依赖仍只有 4 个包（三个上游加 typebox），M5.7 加 @modelcontextprotocol/sdk 一个。
- 12 个目录职责与 ROADMAP §4 目录图一致，无目录漂移。
