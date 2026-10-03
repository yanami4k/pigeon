// 打包产物的入口（决策 351）：scripts/build-bundle.mjs 以本文件为入口打成 dist/pigeon-cli.mjs 单文件。终端界面子进程由环境变量
// 分派到 tui 入口（读后即删），其余一律走命令行入口。源码运行不经过这里：两个入口文件各自判断是否被直接运行，本文件在源码
// 运行时被 import 也不做任何事。命令行与终端界面两个 Actor 互不 import，汇合在这一层。
import { main as cliMain } from "./cli/index.ts";
import { FROM_BUNDLE, takeBundleRole } from "./state/package-paths.ts";
import { main as tuiMain } from "./tui/main.ts";

if (FROM_BUNDLE) {
  const main = takeBundleRole(process.env) === "tui" ? tuiMain : cliMain;
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
