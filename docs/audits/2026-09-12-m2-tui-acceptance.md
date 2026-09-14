# M2 TUI 真实模型链路人工终端验收 + 自动化测试盘点（2026-09-12）

收口 ROADMAP §M2 完成证据第 3 条：「自动化测试和一次人工终端验收分别记录」。本次用真实 Kimi
模型在真实 ConPTY 子进程里驱动 TUI（`node src/tui/main.ts --stream-fn tmp/real-stream-fn.mjs`）
跑六条剧本。本文件不入库（docs/audits/ 按用户决策保持本地）。零生产代码改动；HEAD 仍为
75bcb4d，`npm test` 全绿 305/305（本次复跑确认）。

## 环境与基建

- OS：Windows 11 Home China（10.0.26200）；Node v24.12.0（engines >=22.19 <25 内）；
  ConPTY 100x30（PtyHost 建伪控制台）。
- Provider：Kimi For Coding 订阅端点 `https://api.kimi.com/coding`，模型 `kimi-for-coding`，
  pi-ai `streamSimple`（anthropic-messages 线路）；StreamFn 插件 `tmp/real-stream-fn.mjs`
  （与 M3/M4 验收同一份）；密钥仅经环境变量 `KIMI_API_KEY` 传入，不落任何文件/日志/本文档。
- 驱动基建（新建，tmp/tui-acc/，gitignored）：winpty 在无控制台会话下断言崩溃不可用，
  自建 `PtyHost.cs`（C# ConPTY 桥，csc 编译为 PtyHost.exe）+ `tui-driver.mjs`
  （正则步骤表驱动 stdin/单键/定时 taskkill，原始 ANSI 流 + 剥离流 + VirtualScreen
  快照 + 分块时间线四份日志）。关键问题：父进程被管道重定向时须先 `SetStdHandle(NULL)`
  再 spawn，否则子进程继承管道而非控制台句柄（实测 isTTY=undefined）。
- 退出路径事实（重要偏差，见末节）：TUI 无可达退出命令，验收收场 = 桥发控制台 Ctrl+C
  （子进程以 0xC000013A 终止）或 taskkill /F；事件日志逐条同步写（治理族 fsync），
  强杀不丢已落盘记录，证据完整性不受影响。

## 自动化测试盘点（ROADMAP §M2 完成证据的承载确认）

`node --test "src/tui/*.test.ts"`：31 测试全过（本次复跑，全套 `npm test` 305/305 绿）。
夹具 `src/tui/testing.ts`：Mock Terminal + CJK 感知虚拟屏仿真器（宽度推进与 pi-tui 同款
get-east-asian-width），不启动真实终端。

| 文件 | 数 | 断言面 |
|---|---|---|
| shell.test.ts | 6 | 流式增量逐帧落地 + CJK 混合宽度不错位 + user 回显 + **提交只经 application API**（fake 注入断言 run() 唯一通道）；工具调用行提议→settled 原位更新、stale runId 增量忽略；工具调用轮（无 text_delta）两侧间距一致无占位空行（决策 035，2026-09-13 补）；空输入静默、busy 拒绝提交保缓冲；dispose 对称退订；真实 PiRuntimeAdapter + fake streamFn 全链路集成 |
| approval.test.ts | 9 | 审批块渲染（工具名/参数/diff/四键提示）；[y] 批准一次、[n] 拒绝、[a] 工具级 grant、[d] 目录限定 grant（含无 path 退化）；fail-closed×2（壳停止/未装配按拒绝，理由逐字）；面板期间非四键全吞；真实 adapter 集成——[y] 后写副作用真实发生 |
| grants-view.test.ts | 5 | /grants 空列表与生效列表渲染（会话 grant + 固化规则）；/revoke 立即失效、/grants save 升格写配置；未知命令与命令失败如实呈现；busy 期间斜杠命令不开旁路 |
| session-view.test.ts | 7 | /sessions 安静行 + 待对账突出行；/resume 全流程（人工确认单键 / 哈希自动确证免菜单 / restoredGrants 物化投影）；会话不存在与重复恢复响亮报错；菜单期间输入吞掉；换绑后旧运行面迟到事件不进消息区 |
| cancel.test.ts | 5 | Esc 触发 interrupt 且只一次、终态行 aborted +「取消」徽章；模态键控优先（审批挂起期 Esc 吞掉）；四分类五档徽章 + errorMessage + syntheticFailure 标注；listenerErrors 增量警告；真实 Adapter 取消链路不悬挂 |

完成证据对照：

- 「TUI 只通过 Application API 提交意图」→ shell.test.ts 注入 fake runtime 断言提交唯一通道是
  `TuiRuntimeFace.run()`；deps 巡航另有 tui 不得依赖 execution 的目录规则。**承载充分**。
