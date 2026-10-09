# 跑批器移出仓库

基线：origin/main 头 bd3ea14。只提交不推送，未动任何标签。范围：把跑批器（`src/eval/`、`eval/` 与 `pigeon eval` 子命令）与早期探针脚本 `spikes/` 移出仓库，清掉随之不再被产品代码引用的部分；产品功能不变。

## 一、提交

| 提交 | 内容 |
|---|---|
| 37f1577 | 测试分档、随包文件与依赖规则里去掉跑批器相关项（含 CI、vitest、打包脚本注释） |
| 5b6bc67 | 删除 `src/eval/`、`eval/` 与 `pigeon eval` 子命令；借用跑批器常量的测试断言随之删除；两个产品用到的文件移位 |
| d939a68 | 删除 `spikes/`，去掉 biome 的排除项与 .gitignore 的对应一行 |
| c0bd25b | 删除随之不再被引用的产品代码（见四） |
| 40f41d9 | 改写代码注释里指向已删路径与跑批网关的说法（无行为变化） |
| 22b59b6 | 文档：删跑批器的段落，路线图与探针笔记加"已移出"标注 |

## 二、删除的文件

共删除 170 个文件，另有 2 个文件移位。

| 目录 | 类别 | 文件数 |
|---|---|---|
| `src/eval/` | 源码模块 | 29 |
| | 测试 | 32 |
| | 测试夹具（4 个 `*fixtures.ts`，`stream-fixtures/` 下 4 个文件） | 8 |
| `eval/analysis/` | 分析包 `pigeon_analysis` | 21 |
| | 测试（含夹具 1 个） | 16 |
| | 数据 | 2 |
| | 包配置与说明（`.gitignore`、`README.md`、`pytest.ini`、`requirements.txt`） | 4 |
| `eval/stream/` | 最简 agent 的启动脚本与其测试 | 2 |
| | 镜像构建文件与工具（2 个镜像目录） | 5 |
| `spikes/` | 探针脚本与夹具（顶层 19、`tui-acc/` 19、`spike-pi-tui/` 4、`mcp-acc/` 4、`ledger-migration/` 2、`spike-before-tool-call/` 1、`spike-pi-transcript/` 1） | 50 |
| `src/pi-runtime/` | `gateway-stream.ts`（死代码，见四） | 1 |

移位（内容为产品在用，随目录删除会丢）：

- `src/eval/stream-harness.ts` → `src/application/harness-ref.ts`：`pigeon --version` 输出的代码版本（`HarnessRef`、`describeHarness`、`currentHarnessRef`），逻辑不变；原在跑批器测试里的形状用例移到 `harness-ref.test.ts`，另补写法用例。
- `src/eval/model-pricing.test.ts` → `src/state/model-pricing.test.ts`：测的是保留的 `src/state/model-pricing.ts`（会话花费在用），只改导入路径。

## 三、命令行

- 删除 `pigeon eval stream`、`stream-baseline`、`stream-manifest`、`stream-rejudge`、`stream-image-context` 五个子命令的入口函数、参数解析、用法串与注释，顶层帮助去掉对应一行，子命令集合去掉 `eval`；只为它们存在的常量 `STREAM_CONTAINER_MEMORY` 一并删除。`pigeon eval …` 现按终端界面的未知参数报错。
- `cli/index.ts` 随之不用的导入（`writeFileSync`、`repetitionGuardSettings`、`truncationContinuationSettings` 与全部 `../eval/*`）删除。
- `pigeon run` 的 `--governance-root`、`--json`、`--thinking` 等启动参数不变；`dist/deepseek-stream-fn.mjs` 照旧打包。

## 四、随之删除的死代码

判定方法：删完上述目录与子命令后，用 TypeScript 语言服务逐个查 `src/` 下非测试模块的每个导出被哪些文件引用，删前删后对比；只剩跑批器或测试在用的删除，产品代码在用或文档写成使用者功能的保留。另从入口（`src/bundle-entry.ts`、`src/cli/index.ts`、`src/tui/main.ts`、`src/pi-runtime/deepseek-stream-fn.ts` 与 `scripts/`）按导入求可达，没有新增不可达的模块。

