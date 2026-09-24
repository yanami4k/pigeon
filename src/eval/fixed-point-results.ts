// 定点对照的结果行（决策 158：写结果行，不新增账本记录）：每个事件、每组、每一遍一行，逐行追加到 results.jsonl；
// 撕裂的末行读时丢弃，按"事件 × 组 × 遍次"成键续跑
import type { TurnUsage } from "../state/runtime-events.ts";
import type { FixedPointGroup } from "./fixed-point-events.ts";
import type { HarnessRef } from "./results.ts";
import {
  type LimitPauseRecord,
  readStreamResults,
  type StreamGatewayFacts,
} from "./stream-results.ts";

// 首轮验证的判定（口径同 131）
export interface FirstVerify {
  // 首轮验证整体不过；没有验证记录为 null
  failed: boolean | null;
  // 主判据用的"变红"：在题面以外的检查上变红——格式、类型、分层等非测试步失败一律算，测试步只算题面测试文件以外的用例；
  // 判不清（测试步或未知步输出无法解析、失败清单不全而列出的都属题面、题面测试文件认定不全）且没有别处变红时为 null
  offTaskRed: boolean | null;
  // 算作题面以外变红的报错（步名：指纹简述）
  offTaskFailures: string[];
  // 判不清的步
  undetermined: string[];
}

export interface FixedPointRow {
  eventId: string;
  stream: string;
  seq: number;
  group: FixedPointGroup;
  pass: number;
  sessionId: string;
  // 实际给出的条目（取自重跑会话各 Run 的 run.started）：开局，与每轮回炉
  given: { selection: string | null; opening: string[]; repair: string[][] };
  firstVerify: FirstVerify;
  repairRounds: number | null;
  finalVerdict: "pass" | "fail" | null;
  reverted: boolean;
  outcome: "passed" | "failed";
  // 记忆是否被用上（139）：给出的红转绿条目里，有补改文件在它给出之后、下一次验证之前被 agent 改过；
  // 没给出红转绿条目（不带组、撤回类、回炉才给而首轮已过）为 null
  memoryUsed: boolean | null;
  memoryUsedFiles: string[];
  status: string | null;
  turns: number;
  usage: TurnUsage;
  agentWallMs: number;
  wallMs: number;
  // 网关：等空闲账号的累计毫秒（排队）、各账号转发次数、在途峰值；不经网关为 null
  gateway: StreamGatewayFacts | null;
  limitPauses: LimitPauseRecord[];
  harnessRef: HarnessRef;
}

export function fixedPointKey(row: {
  eventId: string;
  group: FixedPointGroup;
  pass: number;
}): string {
  return `${row.eventId}|${row.group}|${row.pass}`;
}

export function readFixedPointRows(file: string): FixedPointRow[] {
  return readStreamResults(file) as unknown as FixedPointRow[];
}
