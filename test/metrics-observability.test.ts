import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { createTurnScope, _resetMetricsForTest } from '../src/observability/metrics.js'
import { queryTurnTrace } from '../src/observability/query.js'
import { runAgentTurn } from '../src/agent-loop.js'
import { ToolRegistry } from '../src/tool.js'

let tmp = ''
afterEach(() => {
  _resetMetricsForTest()
  if (tmp) {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // 连接可能尚未释放，忽略
    }
  }
  tmp = ''
})

function openDb(dir: string): Database.Database {
  return new Database(path.join(dir, 'metrics.db'))
}

async function freshDb(run: (dir: string) => void | Promise<void>): Promise<void> {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lite-ai-metrics-'))
  process.env.LITE_AI_HOME = tmp
  _resetMetricsForTest()
  try {
    await run(tmp)
  } finally {
    delete process.env.LITE_AI_HOME
    _resetMetricsForTest()
  }
}

test('createTurnScope.flush: llm/tool/turn 共享同一 turn_id', async () => {
  await freshDb(dir => {
    const scope = createTurnScope()
    scope.pushLlm({ model: 'm', provider: 'p', inputTokens: 1, outputTokens: 2, latencyMs: 3, stopReason: 'end' })
    scope.pushTool({ toolName: 'ts', ok: true, latencyMs: 4 })
    scope.flush({ model: 'm', steps: 2, toolCalls: 1, toolErrors: 0, emptyResponses: 0,
      thinkingRetries: 0, midtaskContinuations: 0, contextUtilization: 0.5, maxStepsHit: false, durationMs: 10 })

    const db = openDb(dir)
    const llm = db.prepare('SELECT turn_id FROM llm_calls').all() as { turn_id: string | null }[]
    const tool = db.prepare('SELECT turn_id FROM tool_calls').all() as { turn_id: string | null }[]
    const turn = db.prepare('SELECT turn_id FROM turns').all() as { turn_id: string | null }[]
    assert.equal(llm.length, 1)
    assert.equal(tool.length, 1)
    assert.equal(turn.length, 1)
    assert.equal(llm[0]!.turn_id, scope.turnId)
    assert.equal(tool[0]!.turn_id, scope.turnId)
    assert.equal(turn[0]!.turn_id, scope.turnId)
    db.close()
  })
})

