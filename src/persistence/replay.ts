// Replay 只读重建（M4 S4，ROADMAP §M4：Replay 的只读重建模式；D4 语义锁定：
// 只读重建 = 黑匣子回放，重建引擎是核心；默认不重新执行真实副作用，
// 重新执行（含 M7+ 沙箱回放验证）是另一件事）。
// 纯投影层：输入是冷物化结果（MaterializedSession，D5 派生不落库），输出是
// 单个 Run 的完整时间线——该 Run 的全部事件日志记录严格按落盘顺序原位呈现
// （治理族 intent/decision/receipt 与运行时事件 turn/tool/run 穿插，不分组不重排），
// 与 trace 的「链式分组治理视图」相区别：replay 是原始时间流，飞行记录仪回放。
// 异常纪律：悬账 intent（待对账）、孤儿记录（找不到配对的 Receipt/Resolution）、
// 撕裂尾巴、崩溃残留（无 run.ended）全部如实标注，绝不猜测修补（§3.2/§3.5）。
import type { RunId, SessionId } from "../state/ids.ts";
import type { EventRecord, MaterializedSession, RunClassification } from "./event-log.ts";

// 时间线上的一条记录 + 人话异常标注（空数组 = 无异常）
export interface ReplayEvent {
  record: EventRecord;
  annotations: string[];
}

// 单个 Run 的只读重建结果
export interface RunReplay {
  sessionId: SessionId;
  runId: RunId;
  // 该 Run 的全部事件日志记录，严格按落盘顺序
  events: ReplayEvent[];
  // run.ended 事件是否在场（缺失 = 崩溃残留可能）
  ended: boolean;
  // 会话文件末尾存在撕裂写残片（文件级事实，随物化结果传递）
  tornTail: boolean;
  // Run 级失败四分类（D7）；缺省 = 分类清单中无此 Run（不应出现）
  classification?: RunClassification;
}

// 只读重建：从物化结果过滤出目标 Run 的时间线并附加异常标注。
// Run 无任何记录 = 未知 Run，返回 null（由命令层响亮报错并列出可选项）
export function buildRunReplay(session: MaterializedSession, runId: RunId): RunReplay | null {
  const records = session.records.filter((record) => record.runId === runId);
  if (records.length === 0) {
    return null;
  }
  // 待对账集合：intent 已落盘但无 Receipt 且未确证（OutcomeUnknown，§3.2 禁止盲重放）
  const pending = new Set(
    session.reconcile.unknown.map((entry) => entry.intent.executionId as string)
  );
  // 孤儿集合（对账已按 executionId 全会话核对过，此处只取结论做标注，不重新猜测配对）
  const orphanReceipts = new Set(session.reconcile.orphanReceipts.map((r) => r.id as string));
  const orphanResolutions = new Set(session.reconcile.orphanResolutions.map((r) => r.id as string));

  let ended = false;
  const events: ReplayEvent[] = [];
  for (const record of records) {
    const annotations: string[] = [];
    if (record.kind === "intent" && pending.has(record.executionId)) {
      annotations.push(
        "待对账：intent 已落盘但无 Receipt（OutcomeUnknown，禁止盲重放，用 resume 处理）"
      );
    } else if (record.kind === "receipt" && orphanReceipts.has(record.receipt.id)) {
      annotations.push("孤儿记录：Receipt 找不到对应 intent/decision（日志损坏或手写）");
    } else if (record.kind === "resolution" && orphanResolutions.has(record.id)) {
      annotations.push("孤儿记录：Resolution 找不到对应 intent（日志损坏或手写）");
    }
    if (record.kind === "run.ended") {
      ended = true;
    }
    events.push({ record, annotations });
  }
  const classification = session.classification.runs.find((entry) => entry.runId === runId);
  // 撕裂尾巴归属：残片只可能写在文件末条记录之后——只有拥有末条记录的 Run 才标注，
  // 其余 Run 的时间线完整终结于文件中段，尾巴与它们无关
  const ownsFileTail = records[records.length - 1] === session.records[session.records.length - 1];
  return {
    sessionId: session.sessionId,
    runId,
    events,
    ended,
    tornTail: session.tornTail && ownsFileTail,
    ...(classification !== undefined ? { classification } : {}),
  };
}
