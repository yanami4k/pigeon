// 延续式跑批的两种 agent 接入（第三节）：跑批器只经 StepAgent 调用，不感知 agent 怎么跑。
//   Pigeon（完整、去掉记忆、去掉验证门与回退）：与外部基准同一条路——进程内经 headless 入口运行，执行端为该流的容器；
//   最简 agent（099）：宿主上的独立进程，经请求文件拿到题面、容器与预算，命令在该流的容器里执行，结果写回结果文件。
// 模型接入由各自的 stream-fn / 启动器配置决定；限额的统一处理（第 17、18 条）待定后接在这一层之下。
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runHeadless } from "../application/headless.ts";
import { createContainerWorkspaceHost } from "../execution/container-host.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { verifyStepsDisplay } from "../state/verify-steps.ts";
import { deterministicErrorOf, isContentRefusal } from "./runner.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import type { StepAgent, StepAgentResult } from "./stream-runner.ts";
import {
  dockerStreamShell,
  removeCoveringHelpers,
  STEP_START_REFS,
  StreamWorkspace,
} from "./stream-workspace.ts";

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
  // 人写的测试与测试辅助文件（按这条流的运行方式归类）：开回炉的条件在每次验证之前把 agent 对它们的改动还原成
  // 这一步开工时的版本（开工时的树已含跑批器预置的人写测试），agent 不能靠改测试让验证通过
  humanTestFile?: (path: string) => boolean;
  // 限额控制器：这一步期间有任何限额信号（暂停、停止）即中止在途的运行——这一步反正要作废重做，不必跑满
  // （与最简 agent 同一做法：订阅即时通知，另以 500 毫秒轮询兜底）
  limits?: LimitWatch;
}

// 限额看守要看的：控制器的状态、信号计数与订阅
export interface LimitWatch {
  readonly state: string;
  readonly signals?: number;
  subscribe?(listener: () => void): () => void;
}

// 这一步开始后一有限额信号就调用 onSignal；返回停止看守的函数
function watchLimits(limits: LimitWatch | undefined, onSignal: () => void): () => void {
  if (limits === undefined) return () => {};
  const signalsAtStart = limits.signals ?? 0;
  let fired = false;
  const check = () => {
    if (fired) return;
    if (limits.state !== "running" || (limits.signals ?? 0) !== signalsAtStart) {
      fired = true;
      onSignal();
    }
  };
  const unsubscribe = limits.subscribe?.(check);
  const timer = setInterval(check, 500);
  check();
  return () => {
    clearInterval(timer);
    unsubscribe?.();
  };
}

// Pigeon 步的结果：回炉字段另带"agent 改过人写测试"的计数——有几次验证之前发现并还原了 agent 对人写测试的改动
export interface PigeonStepAgentResult extends StepAgentResult {
  repair: (NonNullable<StepAgentResult["repair"]> & { humanTestRestores?: number }) | null;
}