- 「重启 TUI 后可恢复并渲染已有 Session」→ session-view.test.ts 的换绑/restoredGrants/重渲测试 +
  本次人工验收剧本 e（真实进程重启恢复）。**承载充分**。
- 「自动化测试和一次人工终端验收分别记录」→ 上表 + 本文档下半部分。**承载充分**。

缺口（如实）：

1. 离屏测试用 Mock Terminal + 自研虚拟屏仿真器，不是真实 ConPTY；真实终端 CJK/光标正确性由
   M2 前置 spike（tmp/spike-pi-tui part B/C，真实 ConPTY 逐格对拍）+ 本次人工验收覆盖，
   自动化层无真实终端回归（Windows CI 无交互控制台，属已知边界而非新缺口）。
2. resize 重绘无自动化用例（spike part C 实测 mode con 改 ConPTY 尺寸不可靠；pi-tui 全量重绘
   路径未被任何测试触碰）。本次人工验收未改窗口尺寸。
3. ~~无「退出 TUI」的任何测试~~（2026-09-13 更新：退出路径已落地，src/tui/exit.test.ts 6 例离屏测试 + 剧本 g 真实 ConPTY 复验，见下）。

## 人工终端验收剧本逐条证据

驱动：`node tmp/tui-acc/run-<x>.mjs`（步骤表 = 等剥离流正则 → 写输入行/单键/定时强杀）。
每个剧本产物：`<name>.log`（剥离 ANSI 人读流）、`.raw.log`、`.screen.<label>.txt`
（VirtualScreen 快照）、`.chunks.log`（分块时间线），均在 tmp/tui-acc/。

### a. 流式渲染 CJK 长文 —— PASS（tmp/tui-acc/ws-a，a-stream.*）

剧本：提示「写一段约 300 字中文散文（深秋清晨街巷），不用工具」；流式中途 4s/8s 定时抓屏。

- 分块时间线（流式生长时序证据）：首块 +217ms，19 块，散文内容块自 +2.7s 起陆续到达，
  收尾块 +11.1s/11.5s（667B/422B），终态行 +11.7s——增量逐帧落地而非一次性吐出。
- 中途快照（a-stream.screen.mid.txt）：`深秋的清晨，街巷像被一层薄雾轻轻罩住。天刚蒙蒙亮，`
  ——首个内容行生长中；最终快照含 `-- turn: stop --` 与 `== run: completed | stop: stop | 分类：正常 ==`。
- CJK 无错位：剥离流散文 11 个长 CJK 行（「青石板路泛着微光…」等），宽标点「，。」完整不劈字；
  VirtualScreen 四张快照（start/mid/final/exit）逐行可见宽度 ≤ 100（PTY 列宽）零超宽、
  全文零 U+FFFD（tmp/tui-acc/check-a-width.mjs 实测输出：4 张快照 overWidth 全 0、fffd 全 false）。

### b. 审批面板 [y] 批准 —— PASS（ws-b，b-approve.*）

剧本：hello.txt 第一行 worlld → world；面板出现按 y。

- 终端原文（剥离流）：
  `批准执行？[y] 批准一次 / [n] 拒绝 / [a] 本会话允许 / [d] 本会话允许(仅限当前调用所在目录)`
  →（驱动单键 "y"）→ `审批结果：人工批准` → `== run: completed | stop: stop | 分类：正常 ==`。
- 文件系统佐证：`hello.txt` = `hello world\nthis file has a typo\n`（编辑真实生效）。
- 账本佐证（.pigeon/sessions/sess_01M2BW90….jsonl）：edit_file intent
  `{"executionId":"exec_01M2BW955C5E2RC2CJE38V0M44","decision":{"approvedBy":"human",…}}`；
  receipt `{"approvedBy":"human","executed":true,"isError":false,"summary":"edit_file 执行完成",
  "contentAfterHash":"aca7e58c9d66e80a"}`。read_file 按决策 1 只留 tool.proposed/tool.settled
  事件级记录（无 intent/receipt），符合证据链分层。

### c. [a] 放权 + 免审命中 + /grants —— PASS（ws-c，c-grant.*）

剧本：第一跑 hello.txt 按 [a]；第二跑 second.txt 改 beta→BETA（不再问人）；然后 /grants。

- 终端原文：`审批结果：人工授权（会话 grant）` + `已创建会话放权 grant_01M2BWBF9X6QZE9QGEH5T4X6ZS（edit_file）`。
- 第二跑全程无面板：剥离流中 `批准执行？[y]` 两次出现均在第二次提交之前（索引 1473/2795 vs
  第二次提交 3325——第二次是重渲染重复行，见偏差 3），两次 `== run: completed` 齐全。
