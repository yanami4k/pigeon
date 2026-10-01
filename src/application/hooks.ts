// 会话级钩子调度（决策 323 / 324 / 326）：事件触发、协议解释、结论汇合、运行记录与提示。
// - 冻结：钩子清单来自会话开始时的设置快照（326 ②），本模块不自读设置文件；
// - 协议（324）：事件信息以 JSON 经标准输入交给命令；退出码 0 放行、2 拦下（标准错误为理由）、其他为钩子自身出错（不拦只提示）；
//   可选 JSON 输出：continue / stopReason / systemMessage / decision 与 reason / hookSpecificOutput 下的
//   additionalContext、permissionDecision、permissionDecisionReason、updatedInput、updatedToolOutput；
// - 并行：同一事件命中的多个钩子并行执行；三层中命令完全相同的只执行一次（state/hooks.ts 的合并已去重）；
// - 执行位置（324）：本机会话在本机、沙箱会话在容器里（经执行端），单个钩子 host:true 的在宿主执行；
// - 记录（324）：每次运行写进会话记录（pigeon.hook 条目：事件、命令、退出码、用时、结论、输出摘要），trace 显示；
//   终端界面在拦下或出错时由 notice 显示一行提示；
// - 入口范围（324）：终端界面、pigeon run、worker 与沙箱会话执行钩子；--line 不接钩子；实验跑批器不读使用者的
//   用户级与项目级钩子（跑批器给空快照，自然不接）。

import {
  type HookCommandOutcome,
  runHookCommandLocal,
  runHookCommandViaHost,
} from "../execution/hook-runner.ts";
import { type HookEventName, hookTimeoutMs, type LayeredHook } from "../state/hooks.ts";
import type { SessionId } from "../state/ids.ts";
import {
  SESSION_ENTRY_VERSION,
  type SessionCustomEntry,
  SessionEntryType,
} from "../state/session-entries.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";

// 一次运行的结论（记录与提示用）
export const HOOK_CONCLUSIONS = [
  "pass", // 放行/无决策（副作用型钩子的正常结束）
  "context", // 只补了上下文
  "allow", // PreToolUse：放行
  "deny", // PreToolUse：拒绝（拒绝名单等照常另行生效）
  "ask", // PreToolUse：要人确认
  "block", // 其余可拦事件的拦截（Stop 要求接着干、UserPromptSubmit 拦下等）
  "error", // 钩子自身出错：不拦只提示
] as const;
export type HookConclusion = (typeof HOOK_CONCLUSIONS)[number];

// 一次运行的记录（调用方写盘、显示与汇合用）
export interface HookRunRecord {
  hook: LayeredHook;
  outcome: HookCommandOutcome;
  conclusion: HookConclusion;
  // 解析出的输出字段（在场的才有）
  systemMessage?: string;
  stopReason?: string;
  continueFalse?: boolean;
  // 拦截理由：exit 2 时为 stderr，JSON 决策时为 reason/permissionDecisionReason
  reason?: string;
  decisionBlock?: boolean;
  permissionDecision?: "allow" | "ask" | "deny";
  updatedInput?: unknown;
  updatedToolOutput?: unknown;
  additionalContext?: string;
  // stdout 被当作纯文本上下文的事件（SessionStart / UserPromptSubmit）
  plainContext?: string;
}

// 一个事件的汇合结果：各调用方按事件语义取用
export interface HookEventReport {
  runs: HookRunRecord[];
  // 任一钩子拦下（exit 2 或有决策的 block/deny）：理由取拒绝 > 要求确认 > 其余的第一个
  blocked?: { reason: string };
  // PreToolUse：至少一个要人确认
  ask?: { reason?: string };
  // PreToolUse：至少一个放行（拒绝 > 要人确认 > 放行 的合并由调用方按本三字段做）
  allow?: boolean;
  // PreToolUse：改过的参数（最后一个给出者；调用方须重新过全部检查）
  updatedInput?: unknown;
  // PostToolUse：替换工具结果
  updatedToolOutput?: unknown;
  // 全部上下文（additionalContext 与纯文本 stdout，按运行顺序）
  additionalContext: string[];
  // continue:false（取第一个）：整个会话停止
  continueFalse?: { stopReason?: string };
  systemMessages: string[];
  // 本次事件是否真的执行了钩子（没有命中的钩子为 false）
  ran: boolean;
}