- `src/pi-runtime/gateway-stream.ts`（经跑批网关的模型接入）及 `pi-runtime/index.ts` 的五个转口：`DEFAULT_GATEWAY_MODEL_ID`、`GATEWAY_PLACEHOLDER_KEY`、`GATEWAY_PROVIDER`、`GATEWAY_UPSTREAM_BASE_URL`、`gatewayStreamFn`。
- `--temperature` 启动参数（只有跑批入口打开接受它）：`LaunchFlags.temperature`、`ParseLaunchFlagsOptions.temperature` 与解析分支，及其测试。运行面本身的温度选项保留，见五。
- 只进跑批身份头的版本常量：`STATUS_BLOCK_VERSION`（`application/status-block.ts`）、`SESSION_SEARCH_VERSION`（`memory/session-search.ts`）、`TRUNCATION_CONTINUATION_VERSION`（`state/runaway-config.ts`）。
- `memory/learned-store.ts` 的 `memoryFileFacts`（跑批结果行的记忆口径）。
- `execution/container-host.ts` 的 `trustedShell` 改为模块内私有（只剩本模块调用）。
- `pi-runtime/deepseek-model.ts` 的 `deepseekModelInfo` 去掉只有网关传的 `modelId`、`maxTokens` 两个参数与"输出上限不为正不声明"的分支；无参调用的结果不变。
- 测试：只删与跑批器相关的断言，产品行为的断言保留。
  - `orchestration-wiring.test.ts`、`runtime-web-tools.test.ts`：删跑批条件循环与跑批常量断言；`pigeon run` 的工具注册断言保留。
  - `script-wiring.test.ts`：跑批条件循环改为直接断言"脚本编排关着时不注册提交脚本的工具"。
  - `deepseek-stream.test.ts`：删两条网关用例与签名用例的网关一半；自带接入的断言保留（模型对象没有上限按 32,000 发，另由 `output-limit.test.ts` 把守）。
  - `runtime-model-info.test.ts`：删网关声明一段。`runtime-thinking.test.ts`：缺省开思考、off 时发温度一条改经自带 DeepSeek 接入与入口模块声明的模型信息跑。
  - `spawn-worker-cli.test.ts`：子命令清单去掉 `eval`。`sampling-e2e.test.ts`：删 `--temperature` 参数用例。
- 配置与脚本：`.dependency-cruiser.js` 的 `eval-below-actors` 规则与 `boundary-rules.test.ts` 的对应用例；`scripts/test-tiers.mjs` 的 `src/eval` 慢档项；`package.json` `files` 的 `eval/stream/`；`scripts/build-bundle.mjs` 的注释（随包文件、`deepseek-stream-fn` 的用途）与构建输出文字；`biome.json` 的 `!spikes`；`.gitignore` 的 spikes 一行；`vitest.config.ts` 与 CI 各一处注释。vitest 配置里没有只为跑批器的设置，CI 里没有跑批器的步骤。
- 注释：18 个文件里指向 `src/eval`、`eval/`、`spikes/` 与跑批网关的注释改写，无行为变化。
- 文档：`docs/configuration.md` 删"跑批器的网关留存与高峰暂停"一节与跑批器参数、身份头的说明句；`docs/testing.md` 慢档说明改写；`docs/roadmap/README.md` 目录表一行；`ROADMAP.md` 相关条目加"已于 2026-10-09 移出仓库"的标注，未删历史条目；`docs/spikes/` 三份笔记的复现脚本行加同样标注。`docs/audits/`、`decisions.md` 与两份预注册未改。仓库里没有入库的 README 与 AGENTS.md。

## 五、保留的拿不准项

