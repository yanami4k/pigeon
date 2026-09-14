// 剧本 E 准备：生成 ws-e 大文件（hashline 编辑的 intent→receipt 窗口靠文件体量撑开）
import { mkdirSync, writeFileSync } from "node:fs";

const root = "tmp/tui-acc/ws-e";
mkdirSync(root, { recursive: true });

const lines = ["line 1"];
const filler = "filler xxxxxxxx";
// 约 150MB：6_000_000 行 × ~26B
for (let i = 2; i <= 6_000_000; i++) {
  lines.push(`${filler} ${i}`);
}
writeFileSync(`${root}/big.txt`, lines.join("\n") + "\n", "utf8");
console.log("big.txt written");
