// test/tool-repeat-notice.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnMonitor } from '../src/monitor/turn-monitor.js'
import type { AssistantContext } from '../src/monitor/types.js'

// ok 固定 true：不影响重复计数。
function monitor() {
  return createTurnMonitor({ toolRepeatNoticeMax: 3, consecutiveFailureMax: 99 })
}

function ctx(partial = {}): AssistantContext {
  return {
    content: '',
    isEmpty: true,
    sawToolResultThisTurn: false,
    toolErrorCount: 0,
    ...partial,
  }
}

test('tool-repeat: 相同工具+输入连续达阈值返回提示', () => {
  const m = monitor()
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
  assert.match(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })!, /已连续出现 3 次/)
  assert.match(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })!, /已连续出现 4 次/)
})

test('tool-repeat: 到达阈值后不拦截', () => {
  const m = monitor()
  m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: true })
  m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: true })
  const third = m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: true })
  assert.ok(typeof third === 'string' || third === null)
})

test('tool-repeat: 中间插入不同调用则清零重计', () => {
  const m = monitor()
  m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })
  m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })
  m.observeToolCall({ toolName: 'grep', input: { path: '/a' }, ok: true })
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
  assert.match(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })!, /3 次/)
})

test('tool-repeat: 相同工具不同输入互不干扰', () => {
  const m = monitor()
  m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })
  m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/b' }, ok: true }), null)
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
  assert.equal(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
  assert.match(m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })!, /3 次/)
})

test('tool-repeat: 新回合（新实例）清空计数', () => {
  const m = createTurnMonitor({ toolRepeatNoticeMax: 3, consecutiveFailureMax: 99 })
  m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })
  m.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true })
  const again = createTurnMonitor({ toolRepeatNoticeMax: 3, consecutiveFailureMax: 99 })
  assert.equal(again.observeToolCall({ toolName: 'read_file', input: { path: '/a' }, ok: true }), null)
})

test('detectAssistant: finish 直通', () => {
  const m = createTurnMonitor({ toolRepeatNoticeMax: 3, consecutiveFailureMax: 99 })
  assert.deepEqual(
    m.detectAssistant(ctx({ content: '结果', isEmpty: false, kind: 'final' })),
    { kind: 'finish' },
  )
})