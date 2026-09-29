// 提交编排脚本的工具 orchestrate（决策 294 D、309–314）：模型写一段脚本交给程序，在专用容器里执行、批量派 worker；提交后立即
// 返回运行号，脚本结束时一条汇总通知进主 agent 的下一轮（与 worker 完成通知同一条队列）。
// - 谁来用（309）：工具集随会话冻结，不能按每条输入增删；工具因此常注册，缺省由程序按本次人手输入是否点名判定能否执行
//   （script-naming.ts），没点名即拒绝；项目配置打开"由模型判断"后不看点名，说明第 2 句随之换。只给主会话（终端界面与
//   pigeon run）注册；worker（嵌套缺省一层，299）、沙箱会话与跑批器各条件都不注册。
// - 本工具只读档、不经审批：脚本本身不碰 IO；worker 各自的调用按 302、303 走，脚本结束时的收回另外整批请示一次。
import { type Static, Type } from "typebox";
import { isGitWorkspace } from "../orchestration/checkpoint.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";
import { ScriptLaunchError } from "./script-host.ts";
import type { ScriptBudget, ScriptGate } from "./script-naming.ts";
import type { ScriptRuns, ScriptSpec } from "./script-runner.ts";
import {
  ORCHESTRATE_PARAM_TEXTS,
  ORCHESTRATE_TEXTS,
  ORCHESTRATE_TOOL,
  orchestrateDescription,
} from "./script-texts.ts";

export { ORCHESTRATE_TOOL };

export const OrchestrateParamsSchema = Type.Object({
  name: Type.String({ description: ORCHESTRATE_PARAM_TEXTS.name }),
  phases: Type.Optional(Type.Array(Type.String(), { description: ORCHESTRATE_PARAM_TEXTS.phases })),
  script: Type.String({ description: ORCHESTRATE_PARAM_TEXTS.script }),
  args: Type.Optional(Type.Unknown({ description: ORCHESTRATE_PARAM_TEXTS.args })),
  resume_run: Type.Optional(Type.String({ description: ORCHESTRATE_PARAM_TEXTS.resumeRun })),
});
export type OrchestrateParams = Static<typeof OrchestrateParamsSchema>;

export interface ScriptHost {
  runs: ScriptRuns;
  governanceRoot: string;
}

// 注册开关与晚绑定：装配运行面时注册工具，编排器与运行器建好后再 bind
export class ScriptSlot {
  readonly gate: ScriptGate;
  #host: ScriptHost | undefined;

  constructor(gate: ScriptGate) {
    this.gate = gate;
  }

  bind(host: ScriptHost): void {
    this.#host = host;
  }

  get host(): ScriptHost | undefined {
    return this.#host;
  }
}

export interface OrchestrateDetails {
  runId?: string;
  // 续跑时从会话里找回脚本用
  spec?: ScriptSpec;
  budget?: ScriptBudget;
  rejected?: "not-named" | "unbound" | "not-git" | "unknown-run" | "running" | "docker" | "failed";
}

function reply(text: string, details: OrchestrateDetails): PigeonToolResult<OrchestrateDetails> {
  return { content: [{ type: "text", text }], details };
}

export function createOrchestrateTool(
  slot: ScriptSlot
): PigeonAgentTool<typeof OrchestrateParamsSchema, OrchestrateDetails> {
  return {
    name: ORCHESTRATE_TOOL,
    label: ORCHESTRATE_TOOL,
    description: orchestrateDescription({ modelDecides: slot.gate.settings.modelDecides }),
    parameters: OrchestrateParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<PigeonToolResult<OrchestrateDetails>> {
      // 309：点名由程序判断（本次人手输入），模型自己说了不算
      if (!slot.gate.allowed()) {
        return reply(ORCHESTRATE_TEXTS.notNamed, { rejected: "not-named" });
      }
      const host = slot.host;
      if (host === undefined) {
        return reply(ORCHESTRATE_TEXTS.unbound, { rejected: "unbound" });
      }
      if (!isGitWorkspace(host.governanceRoot)) {
        return reply(ORCHESTRATE_TEXTS.notGit, { rejected: "not-git" });
      }
      const spec: ScriptSpec = {
        name: params.name.trim() === "" ? "script" : params.name.trim(),
        phases: params.phases ?? [],
        script: params.script,
        ...(params.args !== undefined ? { args: params.args } : {}),
      };
      try {
        if (params.resume_run !== undefined && params.resume_run.trim() !== "") {
          const runId = params.resume_run.trim();
          const budget = slot.gate.namedBudget();
          const result = await host.runs.resume(runId, {
            spec,
            ...(budget !== undefined ? { budget } : {}),
          });
          if (result === "unknown") {
            return reply(ORCHESTRATE_TEXTS.unknownRun(runId), { rejected: "unknown-run" });
          }
          if (result === "running") {
            return reply(ORCHESTRATE_TEXTS.stillRunning(runId), { rejected: "running" });
          }
          const effective = host.runs.budget(runId);
          return reply(ORCHESTRATE_TEXTS.resumed(spec.name, runId), {
            runId,
            spec,
            ...(effective !== undefined ? { budget: effective } : {}),
          });
        }
        const budget = slot.gate.budget();
        const runId = await host.runs.start(spec, budget);
        return reply(ORCHESTRATE_TEXTS.started(spec.name, runId), {
          runId,
          spec,
          ...(budget !== undefined ? { budget } : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return error instanceof ScriptLaunchError
          ? reply(ORCHESTRATE_TEXTS.noDocker(reason), { rejected: "docker" })
          : reply(ORCHESTRATE_TEXTS.failed(reason), { rejected: "failed" });
      }
    },
  };
}

// 装配根注册用的元数据：只读档（脚本不碰 IO；worker 与收回各自请示），串行
export function orchestrateRegistration(): ToolRegistration {
  return {
    name: ORCHESTRATE_TOOL,
    description: "提交编排脚本，在隔离容器里批量派 worker",
    parameters: OrchestrateParamsSchema,
    tier: "read",
    pathConfinement: { kind: "none" },
    executionMode: "sequential",
  };
}
