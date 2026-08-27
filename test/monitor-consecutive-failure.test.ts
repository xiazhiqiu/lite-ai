// test/monitor-consecutive-failure.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnMonitor } from '../src/monitor/turn-monitor.js'

function monitor() {
  return createTurnMonitor({ toolRepeatNoticeMax: 99, consecutiveFailureMax: 3 })
}

test('consecutive-failure: 连续失败达阈值返回提示', () => {
  const m = monitor()
  assert.equal(m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: false }), null)
  assert.equal(m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: false }), null)
  assert.match(m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: false })!, /已连续失败 3 次/)
  assert.match(m.observeToolCall({ toolName: 'run_command', input: { command: 'ls' }, ok: false })!, /已连续失败 4 次/)
})

test('consecutive-failure: 一次成功重置连续计数', () => {
  const m = monitor()
  m.observeToolCall({ toolName: 'a', input: null, ok: false })
  m.observeToolCall({ toolName: 'a', input: null, ok: false })
  assert.equal(m.observeToolCall({ toolName: 'a', input: null, ok: true }), null)
  assert.equal(m.observeToolCall({ toolName: 'a', input: null, ok: false }), null)
  assert.equal(m.observeToolCall({ toolName: 'a', input: null, ok: false }), null)
  assert.match(m.observeToolCall({ toolName: 'a', input: null, ok: false })!, /3 次/)
})

test('consecutive-failure: 自定义阈值生效', () => {
  const m = createTurnMonitor({ toolRepeatNoticeMax: 99, consecutiveFailureMax: 5 })
  for (let i = 0; i < 4; i++) {
    assert.equal(m.observeToolCall({ toolName: 'a', input: null, ok: false }), null)
  }
  assert.match(m.observeToolCall({ toolName: 'a', input: null, ok: false })!, /5 次/)
})