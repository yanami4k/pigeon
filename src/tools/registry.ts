// Tool Registry（ROADMAP §M3）：工具元数据注册中心——名称、描述、typebox 参数 schema、
// 风险分层、路径约束声明与执行模式标记。纯注册表：不含任何真实工具实现，
// 不 import @earendil-works/*（上游工具包装收口于 M3 切片 2）。
import { IsObject, type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

// 风险分层：read 只读 / write 写文件 / exec 执行进程；策略求值按此分层决定是否需人工批准
export const ToolRiskTierSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("exec"),
]);
export type ToolRiskTier = Static<typeof ToolRiskTierSchema>;

// 路径约束声明：文件类工具声明自己的路径活动范围，供治理层与审计核对
export const PathConfinementSchema = Type.Union([
  // 不触碰文件系统
  Type.Object({ kind: Type.Literal("none") }),
  // 限制在工作区根之内
  Type.Object({ kind: Type.Literal("workspace") }),
  // 限制在显式路径根清单之内
  Type.Object({
    kind: Type.Literal("roots"),
    roots: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
]);
export type PathConfinement = Static<typeof PathConfinementSchema>;

// 执行模式标记（对齐上游 pi-agent-core：默认 parallel，sequential 强制走串行执行器）
export const ToolExecutionModeSchema = Type.Union([
  Type.Literal("parallel"),
  Type.Literal("sequential"),
]);
export type ToolExecutionMode = Static<typeof ToolExecutionModeSchema>;

// 工具名形态：小写蛇形（read_file、run_tests），与上游工具命名风格一致
const ToolRegistrationMetaSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
  description: Type.String({ minLength: 1 }),
  tier: ToolRiskTierSchema,
  pathConfinement: PathConfinementSchema,
  executionMode: ToolExecutionModeSchema,
});

export interface ToolRegistration {
  readonly name: string;
  readonly description: string;
  // 对象 schema：模型可见的参数形状；M3 工具一律对象参数（对齐上游 AgentTool）；
  // M5.7 起也接受 MCP 工具原样透传的 JSON Schema（type 为 object）
  readonly parameters: TSchema;
  readonly tier: ToolRiskTier;
  readonly pathConfinement: PathConfinement;
  readonly executionMode: ToolExecutionMode;
}

export class ToolRegistryError extends Error {}

// 对象形参数 schema：typebox 对象，或 type 为 object 的原生 JSON Schema（M5.7 S2：MCP 工具的 inputSchema
// 原样透传——上游按 JSON Schema 关键字校验参数、原样发给 provider，不依赖 typebox 的类型标记）
function isObjectParameters(schema: unknown): boolean {
  if (IsObject(schema)) {
    return true;
  }
  return (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as Record<string, unknown>).type === "object"
  );
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolRegistration>();

  // 注册期校验：畸形元数据拒绝、parameters 非对象 schema 拒绝、重名拒绝
  register(registration: ToolRegistration): void {
    // 经 unknown 中转：Value.Check 是类型谓词，直接在形参上取反会把后续窄化推成 never
    const candidate: unknown = registration;
    if (!Value.Check(ToolRegistrationMetaSchema, candidate)) {
      const name =
        typeof candidate === "object" && candidate !== null && "name" in candidate
          ? String(candidate.name)
          : "（无名）";
      throw new ToolRegistryError(`畸形工具注册：${name}`);
    }
    if (!isObjectParameters(registration.parameters)) {
      throw new ToolRegistryError(
        `工具 ${registration.name} 的 parameters 必须是对象 schema（typebox 对象或 type 为 object 的 JSON Schema）`
      );
    }
    if (this.#tools.has(registration.name)) {
      throw new ToolRegistryError(`重复注册工具：${registration.name}`);
    }
    this.#tools.set(registration.name, registration);
  }

  get(name: string): ToolRegistration | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  // 注册序快照
  list(): ToolRegistration[] {
    return [...this.#tools.values()];
  }

  get size(): number {
    return this.#tools.size;
  }
}
