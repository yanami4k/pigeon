// Pigeon 自有 TUI（M2，ROADMAP §4）。M2 S2 落地 Application Shell、输入区与流式消息区
// （turn 级）；审批面板（S3）、会话列表/resume（S4）、取消键（S5）在后续切片。
// 本目录是唯一允许直连 @earendil-works/pi-tui 的位置（.dependency-cruiser.js
// tui-pi-tui-only）：pi-tui 是纯终端 UI 库——spike 实证（docs/notes/spike-pi-tui.zh-CN.md）
// 其依赖仅 get-east-asian-width + marked，与 agent 运行交互无关，故不设 tools/wrap.ts
// 式桥接，豁免精确到这一个包；上游 agent 交互仍一律经 pi-runtime Adapter。
// 施工纪律（spike 结论）：每消息一个 Text 组件（禁止单 Text 装全部历史）、自有 chrome
// 只用 ASCII、不设计依赖 CPR/DSR 应答的探测、流式文本经 Adapter subscribeStream 观察口
// （决策 024）、意图提交只经 application API（决策 025，TuiRuntimeFace）。
export { PigeonTuiShell, type TuiRuntimeFace, type TuiShellOptions } from "./shell.ts";
