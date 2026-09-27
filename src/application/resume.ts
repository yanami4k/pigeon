// resume 续跑流程（M4 S5；M2 S1 决策 025 从 cli/session.ts 抽到 Controller 层；账本重构决策 183）：
// 核对会话在会话存储里有文件 → 报告将还原的对话上下文（消息条数、上一个 Run 是否收尾、末条助手消息里悬空的工具调用）→
// 进入调用方注入的续会话入口。续会话入口装配运行面时（session-runtime.ts 的 resume）由写者打开会话文件、用 pi 的
// buildSessionContext 还原消息，并为每个悬空调用补一条"进程在执行途中中断、结果未知、请自行核实"的工具结果，由 agent 自行核对；
// 程序不再按文件哈希对账、也不再逐条问人（原哈希三方比对与人工确认菜单随之删除）。系统永不自动重新执行（§3.2）。
// 旧格式会话（迁移之前创建）不能续跑，明确报错（187：旧会话由只读的旧版代码读，211）。
// 输出依赖注入（决策 025）：cli 打终端，tui 打消息区；WriteFn 与 cli/repl.ts 的同名类型结构同型，定义留在本层
// 是为了不引入 application → cli 的反向依赖（application-is-controller 巡航规则）。
import { join } from "node:path";
import { hasLegacySessionFile, LEGACY_READER_HINT } from "../persistence/session-catalog.ts";
import { listSessionFiles } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { sessionContextMessages } from "../pi-runtime/session-store.ts";
import { danglingToolCalls, type StoreMessage } from "../state/session-judge.ts";

// 提问函数：返回一行输入；EOF/流关闭返回 null（与 cli/repl.ts 的 AskFn 结构同型）
export type AskFn = (prompt: string) => Promise<string | null>;
// 输出函数（与 cli/repl.ts 的 WriteFn 结构同型）
export type WriteFn = (text: string) => void;

export interface ResumeFlowOptions {
  // 治理根（会话文件在 <root>/.pigeon/sessions/）
  root: string;
  sessionId: string;
  write: WriteFn;
  // 续会话入口（测试可 mock/即刻返回；cli 在此进入 REPL，见 cli/index.ts）
  enterRepl: () => Promise<void>;
}

// 续跑前的报告：将还原的消息条数、未收尾的 Run、悬空的工具调用（真正的还原在续会话入口装配运行面时做）
export function describeResume(root: string, sessionId: string): string[] {
  const sessionsDir = join(root, ".pigeon", "sessions");
  const loaded = loadStoreSession(sessionsDir, sessionId);
  if (loaded === undefined) {
    if (hasLegacySessionFile(sessionsDir, sessionId)) {
      throw new Error(
        `会话 ${sessionId} 是旧格式会话（迁移之前创建），不能续跑；${LEGACY_READER_HINT}`
      );
    }
    const available = [...new Set(listSessionFiles(sessionsDir).map((file) => file.sessionId))];
    throw new Error(
      `会话不存在：${sessionId}` +
        (available.length > 0 ? `。已有会话：${available.join("、")}` : "（尚无会话记录）")
    );
  }
  const messages = sessionContextMessages(loaded.main);
  const lines = [`会话 ${sessionId} 续跑：还原对话上下文 ${messages.length} 条消息。`];
  const unfinished = loaded.view.runs.filter((run) => run.end === undefined).length;
  if (unfinished > 0) {
    lines.push(`  ${unfinished} 个 Run 没有收尾记录（进程死于中途）。`);
  }
  const dangling = danglingToolCalls(messages as unknown as StoreMessage[]);
  if (dangling.length > 0) {
    lines.push(
      `  末条助手消息有 ${dangling.length} 个工具调用没有结果（${dangling.map((call) => call.name).join("、")}）：` +
        "各补一条“结果未知、请自行核实”的工具结果，由 agent 核对后再继续。"
    );
  }
  return lines;
}

export async function runResumeFlow(options: ResumeFlowOptions): Promise<void> {
  for (const line of describeResume(options.root, options.sessionId)) {
    options.write(`${line}\n`);
  }
  options.write("后续 Run 接着原对话继续写入本会话。\n");
  await options.enterRepl();
}
