// 测试分档清单（决策 370）。慢档 = 下面列出的测试文件；快档 = src/**/*.test.ts 里其余全部。
// npm run test 只跑快档、npm run test:slow 只跑慢档；npm run verify 用快档（开发中的快速检查），
// npm run verify:full 与 CI 跑两档——交付与合并前必须跑 verify:full（见 docs/testing.md）。
// 用清单而不用命名约定：每一项旁边写得下理由，文件不必改名。新增或改动的测试文件在验证服务器上单独跑
// （node scripts/test-timing.mjs --concurrency 1 <文件>）超过 10 秒的，须先设法减重，减不下来再加进这里并写明理由。
export const SLOW_TESTS = [
  {
    pattern: "src/eval/**/*.test.ts",
    reason:
      "跑批器与实验装置（出题、人的基准、跑批、模型网关、报告）：多数用例真跑 git 与假容器，" +
      "部分用实验镜像起真容器",
  },
  {
    pattern: "src/cli/spawn-worker-cli.test.ts",
    reason:
      "端到端：在 pigeon run 子进程里派 worker、等并行完成、合并分支，每条用例冷启动一次 CLI 子进程",
  },
  {
    pattern: "src/execution/container-host.test.ts",
    reason:
      "含真容器层：对着真容器验超时杀干净、退出码、输出截断与路径映射，起停容器与等超时占大头",
  },
  {
    pattern: "src/execution/hook-runner.test.ts",
    reason: "含超时杀整棵进程树与经真容器执行钩子的用例：等超时、起停容器占大头",
  },
  {
    pattern: "src/execution/sandbox-docker.test.ts",
    reason:
      "真容器：日常沙箱起停容器，并在容器里联网装新旧两版 pnpm 核对 store 位置，下载与安装占大头",
  },
];
