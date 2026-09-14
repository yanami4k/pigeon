# M4 真实模型链路端到端验收（2026-09-12）

- 基线：`dev` @ `5f14d63`（M4 收口修复 + 模块归位 + 路线图回写全部提交，已推送 origin/dev）
- Provider：Kimi For Coding（`https://api.kimi.com/coding`，pi-ai `streamSimple` anthropic-messages 线路，模型 `kimi-for-coding`）；插件沿用 M3 验收的 `tmp/real-stream-fn.mjs`（gitignored，密钥只经环境变量 `KIMI_API_KEY` 读取，本文档与日志均不含密钥）
- 驱动：`tmp/acc-driver.mjs`（起 CLI 子进程，按"等 stdout 正则 → 写 stdin 一行"交互，支持定时 SIGKILL 模拟崩溃）；各路径脚本 `tmp/acc-run-*.mjs`；原始终端日志 `tmp/acc-*.log`；工作区 `tmp/acc-a`、`tmp/acc-c`、`tmp/acc-d`、`tmp/ws-approve`（全部 gitignored，保留为证据）
- 覆盖面（交接文档 §4 第 2 步 + 收口新增）：多 Run + entry 族 ✔、[a] / [d] / /grants save / /revoke 全流程 ✔、新进程命中固化规则 ✔、/revoke config#N 留痕与历史回指不漂移 ✔、真实进程崩溃 + resume 续跑 ✔、trace / replay / session list 真实渲染 ✔、D8 旧账本迁移 ✔
- 结论：功能路径全部通过；验收暴露两处判据与措辞缺陷（O-1、O-3，P2），已在同日修复并复验（见末节）；O-2 为模型行为
- `git status --short` 全程为空，未 commit 任何东西

## 路径 A：多 Run + [a] 放权 + 免审命中 + 升格（tmp/acc-a，会话 sess_01M2BA0A…）

一个进程两个任务。任务一：读 hello.txt 改错别字，审批提示按 `a`；任务二：读 second.txt 改 beta → BETA，无审批提示。之后 `/grants`、`/grants save <id>`、`/grants`、`:quit`。一次成功。

终端摘录：

```
批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录)
已创建会话放权 grant_01M2BA0G4V8THA3E1M9CMC2S14（edit_file）
终态：completed（stopReason=stop）
  read_file：approved（policy:auto）→ settled
  edit_file：approved（human）→ settled
终态：completed（stopReason=stop）
  read_file：approved（policy:auto）→ settled
  edit_file：approved（human:grant）→ settled
会话放权（1）：
  grant_01M2BA0G… ｜ edit_file ｜ 工具级（不限目录） ｜ 创建 2026-09-12 17:17 ｜ 命中 1 次 ｜ 首调 tool_MfRjJ…
固化规则（0，来自 .pigeon/grants.json）：
已升格 grant_01M2BA0G… → .pigeon/grants.json（固化规则下次会话启动时生效；本会话求值冻结）
```

- 文件：hello.txt → `hello world`，second.txt → `alpha / BETA`（编辑真实生效）。
- grants.json：一条规则，promotedFrom.grantId = grant_01M2BA0G…，含 sessionId 与首调参数。
- Event Log 记录族序列（两个 Run 各 6 条 entry，runSeq 1–6 连续；run.ended.messageCount = 6 与 entry 数一致 → 冷侧断号判据在真实链路零误报）：`entry turn.started entry turn.completed tool.proposed tool.settled entry turn.started entry turn.completed tool.proposed grant.created intent(human) receipt tool.settled entry turn.started entry turn.completed run.ended` × Run 1；Run 2 同形但 intent 为 `human:grant grantRef={session-grant, grant_01M2BA0G…}`；末条 `grant.promoted`（REPL 时段，无 runId）。
- trace 渲染：会话头 `Run 2 个 ｜ 工具调用 4 次 ｜ 待对账 0 次 ｜ 落盘缺口 0 处`；读调用标"事件级记录（读调用按决策 1 只留事件级）"；编辑调用标"人工批准（human）"与"人工授权（会话 grant）（human:grant）"，哈希证据"改前 → 预期改后"与 Receipt"实测改后 …（与预期一致）"。
- replay 渲染：20 条事件按落盘序，`grant.created` 原位出现在 tool.proposed 与 intent 之间；Receipt 落盘时间戳早于 tool.settled 事件（既有已知形态：settle 时先落账再发事件）。

## 路径 B：新进程命中固化规则 + /revoke config#0（tmp/acc-a，会话 sess_01M2BA2W…）

