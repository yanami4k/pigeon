// 记忆快照（决策 191、332）：每一步开工前，把作业目录（治理根）下项目级学到的记忆 .pigeon/state/memory.md 复制为该步的
// 快照；这一步作废重做、或进程死在这一步中途之后续跑时，先把记忆恢复成这份快照，再重做这一步。第 N 步的快照即第 N-1 步
// 完成时的记忆，同一步已有快照就只恢复、不重取。跑批器只推项目级记忆（不读使用者的用户级记忆）；决策 331 起无人值守的
// 入口不写记忆，记忆文件此后没有写入方，快照照常取（多半为空），以便以后接回写入方时口径不变
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { memoryFileFacts } from "../memory/learned-store.ts";
import { projectMemoryPathOf } from "../state/paths.ts";

const SNAPSHOT_FILE = "memory.md";

export function memoryFileOf(jobDir: string): string {
  return projectMemoryPathOf(jobDir);
}

export function memorySnapshotOf(jobDir: string, seq: number): string {
  return path.join(jobDir, "memory-snapshots", `step-${seq}`);
}

// 第 seq 步开工前调用：还没有这一步的快照即取一份（记忆文件不在也取，快照里就没有它），返回 "taken"；
// 已有即把记忆文件恢复成它（先删掉现有的，快照里有再复制回来），返回 "restored"
export function snapshotOrRestoreMemory(jobDir: string, seq: number): "taken" | "restored" {
  const file = memoryFileOf(jobDir);
  const snapshot = memorySnapshotOf(jobDir, seq);
  if (existsSync(snapshot)) {
    rmSync(file, { force: true });
    const saved = path.join(snapshot, SNAPSHOT_FILE);
    if (existsSync(saved)) {
      mkdirSync(path.dirname(file), { recursive: true });
      copyFileSync(saved, file);
    }
    return "restored";
  }
  // 先写到临时目录再改名：取到一半进程被杀，不会留下半份快照被当作完整的恢复
  const tmp = `${snapshot}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  if (existsSync(file)) copyFileSync(file, path.join(tmp, SNAPSHOT_FILE));
  renameSync(tmp, snapshot);
  return "taken";
}

// 每步开工时的记忆大小（202、223）：记忆文件的字节数、条目数与条目部分的字符数（文件头不计；按 Unicode 码点数），
// 用记忆模块的同一份解析（memory/learned.ts），与推送段、记忆工具的口径一致。文件不在记 0
export function memoryFactsOf(jobDir: string): {
  bytes: number;
  entries: number;
  entryChars: number;
} {
  return memoryFileFacts(memoryFileOf(jobDir));
}
