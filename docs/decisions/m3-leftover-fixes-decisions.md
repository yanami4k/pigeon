# M3 遗留问题修复决策（2026-09-11）

- 定位：M3 收口后三项技术遗留的逐件裁决记录；上游决策见 m3-key-decisions.md
- 裁决人：项目负责人；方式：逐件盘问后裁决

## 背景：M3 收口时的三项技术遗留

1. 幽灵工具名死循环对熔断不可见（上游查表阶段拦截，hook 不可见）
2. 熔断触发时真实理由被上游 "Operation aborted" 覆盖
3. Receipt v1→v2 迁移为占位（v1 从未落盘）

## 决策 ①：幽灵工具名熔断 = 事件级计数（已实施，5b3f7f4/cec5abe）

- spike 事实（tmp/notfound-spike.mjs）：not-found 时 tool_execution_start/end 照常发出（isError=true），hook 调用 0 次，无人工 abort 则循环永续
- 方案选型：A（事件级计数，复用熔断框架）vs B（shouldStopAfterTurn 扫 transcript 兜底）；选 A，因为事件事实成立，B 不需要
- 实现要点：判据 settled+isError+不在广告集；同名连续计数（非幽灵事件清零）达共享阈值（3）→ abort；审计轨迹 = 事件日志 tool.proposed/tool.settled 序列
- 已知代价及裁决：幽灵路径无 ToolExecution 账本（hook 未运行，无决策可记、零副作用无账可对）——裁决不处理，M4 事件日志落盘后轨迹自动持久化

## 决策 ②：拒绝决定落盘 = 新增 decision 记录族（已实施，ac2de7e）

- 缺口：被拒绝调用的理由文本只活在内存 ToolExecution.decision.reason；receipt 无 reason 字段、rejected 不写 intent 行 → 进程退出理由蒸发，落盘只剩"已拒绝"
- 方案选型：(a) decision 记录族 vs (b) Receipt v3 加 reason vs (c) 只补 run.breaker_tripped 事件；选 (a)——Receipt 职责是副作用对账不塞理由（排 b），熔断事件是症状级补丁（排 c）
- 实现要点：第三条 JSONL 记录族 decision（approvedBy+逐字 reason+rawArgs 快照）；三个拒绝点（policy:deny / 无 handler fail-closed / 人工拒绝）全落盘；reconcile 新增 rejected 分类（闭环，永不入 OutcomeUnknown）；写盘失败不改阻断结果、错误进 listenerErrors
- 附带效果：熔断时刻的真实理由随之落盘（②覆盖①遗留的"理由丢失"症状），run.breaker_tripped 事件判定为不需要

## 决策 ③：Receipt v1→v2 占位迁移 = 不动

- 理由：v1 从未被持久化；迁移函数是迁移管线的保活装置（JSONL 冷读是其首个真实消费方）；删除无收益且 M4 要重建

## 遗留清单更新

- 技术遗留：清零
- 验收缺口：真实模型链路未端到端验证（fake streamFn only；CLI 需用户手写 --stream-fn 插件；anthropic-sdk override 验证按项目负责人裁决搁置——不接 Anthropic）
- 工程项：dev/main 均未推送（dev HEAD ac2de7e）；当时 docs/decisions、docs/audits、docs/notes 均只在本地（decisions.md 047 起 decisions 与 audits 入库）
- 顺延：模式识别安全扫描 → M6；per-tool shared/exclusive 并发 → M4+；下一里程碑 M4
