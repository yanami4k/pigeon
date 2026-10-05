// 快照里不收的未跟踪大文件（决策 381）：列出某目录下未跟踪且未被忽略的文件与大小（加固过的 git ls-files，按用户的索引判定
// 跟踪与否，不跑过滤与钩子），按 snapshot 一节的上限挑出不进快照的；再给出 git add 用的路径规格文件，把它们排除在暂存之外。
// 只看普通文件（符号链接、嵌套仓库不算）。各快照处共用：workdir-snapshot.ts、orchestration/checkpoint.ts、worker 交回。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickOversized, type SkippedFile, type UntrackedLimits } from "../state/snapshot-config.ts";
import { hardenedGitArgs } from "./git-hardening.ts";

// ls-files 的参数：-z 输出不转义路径
export const UNTRACKED_LIST_ARGS: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
];

// 列表类命令在大仓库里输出可达数十 MiB
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// ls-files 的输出（路径相对 cwd）配上大小；drop 为调用方要剔除的路径（如程序状态）
export function untrackedSizes(
  cwd: string,
  output: string,
  drop: (path: string) => boolean = () => false
): SkippedFile[] {
  const files: SkippedFile[] = [];
  for (const path of output.split("\0")) {
    if (path === "" || drop(path)) continue;
    try {
      const stat = lstatSync(join(cwd, path));
      if (stat.isFile()) files.push({ path, bytes: stat.size });
    } catch {
      // 列出之后被删了：不进快照，也不必报
    }
  }
  return files;
}

// 同步版：cwd 下不进快照的未跟踪文件。config 为加在子命令前的额外 -c 选项（检查点的临时忽略文件）
export function oversizedUntracked(
  cwd: string,
  limits: UntrackedLimits,
  options: { config?: readonly string[]; drop?: (path: string) => boolean } = {}
): SkippedFile[] {
  const output = execFileSync(
    "git",
    [...hardenedGitArgs(cwd), ...(options.config ?? []), ...UNTRACKED_LIST_ARGS],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  return pickOversized(untrackedSizes(cwd, output, options.drop), limits);
}

// 按字面匹配的路径规格（文件名里的 * ? [ 不当通配）
function literal(path: string, exclude: boolean): string {
  return `:(${exclude ? "exclude," : ""}literal)${path}`;
}

// git add -A 的路径规格文件（NUL 分隔）：当前目录，排除跳过的文件。返回文件路径，用完由调用方删
export function addPathspecFile(skipped: readonly SkippedFile[]): string {
  return writeSpecs([".", ...skipped.map((file) => literal(file.path, true))]);
}

// git rm --cached 的路径规格文件：只含跳过的文件（复用的临时索引里可能还留着它们变大之前的内容）
export function removePathspecFile(skipped: readonly SkippedFile[]): string {
  return writeSpecs(skipped.map((file) => literal(file.path, false)));
}

function writeSpecs(specs: readonly string[]): string {
  const file = join(tmpdir(), `pigeon-pathspec-${randomBytes(8).toString("hex")}`);
  writeFileSync(file, `${specs.join("\0")}\0`);
  return file;
}

// 读路径规格文件的 git 参数
export function pathspecFileArgs(file: string): string[] {
  return [`--pathspec-from-file=${file.split("\\").join("/")}`, "--pathspec-file-nul"];
}
