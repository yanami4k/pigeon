// 钩子（决策 323 / 324 / 326）：settings 的 hooks 一节——事件名 → [{ matcher, hooks: [{ type: "command", command, …}] }]。
// 结构照 Claude Code，事件名与协议照 323/324 的结论；type 只支持 command，保留字段以便扩展。
// 本模块只放 schema、事件清单与合并判据（纯函数、无 IO）；执行器在 execution/hook-runner.ts，
// 会话级调度在 application/hooks.ts。钩子在会话开始时随设置快照冻结（326 ②），逐条进按内容确认（326 ③，见 config-trust.ts）。
import { type Static, Type } from "typebox";

// 首批 13 个事件（323）：有对应时刻的事件，名称与语义照 Claude Code
export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

// 单个钩子处理命令（type 只认 command；timeout 单位秒——照 Claude Code 的配置写法；host=true 在宿主执行，
// 缺省在工作区所在处执行：本机会话在本机、沙箱会话在容器里，324）
export const HookHandlerSchema = Type.Object(
  {
    type: Type.Literal("command"),
    command: Type.String({ minLength: 1, maxLength: 4000 }),
    // 秒；缺省按事件给（UserPromptSubmit 30、SessionEnd 1.5、其余 600；SessionEnd 单个钩子最长 60）
    timeout: Type.Optional(Type.Integer({ minimum: 1 })),
    host: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);
export type HookHandler = Static<typeof HookHandlerSchema>;

// matcher 组：matcher 对工具类事件按正则匹配 Pigeon 的工具名，对其余事件匹配各自的取值
// （SessionStart 的 source、SessionEnd 的 reason、PreCompact/PostCompact 的 trigger、Notification 的通知种类）；
// 缺省、"*" 与空串匹配全部
export const HookMatcherGroupSchema = Type.Object(
  {
    matcher: Type.Optional(Type.String({ maxLength: 500 })),
    hooks: Type.Array(HookHandlerSchema, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false }
);
export type HookMatcherGroup = Static<typeof HookMatcherGroupSchema>;

// hooks 一节：事件名 → matcher 组清单。键限 13 个事件名（写错事件名即校验报错）
export const HooksSectionSchema = Type.Object(
  Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      Type.Optional(Type.Array(HookMatcherGroupSchema, { maxItems: 100 })),
    ])
  ),
  { additionalProperties: false }
);
export type HooksSection = Static<typeof HooksSectionSchema>;

// 顶层开关（决策 324）：disableAllHooks 停用全部钩子；三层合并按标量覆盖（高优先层说了算）
export const DISABLE_ALL_HOOKS_KEY = "disableAllHooks";
// 收尾钩子的连续拦截上限（323：缺省 8，可在设置里改）；顶层键
export const STOP_HOOK_BLOCK_CAP_KEY = "stopHookBlockCap";
export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;

// 一层设置里解析出的一条钩子（带出处）
export interface LayeredHook {
  event: HookEventName;
  matcher?: string;
  command: string;
  timeoutMs?: number;
  host: boolean;
  layer: "user" | "project" | "local";
}

// 一层 hooks 一节 → 扁平清单（层由调用方给）
export function hooksOfLayer(
  section: HooksSection | undefined,
  layer: LayeredHook["layer"]
): LayeredHook[] {
  if (section === undefined) return [];
  const out: LayeredHook[] = [];
  for (const event of HOOK_EVENTS) {
    for (const group of section[event] ?? []) {
      for (const handler of group.hooks) {
        out.push({
          event,
          ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          command: handler.command,
          ...(handler.timeout !== undefined ? { timeoutMs: handler.timeout * 1000 } : {}),
          host: handler.host === true,
          layer,
        });
      }
    }
  }
  return out;
}

// 三层合并（324）：各层条目并列生效（不去重事件或 matcher）；同一事件同一 matcher 下命令完全相同的只留一份。
// 层序即传入序（按优先级从低到高）
export function mergeHookLayers(layers: readonly LayeredHook[][]): LayeredHook[] {
  const seen = new Set<string>();
  const out: LayeredHook[] = [];
  for (const list of layers) {
    for (const hook of list) {
      const key = `${hook.event}${hook.matcher ?? ""}${hook.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hook);
    }
  }
  return out;
}

// matcher 是否命中：缺省、"*"、空串匹配全部；其余按正则（非锚定）匹配目标串；正则非法即不命中
// （合法性在设置校验时已查过，这里兜底不抛）
export function hookMatcherMatches(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

// 一个事件的命中清单
export function hooksForEvent(
  hooks: readonly LayeredHook[],
  event: HookEventName,
  target: string
): LayeredHook[] {
  return hooks.filter((hook) => hook.event === event && hookMatcherMatches(hook.matcher, target));
}

// 事件的缺省超时（毫秒）：UserPromptSubmit 挡在每条输入前（30 秒）、SessionEnd 只给短时限（1.5 秒，
// 照 Claude Code 的做法；单个钩子可用自己的 timeout 提高，最长 60 秒），其余 600 秒
export function hookDefaultTimeoutMs(event: HookEventName): number {
  if (event === "UserPromptSubmit") return 30_000;
  if (event === "SessionEnd") return 1_500;
  return 600_000;
}

// SessionEnd 单个钩子允许的最长时限（照 Claude Code：超出按 60 秒计）
export const SESSION_END_HOOK_MAX_TIMEOUT_MS = 60_000;

// 一个钩子的实际时限
export function hookTimeoutMs(event: HookEventName, hook: LayeredHook): number {
  const configured = hook.timeoutMs ?? hookDefaultTimeoutMs(event);
  return event === "SessionEnd"
    ? Math.min(configured, SESSION_END_HOOK_MAX_TIMEOUT_MS)
    : configured;
}

// 设置校验用的组合判据：matcher 须是合法正则
export function hooksSectionProblems(section: HooksSection): string[] {
  const problems: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const group of section[event] ?? []) {
      if (group.matcher !== undefined && group.matcher !== "" && group.matcher !== "*") {
        try {
          new RegExp(group.matcher);
        } catch (error) {
          problems.push(
            `hooks.${event}：matcher 不是合法正则：${group.matcher}（${error instanceof Error ? error.message : String(error)}）`
          );
        }
      }
    }
  }
  return problems;
}
