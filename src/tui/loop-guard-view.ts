// 终端界面里主 agent 的打转检测（决策 305–307）：提醒进模型的下一轮，同时原文在消息区显示成系统消息（同 worker 通知的样式，
// 不显示成人输入的话）；叫停时消息区写明检测到打转、重复的调用与轮数，同 Esc 中断本轮（原因记为打转），会话照常可用。
// 壳晚于运行面构造：还没有壳时叫停直接中断运行面
import {
  attachLoopGuard,
  LOOP_GUARD_TEXTS,
  type LoopGuardTarget,
} from "../application/loop-guard.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { RunStopCause } from "../state/session-entries.ts";

export interface LoopGuardShell {
  addSystem(line: string): void;
  stopForLoop(text: string): void;
  render(): void;
}

export function guardTuiAgent(input: {
  runtime: LoopGuardTarget & { interrupt(cause?: RunStopCause): Promise<void> };
  settings: LoopGuardSettings | undefined;
  shell: () => LoopGuardShell | undefined;
}): () => void {
  const { runtime } = input;
  return attachLoopGuard(
    runtime,
    input.settings,
    (found) => {
      const shell = input.shell();
      if (shell === undefined) {
        void runtime.interrupt("looping").catch(() => {});
        return;
      }
      shell.stopForLoop(LOOP_GUARD_TEXTS.tuiStopped(found));
      shell.render();
    },
    (text) => {
      const shell = input.shell();
      shell?.addSystem(text);
      shell?.render();
    }
  );
}
