// 三层设置（决策 325）：用户级 ~/.pigeon/settings.json、项目共享 .pigeon/settings.json、项目个人 .pigeon/settings.local.json；
// 项目个人 > 项目共享 > 用户级。纯 schema、校验与合并，无 IO；文件读取与会话快照在 persistence/settings.ts。
// - 各节沿用原配置文件的字段（去掉各文件自己的 version）：mcp、permissions、commands、orchestration、web、sandbox、loopGuard、
//   hooks（决策 323/324）、学到的记忆的两层上限 memory（决策 332）、模型信息的覆盖值 modelInfo（决策 362）、撞上限续跑
//   truncationContinuation、流式重复检测 repetitionGuard（决策 367）与工具的上限类设置 tools（决策 356、357、368）；
//   另有顶层键 disableAllHooks 与 stopHookBlockCap（324/323）、只许写在用户级的
//   trustedDirectories（决策 326 ③）与整个文件可选的 $schema。
// - 合并：对象按键逐层合并，标量与数组由高优先层整体替换；两个例外：permissions 的放权规则三层并集生效，
//   hooks 各层的条目并列生效（同一事件同一 matcher 下命令完全相同的只留一份）。
// - 响亮失败：顶层或节内的未知键、写在设置里的 key、写在项目级的 trustedDirectories、非法的钩子 matcher，一律指出文件、键与所在层。
// 以后各段往 SETTINGS_SECTIONS 里加节，合并与未知键检查随之生效。
import path from "node:path";
import type { TSchema } from "typebox";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { COMMAND_NAME_PATTERN, type CommandsConfig, CommandsSectionSchema } from "./commands.ts";
import { type ConfigGrantRule, PermissionsSectionSchema } from "./grants.ts";
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  DISABLE_ALL_HOOKS_KEY,
  type HooksSection,
  HooksSectionSchema,
  hooksOfLayer,
  hooksSectionProblems,
  type LayeredHook,
  mergeHookLayers,
  STOP_HOOK_BLOCK_CAP_KEY,
} from "./hooks.ts";
import {
  LoopGuardSectionSchema,
  type LoopGuardSettings,
  loopGuardSettings,
} from "./loop-guard-config.ts";
import { type DotMcpJson, type McpConfig, McpSectionSchema, mergeMcpConfig } from "./mcp-config.ts";
import { type MemoryLimits, MemorySectionSchema, memoryLimits } from "./memory-config.ts";
import { type ModelInfoSection, ModelInfoSectionSchema } from "./model-info.ts";
import {
  OrchestrationSectionSchema,
  type OrchestrationSettings,
  orchestrationSettings,
} from "./orchestration-config.ts";
import {
  type RepetitionGuardSection,
  RepetitionGuardSectionSchema,
  type RepetitionGuardSettings,
  repetitionGuardSettings,
  type TruncationContinuationSection,
  TruncationContinuationSectionSchema,
  type TruncationContinuationSettings,
  truncationContinuationSettings,
} from "./runaway-config.ts";
import {
  type SandboxConfig,
  SandboxSectionSchema,
  sandboxConfigProblems,
} from "./sandbox-config.ts";
import { WorkerRoleSchema } from "./session-payloads.ts";
import {
  type ReadFileLimits,
  type RunCommandOutputLimits,
  readFileLimits,
  runCommandOutputLimits,
  type SearchLimits,
  searchLimits,
  ToolsSectionSchema,
} from "./tools-config.ts";
import { WEB_KEY_FIELDS, type WebSection, WebSectionSchema } from "./web-config.ts";

// 三层，按优先级从低到高
export const SETTINGS_LAYERS = ["user", "project", "local"] as const;
export type SettingsLayer = (typeof SETTINGS_LAYERS)[number];

export const SETTINGS_LAYER_LABELS: Readonly<Record<SettingsLayer, string>> = {
  user: "用户级",
  project: "项目共享",
  local: "项目个人",
};

// 各节：节名 → schema（节名 camelCase）
export const SETTINGS_SECTIONS = {
  mcp: McpSectionSchema,
  permissions: PermissionsSectionSchema,
  commands: CommandsSectionSchema,
  orchestration: OrchestrationSectionSchema,
  web: WebSectionSchema,
  hooks: HooksSectionSchema,
  sandbox: SandboxSectionSchema,
  loopGuard: LoopGuardSectionSchema,
  memory: MemorySectionSchema,
  modelInfo: ModelInfoSectionSchema,
  truncationContinuation: TruncationContinuationSectionSchema,
  repetitionGuard: RepetitionGuardSectionSchema,
  tools: ToolsSectionSchema,
} as const satisfies Record<string, TSchema>;
export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;

