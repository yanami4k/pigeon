// 斜杠命令表（决策 286 第 4、6 项）：命令的用法、在当前会话是否可用、运行中能不能用，集中在这一张表。
// 未知命令的提示与 /resume 的用法提示从表生成，以后加命令不再漏。运行中放行的是只读类命令与 /cancel、/quit；
// 改主会话状态或工作目录的命令运行中仍拒，并说明原因。分发本身仍在 commands.ts。
// 决策 301：进入 worker 会话后只放行表里标了 inWorkerSession 的命令（/stop、/approve 只在 worker 会话里用），其余说明要先回主会话。

// 判断可用性需要的壳侧只读面（CommandsHost 的子集）
export interface CommandAvailability {
  sessionsRoot(): string | undefined;
  searchRoot(): string | undefined;
  resumeConfigured(): boolean;
  hasGrants(): boolean;
  inSandbox(): boolean;
  // worker 编排面在场，及其可选动作
  workers(): { fork: boolean; take: boolean } | undefined;
  // 决策 294 B1：任务清单的查看命令在场（缺省即不在场）
  tasks?(): boolean;
  // 决策 301：正在 worker 会话里（缺省即不在）
  inWorkerSession?(): boolean;
  // 决策 309：脚本编排的命令面在场（缺省即不在场）
  scripts?(): boolean;
  // 决策 331：/memory 的命令面在场（缺省即不在场）
  memory?(): boolean;
}

export interface SlashCommandSpec {
  // 命令词（不含斜杠）；/grants save 以 "grants save" 两词记
  name: string;
  usage: string;
  // 运行中：allow 随时可用；reject 运行中拒绝，reason 说明原因
  whileRunning: { allow: true } | { allow: false; reason: string };
  // 决策 301：进入 worker 会话后能不能用（缺省不能）
  inWorkerSession?: boolean;
  available(host: CommandAvailability): boolean;
}

const MAIN_STATE = "它会改动主会话状态";
const WORKDIR = "它会改动工作目录";

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: "quit",
    usage: "/quit",
    whileRunning: { allow: true },
    inWorkerSession: true,
    available: () => true,
  },
  {
    name: "compact",
    usage: "/compact [重点]",
    whileRunning: { allow: false, reason: `${MAIN_STATE}（压缩对话上下文）` },
    available: () => true,
  },
  {
    name: "sessions",
    usage: "/sessions",
    whileRunning: { allow: true },
    available: (host) => host.sessionsRoot() !== undefined,
  },
  {
    name: "resume",
    usage: "/resume [sessionId]",
    whileRunning: { allow: false, reason: `${MAIN_STATE}（换到另一个会话）` },
    available: (host) => host.resumeConfigured(),
  },
  {
    name: "search",
    usage: "/search <关键词>",
    whileRunning: { allow: true },
    available: (host) => host.searchRoot() !== undefined,
  },
  {
    name: "grants",
    usage: "/grants",
    whileRunning: { allow: true },
    available: (host) => host.hasGrants(),
  },
  {
    name: "revoke",
    usage: "/revoke <id>",
    whileRunning: { allow: false, reason: `${MAIN_STATE}（撤销放权）` },
    available: (host) => host.hasGrants(),
  },
  {
    name: "grants save",
    usage: "/grants save <id>",
    whileRunning: { allow: false, reason: "它会改动项目的放权配置（固化放权）" },
    available: (host) => host.hasGrants(),
  },
  {
    name: "fork",
    usage: "/fork",
    whileRunning: { allow: false, reason: `${MAIN_STATE}（从当前会话分叉）` },
    available: (host) => host.workers()?.fork === true && !host.inSandbox(),
  },
  {
    name: "spawn",
    usage: '/spawn <角色> "<任务>"',
    whileRunning: { allow: false, reason: `${MAIN_STATE}（派出 worker）` },
    available: (host) => host.workers() !== undefined && !host.inSandbox(),
  },
  {
    name: "cancel",
    usage: "/cancel <worker>",
    whileRunning: { allow: true },
    available: (host) => host.workers() !== undefined && !host.inSandbox(),
  },
  {
    name: "workers",
    usage: "/workers",
    whileRunning: { allow: true },
    inWorkerSession: true,
    available: (host) => host.workers() !== undefined && !host.inSandbox(),
  },
  // 决策 301：切换树形视图（同 Ctrl+X），只读，运行中可用
  {
    name: "agents",
    usage: "/agents",
    whileRunning: { allow: true },
    inWorkerSession: true,
    available: (host) => host.workers() !== undefined && !host.inSandbox(),
  },
  // 决策 301：worker 会话里停止它、补批续做；只动这个 worker，不动主会话，运行中可用
  {
    name: "stop",
    usage: "/stop",
    whileRunning: { allow: true },
    inWorkerSession: true,
    available: (host) => host.inWorkerSession?.() === true,
  },
  {
    name: "approve",
    usage: "/approve [附言]",
    whileRunning: { allow: true },
    inWorkerSession: true,
    available: (host) => host.inWorkerSession?.() === true,
  },
  {
    name: "take",
    usage: "/take <worker>",
    whileRunning: { allow: false, reason: `${WORKDIR}（叠入 worker 的改动）` },
    available: (host) => host.workers()?.take === true && !host.inSandbox(),
  },
  // 决策 294 B1：查看任务清单，只读，运行中可用
  {
    name: "tasks",
    usage: "/tasks",
    whileRunning: { allow: true },
    inWorkerSession: true,
    available: (host) => host.tasks?.() === true,
  },
  // 决策 309、312、301：/orchestrate 点名发起、续跑、停止、放弃；运行中可用（发起的那条输入照常排队）
  {
    name: "orchestrate",
    usage: "/orchestrate <任务> [额度 ¥5|$2|300k]",
    whileRunning: { allow: true },
    available: (host) => host.scripts?.() === true && !host.inSandbox(),
  },
  // 决策 331：查看两层记忆只读，运行中可用；编辑要暂停界面打开编辑器，运行中拒绝
  {
    name: "memory",
    usage: "/memory",
    whileRunning: { allow: true },
    available: (host) => host.memory?.() === true,
  },
  {
    name: "memory edit",
    usage: "/memory edit project|user",
    whileRunning: { allow: false, reason: "它会暂停界面、打开编辑器" },
    available: (host) => host.memory?.() === true,
  },
  {
    name: "export",
    usage: "/export",
    whileRunning: { allow: false, reason: `${WORKDIR}（把沙箱里的改动提交成分支交回）` },
    available: (host) => host.inSandbox(),
  },
];

