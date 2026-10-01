// 会执行命令或放权的配置的确认记录（决策 326 ③、341）：用户级 ~/.pigeon/state/config-trust.json，按项目规范化路径 + 条目键记指纹；
// 原子写入，读改写在独占锁里做（两个窗口同时确认不互相覆盖）。另给出沙箱配置指向的项目 Dockerfile 的内容（并入指纹）。
// 记录畸形时响亮失败（指出文件），不当作空记录——当作空只会让人重复确认，但掩盖了文件被改坏。
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TrustEntry, TrustRecord } from "../state/config-trust.ts";
import { trustKeyOf } from "../state/config-trust.ts";
import { configTrustPathOf, userStateDir } from "../state/paths.ts";
import type { SettingsSnapshot } from "../state/settings.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { acquireExclusiveLock } from "./exclusive-lock.ts";

export const CONFIG_TRUST_VERSION = 1;

const ConfigTrustFileSchema = Type.Object({
  version: Type.Literal(CONFIG_TRUST_VERSION),
  // 项目规范化路径 → 条目键 → 指纹
  projects: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
});

export class ConfigTrustStoreError extends Error {}

// 项目的规范化路径（含符号链接解析）；路径不在时原样取绝对路径
export function normalizeProjectPath(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

function readTrustFile(file: string): Record<string, Record<string, string>> {
  if (!existsSync(file)) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigTrustStoreError(
      `配置确认记录不是合法 JSON：${file}：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Value.Check(ConfigTrustFileSchema, raw)) {
    throw new ConfigTrustStoreError(`配置确认记录格式不对：${file}`);
  }
  return (raw as { projects: Record<string, Record<string, string>> }).projects;
}

// 读本项目已确认的指纹
export function loadTrustRecord(root: string, homeDir: string = homedir()): TrustRecord {
  return readTrustFile(configTrustPathOf(homeDir))[normalizeProjectPath(root)] ?? {};
}

// 记下这些条目的指纹（同一项目的其余条目原样保留）
export function recordTrustedEntries(
  root: string,
  entries: readonly TrustEntry[],
  homeDir: string = homedir()
): void {
  const file = configTrustPathOf(homeDir);
  mkdirSync(userStateDir(homeDir), { recursive: true });
  const release = acquireExclusiveLock(`${file}.lock`, "配置确认记录正被另一个窗口写入：稍后重试");
  try {
    const projects = readTrustFile(file);
    const key = normalizeProjectPath(root);
    const current = { ...(projects[key] ?? {}) };
    for (const entry of entries) {
      current[trustKeyOf(entry)] = entry.fingerprint;
    }
    projects[key] = current;
    writeFileAtomic(
      file,
      `${JSON.stringify({ version: CONFIG_TRUST_VERSION, projects }, null, 2)}\n`
    );
  } finally {
    release();
  }
}

// 沙箱配置指向的项目 Dockerfile 的内容：取读快照那一刻记下的；没记下（手工拼的快照）才现读，不在或读不出为 undefined
export function sandboxDockerfileContent(snapshot: SettingsSnapshot): string | undefined {
  const dockerfile = snapshot.merged.sandbox?.dockerfile;
  if (dockerfile === undefined) return undefined;
  if (snapshot.dockerfileContent !== undefined) return snapshot.dockerfileContent;
  try {
    return readFileSync(path.resolve(snapshot.root, dockerfile), "utf8");
  } catch {
    return undefined;
  }
}
