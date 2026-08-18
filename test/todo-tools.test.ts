import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'
import type { ToolContext } from '../src/tool.js'

let tempRoot: string
const ctx: ToolContext = { cwd: 'D:/dev/lite-ai' }

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-todo-'))
  process.env.LITE_AI_HOME = tempRoot
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempRoot, { recursive: true, force: true })
})

async function registry() {
  const { rewriteTodoListTool } = await import('../src/tools/todo-write.js')
  const { updateTodoStatusTool } = await import('../src/tools/todo-status.js')
  return new ToolRegistry([rewriteTodoListTool, updateTodoStatusTool])
}

test('isTodosEnabled: 默认关闭，置 1 开启', async () => {
  const { isTodosEnabled } = await import('../src/utils/todo-store.js')
  delete process.env.LITE_AI_TASKS
  assert.equal(isTodosEnabled(), false)
  process.env.LITE_AI_TASKS = '1'
  assert.equal(isTodosEnabled(), true)
  delete process.env.LITE_AI_TASKS
})

test('todoProjectSlug / todosFilePath: 项目标识与路径', async () => {
  const { todoProjectSlug, todosFilePath } = await import('../src/utils/todo-store.js')
  assert.equal(todoProjectSlug('D:/dev/lite-ai'), 'D-dev-lite-ai')
  assert.equal(todoProjectSlug('C:\\work\\proj'), 'C-work-proj')
  const file = todosFilePath('D:/dev/lite-ai')
  assert.ok(file.endsWith('.json'))
  assert.ok(file.includes('lite-ai-todo-'))
})

test('rewrite_todo_list: 创建清单并落盘，读回一致', async () => {
  const tools = await registry()
  const input = {
    todos: [
      { id: '1', content: 'Refactor auth', status: 'in_progress' },
      { id: '2', content: 'Add tests', status: 'pending' },
    ],
  }
  const result = await tools.execute('rewrite_todo_list', input, ctx)
  assert.equal(result.ok, true)

  const { readTodos } = await import('../src/utils/todo-store.js')
  const list = await readTodos(ctx.cwd)
  assert.equal(list.todos.length, 2)
  assert.equal(list.todos[0]!.id, '1')
  assert.equal(list.todos[0]!.status, 'in_progress')
})

test('rewrite_todo_list: in_progress 超过 3 拒绝且不落盘', async () => {
  const tools = await registry()
  const input = {
    todos: [
      { id: '1', content: 'a', status: 'in_progress' },
      { id: '2', content: 'b', status: 'in_progress' },
      { id: '3', content: 'c', status: 'in_progress' },
      { id: '4', content: 'd', status: 'in_progress' },
    ],
  }
  const result = await tools.execute('rewrite_todo_list', input, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /Too many in_progress/)
})

test('rewrite_todo_list: 非法 status 被 schema 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'rewrite_todo_list',
    { todos: [{ id: '1', content: 'a', status: 'done' }] },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /expected one of/)
})

test('update_todo_status: 未知 id 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'update_todo_status',
    { updates: [{ id: 'missing', status: 'completed' }] },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown todo id/)
})

test('update_todo_status: 合法更新并落盘', async () => {
  const tools = await registry()
  await tools.execute(
    'rewrite_todo_list',
    { todos: [{ id: '1', content: 'task', status: 'in_progress' }] },
    ctx,
  )
  const result = await tools.execute(
    'update_todo_status',
    { updates: [{ id: '1', status: 'completed' }] },
    ctx,
  )
  assert.equal(result.ok, true)

  const { readTodos } = await import('../src/utils/todo-store.js')
  const list = await readTodos(ctx.cwd)
  assert.equal(list.todos[0]!.status, 'completed')
})

test('update_todo_status: 更新后 in_progress 超过 3 拒绝', async () => {
  const tools = await registry()
  await tools.execute(
    'rewrite_todo_list',
    {
      todos: [
        { id: '1', content: 'a', status: 'in_progress' },
        { id: '2', content: 'b', status: 'in_progress' },
        { id: '3', content: 'c', status: 'in_progress' },
        { id: '4', content: 'd', status: 'pending' },
      ],
    },
    ctx,
  )
  const result = await tools.execute(
    'update_todo_status',
    { updates: [{ id: '4', status: 'in_progress' }] },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Too many in_progress/)
})

test('落盘文件为 JSON 且可读', async () => {
  const { todosFilePath } = await import('../src/utils/todo-store.js')
  const file = todosFilePath(ctx.cwd)
  const raw = await readFile(file, 'utf8')
  const parsed = JSON.parse(raw) as { todos: unknown[] }
  assert.ok(Array.isArray(parsed.todos))
})