import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { PermissionManager } from '../src/permissions.js'

const originalLiteAiHome = process.env.LITE_AI_HOME
let tempRoots: string[] = []

afterEach(async () => {
  if (originalLiteAiHome === undefined) {
    delete process.env.LITE_AI_HOME
  } else {
    process.env.LITE_AI_HOME = originalLiteAiHome
  }
  tempRoots = []
})

async function createManager(): Promise<PermissionManager> {
  const root = await mkdtemp(join(tmpdir(), 'liteai-perm-'))
  tempRoots.push(root)
  process.env.LITE_AI_HOME = root
  const manager = new PermissionManager(root)
  await manager.whenReady()
  return manager
}

test('noticeToolRepeat: 相同工具+输入连续达阈值返回提示', async () => {
  const m = await createManager()
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // 1
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // 2
  assert.match(m.noticeToolRepeat('read_file', { path: '/a' })!, /已连续出现 3 次/) // 3
  assert.match(m.noticeToolRepeat('read_file', { path: '/a' })!, /已连续出现 4 次/) // 4
})

test('noticeToolRepeat: 到达阈值后仍不拦截（返回提示但调用方能继续）', async () => {
  const m = await createManager()
  m.noticeToolRepeat('run_command', { command: 'ls' })
  m.noticeToolRepeat('run_command', { command: 'ls' })
  const third = m.noticeToolRepeat('run_command', { command: 'ls' })
  // 绝不返回拦截信号，只返回提示文案（或 null）
  assert.ok(typeof third === 'string' || third === null)
})

test('noticeToolRepeat: 中间插入不同调用则清零重计', async () => {
  const m = await createManager()
  m.noticeToolRepeat('read_file', { path: '/a' })
  m.noticeToolRepeat('read_file', { path: '/a' })
  m.noticeToolRepeat('grep', { path: '/a' }) // 不同调用
  // 回到 read_file /a 重新从 1 计数，前两次不计入
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // 1
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // 2
  assert.match(m.noticeToolRepeat('read_file', { path: '/a' })!, /已连续出现 3 次/) // 3
})

test('noticeToolRepeat: 相同工具不同输入互不干扰', async () => {
  const m = await createManager()
  // /a 提前累积 2 次
  m.noticeToolRepeat('read_file', { path: '/a' })
  m.noticeToolRepeat('read_file', { path: '/a' })
  // 换输入 /b：触发清零，/a 的计数被重置
  assert.equal(m.noticeToolRepeat('read_file', { path: '/b' }), null)
  // 回到 /a：从 0 重新连续累积
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // /a 重新 1
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // /a 重新 2
  assert.match(m.noticeToolRepeat('read_file', { path: '/a' })!, /3 次/) // /a 重新到 3
})

test('noticeToolRepeat: beginTurn 清空回合内计数', async () => {
  const m = await createManager()
  m.noticeToolRepeat('read_file', { path: '/a' })
  m.noticeToolRepeat('read_file', { path: '/a' })
  m.beginTurn()
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }), null) // 重新 1
})

test('noticeToolRepeat: 自定义阈值生效', async () => {
  const m = await createManager()
  const threshold = 5
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }, threshold), null)
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }, threshold), null)
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }, threshold), null)
  assert.equal(m.noticeToolRepeat('read_file', { path: '/a' }, threshold), null)
  assert.match(m.noticeToolRepeat('read_file', { path: '/a' }, threshold)!, /5 次/)
})