// 顶层的非节键
export const SCHEMA_KEY = "$schema";
export const TRUSTED_DIRECTORIES_KEY = "trustedDirectories";
// 顶层键：停用全部钩子（324）与收尾钩子连续拦截上限（323）
export { DISABLE_ALL_HOOKS_KEY, STOP_HOOK_BLOCK_CAP_KEY };

export const SettingsFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    mcp: Type.Optional(McpSectionSchema),
    permissions: Type.Optional(PermissionsSectionSchema),
    commands: Type.Optional(CommandsSectionSchema),
    orchestration: Type.Optional(OrchestrationSectionSchema),
    web: Type.Optional(WebSectionSchema),
    sandbox: Type.Optional(SandboxSectionSchema),
    loopGuard: Type.Optional(LoopGuardSectionSchema),
    hooks: Type.Optional(HooksSectionSchema),
    memory: Type.Optional(MemorySectionSchema),
    modelInfo: Type.Optional(ModelInfoSectionSchema),
    truncationContinuation: Type.Optional(TruncationContinuationSectionSchema),
    repetitionGuard: Type.Optional(RepetitionGuardSectionSchema),
    tools: Type.Optional(ToolsSectionSchema),
    [DISABLE_ALL_HOOKS_KEY]: Type.Optional(Type.Boolean()),
    [STOP_HOOK_BLOCK_CAP_KEY]: Type.Optional(Type.Integer({ minimum: 1 })),
    trustedDirectories: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);
export type SettingsFile = Static<typeof SettingsFileSchema>;

// 一层的出处（报错与确认清单里用）
export interface SettingsSource {
  layer: SettingsLayer;
  // 文件的展示写法（如 .pigeon/settings.json、~/.pigeon/settings.json）
  file: string;
}

export function describeSource(source: SettingsSource): string {
  return `${source.file}（${SETTINGS_LAYER_LABELS[source.layer]}）`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 信任目录的写法：绝对路径，或 ~ 本身、~/ 开头（展开为用户主目录）
export function isTrustedDirectoryForm(dir: string): boolean {
  return dir === "~" || dir.startsWith("~/") || path.isAbsolute(dir);
}

// typebox 校验失败的逐条说明
export function schemaProblems(schema: TSchema, value: unknown, prefix: string): string[] {
  return [...Value.Errors(schema, value)].map((failure) => {
    const where = "instancePath" in failure ? String(failure.instancePath) : "";
    return `${prefix}${where === "" ? "/" : where}：${failure.message}`;
  });
}

// 校验一层设置文件的内容；返回校验通过的内容或逐条问题（问题文字已带文件与层）
export function validateSettingsLayer(
  raw: unknown,
  source: SettingsSource
): { file: SettingsFile } | { problems: string[] } {
  const where = describeSource(source);
  if (!isPlainObject(raw)) {
    return { problems: [`设置文件 ${where}：顶层须为对象`] };
  }
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key === SCHEMA_KEY || key === DISABLE_ALL_HOOKS_KEY || key === STOP_HOOK_BLOCK_CAP_KEY) {
      continue;
    }
    if (key === TRUSTED_DIRECTORIES_KEY) {
      if (source.layer !== "user") {
        problems.push(
          `设置文件 ${where}：${TRUSTED_DIRECTORIES_KEY} 只能写在用户级设置里（项目不能为自己免于确认）`
        );
      } else if (Array.isArray(raw[key])) {
        // 只接受绝对路径或 ~ 开头（展开为用户主目录）：相对路径随启动目录而变，免检范围不可预料
        for (const dir of raw[key] as unknown[]) {
          if (typeof dir === "string" && !isTrustedDirectoryForm(dir)) {
            problems.push(
              `设置文件 ${where}：${TRUSTED_DIRECTORIES_KEY} 里的 ${dir} 不是绝对路径（只接受绝对路径或 ~ 开头）`
            );
          }
        }
      }
      continue;
    }
    if (!Object.hasOwn(SETTINGS_SECTIONS, key)) {
      problems.push(
        `设置文件 ${where}：未知键 ${key}（可用 ${[SCHEMA_KEY, ...Object.keys(SETTINGS_SECTIONS), TRUSTED_DIRECTORIES_KEY, DISABLE_ALL_HOOKS_KEY, STOP_HOOK_BLOCK_CAP_KEY].join("、")}）`
      );
      continue;
    }
    const section = raw[key];
    const schema = SETTINGS_SECTIONS[key as SettingsSectionName];
    if (!isPlainObject(section)) {
      problems.push(`设置文件 ${where}：${key} 一节须为对象`);
      continue;
    }
    // key 不进设置文件（先于未知键检查，给出应设的环境变量名）
    if (key === "web") {
      problems.push(...webKeyProblems(section, where));
    }
    // 钩子的 matcher 须是合法正则（其余由 schema 校验）
    if (key === "hooks") {
      problems.push(...hooksSectionProblems(section as HooksSection));
    }
    const known = new Set(Object.keys(schema.properties as Record<string, unknown>));
    for (const inner of Object.keys(section)) {
      if (!known.has(inner)) {
        problems.push(
          `设置文件 ${where}：${key} 一节里的未知键 ${inner}（可用 ${[...known].join("、")}）`
        );
      }
    }
  }
  if (problems.length > 0) {
    return { problems };
  }
  if (!Value.Check(SettingsFileSchema, raw)) {
    return { problems: schemaProblems(SettingsFileSchema, raw, `设置文件 ${where}：`) };
  }
  return { file: raw as SettingsFile };
}