export function pigeonStepAgent(options: PigeonStepAgentOptions): StepAgent & {
  run(input: Parameters<StepAgent["run"]>[0]): Promise<PigeonStepAgentResult>;
} {
  return {
    async run(input): Promise<PigeonStepAgentResult> {
      const repairRounds = input.condition.repairRounds;
      const streamFn =
        input.modelBaseUrl !== undefined && options.streamFnFor !== undefined
          ? options.streamFnFor(input.modelBaseUrl)
          : options.streamFn;
      if (streamFn === undefined)
        throw new Error("Pigeon agent 没有模型接入：既无网关地址也无固定的 stream-fn");
      // 本步标记：Pigeon 在容器里执行的每条命令都带上它（与最简 agent 同一做法），步结束后据此清掉残留的后台进程，
      // 免得它们在步与步之间重新生成被删的 conftest 等文件
      const marker = `pigeon-step-${randomBytes(8).toString("hex")}`;
      const host = createContainerWorkspaceHost({
        container: input.target.container,
        root: input.target.root,
        env: { PIGEON_STEP_MARKER: marker },
        stepStartRef: `${STEP_START_REFS}/${input.job.stream}/${input.step.seq}`,
        ...(options.docker !== undefined ? { docker: options.docker } : {}),
      });
      // 容器工作区下宿主侧只是占位目录：账本与治理按它登记，工具不经它读写
      const placeholder = path.join(input.workDir, "workspace");
      mkdirSync(placeholder, { recursive: true });
      const abort = new AbortController();
      const stopWatch = watchLimits(options.limits, () => abort.abort());
      let run: Awaited<ReturnType<typeof runHeadless>>;
      try {
        run = await runHeadless({
          task: input.prompt,
          governanceRoot: input.workDir,
          workspaceRoot: placeholder,
          workspaceHost: host,
          streamFn,
          yolo: options.yolo,
          sessionId: newSessionId(),
          maxTurns: input.budget.maxTurns,
          wallClockMs: input.budget.wallClockMs,
          skillRoots: [],
          memoryRoots: [],
          taskDirective: STREAM_WORK_DIRECTIVE,
          // 结构化记忆（134、157）：完整条件开启、按题面与报错正常挑选（固定挑选只用于定点对照的单步重跑）；
          // 去掉记忆的条件关闭。事实取自治理根里的以往会话，治理根即作业目录（条件 × 流 × 遍次各一个，见跑批器），
          // 记忆因此只在同一条流里沿步累积，不跨条件、遍次或流串用
          structuredMemory: input.condition.memory ? {} : { enabled: false },
          // 回炉（142、143、154）：验证经执行端在该流的容器里执行，修满轮数仍失败即经执行端撤回到这一步起点。
          // 分步验证（159）原样交给 headless：各步在各自的执行目录下执行、各出结论，验证记录带各步结果，
          // 报错路径按执行目录换算回工作区根（strands 各步在 strands-py/ 下），回炉反馈按步截取
          ...(repairRounds > 0
            ? {
                verify: {
                  command: verifyStepsDisplay(input.verify.steps),
                  steps: input.verify.steps.map((s) => ({ ...s })),
                  timeoutMs: input.verify.timeoutMs,
                  source: "project" as const,
                },
                repairRounds,
                // 每次验证前按与判题前同一规则删掉 agent 放的、覆盖人写测试的自动加载辅助文件（conftest）
                ...(input.autoloadedTestHelper !== undefined && input.humanTests !== undefined
                  ? {
                      beforeVerify: async () => {
                        const ws = new StreamWorkspace(
                          dockerStreamShell({
                            container: input.target.container,
                            root: input.target.root,
                            ...(options.docker !== undefined ? { docker: options.docker } : {}),
                          })
                        );
                        const humanTree = new Set(input.humanTree ?? []);
                        await removeCoveringHelpers(
                          ws,
                          input.autoloadedTestHelper as string,
                          (p) => humanTree.has(p),
                          input.humanTests ?? []
                        );
                      },
                    }
                  : {}),
                // 跑批器给了人在这一步的测试集就只认它（agent 早先落地的自己的测试不还原、不计数），否则按归类
                ...(input.humanTestFiles !== undefined
                  ? { protectedFiles: (p: string) => input.humanTestFiles?.has(p) === true }
                  : options.humanTestFile !== undefined
                    ? { protectedFiles: options.humanTestFile }
                    : {}),
              }
            : {}),
          ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
          ...(options.maxOutputTokens !== undefined
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          abortSignal: abort.signal,
        });
      } finally {
        stopWatch();
      }
      if (
        !(await clearMarkedProcesses(options.docker ?? ["docker"], input.target.container, marker))
      ) {
        return {
          status: "aborted",
          turns: run.turns,
          usage: run.usage,
          wallMs: run.durationMs,
          repair: null,
          interrupted: "Pigeon 在容器里的进程清理不净：这一步作废",
        };
      }
      if (abort.signal.aborted) {
        return {
          status: "aborted",
          turns: run.turns,
          usage: run.usage,
          wallMs: run.durationMs,
          repair: null,
          interrupted: "限额信号：Pigeon 已中止",
        };
      }
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
        repair:
          run.repair === undefined
            ? null
            : {
                rounds: run.repair.rounds,
                finalVerdict:
                  run.repair.verdict === "pass" || run.repair.verdict === "fail"
                    ? run.repair.verdict
                    : null,
                reverted: run.repair.reverted,
                budgetExhausted: run.repair.budgetExhausted,
                ...(run.repair.restoreError !== undefined
                  ? { restoreError: run.repair.restoreError }
                  : {}),
                ...(run.repair.protectedRestores !== undefined
                  ? { humanTestRestores: run.repair.protectedRestores }
                  : {}),
              },
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
  // 限额控制器：这一步期间有任何限额信号（暂停、停止、并发受限降路）即杀掉启动器——这一步反正要作废重做。
  // 订阅即时通知，另以 500 毫秒轮询兜底
  limits?: {
    readonly state: string;
    readonly signals?: number;
    subscribe?(listener: () => void): () => void;
  };
}

// 密钥类变量的名字：真 key 只在跑批进程内置的网关里，启动器只拿到网关地址与占位 key
const SECRET_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|AUTH)/i;

// 启动器的环境：宿主环境去掉密钥类变量
export function launcherEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
}

// 清掉容器里带本步标记的进程，输出这一轮找到并杀掉的个数（清理命令自身不带标记，不会杀到自己）
const KILL_MARKED = [
  'm="PIGEON_STEP_MARKER=$1"; n=0',
  "for p in /proc/[0-9]*; do",
  '  pid=$(basename "$p"); [ "$pid" = "$$" ] && continue',
  '  if { tr "\\000" "\\n" < "$p/environ"; } 2>/dev/null | grep -qx "$m"; then kill -9 "$pid" 2>/dev/null; n=$((n + 1)); fi',
  "done",
  'echo "$n"',
].join("\n");

// 一步结束后清掉 agent（最简 agent 与 Pigeon）在容器里启动、仍在运行的进程：反复清到一轮里找不到为止；清不净（或清理本身失败）返回 false
async function clearMarkedProcesses(
  docker: readonly string[],
  container: string,
  marker: string
): Promise<boolean> {
  const [program = "docker", ...pre] = docker;
  for (let round = 0; round < 5; round++) {
    const found = await new Promise<number | null>((resolve) => {
      execFile(
        program,
        [...pre, "exec", container, "sh", "-c", KILL_MARKED, "sh", marker],
        { timeout: 60_000, windowsHide: true },
        (error, stdout) => {
          const n = Number.parseInt(String(stdout).trim(), 10);
          resolve(error !== null || Number.isNaN(n) ? null : n);
        }
      );
    });
    if (found === null) return false;
    if (found === 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function commandStepAgent(options: CommandStepAgentOptions): StepAgent {
  return {
    async run(input): Promise<StepAgentResult> {
      const dir = path.join(input.workDir, "minimal", `step-${input.step.seq}`);
      mkdirSync(dir, { recursive: true });
      const requestFile = path.join(dir, "request.json");
      const resultFile = path.join(dir, "result.json");
      // 本步标记：启动器在容器里执行的每条命令都带上它（环境变量 PIGEON_STEP_MARKER），结束后据此清掉残留进程
      const marker = `pigeon-step-${randomBytes(8).toString("hex")}`;
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
          stepMarker: marker,
        })
      );
      const started = Date.now();
      const [program = "", ...args] = options.command;
      const ended = await new Promise<"done" | "timeout" | "paused">((resolve, reject) => {
        const child = spawn(program, [...args, requestFile, resultFile], {
          env: launcherEnv(),
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
        const limits = options.limits;
        const signalsAtStart = limits?.signals ?? 0;
        const check = () => {
          if (limits === undefined) return;
          if (limits.state !== "running" || (limits.signals ?? 0) !== signalsAtStart)
            kill("paused");
        };
        const unsubscribe = limits?.subscribe?.(check);
        const watch = setInterval(check, 500);
        check();
        const done = () => {
          clearTimeout(timer);
          clearInterval(watch);
          unsubscribe?.();
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
      // 不论怎么结束（正常收尾、墙钟到、限额被杀），先清掉它在容器里留下的进程、确认没有残留，再交回判题与落地
      if (
        !(await clearMarkedProcesses(options.docker ?? ["docker"], input.target.container, marker))
      ) {
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs: Date.now() - started,
          repair: null,
          interrupted: "最简 agent 在容器里的进程清理不净：这一步作废",
        };
      }
      const wallMs = Date.now() - started;
      if (ended === "paused") {
        return {
          status: "aborted",
          turns: 0,
          usage: ZERO_USAGE,
          wallMs,
          repair: null,
          interrupted: "限额信号：最简 agent 已中止",
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
