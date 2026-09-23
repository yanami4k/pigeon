// 延续式跑批的两种 agent 接入（第三节）：跑批器只经 StepAgent 调用，不感知 agent 怎么跑。
//   Pigeon（完整、去掉记忆、去掉验证门与回退）：与外部基准同一条路——进程内经 headless 入口运行，执行端为该流的容器；
//   最简 agent（099）：宿主上的独立进程，经请求文件拿到题面、容器与预算，命令在该流的容器里执行，结果写回结果文件。
// 模型接入由各自的 stream-fn / 启动器配置决定；限额的统一处理（第 17、18 条）待定后接在这一层之下。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runHeadless } from "../application/headless.ts";
import { createContainerWorkspaceHost } from "../execution/container-host.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { deterministicErrorOf, isContentRefusal } from "./runner.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import type { StepAgent, StepAgentResult } from "./stream-runner.ts";

// 工作方式指令：与外部基准同一句的写法（对齐公开最简实现的措辞），把"修 issue"换成"实现用户消息里描述的改动"。
// 四个条件共用；它属于被测条件，改它等于换条件
export const STREAM_WORK_DIRECTIVE =
  "Your task is to make changes to non-test files in the repository at /testbed in order to implement the change described in the user message, in a way that is general and consistent with the codebase.";

export interface PigeonStepAgentOptions {
  // 固定的模型接入（不经网关时）
  streamFn?: StreamFn;
  // 经网关时：按跑批给这个作业的网关地址造模型接入
  streamFnFor?: (baseUrl: string) => StreamFn;
  yolo: boolean;
  docker?: readonly string[];
  thinking?: ThinkingLevel;
  maxOutputTokens?: number;
  temperature?: number;
  provider?: string;
  modelId?: string;
  homeDir?: string;
}

export function pigeonStepAgent(options: PigeonStepAgentOptions): StepAgent {
  return {
    async run(input): Promise<StepAgentResult> {
      if (input.condition.repairRounds > 0) {
        throw new Error(
          `条件 ${input.condition.name} 需要回炉（${input.condition.repairRounds} 轮），回炉尚未合入，本条件暂不能跑`
        );
      }
      const streamFn =
        input.modelBaseUrl !== undefined && options.streamFnFor !== undefined
          ? options.streamFnFor(input.modelBaseUrl)
          : options.streamFn;
      if (streamFn === undefined)
        throw new Error("Pigeon agent 没有模型接入：既无网关地址也无固定的 stream-fn");
      const host = createContainerWorkspaceHost({
        container: input.target.container,
        root: input.target.root,
        ...(options.docker !== undefined ? { docker: options.docker } : {}),
      });
      // 容器工作区下宿主侧只是占位目录：账本与治理按它登记，工具不经它读写
      const placeholder = path.join(input.workDir, "workspace");
      mkdirSync(placeholder, { recursive: true });
      const run = await runHeadless({
        task: input.prompt,
        governanceRoot: input.workDir,
        workspaceRoot: placeholder,
        workspaceHost: host,
        streamFn,
        yolo: options.yolo,
        sessionId: newSessionId(),
        maxTurns: input.budget.maxTurns,
        wallClockMs: input.budget.wallClockMs,
        // 结构化记忆尚未建：开关打开时暂时等同于关闭
        skillRoots: [],
        memoryRoots: [],
        taskDirective: STREAM_WORK_DIRECTIVE,
        ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      });
      // 与外部基准同一判法：内容审核拒答与确定性错误照常判分；其余以错误收尾的算模型服务故障，这一步作废重做
      const refused = run.status === "failed" && isContentRefusal(run.errorMessage);
      const deterministic =
        run.status === "failed" && !refused ? deterministicErrorOf(run.errorMessage) : undefined;
      const providerFailed =
        !refused &&
        deterministic === undefined &&
        (run.failure?.category === "infrastructure" || run.status === "failed");
      return {
        status: run.status,
        turns: run.turns,
        usage: run.usage,
        wallMs: run.durationMs,
        repair: null,
        ...(providerFailed
          ? { interrupted: `模型服务故障（终态 ${run.status}）：${run.errorMessage ?? ""}` }
          : {}),
      };
    },
  };
}

