import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIModelAdapter } from '../src/openai-adapter.js'
import { ToolRegistry } from '../src/tool.js'
import type { ChatMessage, ModelToolDefinition } from '../src/types.js'
import type { RuntimeConfig } from '../src/config.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function runtime(): RuntimeConfig {
  return {
    provider: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    mcpServers: {},
    sourceSummary: 'test',
  }
}

function adapter(): OpenAIModelAdapter {
  return new OpenAIModelAdapter(new ToolRegistry([]), async () => runtime())
}

function captureFetch(): { url: string; headers: Record<string, string>; body: unknown } {
  const captured: { url: string; headers: Record<string, string>; body: unknown } = {
    url: '',
    headers: {},
    body: null,
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input)
    captured.headers = (init?.headers ?? {}) as Record<string, string>
    captured.body = init?.body ? JSON.parse(String(init.body)) : null
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '<final>done' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200 })
  }) as typeof fetch
  return captured
}

describe('OpenAI model adapter', () => {
  it('posts to /chat/completions with bearer auth and converted messages', async () => {
    const captured = captureFetch()
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]

    await adapter().next(messages)

    assert.equal(captured.url, 'https://example.test/v1/chat/completions')
    assert.equal(captured.headers.Authorization, 'Bearer test-key')
    const body = captured.body as { model: string; messages: Array<{ role: string; content: unknown }> }
    assert.equal(body.model, 'test-model')
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('merges consecutive tool calls and emits tool-role results', async () => {
    const captured = captureFetch()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant_tool_call',
        toolUseId: 'call-1',
        toolName: 'read_file',
        input: { path: 'a' },
      },
      {
        role: 'assistant_tool_call',
        toolUseId: 'call-2',
        toolName: 'list_files',
        input: {},
      },
      {
        role: 'tool_result',
        toolUseId: 'call-1',
        toolName: 'read_file',
        content: 'content-a',
        isError: false,
      },
      {
        role: 'tool_result',
        toolUseId: 'call-2',
        toolName: 'list_files',
        content: 'content-b',
        isError: false,
      },
    ]

    await adapter().next(messages)

    const body = captured.body as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find(
      m => m.role === 'assistant' && Array.isArray(m.tool_calls),
    ) as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
    assert.equal(assistant.tool_calls.length, 2)
    assert.equal(assistant.tool_calls[0].id, 'call-1')
    assert.equal(assistant.tool_calls[0].function.name, 'read_file')
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: 'a' })

    const toolResults = body.messages.filter(m => m.role === 'tool')
    assert.equal(toolResults.length, 2)
    assert.equal(toolResults[0].tool_call_id, 'call-1')
    assert.equal(toolResults[0].content, 'content-a')
  })

  it('parses tool_calls, reasoning, usage and diagnostics from the response', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: 'let me read',
            reasoning_content: 'thinking...',
            tool_calls: [
              {
                id: 'call-9',
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'x' }) },
              },
            ],
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 7 },
      }), { status: 200 })
    }) as typeof fetch

    const step = await adapter().next([{ role: 'user', content: 'go' }])

    assert.equal(step.type, 'tool_calls')
    if (step.type !== 'tool_calls') return
    assert.equal(step.calls.length, 1)
    assert.deepEqual(step.calls[0], { id: 'call-9', toolName: 'read_file', input: { path: 'x' } })
    assert.equal(step.thinkingBlocks?.[0]?.type, 'thinking')
    assert.equal(step.thinkingBlocks?.[0]?.text, 'thinking...')
    assert.equal(step.diagnostics?.stopReason, 'tool_calls')
    assert.deepEqual(step.usage, {
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      source: 'openai',
    })
  })

  it('passes the per-request tool list to the body', async () => {
    const captured = captureFetch()
    const tool: ModelToolDefinition = {
      name: 'my_tool',
      description: 'desc',
      inputSchema: { type: 'object', properties: {} },
    }

    await adapter().next([{ role: 'user', content: 'hi' }], { tools: [tool] })

    const body = captured.body as { tools: Array<{ type: string; function: { name: string } }> }
    assert.deepEqual(body.tools.map(t => t.function.name), ['my_tool'])
    assert.equal(body.tools[0].type, 'function')
  })

  it('passes AbortSignal through to fetch', async () => {
    let fetchSignal: AbortSignal | null | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal
      markStarted?.()
      return await new Promise<Response>((_resolve, reject) => {
        const rejectForAbort = () => reject(new Error('fetch aborted'))
        if (fetchSignal?.aborted) {
          rejectForAbort()
          return
        }
        fetchSignal?.addEventListener('abort', rejectForAbort, { once: true })
      })
    }) as typeof fetch

    const controller = new AbortController()
    const request = adapter().next([{ role: 'user', content: 'hello' }], {
      signal: controller.signal,
    })

    await started
    controller.abort(new Error('closed'))

    await assert.rejects(request, /fetch aborted/)
    assert.equal(fetchSignal, controller.signal)
  })
})