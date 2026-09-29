// 树形视图（决策 301 第 2 项）：可切换进出的整屏视图，按主 agent、脚本、阶段、worker 分层。脚本与阶段两层本段只留节点类型与
// 数据接口（OrchestrationScriptNode，由脚本编排接上），没有数据时不显示；嵌套派出的 worker 挂在派出它的 worker 之下。
// worker 节点缺省收起，展开才显示该 worker 最近的若干条工具调用；开了任务清单时，worker 节点旁按标签标出对应的清单项。
// 选中 worker 节点可进入它的会话或停止它（按键在壳里路由）。纯 ASCII chrome；内容（任务标题、工具参数摘要）按显示宽度截断。
import type { Component } from "@earendil-works/pi-tui";
import type { TaskItem } from "../application/task-list-tool.ts";
import type { WorkerStatus } from "../application/workers-commands.ts";
import type { SessionId } from "../state/ids.ts";
import { clipToWidth } from "./status-bar.ts";
import type { WorkerActivityTracker } from "./worker-activity.ts";
import { columnsOf, workerRowText } from "./worker-panel.ts";

// 展开时显示的最近工具调用条数
export const TREE_RECENT_TOOLS = 5;

export const TREE_HEADER =
  "== workers tree | [up/down] move, [right/space] expand, [left] collapse, [enter] open session, [x] stop, [esc] close ==";

// 脚本编排的数据接口（决策 294 D、301）：一次脚本编排与其各阶段，阶段列出它派出的 worker
export interface OrchestrationPhaseNode {
  id: string;
  title: string;
  // 阶段状态的一个词（如 running、done）；缺省不写
  state?: string;
  workers: readonly SessionId[];
}

export interface OrchestrationScriptNode {
  id: string;
  title: string;
  state?: string;
  phases: readonly OrchestrationPhaseNode[];
}

export interface TreeSources {
  mainSessionId: SessionId;
  statuses: readonly WorkerStatus[];
  tracker: WorkerActivityTracker;
  scripts: readonly OrchestrationScriptNode[];
  // 任务清单开着时在场
  tasks?: readonly TaskItem[];
  now: number;
}

export type TreeLineKind = "main" | "script" | "phase" | "worker" | "tool";

export interface TreeLine {
  kind: TreeLineKind;
  depth: number;
  text: string;
  // worker 节点与其展开的调用行在场
  sessionId?: SessionId;
}

// 按标签对应的清单项：[task #2 标题 (in_progress)]
export function taskMarks(status: WorkerStatus, tasks: readonly TaskItem[] | undefined): string {
  if (tasks === undefined || status.label === undefined) return "";
  return tasks
    .filter((task) => task.workerLabel === status.label)
    .map((task) => `[task #${task.id} ${task.title} (${task.status})]`)
    .join(" ");
}

