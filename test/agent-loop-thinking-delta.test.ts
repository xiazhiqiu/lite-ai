import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { ToolRegistry } from '../src/tool.js'
import { runAgentTurn } from '../src/agent-loop.js'
import type { ChatMessage, ModelAdapter } from '../src/types.js'

const echoTool = {
  name: 'echo',
  description: 'echo',
  inputSchema: {},
  schema: z.object({ text: z.string() }),
  isParallelSafe: () => true,
  run: async (input: { text: string }) => ({
    ok: true,
    output: `echo:${input.text}`,
  }),
}

function makeRegistry() {
  return new ToolRegistry([echoTool])
}

test('onThinkingDelta 透传：thinking 增量原样转发', async () => {
  const deltas: string[] = []
  const adapter: ModelAdapter = {
    async next(_messages, options) {
      options?.onThinkingDelta?.('先分析')
      options?.onThinkingDelta?.('告警特征')
      return { type: 'assistant', content: '结论', kind: 'final' }
    },
  }

  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  await runAgentTurn({
    model: adapter,
    tools: makeRegistry(),
    messages,
    cwd: process.cwd(),
    onThinkingDelta: delta => deltas.push(delta),
  })

  assert.deepEqual(deltas, ['先分析', '告警特征'])
})

test('未传 onThinkingDelta：options 不携带该字段（向后兼容）', async () => {
  let capturedOptions: unknown = null
  const adapter: ModelAdapter = {
    async next(_messages, options) {
      capturedOptions = options ?? null
      return { type: 'assistant', content: 'done', kind: 'final' }
    },
  }

  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  await runAgentTurn({
    model: adapter,
    tools: makeRegistry(),
    messages,
    cwd: process.cwd(),
  })

  assert.equal('onThinkingDelta' in (capturedOptions as object), false)
})

test('LITE_AI_STREAMING=0：thinking 增量仍透传（与执行器路径解耦）', async () => {
  process.env.LITE_AI_STREAMING = '0'
  try {
    const deltas: string[] = []
    const adapter: ModelAdapter = {
      async next(_messages, options) {
        options?.onThinkingDelta?.('关了流式也照发')
        return { type: 'assistant', content: 'done', kind: 'final' }
      },
    }

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    await runAgentTurn({
      model: adapter,
      tools: makeRegistry(),
      messages,
      cwd: process.cwd(),
      onThinkingDelta: delta => deltas.push(delta),
    })

    assert.deepEqual(deltas, ['关了流式也照发'])
  } finally {
    delete process.env.LITE_AI_STREAMING
  }
})

test('thinking 与 text 增量互不干扰，按到达序分别转发', async () => {
  const thinking: string[] = []
  const text: string[] = []
  const adapter: ModelAdapter = {
    async next(_messages, options) {
      options?.onThinkingDelta?.('想1')
      options?.onTextDelta?.('答1')
      options?.onThinkingDelta?.('想2')
      options?.onTextDelta?.('答2')
      return { type: 'assistant', content: '答1答2', kind: 'final' }
    },
  }

  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  await runAgentTurn({
    model: adapter,
    tools: makeRegistry(),
    messages,
    cwd: process.cwd(),
    onThinkingDelta: delta => thinking.push(delta),
    onTextDelta: delta => text.push(delta),
  })

  assert.deepEqual(thinking, ['想1', '想2'])
  assert.deepEqual(text, ['答1', '答2'])
})
