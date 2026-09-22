/**
 * OpenAI 侧 thinking 回传回归。
 *
 * 背景（真实线上故障，不是推演）：告警入队 → 诊断 → 调工具，之后第 2 次 LLM 调用
 * 被 provider 拒掉：
 *
 *   400 The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * 根因：`reasoning_content` 被当成「有值才回传」处理（`pendingReasoning ? {...} : {}`），
 * 而 provider 返回的是 `reasoning_content: ""` —— 字段在、内容空。于是该字段被整个
 * 抹掉，服务端不认。
 *
 * 对真实失败请求体做过单变量变异，规则如下（测试据此锁死）：
 *   · 全无该字段                                  → 400
 *   · 只给「带 tool_calls 那条」补                  → 400
 *   · 只给「tool_calls 之前那条文本 assistant」补    → 200
 *   · 给「全部 assistant」补（空串）                → 200  ← 本实现取的安全超集
 *
 * 对照：Anthropic 侧已有 `anthropic-thinking-roundtrip.test.ts`。那边 thinking 与
 * tool_use 同处一条 assistant 消息，天然不丢；OpenAI 侧被拆成「文本 + tool_calls」
 * 两条消息，才暴露出这个缝隙。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIModelAdapter } from '../src/openai-adapter.js'
import { ToolRegistry } from '../src/tool.js'
import type { ChatMessage } from '../src/types.js'
import type { RuntimeConfig } from '../src/config.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function runtime(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    provider: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    mcpServers: {},
    sourceSummary: 'test',
    ...overrides,
  }
}

function adapter(overrides: Partial<RuntimeConfig> = {}): OpenAIModelAdapter {
  return new OpenAIModelAdapter(new ToolRegistry([]), async () => runtime(overrides))
}

type CapturedBody = {
  messages: Array<Record<string, unknown>>
}

/** 记录每一次出站请求体；响应由 `responseFor(callIndex)` 决定。 */
function captureAll(responseFor: (callIndex: number) => unknown): CapturedBody[] {
  const bodies: CapturedBody[] = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as CapturedBody)
    const payload = responseFor(bodies.length - 1)
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
  return bodies
}

function response(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ finish_reason: 'stop', message: { content, ...extra } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

/** 一轮工具调用的历史：文本 assistant + tool_calls assistant + tool 结果。 */
function toolRoundMessages(): ChatMessage[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'order-api 5xx 突增' },
    { role: 'assistant', content: '我先查历史事件库。' },
    {
      role: 'assistant_tool_call',
      toolUseId: 'call-1',
      toolName: 'search_incident_kb',
      input: { query: 'order-api 5xx' },
    },
    {
      role: 'tool_result',
      toolUseId: 'call-1',
      toolName: 'search_incident_kb',
      content: '未找到相似历史事件。',
      isError: false,
    },
  ]
}

const hasKey = (m: Record<string, unknown>): boolean =>
  Object.prototype.hasOwnProperty.call(m, 'reasoning_content')

describe('OpenAI reasoning_content round trip', () => {
  it('开了回传时，即便一条推理都没捕获到，每条 assistant 也必须带上该字段（空串）', async () => {
    // 这正是线上失败的形状：provider 给的是 `reasoning_content: ""`，转录里连
    // assistant_thinking 都没有。旧实现因此把字段整个省掉 → 400。
    const bodies = captureAll(() => response('<final>done'))

    await adapter({ passBackReasoning: true }).next(toolRoundMessages())

    const assistants = bodies[0]!.messages.filter(m => m.role === 'assistant')
    assert.equal(assistants.length, 2, '文本那条与 tool_calls 那条各算一条')
    for (const m of assistants) {
      assert.ok(hasKey(m), `assistant 消息必须带 reasoning_content 字段: ${JSON.stringify(m)}`)
      assert.equal(m.reasoning_content, '')
    }
  })

  it('捕获到的推理落在紧随其后的那条 assistant 上，tool_calls 那条补空串保持字段在场', async () => {
    const bodies = captureAll(() => response('<final>done'))

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant_thinking', blocks: [{ type: 'thinking', text: '需要先查事件库。' }] },
      ...toolRoundMessages().slice(2),
    ]

    await adapter({ passBackReasoning: true }).next(messages)

    const assistants = bodies[0]!.messages.filter(m => m.role === 'assistant')
    // 转录顺序是 [assistant_thinking, assistant(文本), assistant_tool_call]，
    // 转换时推理随第一条 assistant 一起出去 —— 与实测结论一致：
    // 只要「tool_calls 之前那条 assistant」带了该字段，服务端即接受（变异 V3 → 200）。
    assert.equal(assistants.length, 2)
    assert.equal(assistants[0]!.content, '我先查历史事件库。')
    assert.equal(assistants[0]!.reasoning_content, '需要先查事件库。')
    const withCalls = assistants.find(m => Array.isArray(m.tool_calls))
    assert.ok(withCalls)
    assert.ok(hasKey(withCalls), 'tool_calls 那条同样要保持字段在场')
    assert.equal(withCalls.reasoning_content, '')
  })

  it('未开回传且 provider 从未返回该字段时，不得凭空注入（避免冒犯 OpenAI 兼容网关）', async () => {
    const bodies = captureAll(() => response('<final>done'))

    await adapter().next(toolRoundMessages())

    const assistants = bodies[0]!.messages.filter(m => m.role === 'assistant')
    assert.equal(assistants.length, 2)
    for (const m of assistants) {
      assert.ok(!hasKey(m), '默认不该注入 reasoning_content')
    }
  })

  it('模型名不含 reasoner/thinking 时，凭「provider 返回过该字段」自行开回传', async () => {
    // deepseek-v4-flash 这类名字命中不了 isThinkingModel() 的启发式，但服务端确实
    // 按 thinking 模式校验。第一轮拿到字段后，第二轮必须开始回传。
    const bodies = captureAll(callIndex =>
      callIndex === 0
        ? response('', { reasoning_content: '' })
        : response('<final>done'),
    )

    const a = adapter({ model: 'deepseek-v4-flash' })
    await a.next([{ role: 'user', content: '第一轮' }])
    await a.next([
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '答' },
      { role: 'user', content: '第二轮' },
    ])

    assert.equal(bodies.length, 2)
    const firstAssistants = bodies[0]!.messages.filter(m => m.role === 'assistant')
    assert.equal(firstAssistants.length, 0, '首轮还没有 assistant 历史')
    const second = bodies[1]!.messages.find(m => m.role === 'assistant')
    assert.ok(second)
    assert.ok(hasKey(second), '见过该字段后必须开始回传')
  })
})
