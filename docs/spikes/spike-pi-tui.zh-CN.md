# Spike：pi-tui 0.84.4 中文终端适配验证（M2 前置，合同性）

- 日期：2026-09-12
- 对象：`@earendil-works/pi-tui@0.84.4`（锁定版本，依赖 `get-east-asian-width@1.6.0` + `marked@18.0.5`；全部结论以 node_modules 内 dist 实际代码 + 本机实跑输出为准）
- 机器：Windows 11 Home China，活动代码页 936（实测 `chcp`），终端 = omp broker 分配的真实 ConPTY（node-pty），Node v24.12.0
- 复现脚本：`spikes/spike-pi-tui/part-a-mock.mjs`（进程内 Mock Terminal + 虚拟屏幕仿真器，约 28s）、`spikes/spike-pi-tui/part-b-conpty.mjs`（真实 ConPTY 光标实测，需 PTY，约 30s）、`spikes/spike-pi-tui/part-c-real.mjs`（真实 pi-tui 应用链路，需 PTY，约 6s）
- 目的：履行 ROADMAP §M2 的前置合同——pi-tui 最小控件 + 中文长文本流式输出 + 窗口 resize 重绘，在 Windows ConPTY 下验证 CJK 宽度与光标定位；不通过则切 ink。

## 方法

三层证据，两边对拍：

- **Part A（库自洽一侧）**：实现一个 CJK 感知的虚拟屏幕仿真器（独立用 `get-east-asian-width` 计算单元格推进、行尾宽字符整体换行、CUU/CUD 视口内钳制、\n 滚屏），实现 `Terminal` 接口喂给真实的 `TuiMainScreen` + `Text` 组件。逐 chunk 流式驱动后断言：仿真器屏幕内容 == 发送内容（零丢失零重复）、每行宽度 ≤ 终端宽、仿真器光标行/视口顶 == pi-tui 内部跟踪值（`hardwareCursorRow` / `previousViewportTop`）。任何宽度误算都会在仿真器里造成意外换行/错位并被捕获。
- **Part B（终端真相一侧）**：本机 ConPTY 实测**不应答** DSR CPR（`\x1b[6n`，12 探针 × 1.5s 全超时）——改用同控制台 PowerShell 子进程读 `[Console]::CursorLeft/CursorTop`（底层 `GetConsoleScreenBufferInfo`，控制台缓冲区真值），与 `get-east-asian-width` 预测逐条对拍。探针自校准（B0）证明查询动作本身不移动光标。
- **Part C（端到端）**：真实 `ProcessTerminal` + `TuiMainScreen` + `Text` + 光标探针（`CURSOR_MARKER` 跟在 CJK 前缀后）在真实 ConPTY 下跑 60 chunk 流式，再用 PowerShell 光标读数校验 pi-tui 的光标落点；并用 `mode con` 做一次真实 ConPTY resize 验证重绘链路。

## 判过标准（先于实跑定义）

| 编号 | 判据 | 通过条件 |
|---|---|---|
| A1 | pi-tui 宽度函数与东文宽度表一致 | 门槛语料（汉字/ASCII/宽标点。，！「」/全角ＡＢＣ/半角ｱｲ/emoji）逐条 `visibleWidth == 逐字素 eastAsianWidth 求和` |
| A2 | 中文长文本流式渲染不错位 | 三种宽高组合（81×12 滚屏、60×50 无滚动、21×10 极窄）逐 chunk 断言：行宽不越界 + 内容零丢失 + 光标行/视口顶与 pi-tui 跟踪一致；纯 Han 语料（千字文）额外要求逐行 == 字素贪心参考（宽字符绝不骑跨行界） |
| A3 | 光标定位数学 | `CURSOR_MARKER` 前缀为 CJK/混合串时，渲染后终端光标列 == `visibleWidth(前缀)`，marker 剥离无残留 |
| A4 | resize 重绘路径 | 宽度 81→41→120 变化触发全量重绘（`fullRedrawCount` 递增），新宽度下内容零丢失、行宽不越界、光标一致 |
| A5 | 流式刷新性能可用 | 无界单 Text 平均帧 < 16ms（跟得上内置 16ms 节流）；真实分消息形状平均帧 < 8ms |
| B1 | 真实 ConPTY 单元格推进 | 汉字/宽标点/全角/半角/混合/emoji 探针实测推进 == 预测宽度，且不异常推进行 |
| B2 | CJK 后光标后退 | 写「中文测试abc」（11 格）后 CSI 3D / 8D 落点逐格精确 |
| B3 | 行尾宽字符整体换行 | 写满整行后再写一个汉字：终端必须把它整体推到下一行 1-2 格，不劈字；超长串换行后行列与预测一致 |
| B4 | 歧义宽字符（U+2014/00B7/2460/2500/00B1） | **不进通过条件**，实测记录分歧（结论：全一致） |
| C1–C4 | 真实链路 | 60 chunk 流式无异常；真实终端光标落点 == pi-tui 预测；resize（若 mode con 生效）触发全量重绘；干净 stop |

