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
  run: async (input: { path: string }) => ({
    ok: true,
    output: `read:${input.path}`,
  }),
}

const writeTool = {
  name: 'write_file',
  description: 'write',
  inputSchema: {},
  schema: z.object({ path: z.string() }),
  run: async (input: { path: string }) => ({
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

const SLOW_MS = 80

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** 带最大并发探针的慢工具：maxRunning 是「是否真并行」的确定性证据（不依赖墙钟）。 */
function makeSlowRegistry() {
  const probe = { running: 0, maxRunning: 0 }
  const slowRead = {
    name: 'slow_read',
    description: 'slow read',
    inputSchema: {},
    schema: z.object({ path: z.string() }),
    isParallelSafe: () => true,
    run: async (input: { path: string }) => {
      probe.running += 1
      probe.maxRunning = Math.max(probe.maxRunning, probe.running)
      await sleep(SLOW_MS)
      probe.running -= 1
      return { ok: true, output: `slow:${input.path}` }
    },
  }
  return { registry: new ToolRegistry([slowRead]), probe }
}

function slowCalls(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    toolName: 'slow_read',
    input: { path: `p${i}` },
  }))
}

test('并发开启：慢工具真并行（maxRunning = 调用数，而非 1）', async () => {
  process.env.LITE_AI_TOOL_CONCURRENCY = '1'
  delete process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT
  try {
    const { registry, probe } = makeSlowRegistry()
    const started = Date.now()
    await runAgentTurn({
      model: makeAdapter({ type: 'tool_calls', calls: slowCalls(3) }),
      tools: registry,
      messages: [],
      cwd: process.cwd(),
    })
    const elapsed = Date.now() - started

    assert.equal(probe.maxRunning, 3, '三个只读工具应同时在飞')
    assert.ok(elapsed < SLOW_MS * 3, `并行应快于串行(${SLOW_MS * 3}ms)，实测 ${elapsed}ms`)
  } finally {
    delete process.env.LITE_AI_TOOL_CONCURRENCY
  }
})

test('并发开启：LITE_AI_TOOL_CONCURRENCY_LIMIT 限住同时在飞数', async () => {
  process.env.LITE_AI_TOOL_CONCURRENCY = '1'
  process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT = '2'
  try {
    const { registry, probe } = makeSlowRegistry()
    await runAgentTurn({
      model: makeAdapter({ type: 'tool_calls', calls: slowCalls(6) }),
      tools: registry,
      messages: [],
      cwd: process.cwd(),
    })

    assert.equal(probe.maxRunning, 2, '上限为 2 时不应出现第 3 个在飞调用')
  } finally {
    delete process.env.LITE_AI_TOOL_CONCURRENCY
    delete process.env.LITE_AI_TOOL_CONCURRENCY_LIMIT
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

test('并发关闭：慢工具 maxRunning = 1（确认开关确实是总闸）', async () => {
  delete process.env.LITE_AI_TOOL_CONCURRENCY
  const { registry, probe } = makeSlowRegistry()
  await runAgentTurn({
    model: makeAdapter({ type: 'tool_calls', calls: slowCalls(3) }),
    tools: registry,
    messages: [],
    cwd: process.cwd(),
  })

  assert.equal(probe.maxRunning, 1, '开关关闭时即便工具声明 safe 也必须串行')
})