// 续接会话的启动参数（决策 286 第 5 项）：pigeon --continue 接本项目最近的主会话；pigeon --resume <id> 接指定会话；
// pigeon --resume 不带会话号时开壳后弹出会话选择器。其余参数原样交给 launch-flags 解析。
// 两者互斥；--resume 后面紧跟的不是 -- 开头的词即当作会话号。
import { listRecentMainSessions, mostRecentMainSession } from "../application/recent-sessions.ts";
import { describeResume } from "../application/resume.ts";

export type ContinueMode =
  | { kind: "new" }
  | { kind: "continue" }
  | { kind: "resume"; sessionId?: string };

export function takeContinueFlags(argv: readonly string[]): {
  argv: string[];
  mode: ContinueMode;
} {
  const rest: string[] = [];
  let mode: ContinueMode = { kind: "new" };
  const claim = (next: ContinueMode): void => {
    if (mode.kind !== "new") {
      throw new Error("--continue 与 --resume 只能给一个");
    }
    mode = next;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--continue") {
      claim({ kind: "continue" });
      continue;
    }
    if (arg === "--resume") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        claim({ kind: "resume", sessionId: next });
        index += 1;
      } else {
        claim({ kind: "resume" });
      }
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, mode };
}

// 启动时打开哪个会话：新会话（picker 为真时开壳后弹出选择器），或直接续接某个会话（带续跑报告）
export type StartTarget =
  | { kind: "new"; picker: boolean; note?: string }
  | { kind: "resume"; sessionId: string; report: string[] };

function sandboxOf(governanceRoot: string, sessionId: string): boolean {
  return listRecentMainSessions(governanceRoot).some(
    (session) => session.sessionId === sessionId && session.sandbox
  );
}

// 按启动方式挑选：带 --sandbox 只续接沙箱会话，不带只续接本机会话（沙箱会话要在容器里续接）
export function resolveStartTarget(
  governanceRoot: string,
  mode: ContinueMode,
  sandbox: boolean
): StartTarget {
  if (mode.kind === "new") return { kind: "new", picker: false };
  if (mode.kind === "continue") {
    const recent = mostRecentMainSession(governanceRoot, { sandbox });
    if (recent === undefined) {
      return {
        kind: "new",
        picker: false,
        note: `本项目没有可续接的${sandbox ? "沙箱" : ""}会话，开一个新会话`,
      };
    }
    return resumeTarget(governanceRoot, recent.sessionId);
  }
  if (mode.sessionId === undefined) {
    if (sandbox) {
      throw new Error(
        "沙箱会话续接请给会话号：pigeon --sandbox --resume <sessionId>，或用 pigeon --sandbox --continue"
      );
    }
    return { kind: "new", picker: true };
  }
  const isSandbox = sandboxOf(governanceRoot, mode.sessionId);
  if (isSandbox && !sandbox) {
    throw new Error(
      `会话 ${mode.sessionId} 是沙箱会话，请用 pigeon --sandbox --resume ${mode.sessionId}`
    );
  }
  if (!isSandbox && sandbox) {
    throw new Error(`会话 ${mode.sessionId} 不是沙箱会话，续接时去掉 --sandbox`);
  }
  return resumeTarget(governanceRoot, mode.sessionId);
}

// 续跑报告与 /resume 同一份（application/resume.ts）；会话不存在或是旧格式时在此响亮失败
function resumeTarget(governanceRoot: string, sessionId: string): StartTarget {
  return {
    kind: "resume",
    sessionId,
    report: [...describeResume(governanceRoot, sessionId), "后续 Run 接着原对话继续写入本会话。"],
  };
}
