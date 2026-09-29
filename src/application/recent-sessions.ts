// 可续接的主会话（决策 286 第 5 项）：pigeon --continue 取本项目最近的一个，/resume 与 pigeon --resume 不带会话号时
// 列出来选。主会话 = 文件头没有父会话的会话：worker 会话、/fork 分支与复盘会话都有父会话，不列。
// 每行给最近活动时间、首条输入摘要、轮数（一条输入一轮）与沙箱标记；按最近活动从新到旧。只读，不写任何记录。
import { execFileSync } from "node:child_process";
import { SANDBOX_START_REF_PREFIX, sandboxBranch } from "../execution/sandbox.ts";
import { listSessionRefs, readSessionView } from "../persistence/session-catalog.ts";
import type { SessionId } from "../state/ids.ts";
import type { SessionView } from "../state/session-view.ts";
import { isReviewSession } from "./session-cost.ts";
import { sessionsDirOf } from "./workspace.ts";

export interface RecentSession {
  sessionId: SessionId;
  // 最近活动（最后一条消息的写入时刻；没有消息取创建时间），Unix 毫秒
  lastActiveAt: number;
  // 首条输入的前一段（换行压成空格）；一条输入都没有时为空串
  firstInput: string;
  // 轮数：输入的条数（一条输入一个 Run）
  turns: number;
  sandbox: boolean;
}

const FIRST_INPUT_CHARS = 60;

function firstInputOf(view: SessionView): string {
  for (const message of view.messages) {
    if (message.role !== "user") continue;
    const text = message.blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") {
      return [...text].length > FIRST_INPUT_CHARS
        ? `${[...text].slice(0, FIRST_INPUT_CHARS).join("")}...`
        : text;
    }
  }
  return "";
}

// 沙箱会话的痕迹：交回的分支或开箱时的起点引用（一次 git 调用列全；非 git 工作区即没有）
function sandboxSessionIds(governanceRoot: string): Set<string> {
  const ids = new Set<string>();
  const branchPrefix = `refs/heads/${sandboxBranch("")}`;
  // for-each-ref 的模式按整段路径匹配：给到 "/" 为止的上一级，再按前缀筛
  const branchParent = branchPrefix.slice(0, branchPrefix.lastIndexOf("/") + 1);
  try {
    const refs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", branchParent, SANDBOX_START_REF_PREFIX],
      { cwd: governanceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    for (const ref of refs.split("\n")) {
      if (ref.startsWith(branchPrefix)) ids.add(ref.slice(branchPrefix.length));
      else if (ref.startsWith(SANDBOX_START_REF_PREFIX))
        ids.add(ref.slice(SANDBOX_START_REF_PREFIX.length));
    }
  } catch {
    // 不是 git 工作区或 git 不可用：没有沙箱会话可言
  }
  return ids;
}

export function listRecentMainSessions(governanceRoot: string): RecentSession[] {
  const sandboxIds = sandboxSessionIds(governanceRoot);
  const sessions: RecentSession[] = [];
  for (const ref of listSessionRefs(sessionsDirOf(governanceRoot))) {
    const view = readSessionView(ref);
    if (view === undefined || view.parentSessionId !== undefined || isReviewSession(view)) {
      continue;
    }
    const last = view.messages.at(-1);
    sessions.push({
      sessionId: view.sessionId,
      lastActiveAt: last?.timestamp ?? view.createdAt,
      firstInput: firstInputOf(view),
      turns: view.runs.length,
      sandbox: sandboxIds.has(view.sessionId),
    });
  }
  return sessions.sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt || b.sessionId.localeCompare(a.sessionId)
  );
}

// pigeon --continue：本项目最近的主会话（按启动方式挑：带 --sandbox 只接沙箱会话，否则只接本机会话）；没有即 undefined
export function mostRecentMainSession(
  governanceRoot: string,
  options: { sandbox: boolean; exclude?: string }
): RecentSession | undefined {
  return listRecentMainSessions(governanceRoot).find(
    (session) =>
      session.sandbox === options.sandbox &&
      session.turns > 0 &&
      session.sessionId !== options.exclude
  );
}

// 选择器的一行（纯 ASCII 之外只有首条输入本身；时间用本地时间，便于人辨认）
export function recentSessionLine(session: RecentSession): string {
  const at = new Date(session.lastActiveAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const mark = session.sandbox ? " [sandbox]" : "";
  const input = session.firstInput !== "" ? session.firstInput : "(no input)";
  return `${time}  ${session.turns} turns${mark}  ${input}`;
}