export interface SessionHooksOptions {
  sessionId: SessionId;
  // 治理根（PIGEON_PROJECT_DIR 的值；沙箱会话为宿主侧治理根）
  governanceRoot: string;
  // 工作区根（本机执行的 cwd；宿主执行沙箱钩子时为宿主侧占位目录）
  workspaceRoot: string;
  // 本机平台
  platform: NodeJS.Platform;
  // 冻结的钩子清单与开关
  hooks: readonly LayeredHook[];
  disableAllHooks: boolean;
  // 会话存储写入面（缺省不记）
  sink?: { append(entry: SessionCustomEntry): void };
  // 记录里附的活动 Run（会话级事件常缺省）
  activeRunId?: () => string | undefined;
  // 终端界面的一行提示（拦下或出错时调用；缺省静默）
  notice?: (line: string) => void;
  // 沙箱：容器执行端（缺省本机执行）
  workspaceHost?: WorkspaceHost;
  // 测试注入：替换两个执行器
  runLocal?: typeof runHookCommandLocal;
  runViaHost?: typeof runHookCommandViaHost;
  env?: NodeJS.ProcessEnv;
}

// 事件输入里除公共字段外的部分（各事件自己的字段）
export type HookEventFields = Record<string, unknown>;

// 公共输入字段（照 Claude Code 的口径取 Pigeon 有的）：session_id、cwd、hook_event_name、permission_mode（审批档）
// 由本模块补齐，各事件字段由调用方给
const HOOK_OUTPUT_STRING_CAP = 2000;

function capText(text: string, cap = HOOK_OUTPUT_STRING_CAP): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > cap ? `${trimmed.slice(0, cap)}…（已截断）` : trimmed;
}

// stdout 是否按 JSON 解析（照 Claude Code：去掉首尾空白后以 { 开头且以 } 结尾）
function maybeJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// 纯文本 stdout 作为上下文的事件（照 Claude Code）
const PLAIN_STDOUT_CONTEXT_EVENTS: ReadonlySet<HookEventName> = new Set([
  "SessionStart",
  "UserPromptSubmit",
]);

