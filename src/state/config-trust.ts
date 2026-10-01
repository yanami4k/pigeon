// 会执行命令的配置按内容确认（决策 326 ③）：纯判据，无 IO。
// 条目：三层设置里 commands 一节的每个短名、sandbox 一节（含其指向的项目 Dockerfile 的内容）、以及 MCP 服务的每个启动定义
// （项目根 .mcp.json 与设置 mcp 一节里给了 launch 的）。按"条目"建模，钩子一段把每个钩子加进来。
// 指纹：条目内容的规范化 JSON（键排序）的 sha256；Dockerfile 再并入文件内容。内容与上次确认记下的不同（含首次出现）即未确认。
// 信任目录只来自用户级设置的 trustedDirectories：项目规范化路径位于其中任一目录之下时免于确认。
import path from "node:path";
import { canonicalJson, sha256Hex } from "./hashing.ts";
import type { McpLaunch } from "./mcp-config.ts";
import { mergeMcpConfig } from "./mcp-config.ts";
import { SETTINGS_LAYER_LABELS, type SettingsLayer, type SettingsSnapshot } from "./settings.ts";

export const TRUST_ENTRY_KINDS = ["command", "sandbox", "mcp-server"] as const;
export type TrustEntryKind = (typeof TRUST_ENTRY_KINDS)[number];

export const TRUST_KIND_LABELS: Readonly<Record<TrustEntryKind, string>> = {
  command: "命令短名",
  sandbox: "沙箱配置",
  "mcp-server": "MCP 服务",
};

export interface TrustEntry {
  kind: TrustEntryKind;
  // 条目标识（短名、server 名；沙箱为 sandbox）
  id: string;
  // 来自哪里（层的说法或 .mcp.json）
  origin: string;
  // 给人看的完整命令或内容摘要
  summary: string;
  fingerprint: string;
}

