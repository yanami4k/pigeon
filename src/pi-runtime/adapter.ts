// PiRuntimeAdapter（ROADMAP M1）：把 pi-agent-core 的 Agent 藏在闭包内，
// 业务层只接触 Adapter 方法。核心约束：
// 1. streamFn 永远显式传入，不依赖包内默认（stream-fn.js 的 getDefaultStreamFn 缺省陷阱）；
// 2. 成败不看 prompt() 的 Promise（失败路径照常 resolve），看末条 assistant 消息的 stopReason
//    + state.errorMessage；
// 3. 内部事件记录与对外订阅全部自包 try/catch——上游 processEvents 顺序 await listener 且无
//    防护，一个抛异常的 listener 会把健康 Run 毒化成 error 终态；
// 4. 注入快照在构造时深冻结；Agent 实例不外泄，hook 字段因此不可被运行中改写；
// 5. 中断固定姿势：abort() → waitForIdle()，终态 stopReason === "aborted"，任何路径不悬挂。
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, StopReason } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { EventEnvelope } from "../state/events.ts";
import { newRunId, newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import { isSyntheticFailureMessage, normalizePiEvent } from "./events.ts";
import { type InjectionSnapshot, InjectionSnapshotSchema } from "./snapshot.ts";

// Run 终态：completed / failed / aborted 之外保留 unknown——
// ROADMAP M1 要求“中断和异常能够得到明确终态或 OutcomeUnknown”，
// 当 transcript 里连一条 assistant 消息都没有（或终态 stopReason 不在预期集合内）时如实上报。
export type RunTerminalStatus = "completed" | "failed" | "aborted" | "unknown";

export interface RunResult {
  runId: RunId;
  status: RunTerminalStatus;
  // 末条 assistant 消息的 stopReason（若有）
  stopReason?: StopReason;
  // 最近一次失败/中止 turn 的错误文本（agent.state.errorMessage）
  errorMessage?: string;
  // 末条 assistant 消息是否为上游合成的失败消息
  syntheticFailure: boolean;
  // 本次 Run 实际广告给模型的工具名单（M1 恒为空）
  advertisedTools: string[];
}

export interface PiRuntimeAdapterOptions {
  snapshot: InjectionSnapshot;
  // 永远显式传入；测试注入假 streamFn，生产注入真实 provider 实现
  streamFn: StreamFn;
  // 真实部署时补充 api/baseUrl 等模型元数据；provider/id 属于模型身份，
  // 由 InjectionSnapshot 唯一提供（类型层 Omit 拒绝 + 构造器运行期兜底）
  model?: Omit<Partial<Model<Api>>, "provider" | "id">;
  sessionId?: SessionId;
}

export class PiRuntimeAdapter {
  readonly sessionId: SessionId;
  readonly #agent: Agent;
  readonly #snapshot: InjectionSnapshot;
  readonly #events: EventEnvelope[] = [];
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  readonly #listenerErrors: unknown[] = [];
  readonly #unsubscribe: () => void;
  #currentRunId: RunId | null = null;
  #disposed = false;

  constructor(options: PiRuntimeAdapterOptions) {
    // 运行期兜底（JS 调用方可绕过类型门）：options.model 不得携带模型身份字段，
    // 否则 spread 会让实际 Agent 模型与 InjectionSnapshot 脱钩
    if (options.model !== undefined && ("provider" in options.model || "id" in options.model)) {
      throw new Error(
        "options.model 不允许携带 provider/id：模型身份由 InjectionSnapshot 唯一提供"
      );
    }
    // 运行期校验 + 防御性拷贝 + 深冻结：此后快照不可变
    const snapshot = Value.Parse(InjectionSnapshotSchema, options.snapshot);
    this.#snapshot = deepFreeze(structuredClone(snapshot));
    this.sessionId = options.sessionId ?? newSessionId();
    this.#agent = new Agent({
      streamFn: options.streamFn,
      initialState: {
        systemPrompt: this.#snapshot.context.systemPrompt,
        model: {
          id: this.#snapshot.model.id,
          name: this.#snapshot.model.id,
          api: "unknown",
          provider: this.#snapshot.model.provider,
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 0,
          maxTokens: 0,
          ...options.model,
        },
        // M1 无工具执行：模型可请求的能力清单恒为空
        tools: [],
      },
    });
    // 内部订阅挂一次，覆盖 Adapter 整个生命周期；回调绝不抛异常
    this.#unsubscribe = this.#agent.subscribe((event: AgentEvent) => {
      this.#recordAndForward(event);
    });
  }

  // 启动一次 Run 并等待其彻底收尾；返回终态判定结果。
  async run(input: string): Promise<RunResult> {
    this.#assertUsable();
    const runId = newRunId();
    this.#currentRunId = runId;
    // 实际广告名单以 Run 启动时 Agent 持有的工具为准（上游对此拍快照，运行中改不动）
    const advertisedTools = this.#agent.state.tools.map((tool) => tool.name);
    try {
      await this.#agent.prompt(input);
      await this.#agent.waitForIdle();
      return this.#judgeTerminal(runId, advertisedTools);
    } finally {
      this.#currentRunId = null;
    }
  }

  // 中断当前 Run：固定姿势 abort → waitForIdle；终态由并发等待的 run() 返回承载。
  async interrupt(): Promise<void> {
    this.#agent.abort();
    await this.#agent.waitForIdle();
  }

  // 观察口：归一化后的 Pigeon Runtime Event 序列（拷贝，不外泄内部数组）
  events(): EventEnvelope[] {
    return this.#events.slice();
  }

  // 观察口：订阅归一化事件；listener 抛异常被吞掉并记录，绝不影响 Run
  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // 被吞掉的 listener 异常记录（含内部归一化异常）
  listenerErrors(): unknown[] {
    return this.#listenerErrors.slice();
  }

  // 冻结的注入快照
  snapshot(): InjectionSnapshot {
    return this.#snapshot;
  }

  // Pi transcript 的深拷贝（观察用途；它不是治理事实源，权威状态以事件日志为准）。
  // 必须深拷贝：浅拷贝会与 Agent 内部共享 message/content 对象，
  // 调用方在观察拷贝上的就地修改会污染 Agent 会话状态，进而毒化后续 Run 的上下文。
  // 拷贝不冻结：观察方对自己的副本做变换是合法的。
  transcript(): AgentMessage[] {
    return structuredClone(this.#agent.state.messages);
  }

  isRunning(): boolean {
    return this.#agent.state.isStreaming;
  }

  // 释放：中止可能的在途 Run，退订并清空外部 listener
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#agent.abort();
    await this.#agent.waitForIdle();
    this.#unsubscribe();
    this.#listeners.clear();
  }

  // Pi 事件入口：归一化 + 落日志 + 转发。整个路径自包 try/catch，
  // 任何异常（含归一化自身）都只进 listenerErrors，绝不冒泡回上游毒化 Run。
  #recordAndForward(event: AgentEvent): void {
    try {
      const runId = this.#currentRunId;
      if (!runId) {
        return;
      }
      const normalized = normalizePiEvent(event, { sessionId: this.sessionId, runId });
      if (!normalized) {
        return;
      }
      // 单一冻结点：日志与 listener 共享同一冻结对象，事件日志按治理语义不可变。
      // 篡改尝试在严格模式下抛 TypeError，被下方 listener 自包 try/catch 吞进 listenerErrors。
      this.#events.push(deepFreeze(normalized));
      for (const listener of this.#listeners) {
        try {
          listener(normalized);
        } catch (error) {
          this.#listenerErrors.push(error);
        }
      }
    } catch (error) {
      this.#listenerErrors.push(error);
    }
  }

  // 终态判定：以末条 assistant 消息的 stopReason 为准，agent_end/prompt() resolve 均无成败语义
  #judgeTerminal(runId: RunId, advertisedTools: string[]): RunResult {
    const messages = this.#agent.state.messages;
    const lastAssistant = messages.findLast(
      (message): message is AssistantMessage => message.role === "assistant"
    );
    const stopReason = lastAssistant?.stopReason;
    const errorMessage = this.#agent.state.errorMessage;
    let status: RunTerminalStatus;
    if (stopReason === "aborted") {
      status = "aborted";
    } else if (stopReason === "error") {
      status = "failed";
    } else if (stopReason === "stop" || stopReason === "length" || stopReason === "deferred") {
      status = "completed";
    } else {
      status = "unknown";
    }
    return {
      runId,
      status,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      syntheticFailure: lastAssistant !== undefined && isSyntheticFailureMessage(lastAssistant),
      advertisedTools,
    };
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error("PiRuntimeAdapter 已释放，不能再启动 Run");
    }
  }
}

// 递归冻结快照（含嵌套对象与数组）
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
