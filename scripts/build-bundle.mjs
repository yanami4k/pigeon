// 打包运行（决策 351）：用 esbuild 把 Pigeon 的入口（src/bundle-entry.ts，含命令行与终端界面）打成 dist/pigeon-cli.mjs 单文件，
// 带 source map（不内嵌源码，按路径指回 src/ 下的源文件）；dist/pigeon.mjs 是启动器：先开 source map 再加载产物，报错按源码
// 行号显示（产物自己开不了：开之前它已加载完），package.json 的 bin 指向它。
// --stream-fn 指定的接入模块在运行时动态导入，不打进包。随包文件（docker/、eval/、package.json）按包根定位，见
// src/state/package-paths.ts；上游三个包的版本在构建时写进产物（打包后用的就是这几个版本）。
// 用法：npm run bundle
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { UPSTREAM_PACKAGES } from "../src/pi-runtime/upstream-version.ts";

const root = new URL("../", import.meta.url);
const at = (relative) => fileURLToPath(new URL(relative, root));

const upstreamVersions = Object.fromEntries(
  UPSTREAM_PACKAGES.map((name) => [
    name,
    JSON.parse(readFileSync(at(`node_modules/${name}/package.json`), "utf8")).version,
  ])
);

mkdirSync(at("dist"), { recursive: true });
await build({
  entryPoints: [at("src/bundle-entry.ts")],
  outfile: at("dist/pigeon-cli.mjs"),
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
  },
  logLevel: "warning",
});

const launcher = at("dist/pigeon.mjs");
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