// 解释一次运行（决策 324 的协议）：退出码、stdout JSON 与 stderr 理由 → 记录
export function interpretHookRun(
  event: HookEventName,
  hook: LayeredHook,
  outcome: HookCommandOutcome
): HookRunRecord {
  const record: HookRunRecord = { hook, outcome, conclusion: "pass" };
  const stderrText = outcome.stderr.trim();
  if (outcome.exitCode === 2) {
    // 拦下：标准错误为理由（逐字）
    record.conclusion =
      event === "PreToolUse"
        ? "deny"
        : event === "PostToolUse" || event === "PostToolUseFailure"
          ? "block"
          : "block";
    record.decisionBlock = true;
    record.reason = stderrText !== "" ? stderrText : "钩子拦下（退出码 2，未给理由）";
    return record;
  }
  if (outcome.exitCode !== 0 || outcome.spawnError !== undefined || outcome.timedOut) {
    // 钩子自身出错（拉不起来、超时、非 0 非 2）：不拦只提示
    record.conclusion = "error";
    record.reason = outcome.timedOut
      ? `钩子超时（${outcome.durationMs} 毫秒）`
      : outcome.spawnError !== undefined
        ? `钩子拉不起来：${outcome.spawnError.message}`
        : `钩子以退出码 ${outcome.exitCode ?? "无"}结束${stderrText !== "" ? `：${stderrText}` : ""}`;
    return record;
  }
  const json = maybeJson(outcome.stdout);
  if (json === undefined) {
    // 纯文本 stdout：SessionStart 与 UserPromptSubmit 当上下文，其余只进记录
    const plain = capText(outcome.stdout);
    if (plain !== undefined && PLAIN_STDOUT_CONTEXT_EVENTS.has(event)) {
      record.plainContext = plain;
      record.conclusion = "context";
    }
    return record;
  }
  const systemMessage = stringField(json.systemMessage);
  if (systemMessage !== undefined) record.systemMessage = systemMessage;
  const stopReason = stringField(json.stopReason);
  if (stopReason !== undefined) record.stopReason = stopReason;
  if (json.continue === false) record.continueFalse = true;
  const reason = stringField(json.reason);
  if (json.decision === "block") {
    record.decisionBlock = true;
    record.reason = reason ?? "钩子拦下（decision: block，未给 reason）";
    record.conclusion = event === "PreToolUse" ? "deny" : "block";
  }
  const specific =
    typeof json.hookSpecificOutput === "object" && json.hookSpecificOutput !== null
      ? (json.hookSpecificOutput as Record<string, unknown>)
      : undefined;
  if (specific !== undefined) {
    const additional = stringField(specific.additionalContext);
    if (additional !== undefined) {
      record.additionalContext = additional;
      if (record.conclusion === "pass") record.conclusion = "context";
    }
    if (event === "PreToolUse") {
      const decision = specific.permissionDecision;
      if (decision === "allow" || decision === "ask" || decision === "deny") {
        record.permissionDecision = decision;
        if (decision === "deny") {
          record.decisionBlock = true;
          record.reason =
            stringField(specific.permissionDecisionReason) ??
            "钩子拒绝（permissionDecision: deny）";
          record.conclusion = "deny";
        } else if (decision === "ask") {
          record.permissionDecision = "ask";
          const why = stringField(specific.permissionDecisionReason);
          if (why !== undefined) record.reason = why;
          record.conclusion = "ask";
        } else {
          record.conclusion = "allow";
        }
      }
      if (specific.updatedInput !== undefined) record.updatedInput = specific.updatedInput;
    }
    if (event === "PostToolUse" && specific.updatedToolOutput !== undefined) {
      record.updatedToolOutput = specific.updatedToolOutput;
    }
  }
  return record;
}

// 汇合各运行的结论文本（PreToolUse 与使用者可读的提示用）
function mergeReason(records: readonly HookRunRecord[]): string | undefined {
  for (const wanted of ["deny", "ask"] as const) {
    const hit = records.find(
      (record) => record.conclusion === wanted && record.reason !== undefined
    );
    if (hit?.reason !== undefined) return hit.reason;
  }
  const blocked = records.find((record) => record.reason !== undefined);
  if (blocked?.reason !== undefined) return blocked.reason;
  return undefined;
}

export class SessionHooks {
  readonly #options: SessionHooksOptions;
  #runId: string | undefined;

  constructor(options: SessionHooksOptions) {
    this.#options = options;
  }

  // 本会话生效的钩子清单（/hooks 列出生效的钩子及其来自哪一层用）
  list(): readonly LayeredHook[] {
    return this.#options.disableAllHooks ? [] : this.#options.hooks;
  }

  get disabled(): boolean {
    return this.#options.disableAllHooks;
  }

  // 记录用：设置当前活动 Run（调用方在 Run 开始时更新）
  setActiveRunId(runId: string | undefined): void {
    this.#runId = runId;
  }

