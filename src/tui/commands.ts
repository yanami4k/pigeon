// 斜杠命令分发（决策 067 拆分自 shell.ts，零行为变化）：grant 命令层在 application/grants.ts
//（决策 030）、会话列表在 application/session-list.ts、检索在 application/search.ts、恢复流程在
// application/resume.ts——全部与 cli 同一份逻辑；语法/语义错误响亮呈现（同 REPL 口径），
// 未知命令如实说明。worker 与 resume 的具体动作由壳转交给对应视图模块。
import { compactFocusOf } from "../application/compaction-text.ts";
import { runGrantCommand } from "../application/grants.ts";
import { runSearchCommand } from "../application/search.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import { WORKER_COMMANDS_HINT } from "../application/workers-commands.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { TuiWorkersFace } from "./workers-view.ts";

// TUI 治理命令上下文（/grants /revoke /grants save；决策 030）
export interface TuiGrantsContext {
  root: string;
  store: SessionGrantStore;
  configRules: readonly ConfigGrantRule[];
}

// 壳侧窄接口：命令分发需要的当前会话上下文与壳动作
export interface CommandsHost {
  addSystem(line: string): void;
  render(): void;
  requestExit(): void;
  sessionId(): SessionId;
  grants(): TuiGrantsContext | undefined;
  workers(): TuiWorkersFace | undefined;
  sessionsRoot(): string | undefined;
  searchRoot(): string | undefined;
  resumeConfigured(): boolean;
  spawnCommand(workers: TuiWorkersFace, raw: string): void;
  cancelCommand(workers: TuiWorkersFace, ref: string | undefined): void;
  workersStatusCommand(workers: TuiWorkersFace): void;
  resumeCommand(arg: string | undefined): void;
  compactCommand(focus: string | undefined): void;
}

export function handleSlashCommand(host: CommandsHost, value: string): void {
  const tokens = value
    .slice(1)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const grants = host.grants();
  try {
    // S5+（裁决 033）：/quit 与双击 Ctrl+C 同一优雅退出路径（busy 语义不开旁路：
    // 运行中提交在 handleSubmit 即被拒绝，退出键仍可用）
    if (tokens[0] === "quit") {
      host.requestExit();
      return;
    }
    // S4：/sessions 会话列表——只读渲染，命令层与 cli 同一份（零新治理语义）
    const sessionsRoot = host.sessionsRoot();
    if (tokens[0] === "sessions" && sessionsRoot !== undefined) {
      host.addSystem(runSessionListCommand({ root: sessionsRoot }).trimEnd());
      host.render();
      return;
    }
    // M5 S2（决策 038）：/search 内容级检索——命令层与 cli 同一份；异步扫描完成后落消息区
    const searchRoot = host.searchRoot();
    if (tokens[0] === "search" && searchRoot !== undefined) {
      void runSearchCommand({ root: searchRoot, args: tokens.slice(1) }).then(
        (text) => {
          host.addSystem(text.trimEnd());
          host.render();
        },
        (error: unknown) => {
          host.addSystem(`命令失败：${error instanceof Error ? error.message : String(error)}`);
          host.render();
        }
      );
      return;
    }
    // M5.5 S4（决策 040）：worker 编排命令——解析与排版在 application/workers-commands.ts
    const workers = host.workers();
    // M7（决策 079）：/fork 手动分叉——分支在独立工作树里续跑，跑完回报
    if (workers?.fork !== undefined && tokens[0] === "fork") {
      host.addSystem("分叉中：分支在独立工作树里续跑，完成后回报");
      void workers.fork(value.trim().slice("/fork".length)).then(
        (text) => {
          host.addSystem(text);
          host.render();
        },
        (error: unknown) => {
          host.addSystem(`分叉失败：${error instanceof Error ? error.message : String(error)}`);
          host.render();
        }
      );
      return;
    }
    if (workers !== undefined && tokens[0] === "spawn") {
      host.spawnCommand(workers, value.trim().slice("/spawn".length));
      return;
    }
    if (workers !== undefined && tokens[0] === "cancel") {
      host.cancelCommand(workers, tokens[1]);
      return;
    }
    if (workers !== undefined && tokens[0] === "workers") {
      host.workersStatusCommand(workers);
      return;
    }
    // 决策 189：/compact [重点] 手动压缩（重点作为摘要的附加说明）
    if (tokens[0] === "compact") {
      host.compactCommand(compactFocusOf(value));
      return;
    }
    // S4：/resume <sessionId> 冷恢复对账 + 换绑续跑（异步流程，见 resume-view.ts）
    if (tokens[0] === "resume" && host.resumeConfigured()) {
      host.resumeCommand(tokens[1]);
      return;
    }
    const handled =
      grants !== undefined &&
      runGrantCommand(tokens, {
        root: grants.root,
        store: grants.store,
        configRules: grants.configRules,
        sessionId: host.sessionId(),
        write: (text) => {
          host.addSystem(text.trimEnd());
        },
      });
    if (!handled) {
      host.addSystem(
        `未知命令：${value}（可用 /quit、/compact [重点]、/sessions、/resume <sessionId>、/search <关键词>、/grants、/revoke <id>、/grants save <id>${workers !== undefined ? WORKER_COMMANDS_HINT : ""}）`
      );
    }
  } catch (error) {
    host.addSystem(`命令失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
