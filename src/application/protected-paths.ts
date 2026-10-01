// 第一道防线（决策 326 ①）：项目的 .pigeon 目录为受保护路径。agent 用写入类文件工具写它下面任何路径须人逐次批准：
// 会话放权与配置放权都不能放行，yolo 下放行，拒绝名单照常优先；worker 在自己工作树里写也一样（判定在 governance.ts）。
// 本模块只判"这次写入落没落在受保护路径上"：
// - 词法：工具参数 path 按工作区根解析后落在 <工作区根>/.pigeon 或 <治理根>/.pigeon 之下；
// - 真实路径（本地工作区）：路径上已存在的最深一层按 realpath 解析（符号链接指进 .pigeon 的也算），再拼上其余部分比较；
// - 大小写不敏感的文件系统上按不敏感比较（探测工作区根所在文件系统，探不出时按平台缺省：macOS、Windows 不敏感）。
// 容器工作区（沙箱）只做词法判定：宿主上的 realpath 对容器里的路径没有意义。run_command 等命令写入不在此列（由第三道防线兜底）。
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PIGEON_DIR, pigeonRel } from "../state/paths.ts";

export interface ProtectedPathOptions {
  workspaceRoot: string;
  governanceRoot: string;
  // 本地工作区：按真实路径判定（容器工作区为 false，只做词法判定）
  realPaths: boolean;
  // 大小写不敏感比较；缺省按工作区根所在文件系统探测（容器工作区缺省敏感）
  caseInsensitive?: boolean;
}

// 判定器：给工具参数里的路径，落在受保护路径上返回其展示写法，否则 undefined
export type ProtectedPathResolver = (target: string) => string | undefined;

function realOrResolved(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

// 路径上已存在的最深一层按 realpath 解析，其余部分原样拼回（要写的文件往往还不存在）
export function resolveThroughExisting(target: string): string {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    if (existsSync(current)) {
      return path.join(realOrResolved(current), ...rest.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute;
    }
    rest.push(path.basename(current));
    current = parent;
  }
}

// 把路径里最后一个字母翻转大小写；没有字母返回 undefined
function flipLastLetter(value: string): string | undefined {
  for (let index = value.length - 1; index >= 0; index--) {
    const char = value.charAt(index);
    const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
    if (flipped !== char) {
      return `${value.slice(0, index)}${flipped}${value.slice(index + 1)}`;
    }
  }
  return undefined;
}

// 探测目录所在文件系统是否大小写不敏感：翻转一个字母后仍指向同一个目录即不敏感
export function caseInsensitiveAt(dir: string): boolean {
  const fallback = process.platform === "darwin" || process.platform === "win32";
  const real = realOrResolved(dir);
  const variant = flipLastLetter(real);
  if (variant === undefined) {
    return fallback;
  }
  try {
    const a = statSync(real);
    if (!existsSync(variant)) {
      return false;
    }
    const b = statSync(variant);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return fallback;
  }
}

function within(parent: string, child: string, caseInsensitive: boolean): string | undefined {
  const norm = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const relative = path.relative(norm(parent), norm(child));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative;
  }
  return undefined;
}

export function createProtectedPathResolver(options: ProtectedPathOptions): ProtectedPathResolver {
  const caseInsensitive =
    options.caseInsensitive ??
    (options.realPaths ? caseInsensitiveAt(options.workspaceRoot) : false);
  const display = (relative: string) =>
    relative === "" ? pigeonRel() : pigeonRel(...relative.split(path.sep));
  // 落在工作区根之内的路径只看工作区根自己的 .pigeon（worker 的工作树在治理根的 .pigeon/state 下，树里的普通文件不算）；
  // 落在工作区根之外的才看治理根的 .pigeon
  const check = (
    target: string,
    workspace: string,
    governance: string,
    dirsOf: (root: string) => string[]
  ) => {
    const root = within(workspace, target, caseInsensitive) !== undefined ? workspace : governance;
    for (const dir of dirsOf(root)) {
      const hit = within(dir, target, caseInsensitive);
      if (hit !== undefined) return display(hit);
    }
    return undefined;
  };
  return (target) => {
    if (target === "") return undefined;
    // 词法判定（含容器工作区）
    const lexical = path.resolve(options.workspaceRoot, target);
    const byName = check(
      lexical,
      path.resolve(options.workspaceRoot),
      path.resolve(options.governanceRoot),
      (root) => [path.join(root, PIGEON_DIR)]
    );
    if (byName !== undefined || !options.realPaths) return byName;
    // 真实路径判定：符号链接解析后落进 .pigeon 的也算；.pigeon 本身是符号链接时，它指向的目录同样受保护
    return check(
      resolveThroughExisting(lexical),
      realOrResolved(options.workspaceRoot),
      realOrResolved(options.governanceRoot),
      (root) => [path.join(root, PIGEON_DIR), realOrResolved(path.join(root, PIGEON_DIR))]
    );
  };
}
