# M4 前置决策（2026-09-12）

- 定位：进入 M4 前对"M3 证据链如何演进"的裁决记录；上游决策见 m3-key-decisions.md、m3-leftover-fixes-decisions.md
- 裁决人：项目负责人；方式：逐件盘问后裁决
- 关联：ROADMAP §M4、§3.2（副作用不能盲目重放）、docs/audits/2026-09-11-m3-review.md（本地）

## 背景

M3 交付了单次执行账本（JSONL 三记录族：intent/decision/receipt）。M4 要落完整 Event Log。用户提问"证据链对 Trace/Eval 有帮助吗，真的需要挂满吗"，盘问后形成以下裁决。

## 决策 1：证据链按副作用分层——写调用挂满三族，读调用降为事件级

- 内容：产生副作用的工具调用（写/exec 类）继续持久化 intent + decision + receipt 完整三族；只读调用（read 类）只保留事件级记录（tool.proposed / tool.settled），不写 receipt 级记录。
- 理由：
  1. §3.2 是架构红线：派发前持久化意图、派发后持久化 Receipt、OutcomeUnknown 不盲重放——写调用三族不可砍。
  2. decision 行的逐字拒绝理由是 M6 Reviewer / M7–M9 蒸馏的负样本监督信号（人不要什么、为什么不要），只记"被拒"不记理由会让学习链路丢一半信号。
  3. 只读调用无副作用，OutcomeUnknown 对账对其无意义；事件级记录已满足 Trace 与学习用途，receipt 级持久化是冗余。
- 下游对账：M4 Trace 完成证据（用户请求→工具参数→审批→Receipt→验证）、M4 冷物化、M6.5 Eval 的 episode 标注，均以这条链为地基。

## 决策 2：M4 存储归并——账本演进为 Event Log 事件族，不双写

- 内容：M4 落 Event Log 时，M3 的 JSONL 账本归并进 Event Log 作为其中的事件族（receipt 成为事件，不再是第二个独立存储）；不得形成"账本一套 + 事件日志一套"的双写冗余。
- 理由：单一事实链是 §3.5（一个权威状态源）的直接推论；双写意味着两套事实需要互相对账，违背冷物化"不产生第二套事实"的完成证据。ROADMAP §M4"将 M3 的单次 Receipt 扩展为完整事件、审批、工具轨迹和最终验证的关联视图"即此意。
- 迁移处置：M3 既有 JSONL 账本格式由 M0 迁移管线承载演进；Receipt v1→v2 占位迁移的处置并入 M4 重建时一并裁决（延续 m3-leftover-fixes-decisions.md 决策③）。

## 决策 3：放权中间档——Grant 体系（2026-09-12 由候选升级为正式决策）

- 背景：M3 只有逐 call prompt 与批发 yolo 两档，中间空档（write/exec 层无中间态；read 层自动放行 M3 已有）。经多轮盘问裁决建立 Grant 体系。形态对照：会话内"别再问"参考 Claude Code don't-ask-again（但 CC 可一步存持久规则，本设计故意拆成两步）；持久配置参考 OMP tools.approval（但 OMP 手写配置无出处，本设计升格带出处）。Pigeon 增量：每次自动放行账本回指具体 grant/配置条目，可审计"这次写操作凭什么没问人"。
- 形态（A+升格）：审批提示第三键 [a] 创建会话级 grant（"本会话允许"）；升格 = 人显式 /grants save 把会话 grant 写进项目配置文件，记录 promotedFrom 出处（哪次会话、哪次动作、首次批准的调用）。逐工具粒度，不给"一批工具长期放行"的捷径：批量放开只能走 yolo（短寿命、启动时显式拨档），长期放开只能逐工具固化（每条独立带出处、独立可撤销）。
- 决策 3a 目录限定：做。grant 对象带可选 pathPrefix（如 src/**）；判定复用 src/tools/paths.ts 的 realpath 包含检查（确定性路径判定，非参数模式识别，不碰 M6 边界；符号链接与 Windows 大小写坑已由 paths.ts 解决）。理由：信任的自然形态是"这个工具在这个范围里"；schema 第一版带字段避免后续迁移。审批提示对应加第四键 [d]（本会话允许，仅限当前调用所在目录）。
- 决策 3b 崩溃恢复：会话 grant 随 M4 Event Log 冷恢复后静默继续有效；恢复屏不加确认环节、不加特殊展示行；生效 grant 统一由 /grants 命令展示（唯一入口，含创建时间与命中次数），/revoke <id> 撤销。理由：崩溃不确定性已被 OutcomeUnknown 对账环节隔离（§3.2），grant 覆盖的是未来新调用、信任基础不因崩溃变化，重复确认是纯摩擦。（裁决覆盖"恢复时一键确认"方案。）
- 决策 3c 排期：并入 M4 施工，功能不裁剪。（裁决覆盖"M4 后独立 2–3 天增量"推荐。）已记录风险：M4 十天盒范围蔓延；缓解：grant 持久化走 Event Log 新事件族（决策 2 归并原则的自然延伸），不另起存储、不做二次迁移。
- 界面形态：全部落在 M3 既有 CLI REPL（审批提示加键 + 斜杠命令 /grants /revoke），不依赖 M2 TUI；M2 落地时 TUI 作为投影继承同一治理状态，零返工（§3.6 Actor 边界）。
- 不可破约束：
  1. deny 清单绝对优先：grant 与配置规则均不豁免 deny；
  2. grant/配置放行的调用照样过熔断计数（循环防护独立于授权）；
  3. 固化只能由人显式触发：agent、模型、后台流程不得写配置文件（§3.1 权限扩大必须有可审计的外部批准主体）；
  4. grant 是治理面运行时状态，不进 InjectionSnapshot（快照冻结针对模型注入内容；grant 必须可撤销，与冻结矛盾）；
  5. 确定性匹配：工具名 + 路径 glob，无自由文本模式（M6 安全扫描边界不破）。
- approvedBy 扩展：human:grant（命中会话 grant，intent 行回指 grantId）、policy:config（命中固化规则，回指配置条目）；与既有 human / policy:yolo / policy:auto / policy:deny 并列。
