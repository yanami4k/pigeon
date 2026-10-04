// 脚本编排的主目录快照（决策 311）：本次脚本开跑时拍一张（做法同 279 的工作目录快照），整次脚本共用，挂在
// refs/pigeon/scripts/<运行号> 上保留到本次脚本收回或放弃为止；工作目录没有未提交改动时起点即 HEAD，同样挂上引用
// （续跑沿用开跑时的起点，HEAD 之后移动也不影响）。续跑时按运行号读回。
import { execFileSync } from "node:child_process";
import { hardenedGitArgs } from "../tools/git-hardening.ts";
import {
  deleteSnapshotRef,
  readSnapshotRef,
  SNAPSHOT_REF_ROOT,
  snapshotWorkdir,
  WorkdirSnapshotError,
} from "./workdir-snapshot.ts";

export interface ScriptSnapshotPoint {
  commit: string;
  snapshot: boolean;
  files: string[];
  ref: string;
}

export function scriptSnapshotRef(runId: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(runId)) {
    throw new WorkdirSnapshotError(`脚本运行号不合法：${runId}`);
  }
  return `${SNAPSHOT_REF_ROOT}scripts/${runId}`;
}

export function takeScriptSnapshot(repoRoot: string, runId: string): ScriptSnapshotPoint {
  const ref = scriptSnapshotRef(runId);
  const snap = snapshotWorkdir({ repoRoot, ref });
  if (!snap.snapshot) {
    execFileSync("git", [...hardenedGitArgs(repoRoot), "update-ref", ref, snap.commit], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return { commit: snap.commit, snapshot: snap.snapshot, files: snap.files, ref };
}

export function readScriptSnapshot(
  repoRoot: string,
  runId: string
): ScriptSnapshotPoint | undefined {
  const ref = scriptSnapshotRef(runId);
  const commit = readSnapshotRef(repoRoot, ref);
  return commit !== undefined ? { commit, snapshot: true, files: [], ref } : undefined;
}

export function releaseScriptSnapshot(repoRoot: string, runId: string): void {
  deleteSnapshotRef(repoRoot, scriptSnapshotRef(runId));
}
