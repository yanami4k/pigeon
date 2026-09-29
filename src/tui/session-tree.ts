// 会话树（决策 304）：整屏树形视图的第二种模式，列出当前会话这一家（application/session-family.ts 拼装）——主会话、分支、
// 失败重试、worker、复盘，逐层嵌套；每个节点写种类、会话号、时间、轮数、花费，worker 与失败重试有结果的写上结果；
// 当前会话标 "(current)"，读不到的成一行"读不到"。按键在壳里路由（查看、在此续接）；动作的说明写在树下方一行。
import type { Component } from "@earendil-works/pi-tui";
import type { FamilyNode, SessionFamily } from "../application/session-family.ts";
import { flattenFamily } from "../application/session-family.ts";
import { clipToWidth, formatCost } from "./status-bar.ts";

export const SESSION_TREE_HEADER =
  "== sessions tree | [tab] running | [up/down] move, [enter] view, [r] resume here, [esc] close ==";

const REVIEW_TIMING: Readonly<Record<string, string>> = {
  closing: "收尾",
  "pre-compaction": "压缩前",
  backfill: "补做",
};

export function familyKindLabel(node: FamilyNode): string {
  switch (node.kind) {
    case "main":
      return "主会话";
    case "branch":
      return "分支";
    case "retry":
      return "失败重试";
    case "worker":
      return `worker ${node.worker?.name ?? "?"}（${node.worker?.role ?? "?"}）`;
    case "review":
      return `复盘（${REVIEW_TIMING[node.review ?? ""] ?? "未注明"}）`;
    case "fork":
      return "分叉（无复盘标记）";
    default:
      return "读不到";
  }
}

// 本地时间 MM-DD HH:mm
function timeOf(at: number | undefined): string {
  if (at === undefined) return "-";
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function familyNodeText(node: FamilyNode, currentSessionId: string): string {
  const parts = [familyKindLabel(node), node.sessionId, timeOf(node.createdAt)];
  if (node.unreadable !== undefined) {
    parts.push(`读不到（${node.unreadable}）`);
  } else {
    parts.push(`${node.turns ?? 0}t`);
    if (node.cost !== undefined) parts.push(formatCost(node.cost, true));
    if (node.result !== undefined) parts.push(node.result);
  }
  if (node.sessionId === currentSessionId) parts.push("(current)");
  return parts.join("  ");
}

export interface SessionTreeSource {
  // 视图可用的行数（终端高度减去标题与状态栏）
  height(): number;
}

export class SessionTree implements Component {
  private readonly source: SessionTreeSource;
  private family: SessionFamily | undefined;
  private problem: string | undefined;
  private cursor = 0;
  private note = "";

  constructor(source: SessionTreeSource) {
    this.source = source;
  }

  // 打开会话树时装入这一家；光标落在当前会话上
  load(family: SessionFamily): void {
    this.family = family;
    this.problem = undefined;
    this.note = "";
    const rows = flattenFamily(family.root);
    this.cursor = Math.max(
      0,
      rows.findIndex((row) => row.node.sessionId === family.currentSessionId)
    );
  }

  // 装不起来（没有会话根等）：只显示一行原因
  fail(problem: string): void {
    this.family = undefined;
    this.problem = problem;
    this.note = "";
  }

  currentSessionId(): string | undefined {
    return this.family?.currentSessionId;
  }

  selected(): FamilyNode | undefined {
    if (this.family === undefined) return undefined;
    return flattenFamily(this.family.root)[this.cursor]?.node;
  }

  move(delta: 1 | -1): void {
    if (this.family === undefined) return;
    const count = flattenFamily(this.family.root).length;
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
    this.note = "";
  }

  // 树下方的一行说明（动作被拒的原因、续接的用法等）
  setNote(note: string): void {
    this.note = note;
  }

  noteText(): string {
    return this.note;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const body: string[] = [];
    if (this.family === undefined) {
      body.push(`  ${this.problem ?? "(no sessions)"}`);
    } else {
      const current = this.family.currentSessionId;
      const rows = flattenFamily(this.family.root);
      const rendered = rows.map((row, index) =>
        clipToWidth(
          ` ${index === this.cursor ? ">" : " "}${"  ".repeat(row.depth + 1)}${familyNodeText(row.node, current)}`,
          width
        )
      );
      const room = Math.max(1, this.source.height() - 2);
      if (rendered.length > room) {
        const start = Math.max(
          0,
          Math.min(rendered.length - room, this.cursor - Math.floor(room / 2))
        );
        body.push(...rendered.slice(start, start + room));
      } else {
        body.push(...rendered);
      }
    }
    const lines = [clipToWidth(SESSION_TREE_HEADER, width), ...body];
    if (this.note !== "") lines.push(clipToWidth(` ${this.note}`, width));
    return lines;
  }
}
