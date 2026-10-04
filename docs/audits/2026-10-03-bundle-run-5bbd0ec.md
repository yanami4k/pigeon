# 打包运行 审计

- 基线：5bbd0ec
- 分支：bundle-run-b
- 范围：决策 351（打包运行，性能调优第一波 1a）。两组提交：按包根定位随包文件与按入口选终端界面子进程（7dfef31）；esbuild 单文件产物、启动器、bin 入口与 CI 冒烟（d930471）。

## 现状

- Pigeon 直接以 node 运行 src 下的 TS 源码，package.json 没有 bin；`src/cli/index.ts` 顶部静态导入全部子命令；终端界面由 `launchTui` 以子进程运行 `src/tui/main.ts`，再加载一遍模块图。
- 以 `import.meta.url` 定位文件的地方：`execution/sandbox-image.ts`（docker/sandbox/Dockerfile）、`execution/script-sandbox.ts`（docker/script/executor.cjs）、`eval/stream-generate.ts`（eval/stream/）、`eval/stream-harness.ts`（仓库的提交号）、`cli/index.ts`（eval/stream/mini/run_mini.py 与 tui 入口）；`pi-runtime/upstream-version.ts` 以 `import.meta.resolve` 找上游包的 package.json。third_party/ 只在注释里引用（许可说明），运行时不读。上游 pi-ai 的模型数据以带 `type: "json"` 的 import 引入。

## 改法

- `src/state/package-paths.ts`：`FROM_BUNDLE` 由构建时的定义 `__PIGEON_BUNDLE__` 得知（源码运行时没有这个名字）；包根在源码运行时为本文件往上两层，打包产物运行时为产物所在目录的上一层（`packageRootUrl`、`packageFileUrl`）。上面五处随包文件改为按包根定位，源码运行时的结果不变。
- 上游版本探测：打包产物里取构建时写入的 `__PIGEON_UPSTREAM_VERSIONS__`（产物里用的就是构建时的版本），源码运行时照旧读安装目录。
- 入口：`src/bundle-entry.ts` 为产物入口，按环境变量 `PIGEON_BUNDLE_ROLE` 分派到终端界面或命令行（`takeBundleRole`，读后即删，不传给再起的进程）；命令行与终端界面两个 Actor 仍互不 import。`cli/index.ts` 与 `tui/main.ts` 导出 `main`，自身的"是否被直接运行"判断在打包产物里不生效。
- 终端界面子进程由入口决定（`tuiChildCommand`）：从源码启动的跑源码的 tui 入口；从打包产物启动的跑同一个产物，加 `--enable-source-maps`，带 `PIGEON_BUNDLE_ROLE=tui`。
- `pigeon --version`：输出包根下 package.json 的版本。
- `scripts/build-bundle.mjs`（`npm run bundle`，esbuild 0.28.2 作 devDependency）：以 `src/bundle-entry.ts` 为入口打成 `dist/pigeon-cli.mjs`（ESM 单文件，附 source map，不内嵌源码），另写启动器 `dist/pigeon.mjs`：先 `process.setSourceMapsEnabled(true)` 再加载产物。产物自己开 source map 时，它自己的栈帧不按源码行号显示（开之前已加载完），故用启动器。`--stream-fn` 的接入模块仍在运行时动态导入，不打进包。dist/ 已在 .gitignore 里。
- package.json 加 `bin.pigeon` 指向 `dist/pigeon.mjs` 与 `bundle` 脚本；开发与测试照旧直接跑源码。
- CI（`.github/workflows/ci.yml`）在 Verify 之后加一步：`npm run bundle && node scripts/bundle-smoke.mjs`。冒烟：`pigeon --version` 输出 package.json 的版本且没有告警；以仓库的 `createFakeStreamFn`（`scripts/smoke-stream-fn.ts`，从 node_modules 另加载一份 pi-ai）跑一次 `pigeon run`，退出码为 0 且假模型收到了第一个请求。临时目录作工作区与家目录。

产物：`dist/pigeon-cli.mjs` 4,555,041 字节，source map 2,751,731 字节，含源文件 1,411 个（src 下 224 个、依赖 1,186 个）；启动器 192 字节。

## 检查

- 终端界面：服务器上以伪终端从 `dist/pigeon.mjs` 启动，界面画出会话标题与状态行，收到 SIGINT 后退出码 0，没有留下进程。
- source map：经启动器加载的产物里，命令行入口报错时的栈帧显示为 `src/bundle-entry.ts` 的行列。

## 测试与变异