// web 一节里写了 key：逐个报出应设的环境变量
function webKeyProblems(section: Record<string, unknown>, where: string): string[] {
  const problems: string[] = [];
  const search = section.search;
  if (!isPlainObject(search)) return problems;
  for (const { backend, env } of WEB_KEY_FIELDS) {
    const backendSection = search[backend];
    if (isPlainObject(backendSection) && Object.hasOwn(backendSection, "apiKey")) {
      problems.push(
        `设置文件 ${where}：web.search.${backend}.apiKey 不能写在设置文件里——key 只从环境变量读，请设置 ${env} 并删掉这一项`
      );
    }
  }
  return problems;
}

// 深合并：对象按键逐层合并，标量与数组由高优先层整体替换
export function mergeSettingsValue(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlainObject(base) && isPlainObject(over)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
      merged[key] = mergeSettingsValue(base[key], value);
    }
    return merged;
  }
  return over;
}

// 一条放权规则及其所在层与在该层里的序号（/revoke config#N 只按项目个人一层的序号移除）
export interface LayeredGrantRule {
  layer: SettingsLayer;
  index: number;
  rule: ConfigGrantRule;
}

// 合并后的设置：各节已合并（permissions 除外，放权规则另列并集；hooks 不按键合并——各层条目并列生效、
// 同一事件同一 matcher 下命令完全相同的只留一份，另列），trustedDirectories 只来自用户级
export interface MergedSettings {
  mcp?: Static<typeof McpSectionSchema>;
  commands?: Static<typeof CommandsSectionSchema>;
  orchestration?: Static<typeof OrchestrationSectionSchema>;
  web?: WebSection;
  sandbox?: SandboxConfig;
  loopGuard?: Static<typeof LoopGuardSectionSchema>;
  memory?: Static<typeof MemorySectionSchema>;
  modelInfo?: ModelInfoSection;
  truncationContinuation?: TruncationContinuationSection;
  repetitionGuard?: RepetitionGuardSection;
  tools?: Static<typeof ToolsSectionSchema>;
  // 决策 355：读档禁读名单的追加项，三层并集（permissions.readDeny；只能往内置名单上加）
  readDeny?: string[];
  trustedDirectories: string[];
  // 停用全部钩子（324）：三层按标量覆盖（高优先层说了算），缺省 false
  disableAllHooks: boolean;
  // 收尾钩子连续拦截上限（323）：缺省 8
  stopHookBlockCap: number;
}

// 每节由哪些层给出（确认清单写明来自哪一层）
export type SectionSources = Partial<Record<SettingsSectionName, SettingsLayer[]>>;

export interface MergeResult {
  merged: MergedSettings;
  grants: LayeredGrantRule[];
  // 三层并列的钩子清单（已去重；层序按优先级从低到高）
  hooks: LayeredHook[];
  sectionSources: SectionSources;
  // 每个命令短名最终取自哪一层
  commandSources: Record<string, SettingsLayer>;
}

