// 编排面板（决策 301 第 1 项）：输入框下方、状态栏之下，每个 worker 一行——名字、状态、耗时、轮数、花费（实时，含在跑的）、
// 正在做什么（最近一个工具调用的一行摘要）。信息过滤照 Claude Code：只列在跑、排队、停在等审批的与最近结束的；行数有上限，
// 超出的折成一行 "+N more"；结束的过一段时间淡出（停在等审批的要人处理，不淡出）；没有要列的 worker 时面板不占行。
// 取代原先输入框上方的 worker 状态行。行的排版与 /workers 共用（/workers 列全部 worker，不过滤、不设上限）。
// 纯 ASCII chrome：worker 名经白名单校验，状态与列头为 ASCII 字面量；工具参数摘要等内容可含宽字符，按显示宽度截断、不折行。
import type { Component } from "@earendil-works/pi-tui";
import type { WorkerStatus } from "../application/workers-commands.ts";
import type { SessionId } from "../state/ids.ts";
import { clipToWidth, formatCost } from "./status-bar.ts";
import type { WorkerActivityTracker } from "./worker-activity.ts";

// 缺省：最多列 5 行，结束的 30 秒后淡出
export const PANEL_MAX_ROWS = 5;
export const PANEL_FADE_MS = 30_000;

export const PANEL_HINT = "  [up/down] select, [enter] open session, [x] stop, [esc] back";

// 状态的一个 ASCII 词：298 的六种说法（done、failed、timeout、limit、cancelled、stalled）加 queued、running 与
// 停在等审批（blocked，可补批续做）
export function workerStateWord(status: WorkerStatus): string {
  const outcome = status.outcome;
  switch (status.state) {
    case "queued":
    case "running":
      return status.state;
    case "completed":
      return "done";
    case "wall-clock-limit":
      return "timeout";
    case "turn-limit":
    case "token-limit":
      return "limit";
    case "cancelled":
    case "aborted":
      return "cancelled";
    case "stalled":
      return "stalled";
    default:
      return outcome?.recoverable === true ? "blocked" : "failed";
  }
}

export function isActiveWorker(status: WorkerStatus): boolean {
  return status.state === "running" || status.state === "queued";
}

// 停在等审批、可补批续做的
export function isBlockedWorker(status: WorkerStatus): boolean {
  return status.outcome?.recoverable === true && !isActiveWorker(status);
}

