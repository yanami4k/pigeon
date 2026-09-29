// 会话家谱（决策 304，终端界面树形视图的会话树模式）：从当前会话出发，沿文件头的父会话（worker）与来源会话（分支、失败重试、
// 复盘）上溯到根主会话，再列出根下全部后代，逐层嵌套。只列这一家；换一家经会话列表。
// 读法：先只读全部会话文件的文件头（首行）拼出家谱，不读全文；再只全读这一家的成员，算种类细节（复盘的触发时机）、
// 时间、轮数、花费与结果。花费按会话花费的同一计价（costTallyOfView：回复自带价格、DeepSeek 按官方人民币价目、无价格的记 token），
// 每个节点只计它自己的，不含子会话（子会话各自成节点）。读不到的文件成一个"读不到"节点，不中断。只读，不写任何记录。

import { readSessionView } from "../persistence/session-catalog.ts";
import {
  listSessionFiles,
  readSessionHeader,
  type SessionFileRef,
  type SessionHeaderView,
} from "../persistence/session-reader.ts";
import { HEADER_METADATA_KEY } from "../state/session-entries.ts";
import type { SessionView } from "../state/session-view.ts";
import { type CostTally, costTallyOfView } from "./session-cost.ts";
import { workerStateLabel } from "./workers-commands.ts";

// 主会话、分支（/fork，manual）、失败重试（retry-on-fail）、worker、复盘（带复盘标记）、未标明的分叉（有来源会话、
// 没有 worker 与分支来历、也没有复盘标记）、读不到（文件头或全文读不出，或家谱里提到的会话没有文件）
export type FamilyNodeKind =
  | "main"
  | "branch"
  | "retry"
  | "worker"
  | "review"
  | "fork"
  | "unreadable";

// 复盘的触发时机：收尾、压缩前、补做（终端界面启动时后台补做的收尾复盘）
export type ReviewTiming = "closing" | "pre-compaction" | "backfill";

export interface FamilyNode {
  sessionId: string;
  kind: FamilyNodeKind;
  // 文件名里的创建时间（毫秒；读不到且没有文件时缺省）
  createdAt?: number;
  worker?: { name: string; role: string };
  review?: ReviewTiming;
  // 输入条数（Run 数，与会话列表同一口径）
  turns?: number;
  cost?: CostTally;
  // worker 的收尾状态、失败重试的结束方式与验证结论
  result?: string;
  // 读不到的原因
  unreadable?: string;
  children: FamilyNode[];
}

export interface SessionFamily {
  root: FamilyNode;
  currentSessionId: string;
  // 读过文件头的会话文件数与全读过的会话数（性能核对用）
  headersRead: number;
  fullyRead: number;
}

export interface SessionFamilyOptions {
  // 测试注入：全读一个会话文件（缺省 readSessionView）
  readView?: (ref: SessionFileRef) => SessionView | undefined;
}

interface HeaderInfo {
  ref: SessionFileRef;
  header: SessionHeaderView | undefined;
}

interface PigeonHeaderMetadata {
  worker?: { name?: unknown; role?: unknown };
  branch?: { trigger?: unknown };
}

function pigeonMetadata(header: SessionHeaderView): PigeonHeaderMetadata {
  const value = header.metadata?.[HEADER_METADATA_KEY];
  return typeof value === "object" && value !== null ? (value as PigeonHeaderMetadata) : {};
}

// 只看文件头的种类（复盘要全读才能确认，这里先记作 fork）
function headerKind(header: SessionHeaderView): FamilyNodeKind {
  const meta = pigeonMetadata(header);
  if (meta.worker !== undefined) return "worker";
  if (meta.branch !== undefined)
    return meta.branch.trigger === "retry-on-fail" ? "retry" : "branch";
  return header.parentSessionId !== undefined ? "fork" : "main";
}

function reviewTimingOf(view: SessionView): ReviewTiming | undefined {
  for (const run of view.runs) {
    const tag = run.start.memoryReview;
    if (tag === undefined) continue;
    if (tag.backfill !== undefined) return "backfill";
    return tag.kind;
  }
  return undefined;
}

