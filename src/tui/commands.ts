// 斜杠命令分发（决策 067 拆分自 shell.ts，零行为变化）：grant 命令层在 application/grants.ts
//（决策 030）、会话列表在 application/session-list.ts、检索在 application/search.ts、恢复流程在
// application/resume.ts——全部与 cli 同一份逻辑；语法/语义错误响亮呈现（同 REPL 口径），
// 未知命令如实说明。worker 与 resume 的具体动作由壳转交给对应视图模块。
// 决策 286：未知命令列出的可用命令从命令表（command-table.ts）按当前会话生成，以后加命令不再漏。
import { compactFocusOf } from "../application/compaction-text.ts";
import { runGrantCommand } from "../application/grants.ts";
import { MEMORY_COMMAND_USAGE } from "../application/memory-command.ts";
import {
  SANDBOX_FORK_UNSUPPORTED,
  SANDBOX_RESUME_UNSUPPORTED,
  SANDBOX_WORKERS_UNSUPPORTED,
} from "../application/sandbox-session.ts";
import { SCRIPT_COMMAND_TEXTS, type ScriptCommands } from "../application/script-commands.ts";
import { commandInputText } from "../application/script-texts.ts";
import { runSearchCommand } from "../application/search.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ConfigGrantRule } from "../state/grants.ts";
import type { SessionId } from "../state/ids.ts";
import type { LayeredGrantRule } from "../state/settings.ts";
import {
  type CommandAvailability,
  unknownCommandText,
  WORKER_SESSION_ONLY,
} from "./command-table.ts";
import { renderHooksView, type TuiHooksFace } from "./hooks-view.ts";
import type { TuiWorkersFace } from "./workers-view.ts";

// 沙箱会话的命令面（与 shell.ts 的 TuiSandboxFace 同形）
interface CommandsSandboxFace {
  exportChanges(): Promise<string>;
}

// 决策 331：/memory 的命令面——查看两层记忆、按层编辑（编辑期间界面暂停，编辑器退出后恢复）
export interface TuiMemoryFace {
  view(): string;
  edit(layer: "project" | "user"): Promise<string>;
}

// TUI 治理命令上下文（/grants /revoke /grants save；决策 030）
export interface TuiGrantsContext {
  root: string;
  store: SessionGrantStore;
  configRules: readonly ConfigGrantRule[];
  // 决策 325：放权规则连同所在层与层内序号（/grants 按层列出）
  layeredRules?: readonly LayeredGrantRule[];
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
  // 决策 237：沙箱会话在场；缺省 = 不在沙箱里
  sandbox?(): CommandsSandboxFace | undefined;
  spawnCommand(workers: TuiWorkersFace, raw: string): void;
  cancelCommand(workers: TuiWorkersFace, ref: string | undefined): void;
  workersStatusCommand(workers: TuiWorkersFace): void;
  // 决策 279：/take <worker 名>
  takeCommand(workers: TuiWorkersFace, name: string | undefined): void;
  resumeCommand(arg: string | undefined): void;
  compactCommand(focus: string | undefined): void;
  // 决策 340：/reload 重读设置（装配方给了重载入口才在场）
  readonly reloadCommand?: ((args: readonly string[]) => void) | undefined;
  // 决策 294 B1：任务清单（排好的文字）；undefined = 清单没开；缺省 = /tasks 不可用
  tasks?(): string | undefined;
  // 决策 301：/agents 切换树形视图
  toggleTree?(): void;
  // 决策 309：脚本编排的命令面（缺省 = /orchestrate 不可用）与以人的输入提交一条（空闲即发、运行中排队）
  scriptCommands?(): ScriptCommands | undefined;
  submitInput?(text: string): void;
  // 决策 323、324：本会话的钩子面（/hooks 的只读清单）；缺省 = /hooks 不可用
  hooksView?(): TuiHooksFace | undefined;
  // 决策 331：/memory 的命令面（缺省 = /memory 不可用）
  memory?(): TuiMemoryFace | undefined;
}

