// 读者对照的命令行入口（决策 180 / 206，账本重构第二段）：对一个治理根下的会话逐个比较判定、续跑与分叉类读者的旧读法
// （物化旧账本）与新读法（读新会话存储），输出差异清单；预期差异带原因，未预期差异以非零退出码报出。
// 比较逻辑在 src/application/reader-compare.ts。
//
// 用法：node spikes/ledger-migration/compare-readers.ts <治理根> [会话号...] [--sources <会话号,...>]
//   不给会话号即比较新存储里的全部会话；--sources 给出可能承载验证记录的其他会话（worker 尝试的验证落在父会话里）。
import path from "node:path";
import { compareReaders } from "../../src/application/reader-compare.ts";
import { listSessionFiles } from "../../src/persistence/session-reader.ts";

const args = process.argv.slice(2);
const sourcesAt = args.indexOf("--sources");
const sources = sourcesAt >= 0 ? (args[sourcesAt + 1] ?? "").split(",").filter(Boolean) : [];
const positional = sourcesAt >= 0 ? args.filter((_, i) => i !== sourcesAt && i !== sourcesAt + 1) : args;
const [root, ...ids] = positional;
if (root === undefined) {
  process.stderr.write(
    "用法：node spikes/ledger-migration/compare-readers.ts <治理根> [会话号...] [--sources <会话号,...>]\n"
  );
  process.exit(2);
}
const sessionsDir = path.join(path.resolve(root), ".pigeon", "sessions");
const targets =
  ids.length > 0 ? ids : [...new Set(listSessionFiles(sessionsDir).map((file) => file.sessionId))];
let unexpected = 0;
for (const sessionId of targets) {
  const result = compareReaders({
    sessionsDir,
    sessionId,
    options: { verificationSources: sources },
  });
  const surprising = result.diffs.filter((diff) => diff.expected === undefined).length;
  process.stdout.write(
    `${sessionId}：比较 ${result.checked} 项，差异 ${result.diffs.length}（未预期 ${surprising}）\n`
  );
  for (const diff of result.diffs) {
    process.stdout.write(
      `  [${diff.area}] ${diff.where}：旧 ${JSON.stringify(diff.old)} ｜ 新 ${JSON.stringify(diff.new)}` +
        `${diff.expected !== undefined ? `（预期：${diff.expected}）` : ""}\n`
    );
  }
  if (surprising > 0) unexpected += 1;
}
process.stdout.write(`共 ${targets.length} 个会话，${unexpected} 个有未预期差异\n`);
process.exitCode = unexpected > 0 ? 1 : 0;
