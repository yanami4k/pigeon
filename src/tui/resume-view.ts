// resume 与历史渲染（决策 067 拆分自 shell.ts）：/resume <sessionId> 的续跑流程在 application/resume.ts
// （报告将还原的对话上下文与悬空的工具调用 → 换绑运行面，运行面装配时还原上下文，决策 183）；enterRepl 钩子 = 换绑运行面续跑
//（同 sessionId 续写会话文件）。历史投影在 application/history.ts（与 cli --with-content 同一份）。
// 换绑产物对本模块不透明（泛型）：壳持有运行面类型，本模块只把它原样交回壳的换绑动作。
import { loadSessionHistory } from "../application/history.ts";
import { runResumeFlow } from "../application/resume.ts";
import { asSessionId, type SessionId } from "../state/ids.ts";

// /resume 换绑产物（S4）：目标会话的新运行面与新治理上下文。装配由调用方（main.ts）完成——
// restoredGrants 种子还原、buildRuntime、旧运行面释放都在壳外；壳只换绑投影
export interface SessionBinding<Runtime, Grants, Workers> {
  runtime: Runtime;
  grants?: Grants;
  // M5.5 S4：目标会话的 worker 编排面（worker 会话的编排面按深度 1 拒绝再派）
  workers?: Workers;
}

// S4：/resume <sessionId> 恢复入口配置（壳选项的一段）
export interface ResumeOptions<Binding> {
  root: string;
  rebind: (sessionId: SessionId) => Binding | Promise<Binding>;
}

// 壳侧窄接口：resume 视图需要的壳状态与壳动作（resuming 状态由壳持有）
export interface ResumeViewHost<Binding> {
  isStarted(): boolean;
  addSystem(line: string): void;
  addHistoryLines(lines: ReturnType<typeof loadSessionHistory>): void;
  render(): void;
  updateStatus(): void;
  setResuming(resuming: boolean): void;
  sessionId(): SessionId;
  hasRunningWorkers(): boolean;
  resumeOptions(): ResumeOptions<Binding> | undefined;
  historyLimit(): number | undefined;
  rebindSession(sessionId: SessionId, binding: Binding): void;
}

export function handleResumeCommand<Binding>(
  host: ResumeViewHost<Binding>,
  arg: string | undefined
): void {
  const resume = host.resumeOptions();
  if (resume === undefined) {
    host.addSystem(
      `未知命令：/resume（可用 /quit、/sessions、/grants、/revoke <id>、/grants save <id>）`
    );
    return;
  }
  if (arg === undefined) {
    host.addSystem("用法：/resume <sessionId>");
    return;
  }
  // 恢复当前会话会让两个写者写同一个会话文件——且语义上无意义（人就活在该会话里）：响亮拒绝
  if (arg === host.sessionId()) {
    host.addSystem(`已在会话 ${arg} 中，无需恢复`);
    return;
  }
  // M5.5 S4（决策 040）：worker 的收尾记录写在当前会话文件里——有 worker 在跑时换绑会让它们
  // 写向已关闭的会话，响亮拒绝
  if (host.hasRunningWorkers()) {
    host.addSystem("有 worker 仍在运行：先 /cancel 或等其收尾，再 /resume");
    return;
  }
  host.setResuming(true);
  host.updateStatus();
  host.render();
  const finish = (error?: unknown): void => {
    host.setResuming(false);
    if (error !== undefined) {
      host.addSystem(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
    host.updateStatus();
    host.render();
  };
  void runResumeFlow({
    root: resume.root,
    sessionId: arg,
    write: (text) => {
      host.addSystem(text.trimEnd());
      host.render();
    },
    // 续跑：换绑运行面（grant 种子、上下文还原与新运行面的装配在壳外的
    // rebind 工厂，同 cli resume 的 enterRepl 配方）；壳已停止则换绑无意义
    enterRepl: async () => {
      if (!host.isStarted()) return;
      const sessionId = asSessionId(arg);
      const binding = await resume.rebind(sessionId);
      host.rebindSession(sessionId, binding);
      // M5 S2（决策 045）：换绑后渲染该会话全部历史（正文、thinking 与治理投影时序交织）
      renderHistory(host, resume.root, sessionId);
    },
  }).then(
    () => finish(),
    (error: unknown) => finish(error)
  );
}

// 历史渲染（M5 S2，决策 045）：投影在 application/history.ts（与 cli --with-content 同一份），
// 壳只排版；渲染失败如实呈现，不影响已完成的换绑（续跑照常可用）
export function renderHistory<Binding>(
  host: ResumeViewHost<Binding>,
  root: string,
  sessionId: SessionId
): void {
  try {
    const limit = host.historyLimit();
    const lines = loadSessionHistory(root, sessionId, limit !== undefined ? { limit } : {});
    host.addSystem(`== 历史：会话 ${sessionId}（${lines.length} 行）==`);
    host.addHistoryLines(lines);
    host.addSystem("== 历史结束，以下为续跑 ==");
  } catch (error) {
    host.addSystem(`历史渲染失败：${error instanceof Error ? error.message : String(error)}`);
  }
  host.render();
}