// 失败重试（与分支）的结果：最后一次运行的结束方式，有验证记录时加上验证结论
function branchResultOf(view: SessionView): string | undefined {
  const lastRun = view.runs.at(-1);
  if (lastRun === undefined) return undefined;
  const parts = [lastRun.end !== undefined ? lastRun.end.ending : "未收尾"];
  const verification = view.items.findLast((item) => item.kind === "verification");
  if (verification !== undefined && verification.kind === "verification") {
    const data = verification.data;
    parts.push(data.exitCode === 0 && !data.timedOut ? "验证通过" : "验证未过");
  }
  return parts.join("，");
}

export function loadSessionFamily(
  sessionsRoot: string,
  currentSessionId: string,
  options: SessionFamilyOptions = {}
): SessionFamily {
  const readView = options.readView ?? readSessionView;
  const infos = new Map<string, HeaderInfo>();
  for (const ref of listSessionFiles(sessionsRoot)) {
    infos.set(ref.sessionId, { ref, header: readSessionHeader(ref.path) });
  }
  const children = new Map<string, string[]>();
  for (const [id, info] of infos) {
    const parent = info.header?.parentSessionId;
    if (parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  // 上溯到根：没有父会话即根；父会话没有文件或文件头读不出即以它为"读不到"的根
  let rootId = currentSessionId;
  const seen = new Set<string>([rootId]);
  for (;;) {
    const parent = infos.get(rootId)?.header?.parentSessionId;
    if (parent === undefined || seen.has(parent)) break;
    seen.add(parent);
    rootId = parent;
    if (infos.get(parent)?.header === undefined) break;
  }
  let fullyRead = 0;
  const views = new Map<string, SessionView | undefined>();
  const viewOf = (id: string): SessionView | undefined => {
    if (views.has(id)) return views.get(id);
    const info = infos.get(id);
    let view: SessionView | undefined;
    if (info?.header !== undefined) {
      fullyRead += 1;
      try {
        view = readView(info.ref);
      } catch {
        view = undefined;
      }
    }
    views.set(id, view);
    return view;
  };
  const build = (id: string, parent: SessionView | undefined, path: Set<string>): FamilyNode => {
    const info = infos.get(id);
    const kids = (children.get(id) ?? []).filter((child) => !path.has(child));
    const next = new Set(path).add(id);
    if (info === undefined || info.header === undefined) {
      const node: FamilyNode = {
        sessionId: id,
        kind: "unreadable",
        unreadable: info === undefined ? "没有会话文件" : "文件头读不出",
        children: [],
      };
      if (info !== undefined) node.createdAt = info.ref.createdAt;
      node.children = kids.map((child) => build(child, undefined, next));
      return node;
    }
    const header = info.header;
    const view = viewOf(id);
    const node: FamilyNode = {
      sessionId: id,
      kind: headerKind(header),
      createdAt: info.ref.createdAt,
      children: [],
    };
    const meta = pigeonMetadata(header);
    if (node.kind === "worker" && meta.worker !== undefined) {
      node.worker = {
        name: String(meta.worker.name ?? "?"),
        role: String(meta.worker.role ?? "?"),
      };
    }
    if (view === undefined) {
      node.unreadable = "全文读不出";
    } else {
      if (node.kind === "fork") {
        const timing = reviewTimingOf(view);
        if (timing !== undefined) {
          node.kind = "review";
          node.review = timing;
        }
      }
      node.turns = view.runs.length;
      node.cost = costTallyOfView(view);
      if (node.kind === "retry" || node.kind === "branch") {
        const result = branchResultOf(view);
        if (result !== undefined) node.result = result;
      }
    }
    if (node.kind === "worker" && parent !== undefined) {
      const settled = parent.children.find((child) => child.spawned.childSessionId === id)?.settled;
      if (settled !== undefined) {
        node.result =
          workerStateLabel(settled.status) +
          (settled.errorKind !== undefined ? `（${settled.errorKind}）` : "");
      }
    }
    node.children = kids.map((child) => build(child, view, next));
    return node;
  };
  const root = build(rootId, undefined, new Set());
  return { root, currentSessionId, headersRead: infos.size, fullyRead };
}

// 按先序展开成带层数的一列（界面逐行显示用）
export function flattenFamily(root: FamilyNode): Array<{ node: FamilyNode; depth: number }> {
  const out: Array<{ node: FamilyNode; depth: number }> = [];
  const walk = (node: FamilyNode, depth: number): void => {
    out.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}