新进程启动装载路径 A 的 grants.json。`/grants` 列出 `config#0 ｜ edit_file ｜ 工具级 ｜ 升格 17:18 ｜ 出处 会话 sess_01M2BA0A… / grant grant_01M2BA0G…`；任务改 second.txt 第一行，无审批提示，`edit_file：approved（policy:config）→ settled`；`/revoke config#0` 输出"已移除固化规则 config#0（edit_file，出处 grant grant_01M2BA0G…）：求值面会话内冻结，下次会话启动起不再生效"；再 `/grants` 仍列出 config#0（会话内冻结，符合设计）。

- grants.json 移除后为 `{"version":1,"grants":[]}`。
- 本会话 Event Log：`intent edit_file policy:config grantRef={config-rule, grant_01M2BA0G4V8THA3E1M9CMC2S14}`，末条 `grant.config-removed grantId=grant_01M2BA0G… index=0`。**回指是升格来源 grant 的稳定身份，不是位置序号；规则移除后该 intent 的回指仍可解析到 grant.created / grant.promoted 记录**（决策 019 的真实链路证据）。
- trace 渲染：`审批：策略放行（固化配置）（policy:config）`。

## 路径 C：真实进程崩溃 + resume（tmp/acc-c）

四次崩溃尝试、三次 resume，全部用 SIGKILL 真杀 CLI 子进程：

| 场次 | 强杀时机 | 落盘残留 | resume 表现 |
|---|---|---|---|
| C1（sess_01M2BA3X…） | 审批提示挂起时 | Run 有 turn.completed(toolUse) 与 tool.proposed，无 intent、无 run.ended | 未 resume；trace：`run.ended 缺失（崩溃残留可能）`，编辑调用标"无治理记录（未过审批闸——上游拦截或事件落盘缺口）" |
| C2（sess_01M2BAKV…） | 同 C1（驱动缺陷导致未按计划在批准后杀，如实记录） | 同 C1 | resume：自动确证无、"剩余待对账：无，证据链完整"；进入 REPL 在同一会话续跑 Run 2（entry runSeq 从 1 重新计数），run.ended 在场；session list 显示 2 个 Run |
| C4（sess_01M2BAPN…） | 批准后 1500 ms | 未砸中：Kimi 收尾轮 < 1.5 s，进程已正常退出 | resume 正常，续跑 Run 2 |
| **C6（sess_01M2BAR1…）** | **批准后 300 ms** | **intent(human) + receipt + tool.settled + entry 5 已落盘，随后死于收尾轮网络往返：无 turn.started/6、无 run.ended** | resume："本次自动确证（哈希比对）：无 / 剩余待对账：无，证据链完整"（Receipt 在场，悬账为零——正确）；续跑 Run 2 成功；trace 头 `run.ended 缺失（崩溃残留可能）`，编辑调用完整显示哈希证据与 Receipt"与预期一致"；replay 末行"记录到此中断（崩溃可能）：本 Run 无 run.ended 事件" |

- 文件：C6 后 notes.txt 已是 `line two`（副作用真实发生且 Receipt 已落盘，崩溃未造成悬账）。
- 跨进程续写同一会话文件：C3/C5/C7 三次 resume 的 Run 2 都追加进原文件，幂等索引重建无冲突。
- **未命中的窗口**：intent 已写、receipt 未写的 OutcomeUnknown 窗口在真实链路只有 edit_file 执行的几毫秒，四次尝试均未落入。该窗口的自动确证（哈希三方比对）与人工三选一由单元崩溃矩阵（故障注入落盘面）覆盖，不在本次真实链路证据内，如实登记。

## 路径 D：[d] 目录限定 + /revoke + 撤销后重新审批（tmp/acc-d，会话 sess_01M2BA41…，4 个 Run）

```
任务 1 改 src/a.txt：审批按 d → 已创建会话放权 grant_01M2BA46…（edit_file）；edit_file：approved（human）
任务 2 改 src/b.txt：无提示；edit_file：approved（human:grant）
任务 3 改 lib/c.txt：弹审批，按 y；edit_file：approved（human）
/grants：grant_01M2BA46… ｜ edit_file ｜ 仅限目录 src ｜ 命中 1 次
/revoke grant_01M2BA46…：已撤销会话放权：立即生效，后续调用重新弹人工审批
任务 4 改 src/a.txt：弹审批，按 n，理由「验收：撤销后必须重新问人，这次故意拒绝」；edit_file：rejected（human）
```

- 文件：src/a.txt `src ALPHA`（任务 4 拒绝后未改回）、src/b.txt `src BRAVO`、lib/c.txt `lib CHARLIE`。
- trace：四个 Run 全部"分类：正常"，Run 4 编辑调用"人工拒绝（human）/ 拒绝理由：验收：撤销后必须重新问人，这次故意拒绝 / Receipt …：未执行（副作用未发生）"；会话头"待对账 0 次 ｜ 落盘缺口 0 处"。

