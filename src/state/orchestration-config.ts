// 编排的项目配置 .pigeon/orchestration.json（决策 297–303）：纯类型与缺省，无 IO。人手写，可缺省；各项不给即取缺省。
// - maxConcurrent：同时在跑的 worker 上限（300，缺省 8；人派、模型派与程序派共用；启动参数 --worker-concurrency 优先）
// - maxDepth：层数（299，缺省 1 即 worker 不能再派；放开时各层共用同一个编排器与并发额度）
// - maxWorkersPerRun：一次运行里模型最多派出的个数（300 取消了缺省的总数上限；这里与启动参数 --worker-limit 都是可选的上限）
// - worker.maxTurns / worker.wallClockMinutes：每个 worker 的轮数与时间上限（300，缺省 40 轮、30 分钟）
// - stallMinutes：卡住判定（298，缺省 10 分钟没有新的模型回复或工具结果即中断）
// - approvalTimeoutMinutes：worker 的审批请求等待时限（303，缺省 5 分钟）
// - taskList：任务清单工具开关（294 B1，缺省开）
// - script.modelDecides：脚本编排由模型自行判断何时用（309，缺省关：须人点名）；script.budget：单次脚本的缺省花费上限（314，
//   写法同点名时的额度，如 "¥20"、"$5"、"2m"；缺省不限）
import { type Static, Type } from "typebox";

export const ORCHESTRATION_CONFIG_VERSION = 1;

export const OrchestrationConfigFileSchema = Type.Object(
  {
    version: Type.Literal(ORCHESTRATION_CONFIG_VERSION),
    maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
    maxDepth: Type.Optional(Type.Integer({ minimum: 1 })),
    maxWorkersPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
    worker: Type.Optional(
      Type.Object(
        {
          maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
          wallClockMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        },
        { additionalProperties: false }
      )
    ),
    stallMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    approvalTimeoutMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    taskList: Type.Optional(Type.Boolean()),
    script: Type.Optional(
      Type.Object(
        {
          modelDecides: Type.Optional(Type.Boolean()),
          budget: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
export type OrchestrationConfigFile = Static<typeof OrchestrationConfigFileSchema>;

// 生效的数值（毫秒为单位）
export interface OrchestrationSettings {
  maxConcurrent: number;
  maxDepth: number;
  // 不给即不设总数上限
  maxWorkersPerRun?: number;
  workerMaxTurns: number;
  workerWallClockMs: number;
  stallMs: number;
  approvalTimeoutMs: number;
  taskList: boolean;
  // 决策 309、314：脚本编排由模型判断（缺省关）与缺省额度的写法（缺省不限；解析在 application）
  scriptModelDecides: boolean;
  scriptBudget?: string;
}

export const DEFAULT_ORCHESTRATION_SETTINGS: Readonly<OrchestrationSettings> = {
  maxConcurrent: 8,
  maxDepth: 1,
  workerMaxTurns: 40,
  workerWallClockMs: 30 * 60_000,
  stallMs: 10 * 60_000,
  approvalTimeoutMs: 5 * 60_000,
  taskList: true,
  scriptModelDecides: false,
};

export function orchestrationSettings(
  file: OrchestrationConfigFile | undefined
): OrchestrationSettings {
  const base = DEFAULT_ORCHESTRATION_SETTINGS;
  return {
    maxConcurrent: file?.maxConcurrent ?? base.maxConcurrent,
    maxDepth: file?.maxDepth ?? base.maxDepth,
    ...(file?.maxWorkersPerRun !== undefined ? { maxWorkersPerRun: file.maxWorkersPerRun } : {}),
    workerMaxTurns: file?.worker?.maxTurns ?? base.workerMaxTurns,
    workerWallClockMs:
      file?.worker?.wallClockMinutes !== undefined
        ? Math.round(file.worker.wallClockMinutes * 60_000)
        : base.workerWallClockMs,
    stallMs:
      file?.stallMinutes !== undefined ? Math.round(file.stallMinutes * 60_000) : base.stallMs,
    approvalTimeoutMs:
      file?.approvalTimeoutMinutes !== undefined
        ? Math.round(file.approvalTimeoutMinutes * 60_000)
        : base.approvalTimeoutMs,
    taskList: file?.taskList ?? base.taskList,
    scriptModelDecides: file?.script?.modelDecides ?? base.scriptModelDecides,
    ...(file?.script?.budget !== undefined ? { scriptBudget: file.script.budget } : {}),
  };
}
