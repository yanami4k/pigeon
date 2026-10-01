// 第一道防线（决策 326 ①）：项目的 .pigeon 目录为受保护路径。agent 用写入类文件工具写它下面任何路径须人逐次批准：
// 会话放权与配置放权都不能放行，yolo 下放行，拒绝名单照常优先；worker 在自己工作树里写也一样（判定在 governance.ts）。
// 本模块只判"这次写入落没落在受保护路径上"：
// - 词法：工具参数 path 按工作区根解析后落在 <工作区根>/.pigeon 或 <治理根>/.pigeon 之下；
// - 真实路径（本地工作区）：路径上已存在的最深一层按 realpath 解析（符号链接指进 .pigeon 的也算），再拼上其余部分比较；
// - 大小写不敏感的文件系统上按不敏感比较（探测工作区根所在文件系统，探不出时按平台缺省：macOS、Windows 不敏感）。
// 容器工作区（沙箱）在容器里判定：路径按容器的工作区根以正斜杠规范化（含写成容器内绝对路径的写法），再经执行端在容器里解析
// 路径上最深的已存在一层（容器里的符号链接指进 .pigeon 的同样算）。run_command 等命令写入不在此列（由第三道防线兜底）。
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

// 容器工作区的判定（决策 326 ①）：执行端只给"解析既有路径"一种能力，要写的文件往往还不存在，故从目标逐层向上找最深的
// 已存在一层，经执行端解析（容器内 readlink -f）后拼回其余部分，再与容器工作区根的 .pigeon 比较；解析越出工作区根
// （执行端拒绝）或一层也找不到时只按词法结果。工作区根与 .pigeon 本身也经执行端解析一次（它们可能是链接）
export function createHostProtectedPathResolver(host: {
  root: string;
  resolveExisting(inputPath: string): Promise<string>;
}): (target: string) => Promise<string | undefined> {
  const posix = path.posix;
  const root = posix.normalize(host.root);
  const display = (relative: string) =>
    relative === "" ? pigeonRel() : pigeonRel(...relative.split("/"));
  const under = (dir: string, target: string): string | undefined => {
    const relative = posix.relative(dir, target);
    return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative))
      ? relative
      : undefined;
  };
  const tryResolve = async (target: string): Promise<string | undefined> => {
    try {
      return await host.resolveExisting(target);
    } catch {
      return undefined;
    }
  };
  let realDirs: Promise<string[]> | undefined;
  const pigeonDirs = (): Promise<string[]> => {
    realDirs ??= (async () => {
      const realRoot = (await tryResolve(root)) ?? root;
      const realPigeon = await tryResolve(posix.join(root, PIGEON_DIR));
      return [
        ...new Set([
          posix.join(root, PIGEON_DIR),
          posix.join(realRoot, PIGEON_DIR),
          ...(realPigeon !== undefined ? [realPigeon] : []),
        ]),
      ];
    })();
    return realDirs;
  };
  return async (target) => {
    if (target === "") return undefined;
    const lexical = posix.isAbsolute(target) ? posix.normalize(target) : posix.join(root, target);
    const byName = under(posix.join(root, PIGEON_DIR), lexical);
    if (byName !== undefined) return display(byName);
    // 逐层向上找最深的已存在一层，经执行端解析后拼回其余部分
    const rest: string[] = [];
    let current = lexical;
    for (;;) {
      const resolved = await tryResolve(current);
      if (resolved !== undefined) {
        const real = posix.join(resolved, ...rest.reverse());
        for (const dir of await pigeonDirs()) {
          const hit = under(dir, real);
          if (hit !== undefined) return display(hit);
        }
        return undefined;
      }
      const parent = posix.dirname(current);
      if (parent === current || under(root, parent) === undefined) {
        return undefined;
      }
      rest.push(posix.basename(current));
      current = parent;
    }
  };
}
