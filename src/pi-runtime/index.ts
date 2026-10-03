// StreamFn 类型经本桶转口：pi-runtime 是唯一允许直连上游的运行交互层（.dependency-cruiser.js）
export type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
// PiRuntimeAdapter 公开面桶文件；fixtures.ts 是测试设施，不从这里导出。
export {
  type CompactionNotice,
  DEFAULT_THINKING_LEVEL,
  type ManualCompactionOutcome,
  PiRuntimeAdapter,
  type PiRuntimeAdapterOptions,
  type RunResult,
  type RunTerminalStatus,
  type StreamTextDelta,
} from "./adapter.ts";
export {
  type BeforeCompaction,
  type BeforeCompactionInfo,
  type CompactionConfig,
  type CompactionConfigInput,
  type CompactionOutcome,
  type CompactionTrigger,
  DEFAULT_CONTEXT_WINDOW,
  resolveCompactionConfig,
} from "./compaction.ts";
export {
  CompletionError,
  type CompletionOutcome,
  type CompletionRequest,
  completeWithoutTools,
} from "./complete.ts";
export {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_MODEL_ID,
  deepseekModel,
  deepseekModelInfo,
} from "./deepseek-model.ts";
export {
  createDeepSeekStreamFn,
  DEEPSEEK_BASE_URL_ENV,
  DEEPSEEK_KEY_ENV,
  resolveDeepSeekBaseUrl,
} from "./deepseek-stream.ts";
export { isSyntheticFailureMessage, normalizePiEvent, turnUsageOf } from "./events.ts";
export {
  DEFAULT_GATEWAY_MODEL_ID,
  GATEWAY_PLACEHOLDER_KEY,
  GATEWAY_PROVIDER,
  GATEWAY_UPSTREAM_BASE_URL,
  gatewayStreamFn,
} from "./gateway-stream.ts";
export type {
  GovernanceHost,
  GovernanceRunOutcome,
  GovernanceVerdict,
  ToolCallProposal,
  ToolGovernance,
  ToolGovernanceFactory,
} from "./governance.ts";
export {
  declarationComplete,
  loadCatalogLookup,
  type ModelAccessInfo,
  modelAccessOf,
  parseModelInfoDeclaration,
  registerModelAccess,
} from "./model-access.ts";
export { FALLBACK_MODEL_MAX_TOKENS } from "./output-limit.ts";
export { isContextOverflowError } from "./overflow.ts";
export {
  INJECTION_SNAPSHOT_VERSION,
  type InjectionSnapshot,
  InjectionSnapshotSchema,
  type ToolPolicy,
  ToolPolicySchema,
} from "./snapshot.ts";
