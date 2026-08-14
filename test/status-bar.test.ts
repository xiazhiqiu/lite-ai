import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ChatMessage } from '../src/types.js'
import { ToolRegistry } from '../src/tool.js'
import { runAgentTurn } from '../src/agent-loop.js'
import {
  buildAgentStatusBar,
  isStatusBarEnabled,
  formatElapsed,
} from '../src/utils/status-bar.js'

const readTool = {
  name: 'read_file',
  description: 'read',
  inputSchema: {},
  schema: z.object({ path: z.string() }),
  run: (input: { path: string }) => ({ ok: true, output: input.path }),
}

function makeRegistry() {
  return new ToolRegistry([readTool])
}

test('buildAgentStatusBar: 格式为键值 + agent_status 包裹', () => {
  const bar = buildAgentStatusBar({
    time: '2026-08-14 10:00:00',
    elapsed: '3m12s',
    toolUsage: '3 (read_file:2, grep_files:1)',
    ctx: '42% (normal)',
    cwd: '/proj',
  })
  assert.ok(bar.startsWith('<agent_status>'))
  assert.ok(bar.endsWith('</agent_status>'))
  assert.ok(bar.includes('time: 2026-08-14 10:00:00'))
  assert.ok(bar.includes('elapsed: 3m12s'))
  assert.ok(bar.includes('tools: 3 (read_file:2, grep_files:1)'))
  assert.ok(bar.includes('ctx: 42% (normal)'))
  assert.ok(bar.includes('cwd: /proj'))
})

test('isStatusBarEnabled: 默认关闭，置 1 开启', () => {
  delete process.env.LITE_AI_STATUS_BAR
  assert.equal(isStatusBarEnabled(), false)
  process.env.LITE_AI_STATUS_BAR = '1'
  assert.equal(isStatusBarEnabled(), true)
  delete process.env.LITE_AI_STATUS_BAR
})

test('formatElapsed', () => {
  assert.equal(formatElapsed(0), '0s')
  assert.equal(formatElapsed(5000), '5s')
  assert.equal(formatElapsed(192000), '3m12s')
  assert.equal(formatElapsed(-100), '0s')
})

test('状态栏瞬态注入：model 收到，返回 messages 不含', async () => {
  process.env.LITE_AI_STATUS_BAR = '1'
  try {
    let receivedMsgs: ChatMessage[] | null = null
    let called = 0
    const adapter = {
      async next(messages: ChatMessage[]) {
        called += 1
        if (called === 1) {
          receivedMsgs = messages
          return {
            type: 'tool_calls' as const,
            calls: [{ id: 'r1', toolName: 'read_file', input: { path: 'a' } }],
          }
        }
        return { type: 'assistant' as const, content: 'done', kind: 'final' as const }
      },
    }

    const result = await runAgentTurn({
      model: adapter,
      tools: makeRegistry(),
      messages: [],
      cwd: '/proj',
      modelName: 'test-model',
    })

    // model 第一次 next 收到的最后一条是状态栏块
    assert.ok(receivedMsgs)
    const last = receivedMsgs![receivedMsgs!.length - 1]!
    assert.equal(last.role, 'user')
    assert.match(String(last.content), /<agent_status>/)
    assert.match(String(last.content), /cwd: \/proj/)

    // 返回的 messages 不含状态栏块（瞬态验证）
    assert.equal(result.some(m => String(m.content).includes('<agent_status>')), false)
  } finally {
    delete process.env.LITE_AI_STATUS_BAR
  }
})

test('状态栏注入携带工具计数', async () => {
  process.env.LITE_AI_STATUS_BAR = '1'
  try {
    let receivedMsgs: ChatMessage[] | null = null
    let called = 0
    const adapter = {
      async next(messages: ChatMessage[]) {
        called += 1
        if (called === 1) {
          return {
            type: 'tool_calls' as const,
            calls: [
              { id: 'r1', toolName: 'read_file', input: { path: 'a' } },
              { id: 'r2', toolName: 'read_file', input: { path: 'b' } },
            ],
          }
        }
        receivedMsgs = messages
        return { type: 'assistant' as const, content: 'done', kind: 'final' as const }
      },
    }

    await runAgentTurn({
      model: adapter,
      tools: makeRegistry(),
      messages: [],
      cwd: '/proj',
      modelName: 'test-model',
    })

    // 第二轮状态栏应包含已执行的 read_file:2
    assert.ok(receivedMsgs)
    const last = receivedMsgs![receivedMsgs!.length - 1]!
    assert.match(String(last.content), /tools: 2 \(read_file:2\)/)
  } finally {
    delete process.env.LITE_AI_STATUS_BAR
  }
})