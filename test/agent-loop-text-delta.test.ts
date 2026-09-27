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

test('onTextDelta 透传：模型生成期间的文本增量原样转发', async () => {
  const deltas: string[] = []
  let capturedOptions: unknown = null
  const adapter: ModelAdapter = {
    async next(_messages, options) {
      capturedOptions = options ?? null
      options?.onTextDelta?.('你')
      options?.onTextDelta?.('好')
      return { type: 'assistant', content: '你好', kind: 'final' }
    },
  }

  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  const result = await runAgentTurn({
    model: adapter,
    tools: makeRegistry(),
    messages,
    cwd: process.cwd(),
    onTextDelta: delta => deltas.push(delta),
  })

  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(typeof (capturedOptions as { onTextDelta?: unknown })?.onTextDelta, 'function')
  // 最终消息不受流式回调影响
  const last = result.at(-1)
  assert.equal(last?.role, 'assistant')
  assert.equal((last as { content: string }).content, '你好')
})

test('未传 onTextDelta：options 不携带该字段（向后兼容既有调用方）', async () => {
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

  assert.equal(capturedOptions !== null, true)
  assert.equal('onTextDelta' in (capturedOptions as object), false)
})

test('LITE_AI_STREAMING=0：文本增量仍透传（与工具执行器路径解耦）', async () => {
  process.env.LITE_AI_STREAMING = '0'
  try {
    const deltas: string[] = []
    const adapter: ModelAdapter = {
      async next(_messages, options) {
        options?.onTextDelta?.('流式关了文本照样到')
        return { type: 'assistant', content: 'done', kind: 'final' }
      },
    }

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    await runAgentTurn({
      model: adapter,
      tools: makeRegistry(),
      messages,
      cwd: process.cwd(),
      onTextDelta: delta => deltas.push(delta),
    })

    assert.deepEqual(deltas, ['流式关了文本照样到'])
  } finally {
    delete process.env.LITE_AI_STREAMING
  }
})

test('多步回合：每个 step 的文本增量都转发（工具步也不例外）', async () => {
  const deltas: string[] = []
  let called = 0
  const adapter: ModelAdapter = {
    async next(_messages, options) {
      called += 1
      if (called === 1) {
        options?.onTextDelta?.('先看看文件')
        return {
          type: 'tool_calls',
          calls: [{ id: 'e1', toolName: 'echo', input: { text: 'a' } }],
        }
      }
      options?.onTextDelta?.('看完了，结论是')
      return { type: 'assistant', content: '看完了，结论是 done', kind: 'final' }
    },
  }

  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  await runAgentTurn({
    model: adapter,
    tools: makeRegistry(),
    messages,
    cwd: process.cwd(),
    onTextDelta: delta => deltas.push(delta),
  })

  assert.deepEqual(deltas, ['先看看文件', '看完了，结论是'])
  assert.equal(called, 2)
})
