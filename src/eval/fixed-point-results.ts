// 定点对照的结果行（决策 158：写结果行，不新增账本记录）：每个事件、每组、每一遍一行，逐行追加到 results.jsonl；
// 撕裂的末行读时丢弃、追加前截掉，按"事件 × 组 × 遍次"成键续跑
import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import type { TurnUsage } from "../state/runtime-events.ts";
import type { FixedPointGroup } from "./fixed-point-events.ts";
import type { HarnessRef } from "./results.ts";
import {
  type LimitPauseRecord,
  readStreamResults,
  type StreamGatewayFacts,
} from "./stream-results.ts";

// 某一次验证的判定（口径同 131）
export interface OffTaskVerdict {
  // 在题面以外的检查上变红——格式、类型、分层等非测试步失败一律算，测试步只算题面测试文件以外的用例；
  // 判不清（测试步或未知步输出无法解析、失败清单不全而列出的都属题面、题面测试文件认定不全）且没有别处变红时为 null
  offTaskRed: boolean | null;
  // 算作题面以外变红的报错（步名：指纹简述）
  offTaskFailures: string[];
  // 判不清的步
  undetermined: string[];
}

// 首轮验证（开局事件的判据，决策 164）
export interface FirstVerify extends OffTaskVerdict {
  // 首轮验证整体不过；没有验证记录为 null
  failed: boolean | null;
}

// 回炉之后的下一次验证（回炉事件的判据，决策 164）：只对首轮未过、进入回炉的遍次有意义。
// 回炉组在每一轮回炉都给，"给出记忆那一轮"即第 1 轮回炉，判的是第 2 次验证；进入回炉却没有第 2 次验证为判不清
export interface RepairVerify extends OffTaskVerdict {
  entered: boolean;
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
  // 实际给出的与该组指定的是否一致，按开局与每一轮回炉分开记（用前核验没过而被拦下即不一致）。意向处理：条目被现场核验
  // 拦下是正式使用时的正常行为，属于处理的一部分，不一致的遍次照样进各自判据的分母，只在汇总里按时机、按组单列计数
  givenMatch: { opening: boolean; repair: boolean[] };
  firstVerify: FirstVerify;
  repairVerify: RepairVerify;
  repairRounds: number | null;
  finalVerdict: "pass" | "fail" | null;
  reverted: boolean;
  outcome: "passed" | "failed";
  // 记忆是否被用上（139）：按带记忆组那几条指定的红转绿条目、在带记忆组本会给出的时间窗口里（开局的看首轮验证之前，
  // 回炉的看每一轮回炉里），agent 是否改了条目的补改文件；三组同一口径，不带组与无关组即基线。
  // 指定条目里没有红转绿的、或回炉条目而这一遍没进回炉，为 null
  memoryUsed: boolean | null;
  memoryUsedFiles: string[];
  status: string | null;
  turns: number;
  usage: TurnUsage;
  agentWallMs: number;
  wallMs: number;
  // 网关：等空闲账号的累计毫秒（排队）、各账号转发次数、在途峰值；不经网关为 null
  gateway: StreamGatewayFacts | null;
  // 等放行的毫秒（agent 开始之前，不计入这一遍的墙钟预算，决策 163）
  admissionWaitMs: number;
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

// 追加一行：文件末尾没有换行（进程死在写到一半）时，末行解析不了即截掉（读时本就丢弃，那一遍会被重做），解析得了就补上换行
export function appendFixedPointRow(file: string, row: FixedPointRow): void {
  if (existsSync(file)) {
    const content = readFileSync(file);
    if (content.length > 0 && content[content.length - 1] !== 0x0a) {
      const cut = content.lastIndexOf(0x0a) + 1;
      let whole = true;
      try {
        JSON.parse(content.subarray(cut).toString("utf8"));
      } catch {
        whole = false;
      }
      if (whole) appendFileSync(file, "\n");
      else truncateSync(file, cut);
    }
  }
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}
