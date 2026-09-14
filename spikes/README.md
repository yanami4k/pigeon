# spikes：上游行为探针与真实链路验收驱动

这些脚本是路线图 §2 "上游 0.84.4 实证事实"的来源，也是 M3 / M4 / M2 真实链路验收的驱动。它们不参与 `npm run verify`，只在需要复现证据或上游升级后重跑。结论以实跑输出为准，不信声明文件。

## 目录

| 目录 / 文件 | 用途 | 笔记 |
|---|---|---|
| `spike-before-tool-call/spike.mjs` | beforeToolCall 阻断、改参通道、循环护栏、hook 与事件时序 | docs/spikes/spike-before-tool-call.zh-CN.md |
| `spike-pi-transcript/spike.mjs` | transcript 无稳定 id、append-only、reset 整组替换、零防御拷贝 | docs/spikes/spike-pi-transcript.zh-CN.md |
| `spike-pi-tui/part-*.mjs` | pi-tui 渲染性能（A5a / A5b）、ConPTY 真实终端、光标与 resize | docs/spikes/spike-pi-tui.zh-CN.md |
| `tui-acc/` | TUI 真实链路验收：ConPTY 桥 `PtyHost.cs`、驱动 `tui-driver*.mjs`、七个剧本 `run-*.mjs` | docs/audits/2026-09-12-m2-tui-acceptance.md |
| `real-stream-fn.mjs`、`acc-driver.mjs`、`acc-run-*.mjs` | cli 真实模型链路验收（M3 / M4） | docs/audits/*-real-provider-acceptance.md |
| `m5-thinking-probe.mjs` | Kimi For Coding 不设 / 设推理档位时是否返回 thinking 块（决策 045） | docs/audits/2026-09-13-m5-ba94b53.md |
| `m5-reasoning-stream-fn.mjs`、`tui-acc/run-m5.mjs`、`tui-acc/run-m5c.mjs` | M5 TUI 真实链路验收：Memory 冻结与下个会话生效、load_skill 读取与拒绝、/search 与两个检索工具、/resume 历史渲染与 thinking | docs/audits/2026-09-13-m5-ba94b53.md |
| `tui-acc/run-m55.mjs` | M5.5 TUI 真实链路验收：两个 worker 并行写各自工作树与审批来源、run_command 精确命令放权、强杀后恢复 worker 会话与深度 1、两个窗口恢复同一会话被拒 | docs/audits/2026-09-13-m5-5-8ac7266.md |
| `reconcile-check.mjs`、`notfound-spike.mjs`、`probe-note2-layout.mjs`、`pty-probe.js` | 单点探针：对账检查、上游拦截幽灵工具、消息区离屏布局、PTY 输入 | 对应审计文件 |

脚本按原有目录层级放置，`../src` 与 `../../src` 的相对引用保持有效；从仓库根目录运行。这些脚本原先位于本地 `tmp/`，docs/audits 下的历史审计文档按只追加不覆盖原则保留当时的 `tmp/...` 路径，对应本目录同名文件。所有运行产出（日志、截屏文本、`acc-*` 与 `tui-acc/ws-*` 工作区、会话文件）统一写到 `tmp/`，该目录被忽略；脚本里出现的 `tmp/...` 路径都是产出位置，不是脚本位置。

## 运行前提

- Node 22+，已 `npm install`（上游锁 0.84.4）。
- 真实模型链路只经环境变量取密钥：`KIMI_API_KEY=... node spikes/acc-run-a.mjs`。密钥不写进任何文件。
- 真实链路脚本会在本机创建会话与工作区目录，产出的日志、`ws-*` 工作区与截屏文本不入库。

## PtyHost（Windows ConPTY 桥）

`tui-acc/PtyHost.cs` 用 C# 5 语法编写，本机 .NET Framework 4.x 自带的 csc 即可编译；驱动脚本默认在 `spikes/tui-acc/PtyHost.exe` 找它，该二进制被忽略不入库：

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:spikes\tui-acc\PtyHost.exe spikes\tui-acc\PtyHost.cs
```

用法与行为见源码头部注释。

## 上游升级后

三个 spike 必须逐个重跑，输出与 docs/spikes 下的笔记逐条比对；任何差异先记进笔记再动代码。docs/roadmap/m0-reuse-own-audit.md 的 reuse / own 表随之重跑。
