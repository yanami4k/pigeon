// 注意：typescript 固定在 6.x —— dependency-cruiser 18.x 尚未支持 TS7 API，
// TS7 下会静默巡航 0 个模块导致 deps 假绿。dependency-cruiser 支持 TS7 后可升回。
/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "禁止循环依赖：模块依赖必须构成有向无环图。",
      from: {},
      to: { circular: true },
    },
    {
      name: "pi-agent-only-via-pi-runtime",
      severity: "error",
      comment:
        "架构约束（路线图 §3.6/约束 6）：业务代码不得直接 import @earendil-works/*；" +
        "src/tools 的豁免已收口为单一桥接文件 src/tools/wrap.ts（纯类型别名），" +
        "其余 tools 文件一律经 wrap.ts 取上游类型；所有运行交互统一经 src/pi-runtime 的 PiRuntimeAdapter。",
      from: { path: "^src", pathNot: "^src/(pi-runtime/|tools/wrap\\.ts$)" },
      to: { path: "node_modules/@earendil-works" },
    },
    // ---- 目录分层（M4 收口重整，ROADMAP §4）：只约束生产代码，测试文件可跨层搭夹具 ----
    {
      name: "state-is-leaf",
      severity: "error",
      comment: "state 是权威状态 schema、纯判据与投影，不依赖任何其他 src 目录（无 IO、无上游）。",
      from: { path: "^src/state/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/state/" },
    },
    {
      name: "persistence-only-state",
      severity: "error",
      comment: "persistence 是 state 的存储实现：只依赖 state，不依赖 tools / pi-runtime / 上层。",
      from: { path: "^src/persistence/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(persistence|state)/" },
    },
    {
      name: "tools-only-state",
      severity: "error",
      comment: "tools（Registry / Policy / 匹配 / Coding 工具）只依赖 state。",
      from: { path: "^src/tools/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(tools|state)/" },
    },
    {
      name: "approvals-only-state-tools",
      severity: "error",
      comment: "approvals（审批接口、会话 grant 运行态）只依赖 state 与 tools 的匹配语义。",
      from: { path: "^src/approvals/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/", pathNot: "^src/(approvals|state|tools)/" },
    },
    {
      name: "pi-runtime-no-storage-or-actors",
      severity: "error",
      comment:
        "pi-runtime 经结构类型接收落盘口（EventLogSink），不得依赖 persistence / execution；也不得依赖 Actor 层。",
      from: { path: "^src/pi-runtime/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/(persistence|execution|cli|tui)/" },
    },
    {
      name: "execution-no-runtime-or-actors",
      severity: "error",
      comment: "execution（恢复、未来的 Durable Executor）不依赖 pi-runtime 与 Actor 层。",
      from: { path: "^src/execution/", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/(pi-runtime|cli|tui)/" },
    },
    {
      name: "tui-cannot-reach-execution",
      severity: "error",
      comment: "TUI 只提交意图、渲染投影，不能触碰执行器（ROADMAP §2/§3.6 Actor 边界）。",
      from: { path: "^src/tui" },
      to: { path: "^src/execution" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
