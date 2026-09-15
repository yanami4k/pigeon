# 模块布局归位：施工记录与验证证据

- 日期：2026-09-12
- 仓库：`pigeon-harness`
- 基线：`dev` @ `aef8877`（M4 收口决策 ①②③ 已提交）
- 依据：docs/decisions/m4-module-layout-decisions.md（选项 c 有限重整）
- 提交：`5f14d63 Move schemas, materialization and projections into layered directories`（51 文件，+1838 / −1627，git 识别重命名 7 个）；`5f14d63 Update roadmap state flows and module map to the as-built layout`（ROADMAP §4 两段）
- 验证：`npm run verify` 全绿——biome 105 文件 0 错、tsc 0 错、265 测试通过（与重整前同数，语义零变化）、dependency-cruiser 117 模块 624 依赖 0 违规

## 重整前后的目录级依赖图（生产代码，不含测试与 fixtures）

重整前（有目录级环）：

```
approvals -> state
cli -> approvals, persistence, pi-runtime, state, tools
persistence -> pi-runtime   ← 反向：存储层依赖运行时拿载荷 schema
persistence -> state, tools ← 反向：存储层依赖工具层（路径围栏、hashline）
pi-runtime -> approvals, persistence, state, tools   ← persistence ↔ pi-runtime 成环
tools -> state
```

重整后（有向无环分层）：

```
state       -> （无）
tools       -> state
persistence -> state
approvals   -> state, tools
execution   -> persistence, state, tools
pi-runtime  -> approvals, state, tools
cli         -> approvals, execution, persistence, pi-runtime, state, tools
```

## 文件归位明细

| 新文件 | 行数 | 来源与职责 |
|---|---|---|
| state/event-log.ts | 361 | 13 记录族 schema、EVENT_LOG_VERSION=5、读路径迁移链（parseEventRecord 出口） |
| state/runtime-events.ts | 63 | RuntimeEventKind、StopReasonSchema、五种载荷 schema（原 pi-runtime/events.ts 17–72 行） |
| state/materialize.ts | 444 | MaterializedSession / ReconcileReport / EntryGap 类型；materializeRecords 纯函数；reconcileRecords；detectEntryGaps；activeGrants；classifySessionRecords |
| state/classification.ts | 106 | git mv，改相对 import |
| state/trace.ts / replay.ts | 314 / 104 | git mv，import 改指 ./event-log 与 ./materialize |
| state/session-summary.ts | 125 | SessionSummary 类型、sessionCreatedAt、summarizeSession（纯）、matchesSessionFilters |
| state/grants.ts | 32 | ConfigGrantRule / PromotedFrom / GrantsConfigFile schema |
| tools/grants.ts | 69 | GrantMatchOutcome、scopeMatches（改为导出）、matchConfigGrants |
| approvals/grant-store.ts | 120 | SessionGrantStore、GrantNotFoundError |
| persistence/grants-config.ts | 119 | loadGrantConfig / appendGrantConfigRule / removeGrantConfigRule / 去重 |
| persistence/event-log.ts | 396 | 错误类、readEventLogFileDetailed / readEventLogFile / listSessionIds、JsonlEventLog、materializeSession 包装（原 1190 行） |
| persistence/session-list.ts | 32 | 列目录 + ULID 预筛 + 逐文件物化 + 过滤 |
| execution/recovery.ts | 80 | recoverSession / RecoveryResult |
| pi-runtime/adapter.ts | 881 | EventLogSink 改为结构接口（只用 state 输入类型）；import 改指 state / tools |

测试文件：persistence/grants.test.ts 按被测模块拆为 persistence/grants-config.test.ts、tools/grants.test.ts、approvals/grant-store.test.ts；classification / trace / replay 测试随源文件搬到 state/（测试跨层引 persistence 的 JsonlEventLog 搭夹具，规则放行）；其余测试只改 import 路径。用例数与断言零变化。

## 分层规则（.dependency-cruiser.js 新增六条）

| 规则 | from（生产代码） | 禁止 to |
|---|---|---|
| state-is-leaf | ^src/state/ | src 下任何非 state 目录 |
| persistence-only-state | ^src/persistence/ | 非 persistence / state |
| tools-only-state | ^src/tools/ | 非 tools / state |
| approvals-only-state-tools | ^src/approvals/ | 非 approvals / state / tools |
| pi-runtime-no-storage-or-actors | ^src/pi-runtime/ | persistence / execution / cli / tui |
| execution-no-runtime-or-actors | ^src/execution/ | pi-runtime / cli / tui |

既有：no-circular、pi-agent-only-via-pi-runtime、tui-cannot-reach-execution 保留。测试文件经 `pathNot: "\\.test\\.ts$"` 豁免。

## 反向验证（规则是否会咬人）

| 变异 | 结果 |
|---|---|
| 在 pi-runtime/adapter.ts 加一条 `import type { JsonlEventLog } from "../persistence/event-log.ts"` | `error pi-runtime-no-storage-or-actors: src/pi-runtime/adapter.ts → src/persistence/event-log.ts`，1 违规 |
| 在 state/materialize.ts 加同一条 | `error state-is-leaf` + `error no-circular`，2 违规 |

两例均在还原后重跑 verify 全绿。类型导入（`import type`）同样被捕获（tsPreCompilationDeps: true）。

## 施工方式与事故

- 拆分用三段 python 脚本（切片、改写 import、按符号表重路由 import）完成，脚本在作业临时目录；每段后 biome --write 归位格式，tsc 与 node --test 逐步核对。
- 首次尝试把 400 行脚本经 bash heredoc 内联执行，bash 解析失败，磁盘零改动；改为脚本落文件再执行。
- 巡航规则正则转义首次写成 `"\.test\.ts$"`（JS 里等于 `.test.ts`），biome 报无用转义；改为 `"\\.test\\.ts$"` 后规则语义与格式同时正确。反向验证在修正后重跑确认。
- 重整全程无 `git checkout -- <file>` 操作；变异还原用备份副本。

## 遗留（已记账，见决策文档"两条过渡债"）

- cli/session.ts 直接调用 execution.recoverSession：M4 过渡豁免，M2 第二个 Actor 出现时重审。
- pi-runtime/adapter.ts 881 行含治理编排：M5.5 前挪到 application/。
- 恢复相关测试仍在 pi-runtime/adapter-persistence.test.ts 的崩溃矩阵里，覆盖完整，位置随 execution/ 填充时再迁。

## 修改记录

| 日期 | 修改 | 提交/状态 |
|---|---|---|
| 2026-09-12 | 模块归位重整 + 六条分层规则 | `5f14d63`，本地 dev，未推送 |
| 2026-09-12 | ROADMAP §4 关键状态流与目录图改为 as-built | `5f14d63`，本地 dev，未推送 |
| 2026-09-12 | 本文档与 m4-module-layout-decisions.md | docs/ 本地 gitignored，不入库 |
