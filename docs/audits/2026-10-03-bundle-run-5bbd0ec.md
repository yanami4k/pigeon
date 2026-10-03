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
