# M4 设计决策（D 系列，2026-09-12）

- 定位：M4 切片方案评审中逐件裁决的设计决策；上位决策见 m4-pre-decisions.md（决策 1 证据链分层 / 决策 2 存储归并 / 决策 3 Grant 体系）；切片方案本身待整理落盘
- 裁决人：项目负责人；方式：逐件盘问后裁决（D1→D8 顺序，全部落定）

## D1：Event Log 存储布局 = 每 session 一文件

- 内容：`.pigeon/sessions/sess_<ulid>.jsonl`，项目内 `.pigeon/`（gitignored），状态跟工作区走。
- 理由：冷物化边界 = 文件边界（恢复某会话只读其文件）；session list = 列目录（ULID 字典序即时间序）；单会话损坏不影响全局；会话可独立归档/删除。跨 session 搜索扫多文件的代价由"最小过滤器"定位消化。
- 否决：全局单文件（冷恢复要全量读再过滤，与有界冷物化冲突）；按大小滚动分片（过度设计）。

## D2：落盘同步策略 = 逐条同步写；治理族 fsync；失败可见化

- 同步策略：事件产生即同步写盘再继续，崩溃窗口为零。依据：归一化事件粗粒度（RuntimeEventKind 仅 5 种，turn/tool/run 级，无流式 token 事件），频率每轮数条，同步写成本可忽略；业界对应物 = WAL 逐条提交（Redis appendfsync always / SQLite synchronous=FULL），缓冲+成组提交（group commit）是高吞吐系统的优化，低频审计日志不适用。
- 耐久分层：治理族（intent/decision/receipt/grant）写后 fsync——进程崩溃与断电均不丢；观察族（turn/tool 事件）appendFileSync——防进程崩溃，不防断电（M3 现状延续）。
- 写盘失败语义：沿用 M3 裁决（进 listenerErrors，不改运行结果——磁盘故障不得瘫痪系统）；M4 新增可见性：进程内 listenerErrors 非空时 REPL 即时警告；冷恢复（resume）与 trace/replay 以文件形态派生标注既往缺口——撕裂尾巴、孤儿记录、entry runSeq 断号、待对账（可见降级，绝不假装证据链完整）。原措辞"启动/冷恢复显式警告 listenerErrors"于 2026-09-12 收口裁决精确化：写盘失败的记录不可能靠写盘持久化，跨进程只能从文件形态推断（见 m4-closeout-decisions.md 决策 ③）。

## D3：Pi entry 映射粒度 = message_end 自封 EntryId + (runId, runSeq) 权威键

- 裁决：2026-09-12，采纳 spike 推荐方案（a）。依据：`docs/notes/spike-pi-transcript.zh-CN.md`（pi-agent-core 0.84.4 实证：消息无稳定 id——timestamp 撞毫秒、responseId 不可靠；transcript append-only、上游零原地修改（8/8 探针）；message_end 事件载荷 === transcript 条目；事件序=数组序；Pi 官方 harness Session 同构——MessageEntry{id,seq,parentId}）。
- 方案：每条 message_end 事件落地时刻由 Pigeon 分配 EntryId，记 (entryId, runId, runSeq) 入 Event Log；权威键为 (runId, runSeq)——上游 reset()/messages setter 可整组替换数组，全局下标不可靠，run 内序号由 append-only 双实证保证。辅助映射：exec_ ↔ toolCallId 双向绑定（run 内唯一）；turn = 连续 entry 区间，turn_end 交叉校验；abort 与上游合成失败消息（handleRunFailure）也占序号，冷物化重放必须计入，否则序号错位。
- 禁忌与约束：timestamp 永不当键；流式阶段（message_start/update，浅拷贝 partial）不锚身份；事件落盘必须先于/同于 transcript 变更（身份只在 message_end 时刻确立；上游 listener 无 try/catch 保护，记录逻辑自身不能抛——与 M3 不变式同款）；adapter.transcript() 的 structuredClone 必须保留、listener 只读（上游零防御拷贝，P6 探针实证外部持引用可篡改旧消息）。
- 扩展点标注：未来若启用上游 harness Session/compaction（当前 core 不触发），映射需跟随 CompactionEntry，届时显式裁决。
- 否决：(b) 消息索引映射——位置非身份，上游插入/替换行为变化会静默错位，且违背 M0 定义 EntryId 品牌类型的设计意图；(c) 托管给 Pi harness Session 层——撞 §3.5 权威状态边界（不把 Pi 私有状态提升为 Pigeon 权威状态）与 M4"Pigeon 自有 Session/Run 状态与 Pi Session Entry 映射"的交付定位（映射，非托管）。

## D4：Replay 交互形态 = 一次性渲染