export function buildTreeLines(
  sources: TreeSources,
  expanded: ReadonlySet<SessionId>,
  recentTools = TREE_RECENT_TOOLS
): TreeLine[] {
  const lines: TreeLine[] = [
    { kind: "main", depth: 0, text: `main agent | session ${sources.mainSessionId}` },
  ];
  const columns = columnsOf(sources.statuses);
  const byParent = new Map<SessionId, WorkerStatus[]>();
  for (const status of sources.statuses) {
    if (status.parentSessionId === undefined) continue;
    const list = byParent.get(status.parentSessionId) ?? [];
    list.push(status);
    byParent.set(status.parentSessionId, list);
  }
  // 归在某个阶段下的 worker 不再按派出方重复列出
  const inPhase = new Set<SessionId>(
    sources.scripts.flatMap((script) => script.phases.flatMap((phase) => [...phase.workers]))
  );
  const pushWorker = (status: WorkerStatus, depth: number): void => {
    const marks = taskMarks(status, sources.tasks);
    const open = expanded.has(status.sessionId);
    lines.push({
      kind: "worker",
      depth,
      sessionId: status.sessionId,
      text:
        `${open ? "[-]" : "[+]"} ${workerRowText(status, sources.tracker, sources.now, columns)}` +
        (marks !== "" ? `  ${marks}` : ""),
    });
    if (open) {
      const calls = sources.tracker.get(status.sessionId)?.recentTools.slice(-recentTools) ?? [];
      if (calls.length === 0) {
        lines.push({
          kind: "tool",
          depth: depth + 1,
          sessionId: status.sessionId,
          text: "| (no tool calls yet)",
        });
      }
      for (const call of calls) {
        lines.push({
          kind: "tool",
          depth: depth + 1,
          sessionId: status.sessionId,
          text: `| ${call.line}${call.state !== undefined ? ` ${call.state}` : ""}`,
        });
      }
    }
    for (const child of byParent.get(status.sessionId) ?? []) {
      if (!inPhase.has(child.sessionId)) pushWorker(child, depth + 1);
    }
  };
  const bySession = new Map(sources.statuses.map((status) => [status.sessionId, status]));
  for (const script of sources.scripts) {
    lines.push({
      kind: "script",
      depth: 1,
      text: `script ${script.title}${script.state !== undefined ? `  ${script.state}` : ""}`,
    });
    for (const phase of script.phases) {
      lines.push({
        kind: "phase",
        depth: 2,
        text: `phase ${phase.title}${phase.state !== undefined ? `  ${phase.state}` : ""}`,
      });
      for (const id of phase.workers) {
        const status = bySession.get(id);
        if (status !== undefined) pushWorker(status, 3);
      }
    }
  }
  // 主 agent（或人）直接派出的：派出方是主会话，或派出方不在本编排器里
  for (const status of sources.statuses) {
    if (inPhase.has(status.sessionId)) continue;
    const parent = status.parentSessionId;
    if (parent !== undefined && parent !== sources.mainSessionId && bySession.has(parent)) continue;
    pushWorker(status, 1);
  }
  if (sources.statuses.length === 0) {
    lines.push({ kind: "tool", depth: 1, text: "(no workers yet)" });
  }
  return lines;
}

export interface WorkerTreeSource {
  sources(): TreeSources;
  // 视图可用的行数（终端高度减去标题与状态栏）
  height(): number;
}

export class WorkerTree implements Component {
  private readonly source: WorkerTreeSource;
  private readonly expanded = new Set<SessionId>();
  private cursorId: SessionId | undefined;

  constructor(source: WorkerTreeSource) {
    this.source = source;
  }

  private lines(): TreeLine[] {
    return buildTreeLines(this.source.sources(), this.expanded);
  }

  private workerIds(): SessionId[] {
    return this.lines().flatMap((line) =>
      line.kind === "worker" && line.sessionId !== undefined ? [line.sessionId] : []
    );
  }

  selected(): SessionId | undefined {
    const ids = this.workerIds();
    return this.cursorId !== undefined && ids.includes(this.cursorId) ? this.cursorId : ids[0];
  }

  move(delta: 1 | -1): void {
    const ids = this.workerIds();
    if (ids.length === 0) return;
    const current = Math.max(0, ids.indexOf(this.selected() ?? ids[0] ?? ("" as SessionId)));
    this.cursorId = ids[Math.max(0, Math.min(ids.length - 1, current + delta))];
  }

  setExpanded(open: boolean): void {
    const id = this.selected();
    if (id === undefined) return;
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
  }

  toggleExpanded(): void {
    const id = this.selected();
    if (id === undefined) return;
    this.setExpanded(!this.expanded.has(id));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = this.lines();
    const selected = this.selected();
    const rendered = lines.map((line) => {
      const mark = line.kind === "worker" && line.sessionId === selected ? ">" : " ";
      return clipToWidth(` ${mark}${"  ".repeat(line.depth)}${line.text}`, width);
    });
    // 超出视图高度时以选中行为准取一段
    const room = Math.max(1, this.source.height() - 1);
    let body = rendered;
    if (rendered.length > room) {
      const at = Math.max(
        0,
        lines.findIndex((line) => line.kind === "worker" && line.sessionId === selected)
      );
      const start = Math.max(0, Math.min(rendered.length - room, at - Math.floor(room / 2)));
      body = rendered.slice(start, start + room);
    }
    return [clipToWidth(TREE_HEADER, width), ...body];
  }
}