- 账本：两个 edit_file intent 的 `decision.approvedBy` = `["human","human:grant"]`——
  第二次写调用 grant 免审命中。
- 文件：second.txt 第二行 `keep beta` → `keep BETA`。
- /grants 渲染原文：`会话放权（1）：` / `…｜ edit_file ｜ 工具级（不限目录）｜ 创建 2026-09-12 22:38 ｜
  命中 1 次 ｜ 首调 tool_lAnY…（{…}）` / `固化规则（0，来自 .pigeon/grants.json）：`——命中计数真实渲染。

### d. Esc 取消 —— PASS（ws-d，d-cancel.*）

剧本：「从 1 数到 400 每个数字一行」长流式；流到 200 时按 Esc；取消后再跑一个小 Run 验证不悬挂。

- 驱动：@13039ms 写入单键 `"\u001b"`（Esc）。
- 终端原文：`== run: aborted | stop: aborted | 分类：取消 | error: This operation was aborted ==`——
  aborted 终态 + 四分类「取消」徽章。
- 不悬挂：状态栏回 `state: idle | [enter] submit` 后提交「只回复两个字：好的」，
  `== run: completed | stop: stop | 分类：正常 ==` 正常收尾；进程随后正常收场。

### e. 崩溃恢复 —— PASS（ws-e，e-cal/e-crash/e-resume.*）

崩溃窗口制造（诚实记录手法）：edit_file 的 intent→receipt 窗口对小文件只有毫秒级，用
136MB big.txt（600 万行）撑开——校准跑（e-cal，不杀）量得：按 y 后 +2278ms intent 落盘、
execution 窗口 +2284ms~+4944ms。崩溃跑在按 y 后 +3500ms `taskkill /F`（Windows 无 SIGKILL，
TerminateProcess 等效），命中窗口中段。

- 崩溃现场（e-crash.log）：`[驱动] taskkill /F 子进程（模拟崩溃，距上一步 3500ms，实际 @13539ms）`，
  进程死。会话 sess_01M2BWQCQWX0DQ4Q3CQY43HWGP 留下：edit_file intent（approvedBy=human，
  contentHashes beforeHash=74de…/expectedAfterHash=0bf3…）**无 receipt**、无 run.ended——
  标准 OutcomeUnknown 悬账。磁盘 big.txt 第一行未被改（杀在执行落盘前）。
- 重启 TUI（新进程，同 --root）：`/sessions` 渲染原文——
  ```
   2026-09-12 22:42  1 个 Run  sess_01M2BWK0H225T9N3ZJNGWMFGQ3
   2026-09-12 22:45  1 个 Run  sess_01M2BWQCQWX0DQ4Q3CQY43HWGP
     1 条待对账（上次会话异常中断，用 resume 处理）
   2026-09-12 22:45  0 个 Run  sess_01M2BWQV4FYNYG1JA89QZWKHCK
  ```
  安静行（含校准会话与新会话）+ 待对账突出行，渲染口径符合 D5。
- `/resume sess_01M2BWQC…` 对账报告原文：
  `会话 sess_… 冷恢复对账：` / `  本次自动确证（哈希比对）1 条：` / `    edit_file：未执行` /
  `  剩余待对账：无。` / `    崩溃残留：1 个 Run 无 run.ended（用 trace 或 replay 查看中断位置）` /
  `模型对话上下文重新建立（Pi transcript 不恢复）；后续 Run 继续写入本会话事件日志。`
  ——哈希自动确证命中（当前文件哈希 ≡ intent 改前哈希 ≠ 预期改后 → 未执行），**无需人工菜单**；
  resolution 落盘 `{kind:"resolution", method:"hash-auto", outcome:"not-executed",
  executionId:"exec_01M2BWQJJNT0V4W3BZK4ZBKYSD"}`。
- 同 sessionId 续跑：换绑后 chrome 标题从启动会话 `sess_01M2BWQV4FYN…` 切到
  `== pigeon tui | session sess_01M2BWQCQWX0DQ4Q3CQY43HWGP ==`；续跑「只回复两个字：继续」
  `== run: completed`；崩溃会话文件内出现 2 个不同 runId（崩溃 Run + 续跑 Run），
  续跑记录追加进同一 sess 文件。

### f. /sessions 与 /grants 真实渲染 —— PASS

- /sessions：见剧本 e 第二条证据（e-resume.screen.sessions.txt 快照 + 剥离流原文）。
- /grants：见剧本 c 末条证据（c-grant 剥离流原文；含命中计数与首调摘要）。

### g. 退出路径（决策 033）—— PASS（2026-09-13 补验，ws-g，g1-quit / g2-double / g3-running-exit.*）

