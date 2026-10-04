// 随包文件的位置（决策 351）：Pigeon 可以从源码运行（node src/...），也可以从打包产物运行（dist/ 下的单文件）。两种情况下
// docker/、eval/ 与 package.json 等随包文件都在包根下：源码运行时包根是本文件往上两层，打包产物运行时是产物所在目录的上一层。
// 是否打包产物由构建时的定义 __PIGEON_BUNDLE__ 得知（源码运行时没有这个名字）。只算地址，不读文件。
declare const __PIGEON_BUNDLE__: boolean | undefined;

export const FROM_BUNDLE: boolean =
  typeof __PIGEON_BUNDLE__ !== "undefined" && __PIGEON_BUNDLE__ === true;

// 打包产物里把进程分派到终端界面的环境变量：只在打包产物起终端界面子进程时设，产物入口读后即删（不传给它再起的进程）
export const BUNDLE_ROLE_ENV = "PIGEON_BUNDLE_ROLE";

// 包根：moduleUrl 为源码里本文件的地址，或打包产物的地址
export function packageRootUrl(fromBundle: boolean, moduleUrl: string): URL {
  return new URL(fromBundle ? "../" : "../../", moduleUrl);
}

// 包根下的一个文件或目录（相对包根写，目录以 / 结尾）
export function packageFileUrl(relative: string): URL {
  return new URL(relative, packageRootUrl(FROM_BUNDLE, import.meta.url));
}

// 打包产物入口取本进程的角色：环境变量为 tui 即终端界面，其余为命令行；取后从 env 删去
export function takeBundleRole(env: Record<string, string | undefined>): "tui" | "cli" {
  const role = env[BUNDLE_ROLE_ENV];
  delete env[BUNDLE_ROLE_ENV];
  return role === "tui" ? "tui" : "cli";
}