// 42s、3m05s、1h02m
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedOf(status: WorkerStatus, now: number): string {
  if (status.state === "queued") return "-";
  if (status.outcome !== undefined) return formatElapsed(status.outcome.durationMs ?? 0);
  return formatElapsed(now - status.startedAt);
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

// 正在做什么：在跑的取最近一个工具调用；排队的等空位；结束的写原因或自述的第一行
export function workerDoing(status: WorkerStatus, tracker: WorkerActivityTracker): string {
  if (status.state === "queued") return "waiting for a free slot";
  if (status.state === "running") {
    return tracker.lastTool(status.sessionId)?.line ?? "starting";
  }
  const outcome = status.outcome;
  if (outcome?.recoverable === true && outcome.blocked !== undefined) {
    return `needs approval: ${outcome.blocked.action}`;
  }
  if (outcome?.error !== undefined) return firstLine(outcome.error);
  return firstLine(outcome?.result?.summary ?? "");
}

export interface RowColumns {
  nameWidth: number;
}

export function columnsOf(statuses: readonly WorkerStatus[]): RowColumns {
  return { nameWidth: Math.min(24, Math.max(4, ...statuses.map((status) => status.name.length))) };
}

// 一行（不含行首两格的选中标记）：名字、状态、耗时、轮数、花费、正在做什么
export function workerRowText(
  status: WorkerStatus,
  tracker: WorkerActivityTracker,
  now: number,
  columns: RowColumns
): string {
  const record = tracker.get(status.sessionId);
  const cost = record !== undefined ? formatCost(record.cost, true) : "$0";
  return [
    status.name.padEnd(columns.nameWidth),
    workerStateWord(status).padEnd(9),
    elapsedOf(status, now).padStart(6),
    `${status.turns}t`.padStart(4),
    cost.padStart(8),
    workerDoing(status, tracker),
  ].join("  ");
}

// 收尾时刻：生命周期事件记下的为准，缺时按开跑时刻加耗时
function settledAtOf(status: WorkerStatus, tracker: WorkerActivityTracker): number {
  return (
    tracker.get(status.sessionId)?.settledAt ?? status.startedAt + (status.outcome?.durationMs ?? 0)
  );
}

// 面板要列的 worker（有次序）：在跑、排队与停在等审批的按派出先后，其后是淡出期内结束的（新的在前）
export function panelWorkers(
  statuses: readonly WorkerStatus[],
  tracker: WorkerActivityTracker,
  now: number,
  fadeMs: number
): WorkerStatus[] {
  const active = statuses.filter((status) => isActiveWorker(status) || isBlockedWorker(status));
  const recent = statuses
    .filter((status) => !isActiveWorker(status) && !isBlockedWorker(status))
    .filter((status) => now - settledAtOf(status, tracker) < fadeMs)
    .sort((a, b) => settledAtOf(b, tracker) - settledAtOf(a, tracker));
  return [...active, ...recent];
}

// 还有结束的 worker 在淡出期内（面板要定时刷新，到点让它消失）
export function hasFadingWorkers(
  statuses: readonly WorkerStatus[],
  tracker: WorkerActivityTracker,
  now: number,
  fadeMs: number
): boolean {
  return statuses.some(
    (status) =>
      !isActiveWorker(status) &&
      !isBlockedWorker(status) &&
      now - settledAtOf(status, tracker) < fadeMs
  );
}

export interface WorkerPanelSource {
  statuses(): WorkerStatus[];
  tracker: WorkerActivityTracker;
  now(): number;
  maxRows: number;
  fadeMs: number;
}

export class WorkerPanel implements Component {
  private readonly source: WorkerPanelSource;
  private focusedState = false;
  private selectedId: SessionId | undefined;

  constructor(source: WorkerPanelSource) {
    this.source = source;
  }

  // 当前列出的 worker（与渲染同一口径）
  rows(): WorkerStatus[] {
    return panelWorkers(
      this.source.statuses(),
      this.source.tracker,
      this.source.now(),
      this.source.fadeMs
    ).slice(0, this.source.maxRows);
  }

  isFocused(): boolean {
    return this.focusedState;
  }

  // 选中第一行进入面板；没有可选的即不进
  focus(): boolean {
    const rows = this.rows();
    if (rows.length === 0) return false;
    this.focusedState = true;
    this.selectedId = rows[0]?.sessionId;
    return true;
  }

  blur(): void {
    this.focusedState = false;
  }

  selected(): WorkerStatus | undefined {
    if (!this.focusedState) return undefined;
    const rows = this.rows();
    return rows.find((row) => row.sessionId === this.selectedId) ?? rows[0];
  }

  // 上移到第一行之上即退出面板（回输入框），返回是否仍在面板里
  move(delta: 1 | -1): boolean {
    const rows = this.rows();
    const current = Math.max(
      0,
      rows.findIndex((row) => row.sessionId === this.selected()?.sessionId)
    );
    const next = current + delta;
    if (next < 0) {
      this.blur();
      return false;
    }
    this.selectedId = rows[Math.min(rows.length - 1, next)]?.sessionId;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const all = panelWorkers(
      this.source.statuses(),
      this.source.tracker,
      this.source.now(),
      this.source.fadeMs
    );
    if (all.length === 0) {
      this.focusedState = false;
      return [];
    }
    const shown = all.slice(0, this.source.maxRows);
    const columns = columnsOf(shown);
    const now = this.source.now();
    const selected = this.selected()?.sessionId;
    const lines = shown.map((status) => {
      const mark = this.focusedState && status.sessionId === selected ? "> " : "  ";
      return clipToWidth(
        ` ${mark}${workerRowText(status, this.source.tracker, now, columns)}`,
        width
      );
    });
    if (all.length > shown.length) {
      lines.push(clipToWidth(`   +${all.length - shown.length} more (/workers, ctrl+x)`, width));
    }
    if (this.focusedState) lines.push(clipToWidth(` ${PANEL_HINT}`, width));
    return lines;
  }
}