// 按输入的命令词查表：先认两词命令（/grants save），再认一词；表里没有即 undefined（未知命令）
export function lookupSlashCommand(tokens: readonly string[]): SlashCommandSpec | undefined {
  const two = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : undefined;
  return (
    SLASH_COMMANDS.find((spec) => spec.name === two) ??
    SLASH_COMMANDS.find((spec) => spec.name === tokens[0])
  );
}

export function slashTokens(value: string): string[] {
  return value
    .slice(1)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

// 当前会话可用命令的用法清单（未知命令提示用）
export function availableCommandsHint(host: CommandAvailability): string {
  return SLASH_COMMANDS.filter((spec) => spec.available(host))
    .map((spec) => spec.usage)
    .join("、");
}

export function unknownCommandText(value: string, host: CommandAvailability): string {
  return `未知命令：${value}（可用 ${availableCommandsHint(host)}）`;
}

// /resume 的用法提示（从表取，与未知命令提示同一出处）
export function resumeUsageText(): string {
  const spec = SLASH_COMMANDS.find((entry) => entry.name === "resume");
  return `用法：${spec?.usage ?? "/resume [sessionId]"}（不带会话号时弹出会话列表）`;
}

// 运行中收到的斜杠命令：放行返回 undefined，拒绝返回给人看的一行（未知命令放行，由分发如实说明）
export function rejectWhileRunning(value: string): string | undefined {
  const spec = lookupSlashCommand(slashTokens(value));
  if (spec === undefined || spec.whileRunning.allow) return undefined;
  return `运行中不能用 /${spec.name}：${spec.whileRunning.reason}。等本轮结束或按 Esc 中断后再用；输入已留在输入框`;
}

// 决策 301：worker 会话里收到的斜杠命令——能用的返回 undefined，不能用的返回给人看的一行（未知命令同样说明）
export function rejectInWorkerSession(value: string): string | undefined {
  const tokens = slashTokens(value);
  const spec = lookupSlashCommand(tokens);
  if (spec?.inWorkerSession === true) return undefined;
  const usable = SLASH_COMMANDS.filter((entry) => entry.inWorkerSession === true)
    .map((entry) => entry.usage)
    .join("、");
  return `在 worker 会话里不能用 /${tokens[0] ?? ""}（这里可用 ${usable}）；按 Esc 回主会话后再用，输入已留在输入框`;
}

// 决策 301：主会话里输入 /stop 或 /approve 时的说明
export const WORKER_SESSION_ONLY =
  "/stop 与 /approve 在 worker 会话里用：输入框为空时按 ↓ 从编排面板选中 worker，或按 Ctrl+X（/agents）在树形视图里选中，回车进入";
