// Pigeon 自身的版本（原外部基准 runner 的写法，决策 205 随旧跑批退役搬到提交流）：身份头与结果行都记它。
// 单独成一个叶子模块，身份头、结果行与跑批器都只依赖它、互不成环
import { fileURLToPath } from "node:url";
import { describeHead } from "../orchestration/worktree.ts";

// harness 版本：Pigeon 仓库 HEAD 短号与是否有未提交改动
export interface HarnessRef {
  commit: string;
  dirty: boolean;
}

// 报错与报告里的写法：提交号与是否有未提交改动
export function describeHarness(ref: HarnessRef | undefined): string {
  return `提交 ${ref?.commit ?? "unknown"}（${ref?.dirty === true ? "有" : "无"}未提交改动）`;
}

// 本源码所在仓库（Pigeon）的版本；读不到时如实记 unknown
export function currentHarnessRef(): HarnessRef {
  try {
    return describeHead(fileURLToPath(new URL(".", import.meta.url)));
  } catch {
    return { commit: "unknown", dirty: false };
  }
}
