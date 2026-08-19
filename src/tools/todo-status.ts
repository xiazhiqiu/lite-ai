import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import {
  AbortMutationError,
  type TodoItem,
  type TodoList,
  TODO_STATUSES,
  isTodoStatus,
  updateTodos,
  validateTodoList,
} from '../utils/todo-store.js'
import { formatTodoList } from './todo-write.js'

type Update = {
  id: string
  status: string
}

type Input = {
  updates: Update[]
}

function applyStatusUpdates(list: TodoList, updates: Update[]): string | null {
  const byId = new Map(list.todos.map(item => [item.id, item]))
  for (const update of updates) {
    const item = byId.get(update.id)
    if (!item) {
      return `Unknown todo id "${update.id}". Use rewrite_todo_list to add it, or check the current list:\n${formatTodoList(list.todos)}`
    }
    if (!isTodoStatus(update.status)) {
      return `Invalid status "${update.status}" for "${update.id}". Must be one of: ${TODO_STATUSES.join(', ')}`
    }
    item.status = update.status
    item.timestamp = new Date().toISOString()
  }
  return null
}

export const updateTodoStatusTool: ToolDefinition<Input> = {
  name: 'update_todo_status',
  description:
    'Update the status of one or more existing todos by id. Use when a sub-task completes (completed), you start it (in_progress, at most 3 at once), or it becomes blocked/abandoned (cancelled). Only ids that already exist in the plan are accepted.',
  inputSchema: {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: [...TODO_STATUSES] },
          },
          required: ['id', 'status'],
        },
      },
    },
    required: ['updates'],
  },
  schema: z.object({
    updates: z.array(
      z.object({
        id: z.string().min(1),
        status: z.enum(TODO_STATUSES),
      }),
    ),
  }),
  async run(input, context) {
    let failure: string | null = null
    const list = await updateTodos(context.cwd, cur => {
      const error = applyStatusUpdates(cur, input.updates)
      if (error) {
        failure = error
        throw new AbortMutationError()
      }
      const validationError = validateTodoList(cur)
      if (validationError) {
        failure = validationError
        throw new AbortMutationError()
      }
    })
    if (failure) {
      return { ok: false, output: failure }
    }
    return {
      ok: true,
      output: `TODO statuses updated (${input.updates.length}). Current plan:\n${formatTodoList(list.todos)}`,
    }
  },
}

export function summarizeTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return '(empty)'
  return formatTodoList(todos)
}