// 提交流跑批的两种 agent 接入（第三节）：跑批器只经 StepAgent 调用，不感知 agent 怎么跑。
//   Pigeon（记忆 2 × 2 的四格：能否检索历史会话 × 有无推送记忆，都开验证门与回炉，193）：与外部基准同一条路——进程内经
//     headless 入口运行，执行端为这一步的容器；
//   最简 agent（099）：宿主上的独立进程，经请求文件拿到题面、容器与预算，命令在该流的容器里执行，结果写回结果文件。
// 模型接入由各自的 stream-fn / 启动器配置决定；限额的统一处理（第 17、18 条）待定后接在这一层之下。
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runHeadless } from "../application/headless.ts";
import type { ReviewBudget, ReviewOutcome } from "../application/memory-review.ts";
import { createContainerWorkspaceHost, trustedShell } from "../execution/container-host.ts";
import type { CompactionConfigInput, StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import { DEFAULT_LOOP_GUARD_SETTINGS } from "../state/loop-guard-config.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { verifyStepsDisplay } from "../state/verify-steps.ts";
import { type GatewayMeter, meterDelta } from "./model-gateway.ts";
import { deterministicErrorOf, isContentRefusal } from "./stream-errors.ts";
import { ZERO_USAGE } from "./stream-results.ts";
import type { StepAgent, StepAgentResult, StepReviewFacts } from "./stream-runner.ts";
import {
  dockerStreamShell,
  GATE_REPORT,
  IN_STREAM_CONTAINER,
  removeCoveringHelpers,
  STALE_GIT_LOCKS,
  STEP_START_REFS,
  StreamWorkspace,
  StreamWorkspaceAccessError,
} from "./stream-workspace.ts";

// 工作方式指令：与外部基准同一句的写法（对齐公开最简实现的措辞），把"修 issue"换成"实现用户消息里描述的改动"。
// 各条件共用；它属于被测条件，改它等于换条件
export const STREAM_WORK_DIRECTIVE =
  "Your task is to make changes to non-test files in the repository at /testbed in order to implement the change described in the user message, in a way that is general and consistent with the codebase.";

// Pigeon 条件的采样温度（110，原外部基准的口径，决策 205 随旧跑批退役搬到提交流）：缺省固定为 0；要改必须由调用方显式给出
export const STREAM_DEFAULT_TEMPERATURE = 0;

// 决策 265：跑批器各条件里主 agent 派 worker 一律关掉（所测的 Pigeon 不带这项能力）
export const STREAM_SPAWN_WORKERS = false;
// 决策 291 与 265 的先例：实验条件不注册联网工具（headless 不给 webTools）；身份头照记这一项
export const STREAM_WEB_TOOLS = false;
// 决策 294 与 265 的先例：实验条件不注册任务清单工具（明确关掉；身份头照记这一项）
export const STREAM_TASK_LIST = false;
// 决策 308 与 265 的先例：实验条件关掉打转检测（明确关掉，不依赖缺省；身份头照记这一项）
export const STREAM_LOOP_GUARD = false;

export function streamTemperature(requested: number | undefined): number {
  return requested ?? STREAM_DEFAULT_TEMPERATURE;
}

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
  // 决策 188、218：上下文压缩的配置；缺省为产品缺省（实际几乎不触发），集成冒烟调低触发点验证压缩
  compaction?: CompactionConfigInput;
  // 推送格（191、223、243）：学到的记忆的总量上限（缺省 12,000 字符）与复盘上限（缺省 40 轮、15 分钟）
  memoryLimitChars?: number;
  reviewBudget?: ReviewBudget;
  provider?: string;
  modelId?: string;
  homeDir?: string;
  // 人写的测试与测试辅助文件（按这条流的运行方式归类）：开回炉的条件在每次验证之前把 agent 对它们的改动还原成
  // 这一步开工时的版本（即人在该步之前的版本；人在该步新写的测试判题时才放入），agent 不能靠改测试让验证通过
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

// 这一步开始后一有限额信号、或跑批器按步中止（排队超时等），就调用 onSignal；返回停止看守的函数
function watchLimits(
  limits: LimitWatch | undefined,
  abortSignal: AbortSignal | undefined,
  onSignal: () => void
): () => void {
  if (limits === undefined && abortSignal === undefined) return () => {};
  const signalsAtStart = limits?.signals ?? 0;
  let fired = false;
  const check = () => {
    if (fired) return;
    const limited =
      limits !== undefined &&
      (limits.state !== "running" || (limits.signals ?? 0) !== signalsAtStart);
    if (limited || abortSignal?.aborted === true) {
      fired = true;
      onSignal();
    }
  };
  const unsubscribe = limits?.subscribe?.(check);
  abortSignal?.addEventListener("abort", check);
  const timer = setInterval(check, 500);
  check();
  return () => {
    clearInterval(timer);
    unsubscribe?.();
    abortSignal?.removeEventListener("abort", check);
  };
}

// Pigeon 步的结果：回炉字段另带"agent 改过人写测试"的计数——有几次验证之前发现并还原了 agent 对人写测试的改动；
// 以及验证工具故障的次数（决策 170 ③，有才带）
export interface PigeonStepAgentResult extends StepAgentResult {
  repair:
    | (NonNullable<StepAgentResult["repair"]> & { humanTestRestores?: number; toolFaults?: number })
    | null;
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
      const docker = options.docker ?? ["docker"];
      // 回炉验证之前清进程清不净：这一步中止并作废
      let uncleared = false;
      // 回炉验证之前清 conftest 遇到 agent 设下的访问障碍：这一步中止并作废
      let unprepared: string | undefined;
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
      const stopWatch = watchLimits(options.limits, input.abortSignal, () => abort.abort());
      // 推送格的复盘：每次复盘前后各读一次这个作业的网关计量，做差累加即复盘的请求数、token 与花费
      const pushed = input.condition.pushedMemory;
      const reviews: ReviewOutcome[] = [];
      let reviewMeter: GatewayMeter | undefined;
      let meterBefore: GatewayMeter | undefined;
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
          // 记忆条件（193）：能否检索历史会话 × 有无推送记忆（推送格带记忆工具、压缩前与收尾复盘）
          sessionSearch: input.condition.sessionSearch,
          // 决策 265：各条件都不带主 agent 派 worker 的能力（明确关掉，不依赖缺省；身份头记这一项）
          spawnWorkers: STREAM_SPAWN_WORKERS,
          // 决策 294：任务清单同样不带（明确关掉）
          taskList: STREAM_TASK_LIST,
          // 决策 308：打转检测同样关掉（主 agent、复盘都不挂；轮数与豁免照缺省，只改开关）
          loopGuard: { ...DEFAULT_LOOP_GUARD_SETTINGS, enabled: STREAM_LOOP_GUARD },
          ...(pushed
            ? {
                pushedMemory: true,
                ...(options.memoryLimitChars !== undefined
                  ? { memoryLimitChars: options.memoryLimitChars }
                  : {}),
                ...(options.reviewBudget !== undefined
                  ? { reviewBudget: options.reviewBudget }
                  : {}),
                onReview: {
                  started: () => {
                    meterBefore = input.meter?.();
                  },
                  ended: (outcome: ReviewOutcome) => {
                    reviews.push(outcome);
                    const after = input.meter?.();
                    if (after !== undefined && meterBefore !== undefined) {
                      const delta = meterDelta(after, meterBefore);
                      reviewMeter =
                        reviewMeter === undefined ? delta : addMeters(reviewMeter, delta);
                    }
                    meterBefore = undefined;
                  },
                },
              }
            : {}),
          // 回炉（142、143、154）：验证经执行端在该流的容器里执行，修满轮数仍失败即以失败收尾、容器工作区保留 agent 的改动。
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
                // 每次验证（首轮与各轮回炉）之前：先按本步标记清掉 agent 留在容器里的后台进程（免得它们在验证期间重建被删的
                // conftest，或预先写一份全过的验证门报告被采信），再删掉验证门的报告，最后按与判题前同一规则删掉 agent 放的、
                // 覆盖人写测试的自动加载辅助文件（conftest）。清不净即中止这一步、报被打断
                beforeVerify: async () => {
                  if (
                    !(await clearMarkedProcesses(
                      docker,
                      input.target.container,
                      marker,
                      input.target.root
                    ))
                  ) {
                    uncleared = true;
                    abort.abort();
                    return;
                  }
                  const ws = new StreamWorkspace(
                    dockerStreamShell({
                      container: input.target.container,
                      root: input.target.root,
                      docker,
                    })
                  );
                  // 执行端接下来的 git 操作（还原受保护文件）不执行 agent 在 git 配置里设下的程序
                  await ws.sanitizeGitConfig();
                  await ws.removeTrees([GATE_REPORT]);
                  if (input.autoloadedTestHelper !== undefined && input.humanTests !== undefined) {
                    const humanTree = new Set(input.humanTree ?? []);
                    try {
                      await removeCoveringHelpers(
                        ws,
                        input.autoloadedTestHelper,
                        (p) => humanTree.has(p),
                        input.humanTests
                      );
                    } catch (error) {
                      if (!(error instanceof StreamWorkspaceAccessError)) throw error;
                      unprepared = error.message;
                      abort.abort();
                    }
                  }
                },
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
          ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          abortSignal: abort.signal,
        });
      } finally {
        stopWatch();
      }
      if (
        uncleared ||
        !(await clearMarkedProcesses(docker, input.target.container, marker, input.target.root))
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
      if (unprepared !== undefined) {
        return {
          status: "aborted",
          turns: run.turns,
          usage: run.usage,
          wallMs: run.durationMs,
          repair: null,
          interrupted: `验证前清理 conftest 失败：${unprepared}`,
        };
      }
      if (abort.signal.aborted) {
        return {
          status: "aborted",
          turns: run.turns,
          usage: run.usage,
          wallMs: run.durationMs,
          repair: null,
          interrupted:
            input.abortSignal?.aborted === true
              ? "跑批器按步中止（排队超时等）：Pigeon 已中止"
              : "限额信号：Pigeon 已中止",
        };
      }
      // 与外部基准同一判法：内容审核拒答与确定性错误照常判分；其余以错误收尾的算模型服务故障，这一步作废重做。
      // 空回复异常结束（决策 170 ②）是这一步的真实失败，照常判题：作废重做只会反复作废
      const refused = run.status === "failed" && isContentRefusal(run.errorMessage);
      const deterministic =
        run.status === "failed" && !refused ? deterministicErrorOf(run.errorMessage) : undefined;
      const providerFailed =
        run.status !== "empty-reply" &&
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
                ...(run.repair.protectedRestores !== undefined
                  ? { humanTestRestores: run.repair.protectedRestores }
                  : {}),
                ...(run.repair.toolFaults !== undefined
                  ? { toolFaults: run.repair.toolFaults }
                  : {}),
              },
        ...(providerFailed
          ? { interrupted: `模型服务故障（终态 ${run.status}）：${run.errorMessage ?? ""}` }
          : {}),
        ...(pushed ? { review: reviewFactsOf(reviews, reviewMeter) } : {}),
      };
    },
  };
}

