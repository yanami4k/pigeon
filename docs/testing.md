# 测试规矩

本文是写测试与改测试时的约定（决策 370）。测试框架是 Vitest（决策 369），写法见"框架与写法"一节。

## 写什么、写在哪一层

1. **测行为与契约**：输入、输出、可观察的副作用（落盘的内容、发出的请求、退出码、屏幕上的关键行）。
   不测实现细节，不为了覆盖率去碰私有结构。
   - 工具说明、报错、系统提示等文案只测关键结构或关键片段，例如某个参数名在、某条约束在、某个数值算对了；不整段逐字比对。
     期望值能由产品常量或模板函数生成的，直接用常量或函数，不在测试里抄一遍原文。
   - 经项目负责人定稿的原文（产品代码里标"定稿原文"的说明与返回文字），每一段至多保留一处逐字检查，
     集中在该工具自己的单元测试里；别处只测片段。
2. **一个行为只在最合适的一层测**：逻辑在单元层；装配层（装配根、运行面）一条冒烟，证明接上了；
   端到端只测关键路径。同一断言已在下层测过的，上层不再重复。
3. **变异反向验证只留给关键判定**：安全、数据完整、计费、隔离。做法是去掉判定，确认相应用例精确变红，
   再还原并核对文件逐字一致。其余判定不做变异验证。
4. **测试量以不超过产品代码为目标**：新代码的测试行数不超过它所测的产品代码行数。超出时先看是否有重复的层或重复的情形。
5. **真容器用例只测容器特有的行为**：挂载、权限、网络隔离、超时杀进程、镜像里的工具链等。
   与容器无关的逻辑用替身执行端在单元层测。没有 Docker 或镜像时跳过并写明原因。
6. **单个测试文件超过 10 秒须说明理由，并归入慢档**：先设法减重（共用夹具、缩小规模、把逻辑挪到单元层）；
   减不下来再加进慢档清单 `scripts/test-tiers.mjs`，在清单里写明理由。量法见下。

另外几条随手要守的：

- 已删除的功能不留"它不存在了"的测试；读旧数据的兼容（旧会话、旧结果行能照常读出）是现行行为，照常测。
- 等待异步条件用轮询加上限（例如 `until`），上限只决定真失败时多久报出来，取宽（十几秒），不要用它卡时序。
- 测试失败不能让进程挂住：子进程、定时器、终端与连接在 `finally`、`onTestFinished` 或 `afterAll` 里收掉。

## 框架与写法（Vitest）

- 引入：`import { afterAll, beforeAll, describe, it, test, vi } from "vitest"`（按需）。断言用 `node:assert/strict`
  或 Vitest 的 `expect` 都可以，同一个文件里统一用一种。迁移前的测试一律是 `node:assert/strict`，迁移时没有改写。
- 按平台或环境跳过：`test.skipIf(条件)(名称, fn)`，`describe.skipIf` 同理。条件写成"原因字符串或 false"
  （例如 `process.platform === "win32" ? "Windows 上没有 /bin/sh" : false`），原因留在代码里。
  运行中才知道要跳过的，在测试里调 `t.skip("原因")`：它会立即中止这个测试，原因出现在报告里。
- 运行中补一句说明（例如某一种后端本机没有、这一项未测）：`await t.annotate("…")`。
- 打桩：`vi.spyOn(对象, "方法").mockImplementation(…)`，用完 `mockRestore()`。
- 组内并发：`describe.concurrent(名称, fn)`，组内同时跑的上限见 `vitest.config.ts` 的 `maxConcurrency`。
- 超时：配置里单个测试与钩子的上限都是 10 分钟（node:test 原本不限时）；需要更紧的上限，在测试上给 `{ timeout }`。
- 编译方式：Vitest 经 Vite 转译测试文件与被测代码，产品运行时由 Node 原生剥类型，两者处理语法的方式不同
  （Vite 能转译 Node 剥类型不支持的写法）。类型与语法的把关以 `npm run check`（tsc，`erasableSyntaxOnly`）为准：
  测试通过不等于产品能在 Node 下原样运行。
