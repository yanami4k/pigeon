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
        "架构约束（路线图 §3.6/约束 6）：业务代码不得直接 import @earendil-works/*，" +
        "所有运行交互统一经 src/pi-runtime 的 PiRuntimeAdapter。",
      from: { path: "^src", pathNot: "^src/pi-runtime" },
      to: { path: "node_modules/@earendil-works" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