// 最简 agent 的启动器协议：<启动器命令…> <请求文件> <结果文件>
//   请求：{ prompt, directive, container, root, maxTurns, wallClockMs, docker, modelBaseUrl, model }
//   结果：{ status, turns, usage?: { input, output, totalTokens }, interrupted? }
// 墙钟由跑批器统一计：到时连同子进程一起杀掉，记 wall-clock-limit；限额暂停时同样立刻杀掉，记为被打断（整题作废重做）
export interface CommandStepAgentOptions {
  command: readonly string[];
  docker?: readonly string[];
  // 墙钟之外给启动器收尾的余量
  graceMs?: number;
  // 模型名（启动器按它向网关发请求）
  model?: string;
  // 限额控制器：暂停即杀掉启动器
  limits?: { readonly state: string };
}

export function commandStepAgent(options: CommandStepAgentOptions): StepAgent {
  return {
    async run(input): Promise<StepAgentResult> {
      const dir = path.join(input.workDir, "minimal", `step-${input.step.seq}`);
      mkdirSync(dir, { recursive: true });
      const requestFile = path.join(dir, "request.json");
      const resultFile = path.join(dir, "result.json");
      writeFileSync(
        requestFile,
        JSON.stringify({
          prompt: input.prompt,
          directive: STREAM_WORK_DIRECTIVE,
          container: input.target.container,
          root: input.target.root,
          maxTurns: input.budget.maxTurns,
          wallClockMs: input.budget.wallClockMs,
          docker: options.docker ?? ["docker"],
          modelBaseUrl: input.modelBaseUrl ?? null,
          model: options.model ?? null,
        })
      );
      const started = Date.now();
      const [program = "", ...args] = options.command;
      const ended = await new Promise<"done" | "timeout" | "paused">((resolve, reject) => {
        const child = spawn(program, [...args, requestFile, resultFile], {
          stdio: ["ignore", "ignore", "inherit"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
        let why: "done" | "timeout" | "paused" = "done";
        const kill = (reason: "timeout" | "paused") => {
          if (why !== "done") return;
          why = reason;
          if (process.platform !== "win32" && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else {
            child.kill("SIGKILL");
          }
        };
        const timer = setTimeout(
          () => kill("timeout"),
          input.budget.wallClockMs + (options.graceMs ?? 30_000)
        );
        const watch = setInterval(() => {
          if (options.limits !== undefined && options.limits.state !== "running") kill("paused");
        }, 500);
        const done = () => {
          clearTimeout(timer);
          clearInterval(watch);
        };
        child.on("error", (error) => {
          done();
          reject(new Error(`最简 agent 启动器拉不起来：${error.message}`));
        });
        child.on("close", () => {
          done();
          resolve(why);
        });
      });
      const wallMs = Date.now() - started;
      if (ended === "paused") {
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          repair: null,
          interrupted: "限额暂停：最简 agent 已中止",
        };
      }
      const timedOut = ended === "timeout";
      if (timedOut || !existsSync(resultFile)) {
        return {
          status: timedOut ? "wall-clock-limit" : "unknown",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          repair: null,
        };
      }
      const raw = JSON.parse(readFileSync(resultFile, "utf8")) as {
        status?: string;
        turns?: number;
        usage?: { input?: number; output?: number; totalTokens?: number };
        interrupted?: string;
      };
      return {
        status: raw.status ?? "unknown",
        turns: raw.turns ?? 0,
        usage: {
          ...ZERO_USAGE,
          input: raw.usage?.input ?? 0,
          output: raw.usage?.output ?? 0,
          totalTokens: raw.usage?.totalTokens ?? 0,
        },
        wallMs,
        repair: null,
        ...(raw.interrupted !== undefined ? { interrupted: raw.interrupted } : {}),
      };
    },
  };
}
