// 任务清单（决策 294 B1）：update_tasks 建立与更新、list_tasks 查看。只记录不调度——不派出、不按依赖排序或拦截；每项有标题与状态，
// 可选标注依赖的项与对应的 worker 标签。清单存进会话：每次更新后的整份清单随 update_tasks 的工具结果（details）写进会话文件，
// 续聊时从会话里最后一次更新还原。配置开关缺省开（设置的 orchestration 一节的 taskList），跑批器各条件不注册。
// 两件都是只读档：只改本会话内存里的清单，不读写工作区，不经审批。说明文字为定稿原文。
import { type Static, Type } from "typebox";
import type { AgentMessage } from "../pi-runtime/index.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";

export const UPDATE_TASKS_TOOL = "update_tasks";
export const LIST_TASKS_TOOL = "list_tasks";

export const TASK_STATUSES = ["pending", "in_progress", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const STATUS_WORD: Readonly<Record<TaskStatus, string>> = {
  pending: "待办",
  in_progress: "进行中",
  done: "完成",
  dropped: "放弃",
};

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn?: string[];
  workerLabel?: string;
}

export const UPDATE_TASKS_DESCRIPTION =
  "记下或更新任务清单：把要做的事拆成几项，每项一个标题与状态（待办、进行中、完成、放弃），可注明依赖哪几项、由哪个 worker 标签负责。只作记录，不会自动派出或调度。给出 id 即更新该项，不给即新建。返回整份清单。";

export const LIST_TASKS_DESCRIPTION = "查看当前的任务清单。";

const StatusSchema = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("done"),
    Type.Literal("dropped"),
  ],
  { description: "pending 待办、in_progress 进行中、done 完成、dropped 放弃" }
);

export const UpdateTasksParamsSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.Optional(Type.String({ description: "要更新的项的 id；不给即新建一项" })),
      title: Type.Optional(Type.String({ description: "标题（新建时必填）" })),
      status: Type.Optional(StatusSchema),
      depends_on: Type.Optional(
        Type.Array(Type.String(), { description: "依赖的项的 id（只作记录）" })
      ),
      worker_label: Type.Optional(
        Type.String({ description: "负责这一项的 worker 的标签（spawn_worker 的 label）" })
      ),
    }),
    { minItems: 1 }
  ),
});
export type UpdateTasksParams = Static<typeof UpdateTasksParamsSchema>;

export const ListTasksParamsSchema = Type.Object({});

export class TaskListError extends Error {}

// 本会话的清单（内存里一份；每次更新的整份随工具结果写进会话）
export class TaskList {
  #items: TaskItem[] = [];
  #nextId = 1;

  items(): TaskItem[] {
    return structuredClone(this.#items);
  }

  // 整批校验后一次写入：任何一项不成立即整批不改
  update(params: UpdateTasksParams): TaskItem[] {
    const next = structuredClone(this.#items);
    let nextId = this.#nextId;
    for (const change of params.tasks) {
      if (change.id !== undefined) {
        const item = next.find((entry) => entry.id === change.id);
        if (item === undefined) {
          throw new TaskListError(`没有 id 为 ${change.id} 的项；新建请不给 id`);
        }
        if (change.title !== undefined) {
          if (change.title.trim() === "") throw new TaskListError("标题不能为空");
          item.title = change.title.trim();
        }
        if (change.status !== undefined) item.status = change.status;
        if (change.depends_on !== undefined) item.dependsOn = [...change.depends_on];
        if (change.worker_label !== undefined) item.workerLabel = change.worker_label;
        continue;
      }
      const title = change.title?.trim() ?? "";
      if (title === "") {
        throw new TaskListError("新建的项要有标题");
      }
      next.push({
        id: String(nextId),
        title,
        status: change.status ?? "pending",
        ...(change.depends_on !== undefined ? { dependsOn: [...change.depends_on] } : {}),
        ...(change.worker_label !== undefined ? { workerLabel: change.worker_label } : {}),
      });
      nextId += 1;
    }
    this.#items = next;
    this.#nextId = nextId;
    return this.items();
  }

  // 从会话还原：取最后一次 update_tasks 工具结果里的整份清单
  restore(messages: readonly AgentMessage[]): void {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined || message.role !== "toolResult") continue;
      if (message.toolName !== UPDATE_TASKS_TOOL) continue;
      const tasks = (message.details as { tasks?: unknown } | undefined)?.tasks;
      if (!Array.isArray(tasks)) continue;
      this.#items = structuredClone(tasks as TaskItem[]);
      this.#nextId = this.#items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
      return;
    }
  }
}

export function renderTaskList(items: readonly TaskItem[]): string {
  if (items.length === 0) {
    return "任务清单是空的。";
  }
  return items
    .map(
      (item) =>
        `${item.id}. [${STATUS_WORD[item.status]}] ${item.title}` +
        (item.dependsOn !== undefined && item.dependsOn.length > 0
          ? `（依赖 ${item.dependsOn.join("、")}）`
          : "") +
        (item.workerLabel !== undefined ? `（worker 标签 ${item.workerLabel}）` : "")
    )
    .join("\n");
}

function reply<T>(text: string, details: T): PigeonToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

export function createTaskListTools(
  list: TaskList
): [
  PigeonAgentTool<typeof UpdateTasksParamsSchema, { tasks: TaskItem[] }>,
  PigeonAgentTool<typeof ListTasksParamsSchema, { tasks: TaskItem[] }>,
] {
  return [
    {
      name: UPDATE_TASKS_TOOL,
      label: UPDATE_TASKS_TOOL,
      description: UPDATE_TASKS_DESCRIPTION,
      parameters: UpdateTasksParamsSchema,
      executionMode: "sequential",
      async execute(_id, params) {
        // 校验不过即抛：上游转成错误结果交回模型，清单不变
        const tasks = list.update(params);
        return reply(renderTaskList(tasks), { tasks });
      },
    },
    {
      name: LIST_TASKS_TOOL,
      label: LIST_TASKS_TOOL,
      description: LIST_TASKS_DESCRIPTION,
      parameters: ListTasksParamsSchema,
      executionMode: "sequential",
      async execute() {
        const tasks = list.items();
        return reply(renderTaskList(tasks), { tasks });
      },
    },
  ];
}

export function taskListRegistrations(): ToolRegistration[] {
  const base = {
    tier: "read" as const,
    pathConfinement: { kind: "none" as const },
    executionMode: "sequential" as const,
  };
  return [
    {
      name: UPDATE_TASKS_TOOL,
      description: "记下或更新任务清单",
      parameters: UpdateTasksParamsSchema,
      ...base,
    },
    {
      name: LIST_TASKS_TOOL,
      description: "查看任务清单",
      parameters: ListTasksParamsSchema,
      ...base,
    },
  ];
}