// 三层合并（层按优先级从低到高给）
export function mergeSettingsLayers(
  layers: ReadonlyArray<{ layer: SettingsLayer; file: SettingsFile }>
): MergeResult {
  let merged: Record<string, unknown> = {};
  const grants: LayeredGrantRule[] = [];
  const hookLayers: LayeredHook[][] = [];
  const sectionSources: SectionSources = {};
  const commandSources: Record<string, SettingsLayer> = {};
  let disableAllHooks = false;
  let stopHookBlockCap = DEFAULT_STOP_HOOK_BLOCK_CAP;
  const readDeny = new Set<string>();
  for (const { layer, file } of layers) {
    for (const name of Object.keys(SETTINGS_SECTIONS) as SettingsSectionName[]) {
      const section = file[name];
      if (section === undefined) continue;
      sectionSources[name] = [...(sectionSources[name] ?? []), layer];
      // hooks 不按键合并：各层条目并列生效（324）
      if (name === "permissions" || name === "hooks") continue;
      merged = mergeSettingsValue(merged, { [name]: section }) as Record<string, unknown>;
    }
    hookLayers.push(hooksOfLayer(file.hooks, layer));
    if (file[DISABLE_ALL_HOOKS_KEY] !== undefined) {
      disableAllHooks = file[DISABLE_ALL_HOOKS_KEY];
    }
    if (file[STOP_HOOK_BLOCK_CAP_KEY] !== undefined) {
      stopHookBlockCap = file[STOP_HOOK_BLOCK_CAP_KEY];
    }
    for (const commandName of Object.keys(file.commands?.commands ?? {})) {
      commandSources[commandName] = layer;
    }
    (file.permissions?.grants ?? []).forEach((rule, index) => {
      grants.push({ layer, index, rule });
    });
    for (const entry of file.permissions?.readDeny ?? []) {
      readDeny.add(entry);
    }
  }
  // 并集按优先级从高到低排列（项目个人在前）
  grants.sort((a, b) => SETTINGS_LAYERS.indexOf(b.layer) - SETTINGS_LAYERS.indexOf(a.layer));
  const user = layers.find((entry) => entry.layer === "user")?.file;
  return {
    merged: {
      ...(merged as Omit<
        MergedSettings,
        "trustedDirectories" | "disableAllHooks" | "stopHookBlockCap"
      >),
      ...(readDeny.size > 0 ? { readDeny: [...readDeny] } : {}),
      trustedDirectories: [...(user?.trustedDirectories ?? [])],
      disableAllHooks,
      stopHookBlockCap,
    },
    grants,
    hooks: mergeHookLayers(hookLayers),
    sectionSources,
    commandSources,
  };
}

// 合并后的组合判据（跨层才看得出的问题：角色引用了别层也没有的短名、轮数不递增、image 与 dockerfile 同时给出、MCP 语义不明）
export function mergedSettingsProblems(merged: MergedSettings, dotMcp?: DotMcpJson): string[] {
  const problems: string[] = [];
  const commands = merged.commands?.commands ?? {};
  for (const name of Object.keys(commands)) {
    if (!COMMAND_NAME_PATTERN.test(name)) {
      problems.push(`commands：短名不合法：${name}`);
    }
  }
  for (const [role, names] of Object.entries(merged.commands?.roles ?? {})) {
    if (!Value.Check(WorkerRoleSchema, role)) {
      problems.push(`commands：未知角色：${role}`);
    }
    for (const name of names) {
      if (!Object.hasOwn(commands, name)) {
        problems.push(`commands：角色 ${role} 引用了未登记的短名：${name}`);
      }
    }
  }
  const loop = loopGuardSettings(merged.loopGuard);
  if ("problem" in loop) {
    problems.push(`loopGuard：${loop.problem}`);
  }
  const repetition = repetitionGuardSettings(merged.repetitionGuard);
  if ("problem" in repetition) {
    problems.push(`repetitionGuard：${repetition.problem}`);
  }
  for (const problem of sandboxConfigProblems(merged.sandbox ?? {})) {
    problems.push(`sandbox：${problem}`);
  }
  problems.push(...mergeMcpConfig(dotMcp, merged.mcp).problems.map((p) => `mcp：${p}`));
  return problems;
}

// ---- 会话快照的各节取值（会话开始时读一次，本会话内各处都从快照取）----

export interface SettingsSnapshot {
  // 项目根（治理根）
  root: string;
  // 各层文件（展示写法与是否存在）
  sources: ReadonlyArray<SettingsSource & { exists: boolean }>;
  merged: MergedSettings;
  grants: readonly LayeredGrantRule[];
  // 三层并列的钩子清单（已去重；会话开始时随快照冻结，326 ②）
  hooks: readonly LayeredHook[];
  sectionSources: SectionSources;
  commandSources: Readonly<Record<string, SettingsLayer>>;
  // 项目根 .mcp.json 的内容（一并冻结）
  dotMcp?: DotMcpJson;
  // 决策 326 ③：启动时选了"本次不用"的会执行命令的条目（类型:标识）；worker 与沙箱会话随快照沿用
  excluded?: readonly string[];
  // sandbox 一节指向的项目 Dockerfile 在读快照那一刻的内容（并入指纹；/reload 据此比出 Dockerfile 的变化）
  dockerfileContent?: string;
}

