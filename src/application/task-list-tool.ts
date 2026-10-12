// 任务清单（决策 294 B1）：update_tasks 建立与更新、list_tasks 查看。只记录不调度——不派出、不按依赖排序或拦截；每项有标题与状态，
// 可选标注依赖的项与对应的 worker 标签。清单存进会话：每次更新后的整份清单随 update_tasks 的工具结果（details）写进会话文件，
// 续聊时从会话里最后一次更新还原。配置开关缺省开（设置的 orchestration 一节的 taskList），跑批器各条件不注册。
// 两件都是只读档：只改本会话内存里的清单，不读写工作区，不经审批。说明文字为定稿原文（决策 428 起为英文）。
// 清单的排版（renderTaskList）同时给模型（工具结果）与人（/tasks）看，为英文。
import { type Static, Type } from "typebox";
import type { AgentMessage } from "../pi-runtime/index.ts";
import type { ToolRegistration } from "../tools/registry.ts";
import type { PigeonAgentTool, PigeonToolResult } from "../tools/wrap.ts";

export const UPDATE_TASKS_TOOL = "update_tasks";
export const LIST_TASKS_TOOL = "list_tasks";

export const TASK_STATUSES = ["pending", "in_progress", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const STATUS_WORD: Readonly<Record<TaskStatus, string>> = {
  pending: "pending",
  in_progress: "in progress",
  done: "done",
  dropped: "dropped",
};

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn?: string[];
  workerLabel?: string;
}

export const UPDATE_TASKS_DESCRIPTION =
  "Record or update the task list: break the work into items, each with a title and a status (pending, in progress, done, dropped), optionally noting which items it depends on and which worker label is responsible for it. This is only a record; nothing is spawned or scheduled automatically. Give an id to update that item; omit it to create a new one. Returns the whole list.";

export const LIST_TASKS_DESCRIPTION = "Show the current task list.";

const StatusSchema = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("done"),
    Type.Literal("dropped"),
  ],
  {
    description:
      "pending: not started; in_progress: in progress; done: completed; dropped: abandoned",
  }
);

export const UpdateTasksParamsSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({ description: "The id of the item to update; omit to create a new item" })
      ),
      title: Type.Optional(Type.String({ description: "Title (required when creating an item)" })),
      status: Type.Optional(StatusSchema),
      depends_on: Type.Optional(
        Type.Array(Type.String(), {
          description: "ids of the items this one depends on (record only)",
        })
      ),
      worker_label: Type.Optional(
        Type.String({
          description:
            "Label of the worker responsible for this item (the label given to spawn_worker)",
        })
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
          throw new TaskListError(
            `There is no item with id ${change.id}; to create a new item, omit id`
          );
        }
        if (change.title !== undefined) {
          if (change.title.trim() === "") throw new TaskListError("The title cannot be empty");
          item.title = change.title.trim();
        }
        if (change.status !== undefined) item.status = change.status;
        if (change.depends_on !== undefined) item.dependsOn = [...change.depends_on];
        if (change.worker_label !== undefined) item.workerLabel = change.worker_label;
        continue;
      }
      const title = change.title?.trim() ?? "";
      if (title === "") {
        throw new TaskListError("A new item needs a title");
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
    return "The task list is empty.";
  }
  return items
    .map(
      (item) =>
        `${item.id}. [${STATUS_WORD[item.status]}] ${item.title}` +
        (item.dependsOn !== undefined && item.dependsOn.length > 0
          ? ` (depends on ${item.dependsOn.join(", ")})`
          : "") +
        (item.workerLabel !== undefined ? ` (worker label ${item.workerLabel})` : "")
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
