// 会话开始时的设置（决策 325、326）：各入口（终端界面、--line 与 pigeon resume、pigeon run）共用的一段——
//   ① 旧布局检查：发现旧配置文件或旧位置的程序状态即报错，提示运行 pigeon migrate-config（不自动迁移）；
//   ② 读三层设置与 .mcp.json，形成本会话的设置快照（本会话内各处都从快照取，中途改文件不生效）；
//   ③ 第三道防线：会执行命令或放权的条目（命令短名、沙箱配置连同项目 Dockerfile、MCP 服务启动定义、项目共享层的
//      放行规则〔决策 341〕）内容与上次确认不同
//      （含首次出现）时——交互入口列出请人选"全部确认 / 本次不用 / 退出"，确认即记下指纹；无人值守（pigeon run）报错退出，
//      加 --trust-config 只对本次运行放行、不记指纹。项目位于用户级 trustedDirectories 之下时免于确认。
// worker 与沙箱会话沿用派出它的会话的快照（含确认结果），不再询问。
import { homedir } from "node:os";
import {
  loadTrustRecord,
  normalizeProjectPath,
  recordTrustedEntries,
  sandboxDockerfileContent,
} from "../persistence/config-trust-store.ts";
import { assertNoLegacyLayout } from "../persistence/legacy-layout.ts";
import { ensureProjectStateDir, loadSettings } from "../persistence/settings.ts";
import {
  describeTrustEntry,
  type TrustEntry,
  trustEntriesOf,
  untrustedEntries,
  withinTrustedDirectory,
  withoutTrustEntries,
} from "../state/config-trust.ts";
import type { SettingsSnapshot } from "../state/settings.ts";

export { LegacyLayoutError } from "../persistence/legacy-layout.ts";
export { SettingsError } from "../persistence/settings.ts";

// 交互确认的三种选择
export type TrustChoice = "trust" | "skip" | "quit";

export type ConfigConfirmation =
  // 交互入口：把未确认的条目交给人选
  | { kind: "interactive"; ask: (entries: readonly TrustEntry[]) => Promise<TrustChoice> }
  // 无人值守：未确认即报错；trustConfig 为真时只对本次放行，不记指纹
  | { kind: "unattended"; trustConfig: boolean };

export const TRUST_CONFIG_FLAG = "--trust-config";

export class ConfigNotConfirmedError extends Error {}

export interface OpenSessionSettingsOptions {
  // 用户主目录（缺省 os.homedir()；测试指到临时目录）
  homeDir?: string;
  confirmation: ConfigConfirmation;
  // 一行提示的出口（.pigeon/.gitignore 缺行、本次不用的条目）
  notice?: (line: string) => void;
}

// 大小写不敏感的文件系统：macOS 与 Windows 缺省如此
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

// 信任目录：~ 开头的按用户主目录展开，再规范化
function trustedDirectoriesOf(snapshot: SettingsSnapshot, homeDir: string): string[] {
  return snapshot.merged.trustedDirectories.map((dir) =>
    normalizeProjectPath(dir === "~" || dir.startsWith("~/") ? `${homeDir}${dir.slice(1)}` : dir)
  );
}

// 本会话里未确认的条目（信任目录之下的项目一律为空）
export function pendingTrustEntries(
  snapshot: SettingsSnapshot,
  homeDir: string = homedir()
): TrustEntry[] {
  const project = normalizeProjectPath(snapshot.root);
  if (
    withinTrustedDirectory(project, trustedDirectoriesOf(snapshot, homeDir), CASE_INSENSITIVE_FS)
  ) {
    return [];
  }
  const entries = trustEntriesOf({
    snapshot,
    ...dockerfileOption(sandboxDockerfileContent(snapshot)),
  });
  return untrustedEntries(entries, loadTrustRecord(snapshot.root, homeDir));
}

function dockerfileOption(content: string | undefined): { dockerfileContent?: string } {
  return content !== undefined ? { dockerfileContent: content } : {};
}

// 无人值守遇到未确认条目的报错文字
export function unattendedTrustMessage(entries: readonly TrustEntry[]): string {
  return [
    `以下会执行命令或放权的配置尚未确认（首次出现或内容有变），无人值守运行不用它们：`,
    ...entries.map((entry) => `  ${describeTrustEntry(entry)}`),
    `确认无误后可在终端界面里确认并记下，或加 ${TRUST_CONFIG_FLAG} 只对本次运行放行（不记下）。`,
  ].join("\n");
}

// 确认会执行命令的条目，返回本会话实际使用的快照
export async function confirmSessionConfig(
  snapshot: SettingsSnapshot,
  options: Pick<OpenSessionSettingsOptions, "homeDir" | "confirmation" | "notice">
): Promise<SettingsSnapshot> {
  const homeDir = options.homeDir ?? homedir();
  const pending = pendingTrustEntries(snapshot, homeDir);
  if (pending.length === 0) {
    return snapshot;
  }
  const confirmation = options.confirmation;
  if (confirmation.kind === "unattended") {
    if (confirmation.trustConfig) {
      return snapshot;
    }
    throw new ConfigNotConfirmedError(unattendedTrustMessage(pending));
  }
  const choice = await confirmation.ask(pending);
  if (choice === "trust") {
    recordTrustedEntries(snapshot.root, pending, homeDir);
    return snapshot;
  }
  if (choice === "skip") {
    options.notice?.(
      `本次不用以下未确认的配置：${pending.map((entry) => `${entry.kind}:${entry.id}`).join("、")}`
    );
    return withoutTrustEntries(snapshot, pending);
  }
  throw new ConfigNotConfirmedError("未确认会执行命令或放权的配置，已退出");
}

// 会话开始：旧布局检查 → 程序状态目录 → 读设置 → 确认会执行命令的条目
export async function openSessionSettings(
  root: string,
  options: OpenSessionSettingsOptions
): Promise<SettingsSnapshot> {
  assertNoLegacyLayout(root);
  ensureProjectStateDir(root, options.notice);
  const snapshot = loadSettings(
    root,
    options.homeDir !== undefined ? { homeDir: options.homeDir } : {}
  );
  return confirmSessionConfig(snapshot, options);
}

// 交互确认的问答文字（终端界面接管终端之前与 --line 共用）：列出条目，返回提示语
export function trustPromptText(entries: readonly TrustEntry[]): string {
  return [
    "以下会执行命令或放权的配置首次出现或内容有变，请确认：",
    ...entries.map((entry) => `  ${describeTrustEntry(entry)}`),
    "a 全部确认并记下 ｜ s 本次不用这些条目 ｜ q 退出",
  ].join("\n");
}

// 把一行回答解析成选择；认不出返回 undefined（调用方再问）
export function parseTrustAnswer(answer: string): TrustChoice | undefined {
  const value = answer.trim().toLowerCase();
  if (value === "a") return "trust";
  if (value === "s") return "skip";
  if (value === "q") return "quit";
  return undefined;
}
