// 人写的说明（决策 330）：读 AGENTS.md，会话开始读一次即冻结（拼进系统提示，不走 transformContext）。
// - 用户级：~/.pigeon/AGENTS.md（主目录可注入，测试指到临时目录）。
// - 项目级：从仓库根到工作目录逐层读 AGENTS.md，自上而下拼接，不越过仓库根；某层没有 AGENTS.md 而有 CLAUDE.md 时读该层的
//   CLAUDE.md。仓库根为工作目录往上第一个带 .git（目录或文件，worker 工作树里是文件）的目录；不在 git 仓库里时只读工作目录
//   本身这一层。
// - 拼接顺序：用户级在前，项目级自仓库根往下。合计上限 32 KiB（按 UTF-8 字节计），超出部分截断：跨过上限的那份只放入前面
//   放得下的部分（不劈开字符），其后的不放入；推送内容末尾与终端各提示一行。
// - 冻结身份：每份文件的 sha256 与字节数、是否截断、是否放入，写进注入快照与 Run 开始条目的 memory 清单。
// 取代原先的常驻 Memory（~/.pigeon/preferences.md 与 .pigeon/memory/*.md，决策 042）；旧位置由迁移命令处理。
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sha256Hex } from "../state/hashing.ts";
import type { MemoryManifestEntry } from "../state/injection-manifest.ts";
import { userAgentsMdPath, userPigeonRel } from "../state/paths.ts";

// 合计上限（决策 330，照 Codex）：32 KiB
export const AGENTS_MD_LIMIT_BYTES = 32 * 1024;
export const AGENTS_MD_FILE = "AGENTS.md";
export const CLAUDE_MD_FILE = "CLAUDE.md";
export const USER_AGENTS_MD_DISPLAY = userPigeonRel(AGENTS_MD_FILE);

export interface AgentsMdOptions {
  // 工作目录：从它往上找仓库根
  workspaceRoot: string;
  // 用户级说明所在的主目录；缺省 os.homedir()（测试注入临时目录）
  homeDir?: string;
  // 合计上限（字节）；缺省 32 KiB（测试可调小）
  limitBytes?: number;
}

export interface AgentsMdInstructions {
  // 追加进系统提示的冻结段落；一份说明都没有时为空串
  section: string;
  // 冻结清单：用户级在前，项目级自仓库根往下
  manifest: MemoryManifestEntry[];
  // 超出上限时给终端的一行提示；没截断为 undefined
  notice?: string;
}

interface FoundFile {
  absolute: string;
  display: string;
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

// 仓库根：工作目录往上第一个带 .git 的目录；没有即 undefined
export function repoRootOf(workspaceRoot: string): string | undefined {
  let current = path.resolve(workspaceRoot);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

// 项目级要读的文件：仓库根到工作目录逐层，每层 AGENTS.md，没有则 CLAUDE.md
export function projectInstructionFiles(workspaceRoot: string): FoundFile[] {
  const cwd = path.resolve(workspaceRoot);
  const root = repoRootOf(cwd) ?? cwd;
  const relative = path.relative(root, cwd);
  const segments = relative === "" ? [] : relative.split(path.sep);
  const dirs = [
    root,
    ...segments.map((_, index) => path.join(root, ...segments.slice(0, index + 1))),
  ];
  const found: FoundFile[] = [];
  for (const dir of dirs) {
    for (const name of [AGENTS_MD_FILE, CLAUDE_MD_FILE]) {
      const absolute = path.join(dir, name);
      if (isFile(absolute)) {
        const rel = path.relative(root, absolute).split(path.sep).join("/");
        found.push({ absolute, display: rel });
        break;
      }
    }
  }
  return found;
}

// 取 UTF-8 编码的前 limit 个字节，不劈开字符
function utf8Prefix(raw: Buffer, limit: number): string {
  let end = Math.max(0, Math.min(limit, raw.length));
  // 退到字符起点：UTF-8 的后续字节形如 10xxxxxx
  while (end > 0 && end < raw.length && ((raw[end] as number) & 0xc0) === 0x80) {
    end -= 1;
  }
  return raw.subarray(0, end).toString("utf8");
}

export function loadAgentsInstructions(options: AgentsMdOptions): AgentsMdInstructions {
  const limit = options.limitBytes ?? AGENTS_MD_LIMIT_BYTES;
  const userFile = userAgentsMdPath(options.homeDir ?? homedir());
  const files: FoundFile[] = [
    ...(isFile(userFile) ? [{ absolute: userFile, display: USER_AGENTS_MD_DISPLAY }] : []),
    ...projectInstructionFiles(options.workspaceRoot),
  ];
  const manifest: MemoryManifestEntry[] = [];
  const parts: string[] = [];
  const truncated: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const file of files) {
    const raw = readFileSync(file.absolute);
    const identity = { path: file.display, hash: sha256Hex(raw), bytes: raw.length };
    const remaining = limit - used;
    if (raw.length <= remaining) {
      parts.push(`### ${file.display}\n${raw.toString("utf8").trimEnd()}`);
      manifest.push({ ...identity, truncated: false, included: true });
      used += raw.length;
    } else if (remaining > 0) {
      const partial = utf8Prefix(raw, remaining);
      parts.push(`### ${file.display}\n${partial.trimEnd()}`);
      manifest.push({ ...identity, truncated: true, included: true });
      truncated.push(`${file.display} 只放入前 ${Buffer.byteLength(partial)} 字节`);
      used = limit;
    } else {
      manifest.push({ ...identity, truncated: false, included: false });
      skipped.push(file.display);
    }
  }
  if (parts.length === 0 && skipped.length === 0) {
    return { section: "", manifest };
  }
  const overflow =
    truncated.length > 0 || skipped.length > 0
      ? `合计超出 ${limit / 1024} KiB 上限，已截断：${[
          ...truncated,
          ...(skipped.length > 0 ? [`${skipped.join("、")} 未放入`] : []),
        ].join("；")}`
      : undefined;
  const blocks = [
    "## 人写的说明（AGENTS.md）",
    "以下内容在会话开始时读取；会话中这些文件被改动时，改后的内容会整段追加。",
    ...parts,
    ...(overflow !== undefined ? [`（人写的说明${overflow}；需要时用 read_file 读取全文。）`] : []),
  ];
  return {
    section: blocks.join("\n\n"),
    manifest,
    ...(overflow !== undefined ? { notice: `[说明] AGENTS.md 等人写的说明${overflow}` } : {}),
  };
}