// 两段计量差相加（峰值取较大者）
function addMeters(a: GatewayMeter, b: GatewayMeter): GatewayMeter {
  return {
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costCny: a.costCny + b.costCny,
    upstreamFailures: a.upstreamFailures + b.upstreamFailures,
    queueMs: a.queueMs + b.queueMs,
    peakInFlight: Math.max(a.peakInFlight, b.peakInFlight),
    peakInputTokens: Math.max(a.peakInputTokens, b.peakInputTokens),
    accountRequests: a.accountRequests.map((n, i) => n + (b.accountRequests[i] ?? 0)),
  };
}

// 这一步各次复盘的合计（结果行 review 的来源）
export function reviewFactsOf(
  reviews: readonly ReviewOutcome[],
  meter: GatewayMeter | undefined
): StepReviewFacts {
  return {
    closing: reviews.filter((review) => review.kind === "closing").length,
    preCompaction: reviews.filter((review) => review.kind === "pre-compaction").length,
    turns: reviews.reduce((sum, review) => sum + review.turns, 0),
    tokens: reviews.reduce((sum, review) => sum + review.tokens, 0),
    wallMs: reviews.reduce((sum, review) => sum + review.wallMs, 0),
    hitLimit: reviews.some((review) => review.hitLimit),
    failures: reviews.flatMap((review) =>
      review.error !== undefined
        ? [`${review.kind === "closing" ? "收尾" : "压缩前"}：${review.error}`]
        : []
    ),
    ...(meter !== undefined ? { meter } : {}),
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
  // 限额控制器：这一步期间有任何限额信号（全部账号都不可用时的整批暂停或停止）即杀掉启动器——这一步反正要作废重做。
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

// 清掉 agent 留在容器里的进程，输出这一轮找到并杀掉的个数。跑批器起的作业容器（带 PIGEON_STREAM_CONTAINER=1）里不看
// 标记：除 PID 1（init）、容器主命令（PID 1 最早的子进程）与本脚本及其子进程外全清——agent 用 env -u 或 env -i 起的
// 后台进程不带标记，照样清掉。容器里没有跑批器自己的常驻进程，清理时跑批器也没有并发的 exec。没有这个变量（本机测试的
// "容器"就是本机）只清带本步标记的进程，不碰本机上的其他进程。已成僵尸的不算
export const KILL_STEP_PROCESSES = [
  'm="PIGEON_STEP_MARKER=$1"; n=0; self=$$',
  `if ${IN_STREAM_CONTAINER}; then`,
  '  main=""',
  "  for p in /proc/[0-9]*; do",
  `    pid=\${p#/proc/}`,
  '    { read -r st < "$p/stat"; } 2>/dev/null || continue',
  `    rest=\${st##*) }; set -- $rest`,
  '    [ "$2" = 1 ] || continue',
  '    if [ -z "$main" ] || [ "$pid" -lt "$main" ]; then main=$pid; fi',
  "  done",
  "  for p in /proc/[0-9]*; do",
  `    pid=\${p#/proc/}`,
  '    case "$pid" in 1 | "$self" | "$main") continue ;; esac',
  '    { read -r st < "$p/stat"; } 2>/dev/null || continue',
  `    rest=\${st##*) }; set -- $rest`,
  '    [ "$1" = Z ] && continue',
  '    [ "$2" = "$self" ] && continue',
  '    kill -9 "$pid" 2>/dev/null && n=$((n + 1))',
  "  done",
  "else",
  "  for p in /proc/[0-9]*; do",
  '    pid=$(basename "$p"); [ "$pid" = "$self" ] && continue',
  '    if { tr "\\000" "\\n" < "$p/environ"; } 2>/dev/null | grep -qx "$m"; then kill -9 "$pid" 2>/dev/null; n=$((n + 1)); fi',
  "  done",
  "fi",
  'echo "$n"',
].join("\n");

// 一步结束后与每次回炉验证之前清掉 agent（最简 agent 与 Pigeon）在容器里启动、仍在运行的进程：反复清到一轮里找不到为止，
// 再删掉残留的 git 锁文件（STALE_GIT_LOCKS）；清不净（或清理本身失败）返回 false
export async function clearMarkedProcesses(
  docker: readonly string[],
  container: string,
  marker: string,
  root: string
): Promise<boolean> {
  const [program = "docker", ...pre] = docker;
  for (let round = 0; round < 5; round++) {
    const found = await new Promise<number | null>((resolve) => {
      execFile(
        program,
        [...pre, "exec", container, ...trustedShell(KILL_STEP_PROCESSES, marker)],
        { timeout: 60_000, windowsHide: true },
        (error, stdout) => {
          const n = Number.parseInt(String(stdout).trim(), 10);
          resolve(error !== null || Number.isNaN(n) ? null : n);
        }
      );
    });
    if (found === null) return false;
    if (found === 0) {
      await new Promise<void>((resolve) => {
        execFile(
          program,
          [...pre, "exec", container, ...trustedShell(STALE_GIT_LOCKS, root)],
          { timeout: 60_000, windowsHide: true },
          () => resolve()
        );
      });
      return true;
    }
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
        // 限额信号与跑批器的按步中止同一条路径：杀掉启动器，之后按标记清掉容器里的进程
        const check = () => {
          if (input.abortSignal?.aborted === true) {
            kill("paused");
            return;
          }
          if (limits === undefined) return;
          if (limits.state !== "running" || (limits.signals ?? 0) !== signalsAtStart)
            kill("paused");
        };
        const unsubscribe = limits?.subscribe?.(check);
        input.abortSignal?.addEventListener("abort", check);
        const watch = setInterval(check, 500);
        check();
        const done = () => {
          clearTimeout(timer);
          clearInterval(watch);
          unsubscribe?.();
          input.abortSignal?.removeEventListener("abort", check);
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
        !(await clearMarkedProcesses(
          options.docker ?? ["docker"],
          input.target.container,
          marker,
          input.target.root
        ))
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
          interrupted:
            input.abortSignal?.aborted === true
              ? "跑批器按步中止（排队超时等）：最简 agent 已中止"
              : "限额信号：最简 agent 已中止",
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
