import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIModelAdapter } from '../src/openai-adapter.js'
import { ToolRegistry } from '../src/tool.js'
import type { RuntimeConfig } from '../src/config.js'
import type { ChatMessage, ToolCall } from '../src/types.js'
import { z } from 'zod'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const runtime: RuntimeConfig = {
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.test',
  apiKey: 'test-key',
  mcpServers: {},
  sourceSummary: 'test',
}

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'System' },
  { role: 'user', content: 'Do the thing' },
]

function chunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
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
  const adapter = new OpenAIModelAdapter(tools, async () => runtime)
  return { tools, adapter }
}

test('OpenAI SSE: index 前进时 flush 前序调用，finish 时兜底 flush', async () => {
  const readyCalls: ToolCall[] = []
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      chunk({
        choices: [{ index: 0, delta: { role: 'assistant', content: '查一下。' } }],
      }),
      // call 0 开始
      chunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_0',
              type: 'function',
              function: { name: 'echo_tool', arguments: '' },
            }],
          },
        }],
      }),
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"value":"x"}' } }] },
        }],
      }),
      // call 1 开始（首 delta 即带部分参数）→ 触发 call 0 flush
      chunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 1,
              id: 'call_1',
              type: 'function',
              function: { name: 'echo_tool', arguments: '{"val' },
            }],
          },
        }],
      }),
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 1, function: { arguments: 'ue":"a"}' } }] },
        }],
      }),
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      chunk({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
      'data: [DONE]\n\n',
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
  })

  assert.equal(readyCalls.length, 2)
  assert.deepEqual(readyCalls[0], { id: 'call_0', toolName: 'echo_tool', input: { value: 'x' } })
  assert.deepEqual(readyCalls[1], { id: 'call_1', toolName: 'echo_tool', input: { value: 'a' } })
  assert.equal(step.type, 'tool_calls')
  if (step.type === 'tool_calls') {
    assert.equal(step.calls.length, 2)
    assert.equal(step.content, '查一下。')
    assert.equal(step.diagnostics?.stopReason, 'tool_calls')
  }
  assert.deepEqual(step.usage, {
    inputTokens: 20,
    outputTokens: 8,
    totalTokens: 28,
    source: 'openai',
  })
})

test('OpenAI SSE: reasoning_content 增量累积为 thinking 块（DeepSeek）', async () => {
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      chunk({
        choices: [{ index: 0, delta: { reasoning_content: '推理' } }],
      }),
      chunk({
        choices: [{ index: 0, delta: { reasoning_content: '第一段' } }],
      }),
      chunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'echo_tool', arguments: '{"value":"b"}' } }] } }],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, { onToolCallReady: () => {} })

  assert.equal(step.type, 'tool_calls')
  assert.deepEqual(step.thinkingBlocks, [{ type: 'thinking', text: '推理第一段' }])
})

test('OpenAI SSE: 截断且已触发工具回调 → 部分步骤返回不抛', async () => {
  const readyCalls: ToolCall[] = []
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'echo_tool', arguments: '{"value":"c"}' } }] },
        }],
      }),
      // 新 index 未出现、finish 未到 → 流被截断
    ])) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
  })

  assert.equal(readyCalls.length, 1)
  assert.equal(step.type, 'tool_calls')
  if (step.type === 'tool_calls') {
    assert.equal(step.diagnostics?.stopReason, 'stream_error')
  }
})

test('OpenAI SSE: 截断且未触发工具回调 → 上抛', async () => {
  const { adapter } = makeAdapter()

  globalThis.fetch = (async () =>
    sseResponse([
      chunk({
        choices: [{ index: 0, delta: { content: 'partial' } }],
      }),
    ])) as typeof fetch

  await assert.rejects(
    () => adapter.next(MESSAGES, { onToolCallReady: () => {} }),
    /提前结束/,
  )
})

test('OpenAI SSE: fetch 阶段 500 仍走重试', async () => {
  const { adapter } = makeAdapter()
  let calls = 0

  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'server error' } }), {
        status: 500,
      })
    }
    return sseResponse([
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_r', type: 'function', function: { name: 'echo_tool', arguments: '{"value":"d"}' } }] },
        }],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
  }) as typeof fetch

  const step = await adapter.next(MESSAGES, { onToolCallReady: () => {} })

  assert.equal(calls, 2)
  assert.equal(step.type, 'tool_calls')
})

test('OpenAI SSE: 网关无视 stream 返回 JSON → 降级非流式解析', async () => {
  const readyCalls: ToolCall[] = []
  const { adapter } = makeAdapter()
  let sawStreamRequest = false

  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sawStreamRequest = (JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean }).stream === true
    // 模拟兼容网关：无视 stream 参数，直接回 JSON
    return new Response(
      JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'call_j', type: 'function', function: { name: 'echo_tool', arguments: '{"value":"g"}' } }],
          },
        }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
      { status: 200 },
    )
  }) as typeof fetch

  const step = await adapter.next(MESSAGES, {
    onToolCallReady: call => readyCalls.push(call),
  })

  assert.equal(sawStreamRequest, true, '请求确实带了 stream:true')
  assert.equal(step.type, 'tool_calls')
  assert.equal(readyCalls.length, 0, '降级路径不触发流式回调')
  if (step.type === 'tool_calls') {
    assert.deepEqual(step.calls, [
      { id: 'call_j', toolName: 'echo_tool', input: { value: 'g' } },
    ], '降级路径下调用完整返回，由 agent-loop 兜底注册交付')
  }
})

test('OpenAI SSE: 未传 onToolCallReady → 非流式请求体；传了 → stream + include_usage', async () => {
  const { adapter } = makeAdapter()
  const bodies: unknown[] = []

  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      )
    }
    return sseResponse([
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])
  }) as typeof fetch

  await adapter.next(MESSAGES)
  await adapter.next(MESSAGES, { onToolCallReady: () => {} })

  const first = bodies[0] as { stream?: boolean }
  const second = bodies[1] as { stream?: boolean; stream_options?: { include_usage?: boolean } }
  assert.equal(first.stream, undefined)
  assert.equal(second.stream, true)
  assert.equal(second.stream_options?.include_usage, true)
})
