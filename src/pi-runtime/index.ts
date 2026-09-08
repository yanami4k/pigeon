// PiRuntimeAdapter 公开面桶文件；fixtures.ts 是测试设施，不从这里导出。
export {
  PiRuntimeAdapter,
  type PiRuntimeAdapterOptions,
  type RunResult,
  type RunTerminalStatus,
} from "./adapter.ts";
export {
  isSyntheticFailureMessage,
  normalizePiEvent,
  type RunEndedPayload,
  RuntimeEventKind,
  type ToolProposedPayload,
  type ToolSettledPayload,
  type TurnCompletedPayload,
} from "./events.ts";
export {
  INJECTION_SNAPSHOT_VERSION,
  type InjectionSnapshot,
  InjectionSnapshotSchema,
  type ToolPolicy,
  ToolPolicySchema,
} from "./snapshot.ts";