1. `runHeadless` 的若干进程内可选项现在没有产品入口传入：`temperature`、`taskDirective`、`memoryLayers`、`abortSignal`、`maxTokens`、`skillRoots`、`agentsMd`、`homeDir`、`truncationContinuation`、`repetitionGuard`、`backgroundCloseoutSeconds`、`memoryLimits`。它们属进程内运行 API，温度在 `docs/configuration.md` 写有行为（Run 开始条目记"请求了但未生效"），会话记录里的相应字段要能读旧数据；未删。
2. `sandbox-docker.test.ts` 与 `hook-runner.test.ts` 找测试镜像时，最后退到本机已有的 `pigeon-stream-pigeon:v4`（原由已删的镜像构建文件构建）；只在本机有该镜像时用，未改。
3. `ROADMAP.md` §2 第 3 条"上游升级后重跑 beforeToolCall 与 transcript 两个 spike"的脚本已移出仓库，规则文字未改，只加标注。
4. 以下导出此前另有跑批器在用，现只在本模块与测试里用，保留导出：`TIMEOUT_PROBE_SCRIPT`、`MEMORY_CONFLICT_TEXTS`、`sessionFileName`、`DEFAULT_LOOP_GUARD_SETTINGS`、`DEFAULT_REPETITION_GUARD`、`DEFAULT_TRUNCATION_CONTINUATION`、`WIDE_REPETITION_PARAMS`、`isPeakAt`、`PEAK_MULTIPLIER`、`CN_PUBLIC_HOLIDAYS`、`CN_ADJUSTED_WORKDAYS`；`DEFAULT_MEMORY_LIMITS` 与 `DEFAULT_BACKGROUND_CLOSEOUT_SECONDS` 只在本模块用，与同组缺省常量一样保留导出。
5. 代码注释里另有 59 行（27 个文件，其中测试 10 行）以"跑批器"说明某项缺省取值的来由（如"跑批器各条件关掉"），不指向已删路径，未改。

## 六、验证

本机 Windows，Node 24.12.0，npm 11.6.2，均在提交 22b59b6 上：

- `npm ci` 成功（含 prepare 打包）。
- `npm run check` 通过；`npm run lint` 通过（581 个文件）；`npm run deps` 通过（601 个模块、4550 条依赖，无违规）。
- `npm run bundle` 成功；`node dist/pigeon.mjs --version` 输出 `pigeon 0.0.0（提交 22b59b6（无未提交改动））`；`node scripts/bundle-smoke.mjs` 通过；`pigeon eval stream` 按未知参数报错。
- 快档（`TEST_CONCURRENCY=2 npm test`）：294 个文件、1513 条用例，1454 过、57 跳、2 败。两败在基线 bd3ea14 的源码上本机同样失败，与本次改动无关：`container-round-trips.test.ts` 一条（本机无建符号链接的权限，EPERM）；`checkpoints-async.test.ts`"保留修改时间的同长度覆盖"一条。
- 慢档未跑；其中改过的 `spawn-worker-cli.test.ts` 本机单跑 8 过 1 跳。
- 残留引用：`git grep` 查 `src/eval`、`eval/`、`spikes/`、`pigeon eval`（排除 `docs/audits/`、`decisions.md` 与两份预注册）：代码、配置与脚本无命中；余下命中在 `ROADMAP.md` 的历史条目（16 行，均在已标注移出或已退役的段落里）与 `docs/spikes/` 三份笔记的复现脚本行（4 行，已标注）。

## 七、回报

工程提交 37f1577…22b59b6 共 6 个，审计另成一提交：docs/audits/2026-10-09-remove-eval-runner-bd3ea14.md。删 170 个文件：src/eval 69（源码 29、测试 32、夹具 8）、eval/ 50、spikes/ 50、gateway-stream.ts 1；移位 2 个（代码版本取法、计价测试）。死代码：网关接入与 5 个转口、--temperature 参数、3 个身份版本常量、memoryFileFacts，trustedShell 改私有，deepseekModelInfo 去参数。拿不准而保留：runHeadless 无入口传入的可选项、两处测试回退旧实验镜像、探针重跑规则、只剩测试用的导出、59 行说明性注释。本机：check、lint、deps、bundle、--version、打包冒烟通过；快档 1454 过、57 跳、2 败，两败在基线同样失败、与本次无关；慢档未跑。
