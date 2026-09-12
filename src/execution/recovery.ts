// 冷启动恢复（ROADMAP §4 execution：Receipt 与恢复；M4 S2，D5）：对悬账做哈希三方比对
// 自动确证，写 resolution 治理族记录（唯一会写 Event Log 的恢复动作）。任何路径系统
// 不自动重新执行（§3.2）；剩余悬账留人确认（cli resume 的三选一菜单）。
import { readFileSync } from "node:fs";
import { JsonlEventLog, materializeSession } from "../persistence/event-log.ts";
import type { ResolutionRecord } from "../state/event-log.ts";
import type { SessionId } from "../state/ids.ts";
import type { MaterializedSession } from "../state/materialize.ts";
import { snapshotTag } from "../tools/hashline.ts";
import { resolveWorkspacePath } from "../tools/paths.ts";

// 冷启动恢复（M4 S2，D5 对账流程的自动确证环节）：物化 → 对悬账（intent 无 receipt）做
// 哈希三方比对——读目标文件现状：== 预期改后 → 确证 executed；== 改前 → 确证 not-executed
// （模型之后可正常重提，系统永不重新执行，§3.2）；两头都不符（撕裂写/第三方改动）、
// 目标不可读、或 intent 无哈希 → 原样滞留 OutcomeUnknown 留人确认。
// 每次确证写一条 resolution 治理族记录（fsync 耐久 + 按 executionId 幂等），不是静默销账；
// 写盘失败向上抛（启动期一次性动作，响亮失败由调用方裁决）
export interface RecoveryResult {
  // 确证写入后的最终物化态
  materialized: MaterializedSession;
  // 本次新写入的确证记录（按文件顺序）
  resolutions: ResolutionRecord[];
}

export function recoverSession(
  dir: string,
  sessionId: SessionId,
  workspaceRoot: string
): RecoveryResult {
  const log = new JsonlEventLog(dir, sessionId);
  try {
    const before = materializeSession(dir, sessionId);
    const resolutions: ResolutionRecord[] = [];
    for (const entry of before.reconcile.unknown) {
      const hashes = entry.intent.contentHashes;
      if (hashes === undefined) {
        continue;
      }
      let observedHash: string;
      try {
        observedHash = snapshotTag(
          readFileSync(resolveWorkspacePath(workspaceRoot, hashes.path), "utf8")
        );
      } catch {
        continue; // 目标不存在/不可读/越界 → 滞留 unknown
      }
      // 三方比对：先比改后（已执行），再比改前（未执行），都不符不留记录
      const outcome =
        observedHash === hashes.expectedAfterHash
          ? "executed"
          : observedHash === hashes.beforeHash
            ? "not-executed"
            : undefined;
      if (outcome === undefined) {
        continue;
      }
      resolutions.push(
        log.appendResolution({
          executionId: entry.intent.executionId,
          toolCallId: entry.intent.toolCallId,
          toolName: entry.intent.toolName,
          outcome,
          method: "hash-auto",
          evidence: {
            path: hashes.path,
            beforeHash: hashes.beforeHash,
            expectedAfterHash: hashes.expectedAfterHash,
            observedHash,
          },
          at: Date.now(),
          runId: entry.intent.runId,
        })
      );
    }
    // 重新物化：返回的确证后状态与磁盘一致（resolved 配对已生效）
    return { materialized: materializeSession(dir, sessionId), resolutions };
  } finally {
    log.close();
  }
}