驱动用自退出变体 `tui-driver-selfexit.mjs`（步骤用尽不关桥 stdin，避免桥的 CTRL_C_EVENT 抢在 TUI 自己退出之前——首轮用原驱动三个子剧本退出码全是 0xC000013A，正是桥事件所致，如实记录）。三个子剧本各自独立进程，退出码均为 TUI 自身 `process.exit(0)`：

- g1 单击 Ctrl+C 清缓冲 → /quit：先以原始字节键入 `draft text not submitted`（不回车），屏幕出现草稿；写入 ``，剥离流出现 `[cleared] 输入已清空（再按一次 Ctrl+C 退出）`，退出快照不再含草稿；`/quit` 后进程自行退出 code=0。零模型调用。
- g2 空闲双击 Ctrl+C：写入 ``，进程自行退出 code=0。零模型调用。
- g3 运行中双击 Ctrl+C：Kimi 流式数数到 60 时写入 ``，进程自行退出 code=0；新会话文件记录族 `entry turn.started entry turn.completed run.ended`，末轮 stopReason=aborted 且 run.ended 在场——即优雅退出经 adapter.dispose()（abort → waitForIdle）收尾，不是崩溃残留（对照剧本 e 的 taskkill：无 run.ended）。

这验证了 033 的前提：pi-tui raw mode 下 Ctrl+C 作为 `` 输入字节到达（原偏差 1 的观察），新代码在输入层接管它。

## 费用与 token 说明

Kimi For Coding 为订阅额度。本次共 7 次真实运行（a/b/c/d 各 1、e 校准+崩溃+续跑 3），
每轮 1–3 次 API 调用；e 剧本大文件仅读 5 行窗口，模型侧 token 消耗很小。总耗时约 2.5 分钟。

## 偏差与诚实记录

1. **TUI 无可达退出路径**（原始记录保留如下；**2026-09-13 已修**：决策 033 三层退出形态——Esc 取消 / Ctrl+C 清缓冲 / 双击退出 + /quit，离屏 6 例 + 剧本 g 真实 ConPTY 复验通过）：斜杠命令只有
   /sessions /resume /grants /revoke /grants save，无 /quit；Ctrl+C 在 pi-tui raw mode 下
   被吞为输入数据（ConPTY 实测：\x03 注入后进程继续运行），main.ts 的 SIGINT 优雅退出不可达。
   验收收场只能 taskkill /F 或桥发控制台 Ctrl+C 事件（子进程以 0xC000013A 终止，node 的
   JS SIGINT 处理器在 ConPTY 下不被派发——实测含 CREATE_NEW_PROCESS_GROUP 与否均如此）。
   事件日志逐条同步写（治理族 fsync、观察族 writeSync），强杀不丢已落盘记录，验收证据完整；
   但作为 M2 交付物「用户如何退出 TUI」无答案，建议后续补 /quit 或输入层 ctrl+c 绑定。
2. 崩溃注入用 taskkill /F（Windows 无 SIGKILL）；intent→receipt 窗口靠 136MB 大文件撑开
   （校准数据见剧本 e），非小文件可复现的时序。
3. （原始记录保留如下；**2026-09-13 复验闭合**：剧本 n3 真实 ConPTY 复验 /grants——两条固化
   规则 + 一条会话 grant，/resume 后连发三次触发重绘，四张屏幕快照中每条 grant 行恰出现一次、
   行宽全 ≤100、无 U+FFFD；屏幕上未见重复行，原观察归因于剥离流合成与快照重放近似，证据见
   docs/audits/2026-09-12-m2-fixes.md note-3）剥离输出流含重渲染重复行（审批面板行在剥离流中
   出现两次，位置分析证明第二次提交后面板未再出现）；VirtualScreen 快照对 conhost 合成 VT 流
   的重放是近似——/grants 长行折行处的快照有重影，正文引用一律以剥离流原文为准。
4. 模型行为：7 次运行全部一次成功，严格按 read_file→edit_file 顺序调用、锚点/快照标签逐字
   正确，无幻觉工具名、无重试；未需要调整任务措辞。
5. 施工返工（未消耗 API token）：PtyHost 初版子进程继承管道句柄（isTTY=undefined）→
   SetStdHandle(NULL) 修复；GenerateConsoleCtrlEvent 组定向 + CREATE_NEW_PROCESS_GROUP
   屏蔽 CTRL_C → 改 AttachConsole + 广播；驱动逐块 toString 在块界产生假 U+FFFD →
   StringDecoder 修复（另：run-a.mjs 的 U+FFFD 字面量曾被工具链吞成空串造成误报，已改
   fromCharCode 写法复核为 0）。
6. tmp/tui-acc/（PtyHost.cs/exe、驱动、六个工作区、全部日志）全部 gitignored；
   `git status --short` 为空，未 commit 任何东西。
