// test/monitor-assistant-decision.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnMonitor } from '../src/monitor/turn-monitor.js'
import type { AssistantContext } from '../src/monitor/types.js'

function monitor() {
  return createTurnMonitor({ toolRepeatNoticeMax: 99, consecutiveFailureMax: 99 })
}

function ctx(partial: Partial<AssistantContext> = {}): AssistantContext {
  return { content: '', isEmpty: true, sawToolResultThisTurn: false, toolErrorCount: 0, ...partial }
}

test('progress_continue: 模型标记 progress', () => {
  const m = monitor()
  const action = m.detectAssistant(ctx({ content: '进展', isEmpty: false, kind: 'progress' }))
  assert.equal(action.kind, 'progress_continue')
  assert.equal((action as { progress: string }).progress, '进展')
})

test('thinking_retry: pause_turn + thinking 空响应，达上限前续跑', () => {
  const m = monitor()
  for (let i = 0; i < 3; i++) {
    const action = m.detectAssistant(ctx({
      isEmpty: true,
      diagnostics: { stopReason: 'pause_turn', blockTypes: ['thinking'] },
    }))
    assert.equal(action.kind, 'thinking_retry')
  }
  // 第 4 次超过 3 次上限 → 落到 empty 分支
  const beyond = m.detectAssistant(ctx({ isEmpty: true, diagnostics: { stopReason: 'pause_turn', blockTypes: ['thinking'] } }))
  assert.equal(beyond.kind, 'empty_continue')
})

test('empty_continue: 空响应在第 1、2 次续跑', () => {
  const m = monitor()
  assert.equal(m.detectAssistant(ctx()).kind, 'empty_continue')
  assert.equal(m.detectAssistant(ctx()).kind, 'empty_continue')
})

test('empty_stop: 空响应第 3 次起停止并给 fallback', () => {
  const m = monitor()
  m.detectAssistant(ctx())
  m.detectAssistant(ctx())
  const stop = m.detectAssistant(ctx())
  assert.equal(stop.kind, 'empty_stop')
  assert.match((stop as { fallback: string }).fallback, /空响应/)
})

test('midtask_continue: 跑过工具后纯文本未标 final', () => {
  const m = monitor()
  const action = m.detectAssistant(ctx({ content: '未完', isEmpty: false, sawToolResultThisTurn: true }))
  assert.equal(action.kind, 'midtask_continue')
})

test('finish: 未跑工具 + 非空纯文本未标 final', () => {
  const m = monitor()
  const action = m.detectAssistant(ctx({ content: '答案', isEmpty: false }))
  assert.equal(action.kind, 'finish')
})