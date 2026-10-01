// 测试夹具：文件清单跳过工作区根下治理目录（.pigeon）的场景，本地与容器执行端的用例共用。只供测试使用。
// 命令执行期间：治理目录里的会话文件被追加、新建记忆文件；工作区别处新增、修改、删除；子目录里名为 .pigeon 的普通
// 文件夹新增与修改。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHURN_SCRIPT = `import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
appendFileSync(".pigeon/state/sessions/s.jsonl", "{}\\n");
mkdirSync(".pigeon/state/learned", { recursive: true });
writeFileSync(".pigeon/state/learned/MEMORY.md", "- fact\\n");
writeFileSync("b.txt", "b\\n");
appendFileSync("a.txt", "more\\n");
rmSync("gone.txt");
writeFileSync("sub/.pigeon/new.txt", "new\\n");
appendFileSync("sub/.pigeon/keep.txt", "more\\n");
`;

// 执行前文件清单应列出的全部路径（排好序）
export const CHURN_LISTED_BEFORE = ["a.txt", "gone.txt", "sub/.pigeon/keep.txt"];

// 执行后 run_command 应报出的文件变化
export const CHURN_FILE_CHANGES = {
  added: ["b.txt", "sub/.pigeon/new.txt"],
  removed: ["gone.txt"],
  modified: ["a.txt", "sub/.pigeon/keep.txt"],
  truncated: false,
};

// 在 root 下布好执行前的文件；返回造成上述变化的 run_command 命令串（node 执行放在工作区外的脚本）与清理函数
export function seedGovernanceChurn(root: string): { command: string; cleanup: () => void } {
  mkdirSync(join(root, ".pigeon", "state", "sessions"), { recursive: true });
  mkdirSync(join(root, "sub", ".pigeon"), { recursive: true });
  writeFileSync(join(root, ".pigeon", "state", "sessions", "s.jsonl"), "{}\n");
  writeFileSync(join(root, "sub", ".pigeon", "keep.txt"), "keep\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "gone.txt"), "gone\n");
  const dir = mkdtempSync(join(tmpdir(), "pigeon-listing-script-"));
  const script = join(dir, "churn.mjs");
  writeFileSync(script, CHURN_SCRIPT);
  return {
    command: `"${process.execPath}" "${script}"`,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  };
}
