# M4 收口决策（2026-09-12）

- 定位：M4 对照审计（docs/audits/2026-09-12-m4-review.md）发现的 P2×2 与关联 note 的逐件裁决记录；上位决策见 m4-pre-decisions.md（决策 3 Grant 体系）与 m4-design-decisions.md（D2 失败可见化、D3 entry 映射）
- 裁决人：项目负责人；方式：逐件盘问后裁决（P2-1 → note-6 → P2-2 顺序，全部落定）
- 前提事实：仓库无 .pigeon 目录，Event Log 从未有真实会话落盘，版本推进无历史数据迁移负担；既有 v2→v3、v3→v4 均为加法式纯版本推进先例

## 决策 ①：P2-1 固化规则回指 = promotedFrom.grantId 稳定身份 + 升格/移除留痕

- 缺口：matchConfigGrants 的 refId 是数组下标（`config:grants.json#<index>`），/revoke config#N 用 splice 整文件重写后序号前移，历史 intent 的 grantRef 漂移或悬空；配置移除只改 grants.json，Event Log 零留痕（grant.revoked 族仅覆盖会话 grant）。决策 3"每次自动放行账本回指具体条目，可审计凭什么没问人"在移除后失真
- 方案选型：(a) 稳定身份 + 移除留痕 vs (b) 只补留痕 vs (c) 不修；选 (a)——根因是位置身份不稳定，而稳定身份已在文件里（每条规则自带 promotedFrom.grantId，ULID）
- 实现要点：
  - refId 回指 promotedFrom.grantId，数组序号只留给 /grants 展示与 /revoke config#N 输入
  - /grants save 与 /revoke config#N 各落一条 Event Log 记录（新增记录族 grant.promoted / grant.config-removed，EVENT_LOG_VERSION 4→5，加法式纯版本推进，冷物化器同步）
  - 留痕顺序不对称（施工中确立）：升格 = 扩权，先留证后写配置，留证失败则不扩权（与 grant.created 同款 fail-closed）；移除 = 缩权，先改配置后留证，留证失败只少一条痕迹（反过来会让审计者误以为规则已不生效）
  - 定级依据保持：执行期授权判定本身正确（移除只影响未来求值面且如实标注"下次会话生效"），缺口在历史可追溯性

## 决策 ②：note-6 升格去重 = 同一 grantId 只允许升格一次

- 缺口：appendGrantConfigRule 直接追加不查重，同一会话 grant 重复 /grants save 产生两条 promotedFrom.grantId 相同的规则。当前只是文件噪声（首个命中者生效），但决策 ① 以 grantId 为身份后会撞身份
- 方案选型：(a) 同 grantId 拒绝二次升格 vs (b) 再按 tool+pathPrefix 语义去重 vs (c) 不去重改加规则级 uid；选 (a)——恰好补上身份唯一性缺口；(b) 语义重复是噪声不是歧义，拒绝会丢掉另一次授权的出处；(c) 放弃已认可的 grantId 方案
- 实现要点：/grants save 时查文件内是否已有同 promotedFrom.grantId 规则，有则响亮报错并指出已存在的 config#N

## 决策 ③：P2-2 D2 冷视图可见化 = 三处全补 + D2 措辞精确化

- 缺口：D2 承诺"listenerErrors 非空时启动/冷恢复显式警告 + trace/replay 标注缺口"，as-built 三处不全：①listenerErrors 是进程内数组，新进程恒空，repl.ts 启动即查永不触发；②trace 不渲染 tornTail（replay 有）；③entry 写盘失败按 D3 留 runSeq 空洞，冷视图无连续性检测
- 原理性限制：写盘失败的记录不可能靠写盘持久化，跨进程只能从文件形态派生推断。①的字面承诺不成立，须改措辞
- 方案选型：(a) 三处全补 + 措辞精确化 vs (b) 只补 resume 汇总 vs (c) 只改措辞；选 (a)——三处改动小，②直接违反 D2"绝不假装证据链完整"原话
- 实现要点：
  - runSeq 断号判据放进 materializeSession（按 runId 分组找空洞），trace/replay/resume 消费同一份派生结果（活冷同判据原则）；末尾缺失由 run.ended.messageCount（= 本 Run 的 message_end 条数，真实链路三种收尾实证一致）推出，无 run.ended 的崩溃残留 Run 不推末尾（不知道就不猜）
  - trace 运行头渲染 tornTail 与断号汇总，措辞与 replay 同口径
  - replay 在空洞位置原位标注（沿用"标注："行风格）
  - resume 冷恢复屏汇总既往缺口：撕裂尾巴、孤儿、runSeq 断号、待对账
  - D2 第三条措辞改为"进程内 listenerErrors 非空时即时警告；冷恢复与 trace/replay 以文件形态派生标注既往缺口"
- 定级依据保持：崩溃矩阵证明对账结论不受影响，证据未丢，缺口在可见化覆盖度

## 决策 ④：验收观察 O-1 / O-3 = 崩溃残留 Run 恒为未知，resume 与 trace 计崩溃残留（2026-09-12 验收后）

- 缺口：真实链路验收中三个死于中途的 Run（有 turn.completed 但无 run.ended）在 trace 里显示"分类：正常 ｜ run.ended 缺失（崩溃残留可能）"；resume 对其说"证据链完整"。D7 Run 级判据只看末条 turn.completed 的 stopReason，没把 run.ended 当事实输入；resume 缺口汇总只数撕裂尾巴 / entry 断号 / 孤儿三类。
- 定级修订：这三条验收观察最初被登记为观察项，复审认定是定级错误；O-1、O-3 定 P2 修，O-2（模型写入带前导空格的内容，harness 逐字落账执行）维持为模型行为不判缺陷。
- 方案：RunOutcomeFacts 加 hasRunEnded，缺失即未知且优先于 stopReason；活侧恒传 true（RunResult 在 agent_end 之后计算；abort 路径上游照常发 agent_end，D8 迁移会话本就未知）。冷物化加 unfinishedRuns 单一判据源；resume 汇总加"崩溃残留：N 个 Run 无 run.ended（用 trace 或 replay 查看中断位置）"，标题从"既往落盘缺口"改"既往缺口"（崩溃残留不是写盘失败）；trace 会话头加"崩溃残留 N 个 Run"，与落盘缺口分开计。
- 测试先行：四个红测试（判据 / 冷物化 unfinishedRuns / resume 措辞 / trace 徽章与计数）；既有五个夹具因缺 run.ended 被新判据如实判未知，按真实链路形态补 run.ended（abort 也发 agent_end）而非放宽判据。
- 索引：decisions.md 023。

## 施工约定

- 测试先行：决策 ① 两个红测试（移除后历史 grantRef 仍正确解析；升格/移除有 Event Log 留痕），决策 ② 一个（重复升格报错），决策 ③ 三个（trace 撕裂标注；冷物化断号字段 + replay 原位标注；resume 汇总行）
- 交付以 npm run verify 全绿为准；修复过程与证据落盘 docs/audits/；合并 main 与推送另行指令
- 施工结果：2026-09-12 全部落地，265 测试全绿，变异 M1–M6 精确变红；证据见 docs/audits/2026-09-12-m4-closeout.md
- 其余 note（1/2/3/4/5/7/8）本轮登记不动；note-2、note-4 作为后续里程碑（exec 工具接入、多实例）前置条件