// 空快照：没有任何设置文件（测试与跑批器的缺省）
export function emptySettingsSnapshot(root: string): SettingsSnapshot {
  return {
    root,
    sources: [],
    merged: {
      trustedDirectories: [],
      disableAllHooks: false,
      stopHookBlockCap: DEFAULT_STOP_HOOK_BLOCK_CAP,
    },
    hooks: [],
    grants: [],
    sectionSources: {},
    commandSources: {},
  };
}

export function commandsConfigOf(snapshot: SettingsSnapshot): CommandsConfig {
  return {
    commands: { ...(snapshot.merged.commands?.commands ?? {}) },
    roles: { ...(snapshot.merged.commands?.roles ?? {}) },
  };
}

// 停用全部钩子的快照副本（决策 324：启动参数只对本次运行停用全部钩子；复盘等程序内部运行面也不接钩子）：
// 清单清空、开关置位；其余各节原样
export function withHooksDisabled(snapshot: SettingsSnapshot): SettingsSnapshot {
  return {
    ...snapshot,
    hooks: [],
    merged: { ...snapshot.merged, disableAllHooks: true },
  };
}

export function configGrantRulesOf(snapshot: SettingsSnapshot): ConfigGrantRule[] {
  return snapshot.grants.map((entry) => entry.rule);
}

export function orchestrationSettingsOf(snapshot: SettingsSnapshot): OrchestrationSettings {
  return orchestrationSettings(snapshot.merged.orchestration);
}

// 学到的记忆的两层上限（决策 332）：合并后的 memory 一节，不给的取缺省
export function memoryLimitsOf(snapshot: SettingsSnapshot): MemoryLimits {
  return memoryLimits(snapshot.merged.memory);
}

// 模型信息的覆盖值（决策 362）：合并后的 modelInfo 一节
export function modelInfoSectionOf(snapshot: SettingsSnapshot): ModelInfoSection | undefined {
  return snapshot.merged.modelInfo;
}

// 决策 357：read_file 的单次字节与单行字符上限（tools 一节，不给的取缺省）
export function readFileLimitsOf(snapshot: SettingsSnapshot): ReadFileLimits {
  return readFileLimits(snapshot.merged.tools);
}

// 决策 356：run_command 输出的头尾保留与落盘总量（tools 一节，不给的取缺省）
export function runCommandOutputLimitsOf(snapshot: SettingsSnapshot): RunCommandOutputLimits {
  return runCommandOutputLimits(snapshot.merged.tools);
}

export function loopGuardSettingsOf(snapshot: SettingsSnapshot): LoopGuardSettings {
  const resolved = loopGuardSettings(snapshot.merged.loopGuard);
  if ("problem" in resolved) {
    // 读取快照时已校验，到这里说明快照是手工拼的
    throw new Error(`打转检测设置不对：${resolved.problem}`);
  }
  return resolved.settings;
}

// 撞上限续跑与流式重复检测（决策 367）：合并后的两节，不给的取缺省
export function truncationContinuationOf(
  snapshot: SettingsSnapshot
): TruncationContinuationSettings {
  return truncationContinuationSettings(snapshot.merged.truncationContinuation);
}

export function repetitionGuardOf(snapshot: SettingsSnapshot): RepetitionGuardSettings {
  const resolved = repetitionGuardSettings(snapshot.merged.repetitionGuard);
  if ("problem" in resolved) {
    // 读取快照时已校验，到这里说明快照是手工拼的
    throw new Error(`流式重复检测设置不对：${resolved.problem}`);
  }
  return resolved.settings;
}

// 决策 355：设置追加的读档禁读项（三层并集）；内置名单在 tools/read-deny.ts
export function readDenyOf(snapshot: SettingsSnapshot): string[] {
  return [...(snapshot.merged.readDeny ?? [])];
}

// 决策 368：grep、glob 的结果条数上限（tools 一节，不给的取缺省）
export function searchLimitsOf(snapshot: SettingsSnapshot): SearchLimits {
  return searchLimits(snapshot.merged.tools);
}

export function webSectionOf(snapshot: SettingsSnapshot): WebSection | undefined {
  return snapshot.merged.web;
}

export function sandboxConfigOf(snapshot: SettingsSnapshot): SandboxConfig {
  return snapshot.merged.sandbox ?? {};
}

export function mcpConfigOf(snapshot: SettingsSnapshot): McpConfig {
  const { config, problems } = mergeMcpConfig(snapshot.dotMcp, snapshot.merged.mcp);
  if (problems.length > 0) {
    throw new Error(`MCP 配置校验失败：${problems.join("；")}`);
  }
  return config;
}