## 路径 E：旧工作区启动触发 D8 迁移（tmp/ws-approve，M3 验收留下的 ledger.jsonl）

启动 REPL 后立即 `:quit`（零 API 调用）。`.pigeon/ledger.jsonl` 改名为 `ledger.legacy.jsonl`，迁移出会话 sess_01M2BA44X8…（1 个 Run），另有本次启动即建的空会话 sess_01M2BA44YB…（0 个 Run，"启动即建文件、退出于首事件前"的合法形态）。迁移会话 trace 按设计标注：`分类：未知 ｜ run.ended 缺失`，两次调用各"提议参数：<tool.proposed 事件缺失（证据缺口）>"+ 治理记录与 Receipt 齐全 + "异常：治理记录无对应 tool.proposed 事件"（M3 账本只有治理族，无运行时事件——审计 note-5 的预期形态）。

## 观察（初判为登记项；复审后重判：O-1、O-3 定 P2 已修，O-2 维持模型行为）

- **O-1 崩溃 Run 的分类口径**：C1/C2/C6 三个死于中途的 Run，trace 头显示 `分类：正常 ｜ run.ended 缺失（崩溃残留可能）`。D7 Run 级判据以末条 turn.completed 的 stopReason 定分类，"无 run.ended 但有 turn.completed"落"正常"，只靠头部的崩溃残留标注提示。可选做法：run.ended 缺失时 Run 级分类落"未知"（D7 精神：不确定就不贴正常标签）。影响面：session list 的 `--class unknown` 过滤当前找不到这类会话。
- **O-2 模型行为**：路径 B 中 Kimi 把 `alpha` 改成了带前导空格的 ` ALPHA`；harness 落账、执行与 Receipt 哈希均与模型提议逐字一致（trace 提议参数 `"lines":[" ALPHA"]`），非 harness 问题。
- **O-3 resume 屏的"证据链完整"**：C6 场景 resume 报"证据链完整"是按三类冷侧缺口（撕裂尾巴 / entry 断号 / 孤儿）判定的，run.ended 缺失不在其中，由 trace/replay 承担标注。措辞是否应改为"无待对账与落盘缺口"以免与"崩溃残留"并存时显得矛盾，随 O-1 一并裁决。

## 费用与返工

- API 调用约 28 次（每个完整 Run 2 次，崩溃 Run 1–2 次），Kimi For Coding 订阅额度，对额度可忽略；无 SDK 层错误。
- 返工（均未浪费 API 调用或只浪费一次）：①路径 A 脚本里中文引号写成直引号导致 mjs 语法错，未启动；②C2 驱动"kill 与 send 互斥"导致未按计划在批准后强杀，改驱动支持同步 send + 定时 kill；③C4 延迟 1500 ms 过长未砸中，改 300 ms 命中。
- 模型行为：全部任务一次成功，严格 read_file → edit_file 顺序，hashline 锚点与快照标签逐字正确，无幻觉工具名。

## 复验：O-1 / O-3 修复后对同一批真实崩溃会话重跑（零 API 调用）

修复内容见 docs/decisions/m4-closeout-decisions.md 决策 ④、decisions.md 023；`npm run verify` 全绿（269 测试，+4 红测试先行；既有 5 个夹具因缺 run.ended 被新判据如实判未知，按真实链路形态补 run.ended 而非放宽判据）。

C6 会话（intent + receipt 已落盘，死于收尾轮）trace：

```
会话 sess_01M2BAR1… ｜ Run 2 个 ｜ 工具调用 3 次 ｜ 待对账 0 次 ｜ 落盘缺口 0 处 ｜ 崩溃残留 1 个 Run
Run run_01M2BAR1… ｜ 终态 stopReason=toolUse ｜ 分类：未知 ｜ run.ended 缺失（崩溃残留可能）
Run run_01M2BAR9… ｜ 终态 stopReason=stop ｜ 分类：正常
```

C1 会话（审批挂起时被杀）resume 屏：

```
会话 sess_01M2BA3X… 冷恢复对账：
  本次自动确证（哈希比对）：无
  剩余待对账：无。
  既往缺口（文件形态派生）：
    崩溃残留：1 个 Run 无 run.ended（用 trace 或 replay 查看中断位置）
```

`session list --class unknown` 现在列出全部三个崩溃会话（修复前为空）；路径 A 健康会话的 trace 头逐字不变（无崩溃残留字段）。