// 记录里的键：类型与标识
export function trustKeyOf(entry: Pick<TrustEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

function originOfLayers(layers: readonly SettingsLayer[] | undefined): string {
  if (layers === undefined || layers.length === 0) return "设置";
  return layers.map((layer) => SETTINGS_LAYER_LABELS[layer]).join("、");
}

function launchSummary(launch: McpLaunch): string {
  if (launch.type === "http") {
    return `http ${launch.url}`;
  }
  const env = Object.keys(launch.env ?? {});
  return [
    [launch.command, ...(launch.args ?? [])].join(" "),
    ...(env.length > 0 ? [`（环境变量 ${env.join("、")}）`] : []),
  ].join(" ");
}

export interface TrustEntriesInput {
  snapshot: SettingsSnapshot;
  // 沙箱配置指向的项目 Dockerfile 的内容（读不到为 undefined）；由读取方给出
  dockerfileContent?: string;
}

// 快照里会执行命令的条目
export function trustEntriesOf(input: TrustEntriesInput): TrustEntry[] {
  const { snapshot } = input;
  const entries: TrustEntry[] = [];
  for (const [name, command] of Object.entries(snapshot.merged.commands?.commands ?? {})) {
    const layer = snapshot.commandSources[name];
    entries.push({
      kind: "command",
      id: name,
      origin: layer !== undefined ? SETTINGS_LAYER_LABELS[layer] : "设置",
      summary: command,
      fingerprint: sha256Hex(canonicalJson({ command })),
    });
  }
  const sandbox = snapshot.merged.sandbox;
  if (sandbox !== undefined && Object.keys(sandbox).length > 0) {
    const dockerfile =
      sandbox.dockerfile !== undefined
        ? `\0dockerfile\0${input.dockerfileContent ?? "\0missing"}`
        : "";
    const dockerNote =
      sandbox.dockerfile !== undefined
        ? `；Dockerfile ${sandbox.dockerfile} 内容 sha256 ${sha256Hex(input.dockerfileContent ?? "").slice(0, 12)}${input.dockerfileContent === undefined ? "（文件不存在）" : ""}`
        : "";
    entries.push({
      kind: "sandbox",
      id: "sandbox",
      origin: originOfLayers(snapshot.sectionSources.sandbox),
      summary: `${canonicalJson(sandbox)}${dockerNote}`,
      fingerprint: sha256Hex(`${canonicalJson(sandbox)}${dockerfile}`),
    });
  }
  const { config } = mergeMcpConfig(snapshot.dotMcp, snapshot.merged.mcp);
  for (const server of config.servers) {
    entries.push({
      kind: "mcp-server",
      id: server.name,
      origin:
        server.launchSource === ".mcp.json"
          ? ".mcp.json"
          : originOfLayers(snapshot.sectionSources.mcp),
      summary: launchSummary(server.launch),
      fingerprint: sha256Hex(canonicalJson(server.launch)),
    });
  }
  return entries;
}

// 确认记录：条目键 → 指纹
export type TrustRecord = Readonly<Record<string, string>>;

// 未确认的条目（内容与记录不同，含首次出现）
export function untrustedEntries(
  entries: readonly TrustEntry[],
  record: TrustRecord
): TrustEntry[] {
  return entries.filter((entry) => record[trustKeyOf(entry)] !== entry.fingerprint);
}

// 项目路径是否在某个信任目录之下（两边都应已规范化；大小写不敏感的文件系统按不敏感比较）
export function withinTrustedDirectory(
  projectPath: string,
  trusted: readonly string[],
  caseInsensitive = false
): boolean {
  const norm = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  return trusted.some((dir) => {
    const relative = path.relative(norm(dir), norm(projectPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

// 去掉本次不用的条目：短名（连同角色清单里对它的引用）、沙箱一节、MCP 服务
export function withoutTrustEntries(
  snapshot: SettingsSnapshot,
  excluded: readonly TrustEntry[]
): SettingsSnapshot {
  if (excluded.length === 0) return snapshot;
  const commandNames = new Set(excluded.filter((e) => e.kind === "command").map((e) => e.id));
  const servers = new Set(excluded.filter((e) => e.kind === "mcp-server").map((e) => e.id));
  const dropSandbox = excluded.some((e) => e.kind === "sandbox");
  const merged = { ...snapshot.merged };
  if (commandNames.size > 0 && merged.commands !== undefined) {
    const commands = Object.fromEntries(
      Object.entries(merged.commands.commands ?? {}).filter(([name]) => !commandNames.has(name))
    );
    const roles = Object.fromEntries(
      Object.entries(merged.commands.roles ?? {}).map(([role, names]) => [
        role,
        names.filter((name) => !commandNames.has(name)),
      ])
    );
    merged.commands = {
      commands,
      ...(merged.commands.roles !== undefined ? { roles } : {}),
    };
  }
  if (dropSandbox) {
    delete merged.sandbox;
  }
  let dotMcp = snapshot.dotMcp;
  if (servers.size > 0) {
    if (merged.mcp?.servers !== undefined) {
      merged.mcp = {
        servers: Object.fromEntries(
          Object.entries(merged.mcp.servers).filter(([name]) => !servers.has(name))
        ),
      };
    }
    if (dotMcp !== undefined) {
      dotMcp = {
        ...dotMcp,
        mcpServers: Object.fromEntries(
          Object.entries(dotMcp.mcpServers).filter(([name]) => !servers.has(name))
        ),
      };
    }
  }
  const { dotMcp: _old, ...rest } = snapshot;
  return {
    ...rest,
    merged,
    ...(dotMcp !== undefined ? { dotMcp } : {}),
    excluded: [...(snapshot.excluded ?? []), ...excluded.map((entry) => trustKeyOf(entry))],
  };
}

// /reload 时不确认的条目沿用原内容（决策 340）：把新快照里这些条目换回当前快照里的样子；当前快照里没有的即不启用
export function revertTrustEntries(
  next: SettingsSnapshot,
  current: SettingsSnapshot,
  entries: readonly TrustEntry[]
): SettingsSnapshot {
  if (entries.length === 0) return next;
  const merged = { ...next.merged };
  let dotMcp = next.dotMcp;
  const dropped: TrustEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "command") {
      const previous = current.merged.commands?.commands?.[entry.id];
      if (previous === undefined) {
        dropped.push(entry);
        continue;
      }
      merged.commands = {
        ...merged.commands,
        commands: { ...(merged.commands?.commands ?? {}), [entry.id]: previous },
      };
    } else if (entry.kind === "sandbox") {
      if (current.merged.sandbox === undefined) {
        delete merged.sandbox;
      } else {
        merged.sandbox = current.merged.sandbox;
      }
    } else {
      const previousSettings = current.merged.mcp?.servers?.[entry.id];
      const previousDot = current.dotMcp?.mcpServers[entry.id];
      const servers = { ...(merged.mcp?.servers ?? {}) };
      if (previousSettings === undefined) delete servers[entry.id];
      else servers[entry.id] = previousSettings;
      merged.mcp = { ...merged.mcp, servers };
      const dotServers = { ...(dotMcp?.mcpServers ?? {}) };
      if (previousDot === undefined) delete dotServers[entry.id];
      else dotServers[entry.id] = previousDot;
      dotMcp = { ...dotMcp, mcpServers: dotServers };
    }
  }
  const { dotMcp: _old, ...rest } = next;
  const reverted: SettingsSnapshot = {
    ...rest,
    merged,
    ...(dotMcp !== undefined ? { dotMcp } : {}),
  };
  // 原来没有的短名：照"本次不用"去掉（连同角色清单里的引用）
  return withoutTrustEntries(reverted, dropped);
}

// 给人看的一行
export function describeTrustEntry(entry: TrustEntry): string {
  return `[${entry.origin}] ${TRUST_KIND_LABELS[entry.kind]} ${entry.id}：${entry.summary}`;
}
