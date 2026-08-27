import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { AgentStep, ChatMessage, ModelAdapter } from '../src/types.js'
import { ToolRegistry } from '../src/tool.js'
import { runAgentTurn } from '../src/agent-loop.js'

/** 按调用次数依次吐预设 step 的 stub adapter。耗尽后重复最后一个。 */
function seqAdapter(steps: AgentStep[]): ModelAdapter {
  let i = 0
  return {
    async next() {
      const step = steps[Math.min(i, steps.length - 1)]!
      i += 1
      return step
    },
  }
}

const readFileTool = {
  name: 'read_file',
  description: 'read',
  inputSchema: {},
  schema: z.object({ path: z.string() }),
  isParallelSafe: () => true,
  run: () => ({ ok: true, output: 'x' }),
}

function emptyRegistry(): ToolRegistry {
  return new ToolRegistry([])
}

test('基线: 空响应两次后第三次停止并注入 fallback', async () => {
  const result = await runAgentTurn({
    model: seqAdapter([
      { type: 'assistant', content: '' },
      { type: 'assistant', content: '' },
      { type: 'assistant', content: '' },
    ]),
    tools: emptyRegistry(),
    messages: [],
    cwd: process.cwd(),
  })
  // 第1、2次空响应：各推一条空响应续跑 prompt（user）；第3次：注入 fallback 并结束。
  assert.match(result.at(-1)!.content, /空响应/)
  const userPrompts = [...result].filter(m => m.role === 'user')
  assert.ok(userPrompts.length >= 2)
})

test('基线: thinking pause_turn 空响应触发续跑', async () => {
  const result = await runAgentTurn({
    model: seqAdapter([
      {
        type: 'assistant',
        content: '',
        diagnostics: { stopReason: 'pause_turn', blockTypes: ['thinking'] },
      },
      { type: 'assistant', content: '最终答案', kind: 'final' },
    ]),
    tools: emptyRegistry(),
    messages: [],
    cwd: process.cwd(),
  })
  const progress = [...result].filter(m => m.role === 'assistant_progress')
  assert.ok(progress.length >= 1)
  assert.match(progress[0]!.content, /pause_turn/)
  assert.equal(result.at(-1)!.role, 'assistant')
  assert.equal(result.at(-1)!.content, '最终答案')
})

test('基线: 跑过工具后纯文本未标 final 触发续跑', async () => {
  const result = await runAgentTurn({
    model: seqAdapter([
      { type: 'tool_calls', calls: [{ id: 't1', toolName: 'read_file', input: { path: 'a' } }] },
      { type: 'assistant', content: '先喘口气，还没完' },
      { type: 'assistant', content: '搞定', kind: 'final' },
    ]),
    tools: new ToolRegistry([readFileTool]),
    messages: [],
    cwd: process.cwd(),
  })
  const progress = [...result].filter(m => m.role === 'assistant_progress')
  assert.ok(progress.length >= 1)
  assert.match(progress[0]!.content, /先喘口气/)
  assert.equal(result.at(-1)!.content, '搞定')
})

test('基线: 正常最终答案直接结束', async () => {
  const result = await runAgentTurn({
    model: seqAdapter([{ type: 'assistant', content: 'hello', kind: 'final' }]),
    tools: emptyRegistry(),
    messages: [],
    cwd: process.cwd(),
  })
  assert.deepEqual(result.at(-1), { role: 'assistant', content: 'hello' })
})