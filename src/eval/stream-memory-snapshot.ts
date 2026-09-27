// 记忆快照（决策 191）：每一步开工前，把作业目录（治理根）下的 .pigeon/learned/ 整体复制为该步的快照；这一步作废重做、
// 或进程死在这一步中途之后续跑时，先把记忆恢复成这份快照，再重做这一步。第 N 步的快照即第 N-1 步完成时的记忆，
// 同一步已有快照就只恢复、不重取。记忆文件本身的格式与写入另行施工，这里只做通用的目录复制与恢复
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

export function learnedDirOf(jobDir: string): string {
  return path.join(jobDir, ".pigeon", "learned");
}

export function learnedSnapshotOf(jobDir: string, seq: number): string {
  return path.join(jobDir, "learned-snapshots", `step-${seq}`);
}

// 第 seq 步开工前调用：还没有这一步的快照即取一份（记忆目录不在也取，快照里就没有 learned/），返回 "taken"；
// 已有即把记忆目录恢复成它（先删掉现有的，快照里有 learned/ 再复制回来），返回 "restored"
export function snapshotOrRestoreLearned(jobDir: string, seq: number): "taken" | "restored" {
  const learned = learnedDirOf(jobDir);
  const snapshot = learnedSnapshotOf(jobDir, seq);
  if (existsSync(snapshot)) {
    rmSync(learned, { recursive: true, force: true });
    const saved = path.join(snapshot, "learned");
    if (existsSync(saved)) cpSync(saved, learned, { recursive: true });
    return "restored";
  }
  // 先写到临时目录再改名：取到一半进程被杀，不会留下半份快照被当作完整的恢复
  const tmp = `${snapshot}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  if (existsSync(learned)) cpSync(learned, path.join(tmp, "learned"), { recursive: true });
  renameSync(tmp, snapshot);
  return "taken";
}

// 每步开工时的记忆大小（202、223）：MEMORY.md 的字节数、条目数（以"- [L编号]"开头的行，229 的条目格式）与条目部分的
// 字符数（从第一条起到文件尾，文件头不计；按 Unicode 码点数）。文件不在记 0
export function memoryFactsOf(jobDir: string): {
  bytes: number;
  entries: number;
  entryChars: number;
} {
  const file = path.join(learnedDirOf(jobDir), "MEMORY.md");
  if (!existsSync(file)) return { bytes: 0, entries: 0, entryChars: 0 };
  const raw = readFileSync(file);
  const text = raw.toString("utf8");
  const first = text.search(/^- \[L\d+\]/m);
  return {
    bytes: raw.length,
    entries: (text.match(/^- \[L\d+\]/gm) ?? []).length,
    entryChars: first < 0 ? 0 : [...text.slice(first)].length,
  };
}
