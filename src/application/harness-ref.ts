// Pigeon 自身的代码版本：pigeon --version 输出版本时带上这一项（构建戳或包根的 HEAD）
import { fileURLToPath } from "node:url";
import { describeHead } from "../orchestration/worktree.ts";
import { packageFileUrl } from "../state/package-paths.ts";

// 代码版本：Pigeon 仓库 HEAD 短号与是否有未提交改动
export interface HarnessRef {
  commit: string;
  dirty: boolean;
}

// 输出里的写法：提交号与是否有未提交改动
export function describeHarness(ref: HarnessRef | undefined): string {
  return `提交 ${ref?.commit ?? "unknown"}（${ref?.dirty === true ? "有" : "无"}未提交改动）`;
}

// 打包产物（决策 351）的构建戳：构建时的提交号与有无未提交改动（源码运行时没有这个名字）
declare const __PIGEON_HARNESS_REF__: HarnessRef | undefined;

// 本源码所在仓库（Pigeon）的版本；读不到时如实记 unknown。从打包产物运行时取构建戳：dist 不入库，拉了新代码而没重新打包时，
// 包根的 HEAD 与在跑的代码对不上
export function currentHarnessRef(): HarnessRef {
  if (typeof __PIGEON_HARNESS_REF__ !== "undefined") {
    return { ...__PIGEON_HARNESS_REF__ };
  }
  try {
    return describeHead(fileURLToPath(packageFileUrl("./")));
  } catch {
    return { commit: "unknown", dirty: false };
  }
}
