import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicModelAdapter } from '../src/anthropic-adapter.js'
import { ToolRegistry } from '../src/tool.js'
import type { RuntimeConfig } from '../src/config.js'
import type { ChatMessage, ToolCall } from '../src/types.js'
import { z } from 'zod'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const runtime: RuntimeConfig = {
  model: 'claude-test',
  baseUrl: 'https://api.anthropic.test',
  apiKey: 'test-key',
  mcpServers: {},
  sourceSummary: 'test',
}

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'System' },
  { role: 'user', content: 'Do the thing' },
]

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of frames) controller.enqueue(encoder.encode(item))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeAdapter() {
  const tools = new ToolRegistry([
    {
      name: 'echo_tool',
      description: 'Echo tool for tests',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      schema: z.object({ value: z.string() }),
      async run(input) {
        return { ok: true, output: input.value }
      },
    },
  ])
  const adapter = new AnthropicModelAdapter(tools, async () => runtime)
  return { tools, adapter }
}

test('Anthropic SSE: tool_use 参数分片拼装完成后触发 onToolCallReady，步骤组装完整', async () => {
  const readyCalls: ToolCall[] = []
  const textDeltas: string[] = []
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 10 } },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '先查一下 ' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '文件。' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo_tool' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"val' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'ue":"hi"}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 42 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
    onTextDelta: text => textDeltas.push(text),
  })

  assert.deepEqual(readyCalls, [
    { id: 'toolu_1', toolName: 'echo_tool', input: { value: 'hi' } },
  ])
  assert.equal(step.type, 'tool_calls')
  if (step.type === 'tool_calls') {
    assert.deepEqual(step.calls, readyCalls)
    assert.equal(step.content, '先查一下 文件。')
    assert.equal(step.diagnostics?.stopReason, 'tool_use')
  }
  assert.deepEqual(textDeltas, ['先查一下 ', '文件。'])
  assert.deepEqual(step.usage, {
    inputTokens: 110,
    outputTokens: 42,
    totalTokens: 152,
    source: 'anthropic',
  })
})

test('Anthropic SSE: thinking + signature 增量保留进 thinkingBlocks', async () => {
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 50 } },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '考中' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-1' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'echo_tool' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"value":"x"}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: () => {},
  })

  assert.equal(step.type, 'tool_calls')
  assert.deepEqual(step.thinkingBlocks, [
    { type: 'thinking', thinking: '思考中', signature: 'sig-1' },
  ])
})

test('Anthropic SSE: thinking 增量透传 onThinkingDelta', async () => {
  const thinkingDeltas: string[] = []
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '考中' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])) as typeof fetch

  await adapter.next(MESSAGES, {
    onThinkingDelta: text => thinkingDeltas.push(text),
  })

  assert.deepEqual(thinkingDeltas, ['思', '考中'])
})

test('Anthropic SSE: 断流且已触发工具回调 → 部分步骤返回不抛（防孤儿 tool_use）', async () => {
  const readyCalls: ToolCall[] = []
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 10 } },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_3', name: 'echo_tool' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"value":"y"}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      // 此后流异常中断（不发 message_stop）
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
  })

  assert.equal(readyCalls.length, 1)
  assert.equal(step.type, 'tool_calls')
  if (step.type === 'tool_calls') {
    assert.equal(step.calls.length, 1)
    assert.equal(step.diagnostics?.stopReason, 'stream_error')
  }
})

test('Anthropic SSE: 流内 error 事件且未触发工具回调 → 上抛', async () => {
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 10 } },
      }),
      frame('error', {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    ])) as typeof fetch

  await assert.rejects(
    () => adapter.next(MESSAGES, { onToolCallReady: () => {} }),
    /Overloaded/,
  )
})

test('Anthropic SSE: 参数 JSON 损坏 → 回调仍触发但 input 置空（fail-closed）', async () => {
  const readyCalls: ToolCall[] = []
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_4', name: 'echo_tool' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"value' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 3 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
  })

  assert.deepEqual(readyCalls, [{ id: 'toolu_4', toolName: 'echo_tool', input: {} }])
  assert.equal(step.type, 'tool_calls')
})

test('Anthropic SSE: fetch 阶段 429 仍走重试，第二次成功', async () => {
  const readyCalls: ToolCall[] = []
  const { adapter } = makeAdapter()
  let calls = 0

  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'retry-after': '0' },
      })
    }
    return sseResponse([
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_5', name: 'echo_tool' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"value":"z"}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])
  }) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
  })

  assert.equal(calls, 2)
  assert.equal(step.type, 'tool_calls')
  assert.deepEqual(readyCalls, [
    { id: 'toolu_5', toolName: 'echo_tool', input: { value: 'z' } },
  ])
})

test('Anthropic SSE: 未传 onToolCallReady → 走非流式分支（请求体无 stream 字段）', async () => {
  const { adapter } = makeAdapter()
  const bodies: unknown[] = []

  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(
      JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    )
  }) as typeof fetch

  const step = await adapter.next(MESSAGES)

  assert.equal((bodies[0] as { stream?: boolean }).stream, undefined)
  assert.equal(step.type, 'assistant')
  if (step.type === 'assistant') {
    assert.equal(step.content, 'done')
  }
})

test('Anthropic SSE: 传 onToolCallReady → 请求体带 stream:true', async () => {
  const { adapter } = makeAdapter()
  const bodies: unknown[] = []

  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return sseResponse([
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])
  }) as typeof fetch

  await adapter.next(MESSAGES, { onToolCallReady: () => {} })

  assert.equal((bodies[0] as { stream?: boolean }).stream, true)
})