// 命令表判断可用性用的只读面
export function commandAvailability(host: CommandsHost): CommandAvailability {
  return {
    sessionsRoot: () => host.sessionsRoot(),
    searchRoot: () => host.searchRoot(),
    resumeConfigured: () => host.resumeConfigured(),
    hasGrants: () => host.grants() !== undefined,
    inSandbox: () => host.sandbox?.() !== undefined,
    tasks: () => host.tasks !== undefined,
    reload: () => host.reloadCommand !== undefined,
    hooks: () => host.hooksView?.() !== undefined,
    scripts: () => host.scriptCommands?.() !== undefined,
    memory: () => host.memory?.() !== undefined,
    workers: () => {
      const workers = host.workers();
      return workers === undefined
        ? undefined
        : { fork: workers.fork !== undefined, take: workers.take !== undefined };
    },
  };
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
    // 决策 237、245：沙箱会话——/export 手动交回；分叉、worker 与 /resume 换绑不支持，说明原因
    const sandbox = host.sandbox?.();
    if (sandbox !== undefined) {
      if (tokens[0] === "export") {
        host.addSystem("交回中：把沙箱里的改动提交成分支取回宿主仓库");
        void sandbox.exportChanges().then(
          (text) => {
            host.addSystem(text);
            host.render();
          },
          (error: unknown) => {
            host.addSystem(`交回失败：${error instanceof Error ? error.message : String(error)}`);
            host.render();
          }
        );
        return;
      }
      const reason =
        tokens[0] === "fork"
          ? SANDBOX_FORK_UNSUPPORTED
          : tokens[0] === "spawn" ||
              tokens[0] === "cancel" ||
              tokens[0] === "workers" ||
              tokens[0] === "take"
            ? SANDBOX_WORKERS_UNSUPPORTED
            : tokens[0] === "resume"
              ? SANDBOX_RESUME_UNSUPPORTED
              : undefined;
      if (reason !== undefined) {
        host.addSystem(reason);
        return;
      }
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
    // 决策 301：/agents 切换树形视图；/stop 与 /approve 在 worker 会话里用（主会话里说明怎么进入）
    if (workers !== undefined && tokens[0] === "agents" && host.toggleTree !== undefined) {
      host.toggleTree();
      return;
    }
    if (workers !== undefined && (tokens[0] === "stop" || tokens[0] === "approve")) {
      host.addSystem(WORKER_SESSION_ONLY);
      return;
    }
    // 决策 279：/take <worker 名> 把已收尾 worker 自己的改动叠进工作目录
    if (workers !== undefined && tokens[0] === "take") {
      host.takeCommand(workers, tokens[1]);
      return;
    }
    // 决策 294 B1：/tasks 查看任务清单（完整的清单显示留给编排二段）
    if (tokens[0] === "tasks" && host.tasks !== undefined) {
      host.addSystem(
        host.tasks() ?? "任务清单没有开（设置 orchestration 一节的 taskList 为 false）。"
      );
      return;
    }
    // 决策 309、312、301：/orchestrate——发起即以人的输入提交（交给模型的文字带关键词，点名由程序判断）；续跑、停止、放弃由程序直接做
    const scripts = host.scriptCommands?.();
    if (tokens[0] === "orchestrate" && scripts !== undefined) {
      const sub = tokens[1];
      const done = (text: string) => {
        host.addSystem(text);
        host.render();
      };
      const failed = (error: unknown) =>
        done(`命令失败：${error instanceof Error ? error.message : String(error)}`);
      if (sub === "resume" || sub === "drop") {
        const runId = tokens[2];
        if (runId === undefined) {
          host.addSystem(SCRIPT_COMMAND_TEXTS.usage);
        } else if (sub === "drop") {
          host.addSystem(scripts.drop(runId));
        } else {
          void scripts.resume(runId, tokens.slice(3).join(" ")).then(done, failed);
        }
        return;
      }
      if (sub === "stop") {
        void scripts.stop(tokens[2]).then(done, failed);
        return;
      }
      const task = value.trim().slice("/orchestrate".length).trim();
      if (task === "" || host.submitInput === undefined) {
        host.addSystem(SCRIPT_COMMAND_TEXTS.usage);
        return;
      }
      host.submitInput(commandInputText(task));
      return;
    }
    // 决策 331：/memory 查看两层记忆；/memory edit project|user 用编辑器修改一层（存盘后校验，不合格保留原内容）
    const memory = host.memory?.();
    if (tokens[0] === "memory" && memory !== undefined) {
      if (tokens.length === 1) {
        host.addSystem(memory.view());
        return;
      }
      const layer = tokens[2];
      if (
        tokens[1] === "edit" &&
        tokens.length === 3 &&
        (layer === "project" || layer === "user")
      ) {
        void memory.edit(layer).then(
          (text) => {
            host.addSystem(text);
            host.render();
          },
          (error: unknown) => {
            host.addSystem(`命令失败：${error instanceof Error ? error.message : String(error)}`);
            host.render();
          }
        );
        return;
      }
      host.addSystem(MEMORY_COMMAND_USAGE);
      return;
    }
    // 决策 189：/compact [重点] 手动压缩（重点作为摘要的附加说明）
    if (tokens[0] === "compact") {
      host.compactCommand(compactFocusOf(value));
      return;
    }
    // 决策 323、324：/hooks 只读列出生效的钩子与停用开关（清单随会话冻结，清单与开关取自钩子面）
    if (tokens[0] === "hooks") {
      const hooks = host.hooksView?.();
      if (hooks !== undefined) {
        host.addSystem(renderHooksView(hooks));
        return;
      }
    }
    // 决策 340：/reload 重读设置（结果与待确认条目写进消息区）
    if (tokens[0] === "reload" && host.reloadCommand !== undefined) {
      host.reloadCommand(tokens.slice(1));
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
        ...(grants.layeredRules !== undefined ? { layeredRules: grants.layeredRules } : {}),
        sessionId: host.sessionId(),
        write: (text) => {
          host.addSystem(text.trimEnd());
        },
      });
    if (!handled) {
      host.addSystem(unknownCommandText(value, commandAvailability(host)));
    }
  } catch (error) {
    host.addSystem(`命令失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