- `src/cli/tui-child.test.ts`（3 项）：源码启动时子进程跑源码的 tui 入口、不加环境变量；打包产物启动时子进程跑同一个产物、开 source map、带分派变量；`--version` 走版本分支。
- `src/state/package-paths.test.ts`（2 项）：源码运行时包根下有两份随包文件，产物路径的包根为其上一层；产物入口取角色与读后即删。
- 现有测试未改动。
- 变异（服务器，关键判定为入口按来源选子进程）：判定反过来 → 2 项变红；产物分支不带分派变量 → 1 项变红；产物分支跑源码入口 → 1 项变红；角色一律为命令行 → 1 项变红；角色读后不删 → 1 项变红；均还原后逐字一致。

## 前后测量

到第一个请求的时间（自进程启动起的毫秒，`node scripts/bundle-smoke.mjs --measure 5`：源码与打包产物交替各 5 次，假模型 `scripts/measure-stream-fn.mjs` 不加载仓库与上游模块）：

- 服务器 pigeon-verify（运行时无别的测试在跑）：源码中位 615（599–649），打包产物经启动器中位 234（232–236）。另直接运行 `dist/pigeon-cli.mjs`（不开 source map）5 次中位 209，开 source map 约多 25。
- Windows 本机：可用内存 2.84–2.95 GB，低于 3 GB，未量。

## verify 的实际运行情况

服务器 pigeon-verify（8 vCPU、31 GB 内存、Node 24.12.0），提交 d930471，一条前台命令依次跑完 `npm run lint`、`npm run check`、`node --test --test-concurrency=6 "src/**/*.test.ts"`（运行前无别的测试在跑）、`npm run deps`、`npm run bundle` 与 `node scripts/bundle-smoke.mjs`，全过，全程约 140 秒。测试 1,632 项：通过 1,630，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：576 个模块，无违规。

## 补记：验收修正

改法（提交 a85e6dd）：
- 构建戳：`scripts/build-bundle.mjs` 构建时按 `describeHead` 的口径（短提交号；`git status --porcelain` 非空即有未提交改动）取提交号与有无未提交改动，以 `__PIGEON_HARNESS_REF__` 写进产物；不在 git 仓库里构建时记 unknown。`eval/stream-harness.ts` 的 `currentHarnessRef` 从产物运行时用构建戳（dist 不入库，拉了新代码而没重新打包时包根的 HEAD 与在跑的代码对不上），从源码运行照旧读包根的 HEAD。`pigeon --version` 输出版本并带上这一项，如 `pigeon 0.0.0（提交 a85e6dd（无未提交改动））`。
- npm 打包：package.json 加 `files`（dist 下的启动器、产物与 source map，docker/，eval/stream/），`npm pack --dry-run` 列出的即这些文件与 package.json；加 `prepare`（`npm run bundle`），从 git 安装与 `npm ci` 时都会构建产物。服务器上 `npm ci` 连同这一步共约 3.9 秒，其中构建产物约 0.6 秒。
- 原 `build` 脚本（`tsc -p tsconfig.json`，输出到 dist）在 CI、文档、docker 与脚本里都没有用处，删去；tsconfig 改为只检查不输出（`noEmit`，去掉 rootDir、outDir、declaration、sourceMap），`include` 加 `scripts/**/*.ts`（`scripts/smoke-stream-fn.ts` 纳入 `npm run check`）。
- 冒烟：`pigeon --version` 经启动器与直接运行 `dist/pigeon-cli.mjs`（终端界面子进程即如此）各一次，须只输出一行、版本为 package.json 的版本、构建戳为当前提交、没有告警。
- `src/cli/tui-child.test.ts` 删去与 `spawn-worker-cli.test.ts` 重复的一条断言（tui 入口路径）。

反向验证（服务器）：去掉 `cli/index.ts` 里"是否被直接运行"判断前的 `!FROM_BUNDLE`，重新打包后冒烟失败（直接运行产物时入口执行两遍，`--version` 不止一行）；去掉 `tui/main.ts` 里同一判断，重新打包后冒烟同样失败；均还原后冒烟通过，没有留下进程。

已知限制（打包后仍从 node_modules 加载，或可能失败）：
- `src/mcp/transport.ts` 以变量说明符动态导入 MCP SDK 的 Streamable HTTP 传输，不打进产物，运行时从 node_modules 加载。
- pi-tui 的原生模块按 node_modules 定位，不打进产物。
- pi-ai 的 Bedrock 与 OAuth 线路以变量动态导入相对路径的模块，打包后会到 dist 下找而失败；Pigeon 目前走不到这两条线路。

verify：服务器 pigeon-verify，提交 a85e6dd，一条前台命令依次跑完 `npm run lint`、`npm run check`、`node --test --test-concurrency=2 "src/**/*.test.ts"`（运行前另有六个测试进程在跑）、`npm run deps`、`npm run bundle` 与 `node scripts/bundle-smoke.mjs`，全过，全程约 264 秒。测试 1,632 项：通过 1,630，失败 0，跳过 2（两项只在 Windows 上运行的用例）。deps：576 个模块，无违规。