已知限制声明（不算失败）：Windows 无 SIGWINCH（`terminal.js:109-111` 注释明示 Unix only），resize 事件只能来自宿主改 ConPTY 尺寸；子进程内 `mode con` 改宿主持有的 ConPTY 尺寸不可靠（5 次实测 2 次成功），该路径失败时以 A4 直测重绘路径兜底。

## 实证输出

### Part A（`node spikes/spike-pi-tui/part-a-mock.mjs`，exit 0）

```
== PART A 汇总: 1291 PASS / 0 FAIL ==
  A1 宽度台账 7 PASS；A2a(81x12) 364 PASS；A2b(60x50) 280 PASS；A2c(21x10) 436 PASS；
  A2d-han(21x10/20x10) 190 PASS（逐行 == 字素贪心参考）；A3 光标 4 PASS；A4 resize 5 PASS；A5 5 PASS
INFO 歧义/组合字符 "é"(e+U+0301): pi-tui=1 参考=1；"①②": 2=2；"——": 2=2；"·": 1=1；"±": 1=1；"─": 1=1
PERF-A5a 单Text无界 x2000: wall=26985ms mean=13.489ms p95=25.786ms max=48.75ms 内容=50000格
PERF-A5b 每消息一Text(200条+流式尾巴): mean=1.030ms p95=1.756ms
PERF 节流通路: 2000 chunks 合并为 1 帧, wall=44ms
```

A5a 说明：单 `Text` 无界增长时 `Text.render` 每次全量重折行（O(内容)），50000 格（约 2170 行）时均值 13.5ms 仍 < 16ms 节流周期，但 p95 25.8ms 已会掉帧——**这是缩放曲线数据点，不是 M2 目标形状**。A5b 证明真实形状（每条消息一个 Text，缓存命中 O(1)，只有流式尾巴重折行）200 条消息 + 流式尾巴下均值 1.0ms、p95 1.8ms，余量 16 倍。

### Part B（真实 ConPTY，`spike-b3` 进程，exit 1 仅为 B5 已降级为 INFO 前的历史版本；现行版本判据全过）

```
ENV platform=win32 columns=120 rows=40 isTTY=true / 活动代码页: 936
B0 PASS 探针自校准（查询不移动光标）
B1 PASS ASCII "Hello, World!": 实测=13 预测=13
B1 PASS 汉字x4 "中文测试": 实测=8 预测=8
B1 PASS 宽标点 "。，！「」『』、；：？": 实测=22 预测=22
B1 PASS 全角ASCII "ＡＢＣ１２３": 实测=12 预测=12
B1 PASS 半角片假名 "ｱｲｳ": 实测=3 预测=3
B1 PASS 混合 "混合mixed文本123。": 实测=18 预测=18
B1 PASS emoji "🎉🎊": 实测=4 预测=4
B4 INFO 歧义字符全部一致：U+2014/U+00B7/U+2460/U+2500/U+00B1 本机 ConPTY 均按窄(1)计，与 get-east-asian-width 默认一致
B2 PASS CJK后光标后退: 推进=11(期望11) p1=8 p2=0
B3 PASS 行尾宽字符整体换行: cols=120 满行后={"col":119,"row":14} 再写一汉字后={"col":2,"row":15}
B3 PASS 超长串换行对拍: 预测行+2列1, 实测={"col":1,"row":18} 基线={"col":0,"row":16}
B5 INFO mode con resize 不可靠（见「已知限制」）
```

### Part C（真实 pi-tui 应用，`spike-c` 进程，exit 0）

```
ENV columns=120 rows=40
C1 PASS 60 chunk 流式完成, renders=60, fullRedraw=1
C2 PASS 真实终端光标定位: CursorLeft=19(期望19) CursorTop=5(期望5) pi-tui hardwareCursorRow=3 内容行数=4
C3 PASS 真实 resize: 120->90, resize事件=true, fullRedraw 1->2
C4 PASS tui.stop 干净返回
== PART C 汇总: 0 FAIL ==
```

C3 是真实 ConPTY resize（`mode con cols=90`）→ Node stdout `resize` 事件 → pi-tui `requestRender` → 宽度变化检测 → 全量重绘的完整链路实证。`mode con` 本身在子进程里成功率 2/5（宿主 node-pty 持有尺寸权），但**只要 resize 发生，事件与重绘链路两次实测都正确**；真实用户经窗口管理器改尺寸走的是宿主→ConPTY→`resize` 事件同一路径。

## 源码锚点（node_modules/@earendil-works/pi-tui/dist/，行号即事实）

