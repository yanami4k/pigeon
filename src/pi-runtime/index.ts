// StreamFn 类型经本桶转口：pi-runtime 是唯一允许直连上游的运行交互层（.dependency-cruiser.js）
export type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
// PiRuntimeAdapter 公开面桶文件；fixtures.ts 是测试设施，不从这里导出。
export {
  DEFAULT_THINKING_LEVEL,
  PiRuntimeAdapter,
  type PiRuntimeAdapterOptions,
  type RunResult,
  type RunTerminalStatus,
  type StreamTextDelta,
} from "./adapter.ts";
export { isSyntheticFailureMessage, normalizePiEvent } from "./events.ts";
export {
  DEFAULT_GATEWAY_MODEL_ID,
  GATEWAY_PLACEHOLDER_KEY,
  gatewayStreamFn,
  gatewayUpstreamBaseUrl,
} from "./gateway-stream.ts";
export type {
  EventLogSink,
  GovernanceHost,
  GovernanceRunOutcome,
  GovernanceVerdict,
  ToolCallProposal,
  ToolGovernance,
  ToolGovernanceFactory,
} from "./governance.ts";
export { DEFAULT_MAX_OUTPUT_TOKENS } from "./output-limit.ts";
export { isContextOverflowError } from "./overflow.ts";
export {
  INJECTION_SNAPSHOT_VERSION,
  type InjectionSnapshot,
  InjectionSnapshotSchema,
  migrateInjectionSnapshotV1toV2,
  migrateInjectionSnapshotV2toV3,
  migrateInjectionSnapshotV3toV4,
  type ToolPolicy,
  ToolPolicySchema,
} from "./snapshot.ts";
