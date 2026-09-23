// 结构化记忆测试夹具：真实 git 仓库、按源码里的标记输出各工具真实格式报错的分步验证脚本、编辑与建文件的假模型回复。
// 验证脚本 v.mjs <步名> 扫描工作区（跳过 .git、.pigeon、node_modules），按标记产出报错：
// - 格式：含 FMT_BAD 的文件 → biome 的整文件格式差异（file format ━━━）；
// - 类型：含 TYPE_BAD:<名字> 的文件 → tsc 纯文本报错 TS2304 Cannot find name '<名字>'；
// - 分层：含 LAYER_BAD:<被依赖端> 的文件 → 依赖巡航的 error layer-rule: 文件 → 被依赖端；
// - 测试：*.test.ts 里每行 "// FAILS_UNLESS <文件> <标记> <测试名>"：<文件> 不含 <标记> 即该测试失败（node:test spec 汇总）；
// - 构建：含 BUILD_BAD 的文件 → 无法解析的输出（非测试步）；
// - 集成测试：含 ITEST_BAD 的文件 → 无法解析的输出（测试步）。
// 有报错即退出 1，否则退出 0。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FakeReply } from "../pi-runtime/fixtures.ts";
import type { VerifyConfig } from "../state/attempt-config.ts";
import { verifyStepsDisplay } from "../state/verify-steps.ts";

const NODE = `"${process.execPath}"`;

export const MEMORY_VERIFY_SCRIPT = String.raw`import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
const step = process.argv[2];
const root = process.cwd();
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".pigeon", "node_modules", "templates", "v.mjs", "mk.mjs"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(relative(root, full).split("\\").join("/"));
  }
};
walk(root);
const read = (file) => { try { return readFileSync(join(root, file), "utf8"); } catch { return ""; } };
const out = [];
if (step === "格式") {
  for (const file of files) if (read(file).includes("FMT_BAD")) out.push(file.split("/").join("\\") + " format ━━━━━━━━━━━━━━━━", "", "  × Formatter would have printed the following content:", "");
  if (out.length > 0) out.push("Checked " + files.length + " files in 3ms. No fixes applied.", "Found " + (out.length / 4) + " errors.");
} else if (step === "类型") {
  for (const file of files) for (const match of read(file).matchAll(/TYPE_BAD:(\w+)/g)) out.push(file + "(1,1): error TS2304: Cannot find name '" + match[1] + "'.");
} else if (step === "分层") {
  for (const file of files) for (const match of read(file).matchAll(/LAYER_BAD:(\S+)/g)) out.push("  error layer-rule: " + file + " → " + match[1]);
  if (out.length > 0) out.push("", "x " + out.length + " dependency violations (" + out.length + " errors, 0 warnings). 3 modules, 2 dependencies cruised.");
} else if (step === "测试") {
  const failing = [];
  for (const file of files.filter((name) => name.endsWith(".test.ts"))) {
    for (const match of read(file).matchAll(/\/\/ FAILS_UNLESS (\S+) (\S+) (.+)/g)) {
      if (!read(match[1]).includes(match[2])) failing.push({ file, name: match[3].trim() });
    }
  }
  if (failing.length > 0) {
    out.push("ℹ tests " + failing.length, "ℹ fail " + failing.length, "", "✖ failing tests:", "");
    for (const test of failing) out.push("test at " + test.file.split("/").join("\\") + ":1:1", "✖ " + test.name + " (1.5ms)", "  AssertionError [ERR_ASSERTION]: 失败", "");
  }
} else if (step === "构建") {
  for (const file of files) if (read(file).includes("BUILD_BAD")) out.push("make: *** [all] Error 2 (" + file + ")");
} else if (step === "集成测试") {
  for (const file of files) if (read(file).includes("ITEST_BAD")) out.push("Segmentation fault (core dumped) " + file);
}
process.stdout.write(out.join("\n") + (out.length > 0 ? "\n" : "一切正常\n"));
process.exit(out.length > 0 ? 1 : 0);
`;

// 复制模板文件：node mk.mjs <模板> <目标>（模拟 agent 用命令新建文件，走命令回执的文件变化）
const MAKE_SCRIPT = String.raw`import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const [from, to] = process.argv.slice(2);
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
`;

export const MEMORY_STEP_NAMES = ["格式", "类型", "测试", "分层", "构建", "集成测试"] as const;

export function memoryVerifyConfig(names: readonly string[] = MEMORY_STEP_NAMES): VerifyConfig {
  const steps = names.map((name) => ({ name, command: `${NODE} v.mjs ${name}` }));
  return { command: verifyStepsDisplay(steps), steps, timeoutMs: 60_000, source: "flag" };
}

export interface MemoryRepo {
  root: string;
  home: string;
  git: (args: string[]) => string;
  write: (file: string, content: string) => void;
  commit: (message: string) => void;
  cleanup: () => void;
}

// 建一个 git 仓库：放好验证脚本、建文件脚本与给定文件，提交一次
export function makeMemoryRepo(files: Record<string, string>): MemoryRepo {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-memory-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-memory-home-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pigeon@example.invalid"]);
  git(["config", "user.name", "pigeon-test"]);
  git(["config", "core.autocrlf", "false"]);
  write("v.mjs", MEMORY_VERIFY_SCRIPT);
  write("mk.mjs", MAKE_SCRIPT);
  write(".gitignore", ".pigeon/\n");
  for (const [file, content] of Object.entries(files)) {
    write(file, content);
  }
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["commit", "-q", "--allow-empty", "-m", message]);
  };
  commit("init");
  return {
    root,
    home,
    git,
    write,
    commit,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

// 一次回复里的若干处替换编辑
export function edits(...changes: Array<[path: string, from: string, to: string]>): FakeReply {
  return {
    text: "改一下",
    toolCalls: changes.map(([path, from, to]) => ({
      name: "edit_file",
      args: { path, old_string: from, new_string: to },
    })),
  };
}

// 用命令从模板复制出一个新文件
export function makeFile(template: string, target: string): FakeReply {
  return {
    text: "新建文件",
    toolCalls: [{ name: "run_command", args: { command: `${NODE} mk.mjs ${template} ${target}` } }],
  };
}

export const finished = (text = "好了"): FakeReply => ({ text });
