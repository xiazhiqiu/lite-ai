import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import {
  type TodoItem,
  TODO_STATUSES,
  readTodos,
  saveTodos,
  validateTodoList,
} from '../utils/todo-store.js'

type Input = {
  todos: TodoItem[]
}

export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return '(empty)'
  return todos
    .map(t => `- [${t.status}] ${t.id}: ${t.content}`)
    .join('\n')
}

export const rewriteTodoListTool: ToolDefinition<Input> = {
  name: 'rewrite_todo_list',
  description:
    'Replace the entire TODO plan for this project with the given list. Use for structural changes: creating the plan, adding/removing items, or reordering. Each item needs an "id", "content", and "status" (pending | in_progress | completed | cancelled). At most 3 items may be in_progress at once.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: [...TODO_STATUSES] },
            timestamp: { type: 'string' },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  schema: z.object({
    todos: z.array(
      z.object({
        id: z.string().min(1),
        content: z.string(),
        status: z.enum(TODO_STATUSES),
        timestamp: z.string().optional(),
      }),
    ),
  }),
  async run(input, context) {
    const list = await readTodos(context.cwd)
    const next = {
      project: list.project,
      updatedAt: new Date().toISOString(),
      todos: input.todos,
    }
    const error = validateTodoList(next)
    if (error) {
      return { ok: false, output: error }
    }
    await saveTodos(context.cwd, next)
    return {
      ok: true,
      output: `TODO list updated (${next.todos.length} items). Current plan:\n${formatTodoList(next.todos)}`,
    }
  },
}