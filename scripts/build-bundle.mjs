// 打包运行（决策 351）：用 esbuild 把 Pigeon 的入口（src/bundle-entry.ts，含命令行与终端界面）打成 dist/pigeon-cli.mjs 单文件，
// 带 source map（不内嵌源码，按路径指回 src/ 下的源文件）；dist/pigeon.mjs 是启动器：先开 source map 再加载产物，报错按源码
// 行号显示（产物自己开不了：开之前它已加载完），package.json 的 bin 指向它。
// --stream-fn 指定的接入模块在运行时动态导入，不打进包（dist/deepseek-stream-fn.mjs 是唯一例外：自带的 DeepSeek 接入
// 单独打成自包含产物）。随包文件（docker/、package.json）按包根定位，见
// src/state/package-paths.ts；上游三个包的版本与构建戳（提交号与有无未提交改动，口径同 describeHead）在构建时写进产物。
// 用法：npm run bundle（npm 安装本包时经 prepare 也跑）；--out <目录> 把产物打到另一个目录（真容器测试用当前源码打一份）
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describeHead } from "../src/orchestration/worktree.ts";
import { UPSTREAM_PACKAGES } from "../src/pi-runtime/upstream-version.ts";

const root = new URL("../", import.meta.url);
const at = (relative) => fileURLToPath(new URL(relative, root));

const upstreamVersions = Object.fromEntries(
  UPSTREAM_PACKAGES.map((name) => [
    name,
    JSON.parse(readFileSync(at(`node_modules/${name}/package.json`), "utf8")).version,
  ])
);

// 不在 git 仓库里构建时如实记 unknown
let harnessRef;
try {
  harnessRef = describeHead(at("."));
} catch {
  harnessRef = { commit: "unknown", dirty: false };
}

// 产物目录：缺省 dist/，--out 另指
const outFlag = process.argv.indexOf("--out");
const outDir =
  outFlag >= 0 && process.argv[outFlag + 1] !== undefined
    ? resolve(process.argv[outFlag + 1])
    : at("dist");
const out = (name) => join(outDir, name);
mkdirSync(outDir, { recursive: true });
// 自带的 DeepSeek 接入（决策 380、389、390）：模型接入模块不进包、运行时动态导入，只有 dist/ 而没有源码与依赖时（例如
// 无人值守地在容器里用 DeepSeek 跑 Pigeon）没有可指的接入模块，因此单独打成自包含产物，经 --stream-fn 指向它
// （端点根可经 DEEPSEEK_BASE_URL 改指）
await build({
  entryPoints: [at("src/pi-runtime/deepseek-stream-fn.ts")],
  outfile: out("deepseek-stream-fn.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
await build({
  entryPoints: [at("src/bundle-entry.ts")],
  outfile: out("pigeon-cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  sourcesContent: false,
  // 打进包的 CommonJS 依赖里的 require 要有出处（ESM 产物里没有 require）
  banner: {
    js: 'import { createRequire as __pigeonCreateRequire } from "node:module";\nconst require = __pigeonCreateRequire(import.meta.url);',
  },
  define: {
    __PIGEON_BUNDLE__: "true",
    __PIGEON_UPSTREAM_VERSIONS__: JSON.stringify(upstreamVersions),
    __PIGEON_HARNESS_REF__: JSON.stringify(harnessRef),
  },
  logLevel: "warning",
});
console.log("已生成 dist/deepseek-stream-fn.mjs（自带 DeepSeek 接入的自包含产物）");

const launcher = out("pigeon.mjs");
writeFileSync(
  launcher,
  [
    "#!/usr/bin/env node",
    "// Pigeon 的启动器（scripts/build-bundle.mjs 生成）：先开 source map 再加载打包产物",
    "process.setSourceMapsEnabled(true);",
    'await import("./pigeon-cli.mjs");',
    "",
  ].join("\n")
);
chmodSync(launcher, 0o755);
console.log("已生成 dist/pigeon.mjs（启动器）与 dist/pigeon-cli.mjs（产物，附 .map）");
