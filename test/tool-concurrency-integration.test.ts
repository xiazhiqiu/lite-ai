import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ChatMessage } from '../src/types.js'
import { ToolRegistry } from '../src/tool.js'
import { runAgentTurn } from '../src/agent-loop.js'
import type { ModelAdapter, AgentStep } from '../src/types.js'

// 一个可并发的读工具 + 一个不可并发的写工具
const readTool = {
  name: 'read_file',
  description: 'read',
  inputSchema: {},
  schema: z.object({ path: z.string() }),
  isParallelSafe: () => true,
  run: (input: { path: string }) => ({
    ok: true,
    output: `read:${input.path}`,
  }),
}

const writeTool = {
  name: 'write_file',
  description: 'write',
  inputSchema: {},
  schema: z.object({ path: z.string() }),
  run: (input: { path: string }) => ({
    ok: true,
    output: `write:${input.path}`,
  }),
}

function makeRegistry() {
  return new ToolRegistry([readTool, writeTool])
}

function makeAdapter(step: AgentStep): ModelAdapter {
  let called = 0
  return {
    async next() {
      called += 1
      if (called === 1) return step
      return { type: 'assistant', content: 'done', kind: 'final' }
    },
  }
}

function collectToolMsgIds(messages: ChatMessage[]): string[] {
  return messages
    .filter(m => m.role === 'tool_result')
    .map(m => (m as { toolUseId?: string }).toolUseId ?? '')
}

test('并发开启：tool_result 按 toolUseId 精确配对，无丢失', async () => {
  process.env.LITE_AI_TOOL_CONCURRENCY = '1'
  try {
    const messages: ChatMessage[] = []
    const result = await runAgentTurn({
      model: makeAdapter({
        type: 'tool_calls',
        calls: [
          { id: 'r1', toolName: 'read_file', input: { path: 'a' } },
          { id: 'r2', toolName: 'read_file', input: { path: 'b' } },
        ],
      }),
      tools: makeRegistry(),
      messages,
      cwd: process.cwd(),
    })

    const ids = collectToolMsgIds(result)
    assert.deepEqual(ids, ['r1', 'r2'])
  } finally {
    delete process.env.LITE_AI_TOOL_CONCURRENCY
  }
})

test('并发开启：写工具打断并行批并保持发射序', async () => {
  process.env.LITE_AI_TOOL_CONCURRENCY = '1'
  try {
    const messages: ChatMessage[] = []
    const result = await runAgentTurn({
      model: makeAdapter({
        type: 'tool_calls',
        calls: [
          { id: 'r1', toolName: 'read_file', input: { path: 'a' } },
          { id: 'w1', toolName: 'write_file', input: { path: 'b' } },
          { id: 'r2', toolName: 'read_file', input: { path: 'c' } },
        ],
      }),
      tools: makeRegistry(),
      messages,
      cwd: process.cwd(),
    })

    const ids = collectToolMsgIds(result)
    assert.deepEqual(ids, ['r1', 'w1', 'r2'])
  } finally {
    delete process.env.LITE_AI_TOOL_CONCURRENCY
  }
})

test('并发关闭：行为与旧一致（逐条串行）', async () => {
  delete process.env.LITE_AI_TOOL_CONCURRENCY
  const messages: ChatMessage[] = []
  const result = await runAgentTurn({
    model: makeAdapter({
      type: 'tool_calls',
      calls: [
        { id: 'r1', toolName: 'read_file', input: { path: 'a' } },
        { id: 'r2', toolName: 'read_file', input: { path: 'b' } },
      ],
    }),
    tools: makeRegistry(),
    messages,
    cwd: process.cwd(),
  })

  const ids = collectToolMsgIds(result)
  assert.deepEqual(ids, ['r1', 'r2'])
})