// 在工作区根运行本任务的隐藏验证测试，按测试进程退出码判定成败
import { spawnSync } from "node:child_process";

const TASK_ID = "args-summary-surrogate";
const ASSET = "src/application/summarize-args.eval.test.ts";

const result = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ASSET], {
  cwd: process.cwd(),
  stdio: "inherit",
});
const status = typeof result.status === "number" ? result.status : 1;
console.log(JSON.stringify({ task: TASK_ID, status }));
process.exit(status);