- 隔离：每个 worker 是独立的子进程（forks 池），同一 worker 先后跑的测试文件之间不隔离，共用模块缓存与进程状态
  （比每个文件隔离快约三成；不做第三方依赖预打包，原因见 `vitest.config.ts` 的注释）。因此新写的测试不要依赖
  进程级的全局状态（环境变量、当前目录、模块级单例、全局打桩），要用就在测试里改、在 `finally` 或 `afterAll` 里还原。
  怀疑某个失败是串扰（单独跑这个文件能过、和别的文件一起跑才挂）时，用 `PIGEON_TEST_ISOLATE=1 npm run test:slow`
  这样设上环境变量切回每个文件隔离复查，或加 `--sequence.shuffle.files` 打乱文件顺序看能否复现。

## 快档与慢档

测试分两档，划分写在 `scripts/test-tiers.mjs` 的清单里（用清单而不是命名约定：每一项旁边写得下理由，文件不必改名；
清单里某一项匹配不到文件时，跑测试的脚本直接报错，免得清单悄悄失效）。

- **慢档**：`src/eval` 下的全部测试（跑批器与实验装置），加上清单里列出的、单独跑超过 10 秒的其他测试文件
  （它们测的是 `src/execution`、`src/cli` 等处的代码；慢档的 eval 测试也会跑到 application 层的代码）。
- **快档**：其余全部。

| 命令 | 跑什么 |
|---|---|
| `npm run test` | 快档 |
| `npm run test:slow` | 慢档 |
| `npm run verify` | lint + check + 快档 + deps（开发中的快速检查） |
| `npm run verify:full` | lint + check + 快档与慢档 + deps（交付与合并前必跑） |

- **交付与合并前必须跑 `npm run verify:full`**，不论改了哪个目录：慢档里的文件覆盖的不只是 `src/eval`。
  `npm run verify` 只用于开发中的快速检查，不能代替交付前的全量验证。
- CI（`.github/workflows/ci.yml`）在推送 main 与每个 PR 时跑 `npm run verify:full`。本地合并后直推 main 时，
  CI 在推送之后才跑，因此合并前的全量验证由交付者自己跑 `verify:full`。
- 测试步的并发数（Vitest 的 worker 数）用环境变量 `TEST_CONCURRENCY` 给，例如
  `TEST_CONCURRENCY=6 npm run verify:full`。
- 只跑某几个测试文件：`npm run test -- <文件或 glob…>`（给了文件就只跑这些，不分档；例如
  `npm run test -- src/tui/script-ui.test.ts`）。其余以 `-` 开头的参数原样交给 `vitest run`，例如按名称筛选
  `npm run test -- -t 审批`。
- 真容器用例与全量验收在验证服务器上跑；本机只跑改动涉及的单个文件。

## 覆盖率与基准

- `npm run coverage`：两档全部测试带 v8 覆盖率跑一遍，报告写到 `coverage/`（不入库）。不进 verify。
- `npm run bench`：跑 `src/**/*.bench.ts` 的基准，守这一轮的性能改动不退回。不进 verify，单独运行；
  比较前后数字时在同一台机器上、负载相近时跑。

## 量具

- `node scripts/test-timing.mjs [--concurrency N] [--out 结果.json] [文件或 glob…]`：跑一次 Vitest（JSON 报告），
  记每个测试文件的墙钟、测试项数与每个测试的耗时，打印最慢的文件。判断一个文件是否超过 10 秒，在验证服务器上用
  `--concurrency 1` 单独量。
- `node scripts/test-coverage.mjs [--concurrency N] [--module 路径前缀…] [文件或 glob…]`：逐文件跑 Vitest 的 v8 覆盖率，
  算出每个文件独有覆盖的产品代码行与指定模块的行覆盖率。独有行为 0 只是"删了也不影响覆盖"的候选：
  同样的行可能断言着不同的行为，删或合并之前要逐条确认它测的行为在别处已经测过。
