// 常驻 Memory（M5 S3，决策 042）：两层存储、字符预算、会话开始读一次即冻结。
//   - 用户级 ~/.pigeon/preferences.md：用户偏好，永不截断，排在最前并占用预算；
//   - 项目级 .pigeon/memory/*.md：按配置顺序装到预算满——放得下的整份装入，预算边界上的那份
//     只装入前半并标 truncated，其余不注入、只在段尾列出文件名（模型需要时用 read_file 按需读）。
// 两层都是人可直接编辑的 markdown；M5 的写入方只有人（M8 激活候选时程序写入同一目录）。
// 注入位置是 system prompt 追加段（装配根拼接），不走 transformContext；冻结身份是每文件 sha256
// 与字节数，写进 InjectionSnapshot v3 的 memory 清单。预算单位是字符（约 4 字符 1 token），
// 实际 token 消耗由 turn.completed 的 usage 事后校准（044）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryManifestEntry } from "../state/injection-manifest.ts";
import { sha256Hex } from "../state/message-content.ts";

// 默认字符预算：约 2000 token
export const DEFAULT_MEMORY_BUDGET_CHARS = 8000;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const PREFERENCES_DISPLAY_PATH = "~/.pigeon/preferences.md";

export interface ResidentMemoryOptions {
  workspaceRoot: string;
  // 用户级根；缺省 os.homedir()（测试注入临时目录）
  homeDir?: string;
  budgetChars?: number;
  // 项目 Memory 的配置顺序（文件名）；未列出的文件按文件名字典序排在其后
  order?: readonly string[];
}

export interface ResidentMemory {
  // 追加进 system prompt 的冻结段落；无任何偏好与 Memory 文件时为空串
  section: string;
  // 冻结清单：偏好在前，项目 Memory 按装载顺序
  manifest: MemoryManifestEntry[];
  budgetChars: number;
  usedChars: number;
}

interface MemoryFile {
  displayPath: string;
  content: string;
  bytes: number;
  hash: string;
}

function readMemoryFile(absolutePath: string, displayPath: string): MemoryFile {
  const raw = readFileSync(absolutePath);
  return { displayPath, content: raw.toString("utf8"), bytes: raw.length, hash: sha256Hex(raw) };
}

// 取前 count 个 UTF-16 码元，不劈开代理对
function sliceChars(text: string, count: number): string {
  let end = Math.max(0, Math.min(count, text.length));
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function projectMemoryNames(workspaceRoot: string, order: readonly string[]): string[] {
  const dir = join(workspaceRoot, ".pigeon", "memory");
  if (!existsSync(dir)) {
    return [];
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const listed = [...new Set(order)].filter((name) => names.includes(name));
  return [...listed, ...names.filter((name) => !listed.includes(name))];
}

export function loadResidentMemory(options: ResidentMemoryOptions): ResidentMemory {
  const budgetChars = options.budgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS;
  const manifest: MemoryManifestEntry[] = [];
  const parts: string[] = [];
  const skipped: string[] = [];
  let usedChars = 0;

  const preferencesPath = join(options.homeDir ?? homedir(), ".pigeon", "preferences.md");
  if (existsSync(preferencesPath) && statSync(preferencesPath).isFile()) {
    // 偏好永不截断：全文注入，并占用预算（预算不够时项目 Memory 让位）
    const file = readMemoryFile(preferencesPath, PREFERENCES_DISPLAY_PATH);
    parts.push(`### 用户偏好（${file.displayPath}）\n${file.content.trimEnd()}`);
    manifest.push({
      path: file.displayPath,
      hash: file.hash,
      bytes: file.bytes,
      truncated: false,
      included: true,
    });
    usedChars += file.content.length;
  }

  const memoryDir = join(options.workspaceRoot, ".pigeon", "memory");
  for (const name of projectMemoryNames(options.workspaceRoot, options.order ?? [])) {
    const file = readMemoryFile(join(memoryDir, name), `.pigeon/memory/${name}`);
    const remaining = budgetChars - usedChars;
    const identity = { path: file.displayPath, hash: file.hash, bytes: file.bytes };
    if (file.content.length <= remaining) {
      parts.push(`### ${file.displayPath}\n${file.content.trimEnd()}`);
      manifest.push({ ...identity, truncated: false, included: true });
      usedChars += file.content.length;
    } else if (remaining > 0) {
      const partial = sliceChars(file.content, remaining);
      parts.push(
        `### ${file.displayPath}（超出预算，只装入前 ${partial.length} 字符，全文用 read_file 读取）\n${partial}`
      );
      manifest.push({ ...identity, truncated: true, included: true });
      usedChars += partial.length;
    } else {
      manifest.push({ ...identity, truncated: false, included: false });
      skipped.push(file.displayPath);
    }
  }

  if (manifest.length === 0) {
    return { section: "", manifest, budgetChars, usedChars: 0 };
  }
  const blocks = [
    "## 常驻 Memory",
    `以下内容在会话开始时读取并冻结（字符预算 ${budgetChars}，约 ${Math.ceil(budgetChars / CHARS_PER_TOKEN_ESTIMATE)} token）；` +
      "会话中修改这些文件要到下个会话才生效。",
    ...parts,
  ];
  if (skipped.length > 0) {
    blocks.push(`未注入（超出预算，需要时用 read_file 按需读取）：${skipped.join("、")}`);
  }
  return { section: blocks.join("\n\n"), manifest, budgetChars, usedChars };
}