test('createTurnScope.flush: 未 flush 前不落盘', async () => {
  await freshDb(dir => {
    const scope = createTurnScope()
    scope.pushLlm({ model: 'm' })
    scope.pushTool({ toolName: 't', ok: true })
    const db = openDb(dir)
    // flush 之前不应有任何持久化：连表都尚未创建。
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('llm_calls','tool_calls','turns')`,
    ).all()
    assert.equal(tables.length, 0)
    db.close()
  })
})

test('createTurnScope.flush: 二次 flush 不重复落盘，flush 后 push 忽略', async () => {
  await freshDb(dir => {
    const scope = createTurnScope()
    scope.pushLlm({ model: 'm' })
    scope.pushTool({ toolName: 't', ok: true })
    scope.flush({ model: 'm', steps: 1, toolCalls: 1, toolErrors: 0, emptyResponses: 0,
      thinkingRetries: 0, midtaskContinuations: 0, contextUtilization: 0, maxStepsHit: false, durationMs: 1 })
    scope.flush({ model: 'm', steps: 1, toolCalls: 1, toolErrors: 0, emptyResponses: 0,
      thinkingRetries: 0, midtaskContinuations: 0, contextUtilization: 0, maxStepsHit: false, durationMs: 1 })
    scope.pushTool({ toolName: 't2', ok: true })

    const db = openDb(dir)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM llm_calls').get() as { c: number }).c, 1)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM tool_calls').get() as { c: number }).c, 1)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM turns').get() as { c: number }).c, 1)
    db.close()
  })
})

test('LITE_AI_METRICS=0 时 createTurnScope 静默不写且不抛', () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'lite-ai-off-'))
  process.env.LITE_AI_HOME = tmp
  process.env.LITE_AI_METRICS = '0'
  _resetMetricsForTest()
  const scope = createTurnScope()
  assert.doesNotThrow(() => {
    scope.pushLlm({ model: 'm' })
    scope.pushTool({ toolName: 't', ok: true })
    scope.flush({ model: 'm', steps: 1, toolCalls: 0, toolErrors: 0, emptyResponses: 0,
      thinkingRetries: 0, midtaskContinuations: 0, contextUtilization: 0, maxStepsHit: false, durationMs: 1 })
  })
  delete process.env.LITE_AI_METRICS
  delete process.env.LITE_AI_HOME
  _resetMetricsForTest()
})

test('runAgentTurn: 同回合的 llm/tool/turn 共享 turn_id', async () => {
  await freshDb(async dir => {
    const registry = new ToolRegistry([
      { name: 'e', description: 'x',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        schema: z.object({ text: z.string() }), isReadOnly: true,
        run: async i => ({ ok: true, output: `e:${(i as { text: string }).text}` }) },
    ])
    let step = 0
    const model = {
      async next() {
        step += 1
        if (step === 1) return { type: 'tool_calls', calls: [{ id: 'c1', toolName: 'e', input: { text: 'x' } }] }
        return { type: 'end', content: 'done' }
      },
    }
    await runAgentTurn({ model, tools: registry, messages: [{ role: 'user', content: 'go' }], cwd: process.cwd(), modelName: 'gpt-4o-mini' })

    const db = openDb(dir)
    const llm = db.prepare('SELECT turn_id FROM llm_calls').all() as { turn_id: string | null }[]
    const tool = db.prepare('SELECT turn_id FROM tool_calls').all() as { turn_id: string | null }[]
    const turn = db.prepare('SELECT turn_id FROM turns').all() as { turn_id: string | null }[]
    assert.ok(llm.length >= 2, `expected >=2 llm calls, got ${llm.length}`)
    assert.equal(tool.length, 1)
    assert.equal(turn.length, 1)
    const ids = new Set<string>([...llm.map(r => r.turn_id!), tool[0]!.turn_id!, turn[0]!.turn_id!])
    assert.equal(ids.size, 1)
    db.close()
  })
})

test('execute: 无 scope 时仍即时写 tool_calls，有 scope 时走内存', async () => {
  await freshDb(async dir => {
    const registry = new ToolRegistry([
      { name: 'e', description: 'x',
        inputSchema: { type: 'object', properties: {} }, schema: z.object({}), isReadOnly: true,
        run: async () => ({ ok: true, output: 'ok' }) },
    ])

    await registry.execute('e', {}, { cwd: process.cwd() })
    let db = openDb(dir)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM tool_calls').get() as { c: number }).c, 1)
    db.close()

    const scope = createTurnScope()
    await registry.execute('e', {}, { cwd: process.cwd(), scope })
    db = openDb(dir)
    assert.equal((db.prepare('SELECT COUNT(*) c FROM tool_calls').get() as { c: number }).c, 1)
    db.close()
  })
})

test('queryTurnTrace: 返回该 turn 的 llm/tool/turn 明细', async () => {
  await freshDb(dir => {
    const scope = createTurnScope()
    scope.pushLlm({ model: 'm', inputTokens: 5, outputTokens: 6, latencyMs: 1 })
    scope.pushTool({ toolName: 'a', ok: true, latencyMs: 2 })
    scope.flush({ model: 'm', steps: 1, toolCalls: 1, toolErrors: 0, emptyResponses: 0,
      thinkingRetries: 0, midtaskContinuations: 0, contextUtilization: 1, maxStepsHit: false, durationMs: 3 })

    const trace = queryTurnTrace(scope.turnId)
    assert.ok(trace)
    assert.equal(trace.turn.steps, 1)
    assert.equal(trace.llmCalls.length, 1)
    assert.equal(trace.toolCalls.length, 1)
    assert.equal(trace.toolCalls[0]!.toolName, 'a')

    assert.equal(queryTurnTrace('nonexistent-turn'), null)
  })
})