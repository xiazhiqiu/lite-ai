import path from 'node:path'
import { LITE_AI_TODOS_DIR } from '../config.js'
import { MAX_SUB_AGENTS } from '../agents/types.js'
import {
  AbortMutationError,
  atomicWriteJsonFile,
  mutateJsonFile,
  readJsonDegraded,
} from './json-file.js'

export { AbortMutationError }

export const TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
] as const

export type TodoStatus = (typeof TODO_STATUSES)[number]

export type TodoItem = {
  id: string
  content: string
  status: TodoStatus
  timestamp?: string
}

export type TodoList = {
  project: string
  updatedAt: string
  todos: TodoItem[]
}

/** env 开关，默认关闭。置 LITE_AI_TASKS=1 启用 TODO 工具与注入。 */
export function isTodosEnabled(): boolean {
  return process.env.LITE_AI_TASKS === '1'
}

/** 由 cwd 派生项目标识（与 session.ts 的 projectDirName 同一规则），保证跨 session 共享同一份 TODO。 */
export function todoProjectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

export function todosFilePath(cwd: string): string {
  return path.join(LITE_AI_TODOS_DIR, `${todoProjectSlug(cwd)}.json`)
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (TODO_STATUSES as readonly string[]).includes(value)
}

export function emptyTodoList(cwd: string): TodoList {
  return {
    project: todoProjectSlug(cwd),
    updatedAt: new Date().toISOString(),
    todos: [],
  }
}

function isTodoListShape(value: unknown): value is TodoList {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as TodoList).todos)
  )
}

export async function readTodos(cwd: string): Promise<TodoList> {
  return readJsonDegraded(
    todosFilePath(cwd),
    isTodoListShape,
    () => emptyTodoList(cwd),
  )
}

export async function saveTodos(cwd: string, list: TodoList): Promise<void> {
  await atomicWriteJsonFile(todosFilePath(cwd), {
    ...list,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * 原子"读改写成"：进程内按文件串行 read → mutate → 原子写。
 * mutate 内 `throw new AbortMutationError()` 可中止且不落盘。
 */
export async function updateTodos(
  cwd: string,
  mutate: (current: TodoList) => void,
): Promise<TodoList> {
  return mutateJsonFile(
    todosFilePath(cwd),
    isTodoListShape,
    () => emptyTodoList(cwd),
    cur => {
      mutate(cur)
      cur.updatedAt = new Date().toISOString()
    },
  )
}

function countStatus(list: TodoList, status: TodoStatus): number {
  return list.todos.filter(item => item.status === status).length
}

/** 校验结构：字段类型、status 枚举、in_progress 有界并行（≤ MAX_SUB_AGENTS）。 */
export function validateTodoList(list: TodoList): string | null {
  for (const item of list.todos) {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return 'Each todo item must have a non-empty string "id".'
    }
    if (typeof item.content !== 'string') {
      return `Todo "${item.id}" must have a string "content".`
    }
    if (!isTodoStatus(item.status)) {
      return `Todo "${item.id}" has invalid status "${String(item.status)}". Must be one of: ${TODO_STATUSES.join(', ')}.`
    }
  }

  const inProgress = countStatus(list, 'in_progress')
  if (inProgress > MAX_SUB_AGENTS) {
    return `Too many in_progress todos (${inProgress}). At most ${MAX_SUB_AGENTS} may be in_progress at once (parallel capacity). Mark others pending or completed first.`
  }

  return null
}