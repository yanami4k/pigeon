// 上游版本探测（M7，ROADMAP §M7）：上游 pi-agent-core / pi-ai / pi-tui 锁定在已验证版本；会话树契约测试也只针对该版本的
// v4 JSONL 格式。启动时读取实际安装的版本，与已验证版本不一致或读不出时返回明确的告警文本，由入口打印——不静默继续。
// 版本号从包目录的 package.json 读取（包的 exports 不一定导出 package.json，按解析出的入口向上找）。
// 打包产物（决策 351）里上游包已打进产物，用的是构建时的版本：取构建时写入的 __PIGEON_UPSTREAM_VERSIONS__（源码运行时没有这个名字）。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFIED_UPSTREAM_VERSION = "0.84.4";

declare const __PIGEON_UPSTREAM_VERSIONS__: Readonly<Record<string, string>> | undefined;

export const UPSTREAM_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
] as const;

export interface UpstreamProbe {
  packages: Array<{ name: string; version?: string }>;
  warnings: string[];
}

function installedVersion(name: string): string | undefined {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
    for (let depth = 0; depth < 8; depth++) {
      const manifest = path.join(dir, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === name && typeof parsed.version === "string") {
          return parsed.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    // 解析不到即读不出
  }
  return undefined;
}

const bundledOrInstalledVersion: (name: string) => string | undefined =
  typeof __PIGEON_UPSTREAM_VERSIONS__ !== "undefined"
    ? (name) => __PIGEON_UPSTREAM_VERSIONS__?.[name]
    : installedVersion;

export function probeUpstreamVersions(
  read: (name: string) => string | undefined = bundledOrInstalledVersion
): UpstreamProbe {
  const packages = UPSTREAM_PACKAGES.map((name) => {
    const version = read(name);
    return { name, ...(version !== undefined ? { version } : {}) };
  });
  const warnings = packages.flatMap((entry) => {
    if (entry.version === undefined) {
      return [
        `上游版本告警：读不出 ${entry.name} 的版本，已验证版本为 ${VERIFIED_UPSTREAM_VERSION}（会话树格式与运行语义未经验证）`,
      ];
    }
    return entry.version === VERIFIED_UPSTREAM_VERSION
      ? []
      : [
          `上游版本告警：${entry.name} 实际为 ${entry.version}，已验证版本为 ${VERIFIED_UPSTREAM_VERSION}（会话树格式与运行语义未经验证）`,
        ];
  });
  return { packages, warnings };
}
