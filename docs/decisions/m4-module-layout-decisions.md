# M4 收口：模块布局归位决策（2026-09-12）

- 定位：路线图逐项回写过程中，对"现有模块位置是否科学"复审后形成的裁决；上位约束 ROADMAP §3.5（一个权威状态源）、§3.6（Controller / Actor / 执行边界）、§4（目录即模块边界，依赖方向由 dependency-cruiser 强制）
- 裁决人：项目负责人；方式：盘问后裁决（选项 a / b / c，选 c）
- 关联：docs/audits/2026-09-12-module-layout.md（施工与验证证据）

## 背景：重整前的三处不科学

1. persistence 与 pi-runtime 目录级双向依赖：event-log.ts 引 pi-runtime/events.ts 的载荷 schema；adapter.ts 引 persistence 的分类判据与 grant 匹配。dependency-cruiser 只查模块级循环，目录级绕一圈不报；原有规则只有上游边界一条，"依赖方向按路径强制"对目录之间并不成立。
2. persistence/event-log.ts 一个文件 1190 行七种职责：记录族 schema（路线图归 state）、JSONL 读写器（persistence）、冷物化与对账（state）、分类装配（state）、recoverSession 写 resolution（execution）。trace / replay / session-list 三个纯投影与 classification 纯判据也在 persistence 下。grants.ts 混匹配语义、运行态存储、配置文件读写。
3. persistence 依赖 tools（grant 匹配要路径围栏、恢复要 hashline 哈希），存储层依赖工具层，方向反了；根因是问题 2。

成因：M4 六个切片都以 Event Log 为中心施工，每片顺手放在 event-log.ts 旁边，persistence 成了"M4 的家"。十天时间盒内是合理取舍，收口点是最便宜的归位时机（M5 会继续在这些模块上堆 Memory 与 Session Search）。

## 决策：有限重整（选项 c）

- 选项：(a) 文档跟随现状（零代码风险，但把不科学的结构写进合同）；(b) 全面按路线图原图重整含 application/ Controller（Controller 现在不存在，硬建是空抽象）；(c) 有限重整——只做归位，不引入未到期的抽象。选 c。
- 归位表：

| 内容 | 从 | 到 |
|---|---|---|
| 13 记录族 schema、EVENT_LOG_VERSION、读路径迁移链（parseEventRecord） | persistence/event-log.ts | state/event-log.ts |
| 运行时事件 kind 与五种载荷 schema | pi-runtime/events.ts | state/runtime-events.ts（pi-runtime 只留 normalizePiEvent / isSyntheticFailureMessage） |
| 冷物化（materializeRecords 纯函数）、对账、entry 断号检测、分类装配、MaterializedSession 类型 | persistence/event-log.ts | state/materialize.ts |
| 失败四分类判据 | persistence/classification.ts | state/classification.ts |
| trace / replay 投影 | persistence/ | state/ |
| session 摘要与过滤判据（纯函数） | persistence/session-list.ts | state/session-summary.ts（persistence 只留列目录 + 逐文件物化） |
| recoverSession | persistence/event-log.ts | execution/recovery.ts |
| 固化规则 schema | persistence/grants.ts | state/grants.ts |
| grant 确定性匹配（scopeMatches / matchConfigGrants） | persistence/grants.ts | tools/grants.ts |
| SessionGrantStore | persistence/grants.ts | approvals/grant-store.ts |
| grants.json 读写与去重 | persistence/grants.ts | persistence/grants-config.ts |
| JsonlEventLog 读写器、materializeSession（读 + 纯物化） | 原地 | persistence/event-log.ts（1190 → 396 行） |

- adapter 的落盘口 EventLogSink 从 `Pick<JsonlEventLog, ...>` 改为只用 state 输入类型的结构接口，pi-runtime 不再 import persistence（含类型）。
- 分层规则（.dependency-cruiser.js 新增六条，只约束生产代码，测试文件 pathNot `\.test\.ts$`）：state 是叶子；persistence 只依赖 state；tools 只依赖 state；approvals 只依赖 state / tools；pi-runtime 不依赖 persistence / execution / cli / tui；execution 不依赖 pi-runtime / cli / tui。既有 tui 不得触达 execution 保留。
- 重整后目录级依赖图为有向无环分层：state ← tools ← approvals ← pi-runtime；state ← persistence ← execution；cli 在最上层。之前 persistence ↔ pi-runtime 的双向边消失。

## 两条记账的过渡债（不做，写进路线图目录图注释）

1. **cli 直连 execution**：resume 命令直接调用 recoverSession。§3.6 约束的是权威状态写入，resolution 的权威在 Event Log，CLI 只是触发入口；application/ 在 M4 无交付物，现在造壳是假架构。触发重审的时机是 M2 出现第二个 Actor（两个装配根），届时抽 Controller，与"Job 抽象等第二个执行体"同款纪律。未给 cli 加"不得触达 execution"规则，只保留 tui 那条。
2. **adapter 内的治理编排**：排律、审批调用、intent / decision / receipt / breaker 四族落盘住在 PiRuntimeAdapter（881 行），与 §2 边界规则 3"Adapter 不自行决定权限"有距离。现在不拆：拆出的 Controller 只有一个消费者；adapter 是全仓测试最密的文件，Kimi 真实链路验收前动它等于验收多覆盖一次。触发时机：M5.5 父子 Run 需要 Controller 做权限子集校验，届时挪到 application/，adapter 退回"hook 转发与事件归一化"。

## 路线图回写（同日）

- §4 关键状态流：替换为 as-built（Run 四终态 + D7 四分类；ToolExecution 六态；证据链分层；verification 无运行时推进路径写成明文，作为 M6.5 前置）。
- §4 目录图：已建目录标实际职责与依赖方向，占位目录标里程碑；两条过渡债写进注释。
- 提交：`5f14d63 Move schemas, materialization and projections into layered directories`、`5f14d63 Update roadmap state flows and module map to the as-built layout`。
