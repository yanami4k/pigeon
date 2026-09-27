// 双写对照的命令行入口（决策 180 / 206）：对一个治理根下的会话逐个比对旧账本与新存储，输出差异清单。
// 比对逻辑在 src/persistence/dual-write-compare.ts（当前覆盖消息、Run 开始与收尾、验证记录）。
//
// 用法：node spikes/ledger-migration/compare-dual-write.ts <治理根> [会话号...] [--no-thinking]
//   不给会话号即比对旧账本里的全部会话；--no-thinking 对应运行时关了思考持久化的会话。
import path from "node:path";
import { listSessionIds } from "../../src/persistence/event-log.ts";
import { compareDualWrite } from "../../src/persistence/dual-write-compare.ts";

const args = process.argv.slice(2);
const noThinking = args.includes("--no-thinking");
const [root, ...ids] = args.filter((arg) => arg !== "--no-thinking");
if (root === undefined) {
  process.stderr.write(
    "用法：node spikes/ledger-migration/compare-dual-write.ts <治理根> [会话号...] [--no-thinking]\n"
  );
  process.exit(2);
}
const sessionsDir = path.join(path.resolve(root), ".pigeon", "sessions");
const targets = ids.length > 0 ? ids : listSessionIds(sessionsDir);
let withDiffs = 0;
for (const sessionId of targets) {
  const result = compareDualWrite({
    sessionsDir,
    sessionId,
    ...(noThinking ? { content: { persistThinking: false } } : {}),
  });
  const { messages, runs, verifications } = result.counted;
  process.stdout.write(
    `${sessionId}：消息 ${messages}、Run ${runs}、验证 ${verifications}，差异 ${result.diffs.length}\n`
  );
  for (const diff of result.diffs) {
    process.stdout.write(`  [${diff.area}] ${diff.where}：${diff.detail}\n`);
  }
  if (result.diffs.length > 0) withDiffs += 1;
}
process.stdout.write(`共 ${targets.length} 个会话，${withDiffs} 个有差异\n`);
process.exitCode = withDiffs > 0 ? 1 : 0;
