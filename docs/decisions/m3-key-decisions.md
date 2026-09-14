# M3 关键决策记录

- 日期：2026-09-10
- 裁决人：项目负责人；本文档记录决策过程与内容
- 关联：ROADMAP §M3、docs/notes/spike-before-tool-call.zh-CN.md、docs/audits/2026-09-08-m0-m1-review.md（本地，不入库）

## 决策过程概述

- 2026-09-08 M0/M1 审计（docs/audits/2026-09-08-m0-m1-review.md）：P1×3 + P2×2；其中 4 项已于 2026-09-10 测试先行修复（6f482bd / 04303f4 / d022f58 / 3e9ed8d），`src/tools` 上游导入豁免过宽推迟到 M3 收口。
- beforeToolCall spike（2026-09-10，pi-agent-core 0.84.4 实跑）：结论"阻断可靠"，同时确立四项硬约束——
  1. 原地改写 `ctx.args` 是唯一参数绑定通道（无返回值改参通道，整体重赋值无效）；
  2. 上游无循环护栏，须自建熔断（hook 计数 + `agent.abort()` 或 `shouldStopAfterTurn`）；
  3. parallel 模式审批整批前置，被阻断 call 的 end 事件早于放行者 execute；
  4. transcript/事件只记模型原始参数，"批准≠执行"上游不可自检，须 Pigeon 在 hook 内保证一致并自行留证。
- OMP（oh-my-pi）一手源码核查（本机 `@oh-my-pi/pi-coding-agent@18.1.11`）：per-tool shared/exclusive 调度、审批在 execute 内 per-call、审批 UI 仅 Approve/Deny、默认 yolo。

## 决策 1：审批动作集 = 批准/拒绝（无"改参数"）

- 内容：人工审批动作只有批准与拒绝，不提供"人工修改参数后放行"。
- 理由：spike S2a 证明 `block` 的 reason 逐字反馈模型，拒绝理由直接形成模型的自我修正闭环——与其人改参数，不如拒绝并写明为什么，让模型重提。Receipt 的"批准参数==执行参数"三元组随之退化为一元（执行参数=模型原始参数，仅经批准/拒绝），绑定证据大幅简化。OMP 主路径同样只有 Approve/Deny（wrapper.ts:333），该形态经实证可行。
- 可演进性：schema 迁移管线已在 M0 就位，未来若引入"改参数"动作，可在版本化 schema 上增量演进。

## 决策 2：`toolExecution: "sequential"` 写死 + 并发 `run()` 互斥

- 内容：M3 固定 `toolExecution: "sequential"`，并在 Adapter 层对并发 `run()` 做互斥，确立不变量"任何时刻最多一个待审批/执行中的 call"。
- 理由：spike S4 证明上游无循环护栏，S6 证明 parallel 模式审批整批前置、被阻断者 end 早于放行者 execute——交错观感错乱，逐个审批立即执行不可得。审批瓶颈是人，parallel 省的毫秒没有意义；写审批有顺序依赖——审批批次第 N 个要看前 N−1 个的执行结果。
- 演进路径：M4+ 按 OMP 实证形态演进为 per-tool shared/exclusive（只读并发、写串行）；账本按 call 粒度设计，届时不需要重建。

## 决策 3：CLI 审批 = REPL 内联（单进程最小闭环）

- 内容：审批交互内联在 CLI REPL 里，展示 diff + 批准/拒绝，单进程完成治理闭环。
- 理由：ROADMAP §M3 明确 M3 不依赖 M2 完整 TUI；独立的 approve 子命令 / 队列轮询等跨进程审批留给 Remote 形态。

## 决策 4：yolo 模式 = 人事先批发授权，证据链不断

- 落法：`InjectionSnapshot.tools.policy` 增加 `approvalMode: "prompt" | "yolo"`，快照深冻结（M1 已有），模型不可自改。
- Receipt 照写，`approvedBy` 区分 `"human"` / `"policy:yolo"`，证据链不因 yolo 断开。
- deny 清单绝对（yolo 不豁免）且 M3 仅精确匹配（工具名级）。参数内容模式识别（OMP 的 `rm -rf` 类）显式排除出 M3，归入 M6 安全扫描——理由：做不好的模式识别是虚假安全感。

## M3 施工切片（5 片）

1. ToolExecution 状态机 + Tool Registry + 策略求值
2. 只读工具 + hashline 编辑工具 + `src/tools` 依赖豁免收口（rogue fixture）
3. Adapter 接线：beforeToolCall 审批闸、熔断、`run()` 互斥、args 原地写回绑定
4. REPL 内联审批 CLI（diff + 批准/拒绝）
5. JSONL Receipt 账本、幂等、派发前后崩溃点测试（OutcomeUnknown 不盲重放）、冷启动对账

## 验收映射（ROADMAP §M3 完成证据）

- 未审批写操作无法到达执行器 ← 切片 3
- Agent / Skill / Reviewer 无法伪造人工批准 ← 切片 1 / 3（approvedBy 证据链）
- 派发前后崩溃点测试不盲重放 ← 切片 5
- 冷启动最小 Receipt 对账 ← 切片 5