- 内容：`pigeon replay run_<id>` 将重建时间线作为静态报告打印 stdout，可 grep/less；测试为输出文本比对。
- 语义锁定：M4 的 Replay = 只读重建（黑匣子回放），重建引擎是核心；默认不重新执行真实副作用（路线图完成证据），重新执行（含 M7+ 沙箱回放验证）是另一件事。
- 否决：交互式步进（j/k 导航）——交互壳是 M2 TUI 的天然职责，届时 TUI 渲染同一份重建数据零返工。

## D5：Session 状态 = 派生不落库；列表默认安静，仅"待对账"突出；自动确证消化折进 S2

- 机制：session 聚合状态每次从 Event Log 现算（派生），不写入任何文件（无第二套事实，§3.5 视图是投影）。
- 显示：session 列表默认安静（时间 + 轮数）；唯一突出显示项是"待对账"（通俗措辞 + 动作提示，如"1 条待对账（上次会话异常中断，用 resume 处理）"）——它是唯一 actionable 项（崩溃冷恢复的用户入口）；失败/正常不进列表（要看用 replay）。
- 对账流程（M4 版）：冷启动自动跑（非会话内选择、非 run、不调模型）→ 配对分类（M3 已有）→ 悬账自动确证：intent 记改前/改后内容哈希，恢复时读文件现状哈希三方比对——匹配改后态=已执行（自动销账）；匹配改前态=未执行（自动销账，模型之后可正常重提，非系统重放）；都不匹配=留人确认（resume 时 [1]已执行 [2]未执行 [3]先不管；用户确认 = 第三种确证渠道，对齐 ToolExecution Verified 语义）。任何路径系统不自动重新执行（§3.2）。
- 范围：自动确证折进 S2（冷恢复），S2 盒 1.5d → 2d；receipt/intent 增内容哈希字段。
- 残余存在的理由：撕裂写、崩溃窗口内第三方改动、多步编辑中间态、未来非文件类副作用（无哈希可查）——桶必须在但应近乎恒空，频繁出现即工具实现有毛病的信号。

## D6：Grant 配置文件 = 项目级 .pigeon/grants.json

- 内容：JSON + 版本化 typebox schema（version 字段走 M0 迁移管线）；正规写入方是 /grants save（升格），人可读、/revoke 可撤；promotedFrom 出处为结构化字段（不需要注释承载）。
- 范围：项目级（权限作用域天然是项目）；全局级（跨项目放行）M4 不做。git 归属：随 .pigeon/ 整体 gitignored；"团队共享工具权限"是将来的显式决策，不开口。
- 否决：YAML（要引新依赖，而文件正规写入方是程序，注释需求为假）。

## D7：失败四分类判据表

| 分类 | Run 级判据 | ToolExecution 级判据 |
|---|---|---|
| 取消 | stopReason === "aborted" 且无熔断 decision 记录（用户中断） | 审批前/执行中被 abort |
| ├ 子类：治理熔断 | aborted 且有熔断 decision 行（P2-1 已保证理由落盘；trace 中"用户取消"与"治理熔断"必须一眼可分） | 被熔断切断的在途调用 |
| 业务失败 | stopReason === "length"（输出截断：任务未完成但非系统故障） | 工具自身域错误 isError=true：路径逃逸/文件不存在/hashline 锚不匹配/参数校验失败 |
| 基础设施错误 | syntheticFailure === true（M1 已有检测 = provider 侧故障）；streamFn/SDK/网络异常 | 环境异常：磁盘错误/权限/文件系统调用抛异常 |
| 未知（默认桶） | 崩溃残留、以上判据均不匹配 | reconcile 后仍 OutcomeUnknown（含哈希确证失败残余） |

- 默认桶是"未知"而非"业务失败"：宁可标"不知道"不贴错标签——标签要喂 M6+ 蒸馏，贴错 = 毒信号。
- syntheticFailure 归基础设施：provider 故障信号，归业务失败会污染 M6.5 Eval 的任务失败率统计。

## D8：M3 旧账本迁移 = 启动时一次性迁移

- 内容：M4 版首次启动检测旧 JSONL 账本 → 逐行转换为事件格式（行内 sessionId 路由到对应 session 事件文件）→ 旧文件改名 *.legacy.jsonl 物理保留、逻辑退役 → 所有读取只走 Event Log。
- 机制：走 M0 迁移管线（Receipt v1→v2 占位迁移是保活装置，这是管线首次扛真实跨代迁移）。
- 否决：并存读后归并（双格式永存，读层长期背复杂度，违背决策 2 不双写精神）；不迁移归档（旧会话 trace/replay 失效，M3 验收真实记录是证据，丢了可惜）。