  // 执行一次事件：命中的钩子并行跑；没有命中、被停用或钩子清单为空即空报告。
  // matcherTarget 为 matcher 的匹配对象（工具类事件为工具名；SessionStart 为 source；PreCompact 为 trigger 等）
  async runEvent(
    event: HookEventName,
    matcherTarget: string,
    fields: HookEventFields,
    options: { signal?: AbortSignal } = {}
  ): Promise<HookEventReport> {
    const report: HookEventReport = {
      runs: [],
      additionalContext: [],
      systemMessages: [],
      ran: false,
    };
    if (this.#options.disableAllHooks) return report;
    const matched = this.#options.hooks.filter(
      (hook) => hook.event === event && hookMatcherMatchesLocal(hook.matcher, matcherTarget)
    );
    if (matched.length === 0) return report;
    report.ran = true;
    const env: NodeJS.ProcessEnv = {
      ...(this.#options.env ?? process.env),
      PIGEON_PROJECT_DIR: this.#options.governanceRoot,
    };
    const runLocal = this.#options.runLocal ?? runHookCommandLocal;
    const runViaHost = this.#options.runViaHost ?? runHookCommandViaHost;
    const results = await Promise.all(
      matched.map(async (hook) => {
        const input = {
          session_id: this.#options.sessionId,
          cwd: this.#options.workspaceRoot,
          hook_event_name: event,
          ...fields,
        };
        const stdin = `${JSON.stringify(input)}\n`;
        const timeoutMs = hookTimeoutMs(event, hook);
        const execInput = {
          command: hook.command,
          cwd: this.#options.workspaceRoot,
          platform: this.#options.platform,
          stdin,
          timeoutMs,
          env,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        };
        // 沙箱会话在容器里执行；host:true 的钩子在宿主执行
        const outcome =
          this.#options.workspaceHost !== undefined && !hook.host
            ? await runViaHost(this.#options.workspaceHost, execInput)
            : await runLocal(execInput);
        return { hook, outcome };
      })
    );
    for (const { hook, outcome } of results) {
      const record = interpretHookRun(event, hook, outcome);
      report.runs.push(record);
      this.#record(record);
      this.#notice(record);
      if (record.systemMessage !== undefined) report.systemMessages.push(record.systemMessage);
      if (record.additionalContext !== undefined) {
        report.additionalContext.push(record.additionalContext);
      }
      if (record.plainContext !== undefined) report.additionalContext.push(record.plainContext);
      if (record.continueFalse === true && report.continueFalse === undefined) {
        report.continueFalse = {
          ...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
        };
      }
    }
    // 汇合：拒绝 > 要人确认 > 放行；拦截理由优先拒绝与要求确认
    const denied = report.runs.some((record) => record.conclusion === "deny");
    const asked = report.runs.some((record) => record.conclusion === "ask");
    const allowed = report.runs.some((record) => record.conclusion === "allow");
    const blockedRun = report.runs.find((record) => record.decisionBlock === true);
    if (denied || blockedRun !== undefined) {
      report.blocked = { reason: mergeReason(report.runs) ?? "钩子拦下" };
    } else if (asked) {
      const why = mergeReason(report.runs);
      report.ask = why !== undefined ? { reason: why } : {};
    } else if (allowed) {
      report.allow = true;
    }
    for (const record of report.runs) {
      if (record.updatedInput !== undefined) report.updatedInput = record.updatedInput;
      if (record.updatedToolOutput !== undefined)
        report.updatedToolOutput = record.updatedToolOutput;
    }
    return report;
  }

  #record(record: HookRunRecord): void {
    const sink = this.#options.sink;
    if (sink === undefined) return;
    const runId = this.#options.activeRunId?.() ?? this.#runId;
    const summary = capText(
      record.outcome.stderr !== "" ? record.outcome.stderr : record.outcome.stdout
    );
    sink.append({
      customType: SessionEntryType.Hook,
      data: {
        version: SESSION_ENTRY_VERSION,
        ...(runId !== undefined ? { runId: runId as never } : {}),
        event: record.hook.event,
        command: record.hook.command,
        ...(record.hook.matcher !== undefined ? { matcher: record.hook.matcher } : {}),
        exitCode: record.outcome.exitCode,
        timedOut: record.outcome.timedOut,
        durationMs: record.outcome.durationMs,
        conclusion: record.conclusion,
        ...(summary !== undefined ? { output: summary } : {}),
      },
    });
  }

  #notice(record: HookRunRecord): void {
    const notice = this.#options.notice;
    if (notice === undefined) return;
    if (record.conclusion === "deny" || record.conclusion === "block") {
      notice(`钩子拦下（${record.hook.event}）：${record.reason ?? record.hook.command}`);
    } else if (record.conclusion === "error") {
      notice(`钩子出错（${record.hook.event}）：${record.reason ?? record.hook.command}`);
    }
  }
}

// 与 state/hooks.ts 的 hookMatcherMatches 相同判据（本模块只依赖已校验过的钩子，重复一份避免跨层细节外泄）
function hookMatcherMatchesLocal(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

// 便捷：从一次报告里取会话停止信号（continue:false）
export function reportStopSignal(report: HookEventReport): { stopReason?: string } | undefined {
  return report.continueFalse;
}