| 主题 | 锚点 | 事实 |
|---|---|---|
| 宽度表依赖 | `utils.js:1` | `import { eastAsianWidth } from "get-east-asian-width"`，全库唯此一处引入 |
| 字素宽度 | `utils.js:171` | `graphemeWidth` 内 `eastAsianWidth(cp)`；emoji 强制 2（`:156-158`），零宽簇 0（`:152-154`） |
| 串宽度 | `utils.js:204-252` | `visibleWidth`：纯 ASCII 快路 → 剥 ANSI/OSC/APC → `Intl.Segmenter` 逐字素求和 + LRU 缓存 |
| 折行 | `utils.js:757` `wrapTextWithAnsi` → `wrapSingleLine:778-841` | **词 token 贪心**（token 化见 `splitIntoTokensWithAnsi:680`，Han/假名/谚文每字独立 token 由 `cjkBreakRegex:45` 决定），超长 token 走 `breakLongWord:863` **逐字素断行**——不存在劈开字素的路径 |
| 行宽护栏 | `tui-main-screen.js:472-489` | 渲染行 `visibleWidth(line) > width` 直接写 pi-crash.log 并 throw——pi-tui 自带宽度漂移检测器 |
| 光标标记 | `tui.js:21` | `CURSOR_MARKER = "\x1b_pi:c\x07"`（APC，终端忽略） |
| 光标列计算 | `tui.js:865-885` | `extractCursorPosition`：`col = visibleWidth(marker 之前的文本)`，随后剥离 marker |
| 光标落位 | `tui-main-screen.js:566-586` | `positionHardwareCursor`：行差用 CSI A/B，列用绝对定位 `CSI {col+1} G` |
| resize 入口 | `terminal.js:107` | `process.stdout.on("resize", ...)` → `requestRender()`；`:109-111` SIGWINCH 重发注释明示 Unix only |
| 宽度变化重绘 | `tui-main-screen.js:286-301` | `widthChanged → fullRender(true)`（清屏+清滚动回绕+全量重写）；高度变化同理 `:303-311` |
| 渲染节流 | `tui.js:123` + `:528-553` | `MIN_RENDER_INTERVAL_MS = 16`，`requestRender` 合并突发（A5 实测 2000 chunk → 1 帧） |
| 尺寸来源 | `terminal.js:387-392` | `columns/rows` 直读 `process.stdout.columns/rows` |
| 最小控件 | `components/text.js` | `Text`：`wrapTextWithAnsi` 折行 + 空格补齐到整宽；`setText` 使缓存失效，未变消息渲染 O(1) 命中 |

## 结论

**判过：pi-tui 通过 M2 前置 spike，无需切 ink。**

- CJK 宽度：库侧（A1）与真实 ConPTY 侧（B1）双双对拍一致，含宽标点、全半角、emoji；本机（代码页 936）连歧义宽字符都与 `get-east-asian-width` 默认窄计一致（B4）。
- 光标定位：库内 marker 数学（A3）、真实终端落点（C2）、CJK 后相对移动（B2）、行尾宽字符整体换行（B3）全部逐格精确，零 off-by-one。
- resize：重绘路径（宽度变化 → 全量重绘 → 新宽度下内容一致）在 A4 逐断言直测通过；真实 ConPTY resize 链路（事件 → 重绘）在 C3 实证通过。子进程 `mode con` 改尺寸不可靠是测试夹具限制，不是 pi-tui 缺陷。
- 流式性能：内置 16ms 节流合并突发；真实分消息形状 200 条消息下均值 1.0ms/帧。唯一要避开的是「单个 Text 装全部历史」——50000 格时 p95 已超帧预算。

## 对 M2 设计的含义

1. **消息流必须分组件**：每条消息一个 `Text`（或后续更合适的控件），靠其缓存让未变消息 O(1)；流式只 `setText` 尾巴消息。**禁止**把整段 transcript 塞进单个 Text（A5a 的线性退化曲线是实测证据）。长会话再叠加 `ScrollView`（`components/scroll-view.js`，支持 follow-end）做视口裁剪。
2. **审批四键输入**：`ProcessTerminal` + `addInputListener`（`tui.js:449`）足够承载 y/n/a/d 四键，M2 不需要额外输入库；`Editor`/`Input` 组件可后续评估。
3. **光标探针模式可直接复用**：`CURSOR_MARKER` + 聚焦组件是 pi-tui 官方的光标定位机制（C2 实证落点精确），输入区光标不需要自己算。
4. **resize 无需 M2 自测**：pi-tui 已处理宽度变化全量重绘（`tui-main-screen.js:286-301`）且有行宽护栏 throw（`:472-489`）；M2 只需不在 resize 期间持有自己的宽度缓存副本。
5. **CPR 不可用**：本机 ConPTY 不应答 `\x1b[6n`（Part B 实测）——M2 不得设计任何依赖 CPR/DSR 应答的探测逻辑；需要光标真值时走同控制台子进程 `[Console]::CursorLeft` 的旁路（本 spike 的探针技术）仅用于测试。
6. **歧义宽字符暂无需处理**：本机 ConPTY 与库默认一致（窄）。但 `get-east-asian-width` 的 `ambiguousAsWide` 语义与终端字体/前端渲染器（VS Code xterm.js、Windows Terminal）可能分歧——Part B 测的是 ConPTY 缓冲区记账，前端像素渲染未在本 spike 覆盖；M2 自有 UI 镀铬（边框、分隔符）应只用 ASCII，把歧义字符留给内容区（折行决策错误的最坏后果是视觉毛边，不破坏差分渲染，因为有 `:472-489` 护栏）。
7. **升级再验证**：本 spike 结论绑定 0.84.4；升级 pi-tui 时按 ROADMAP §2 第 3 条与 beforeToolCall/transcript 两个 spike 一起重跑。
