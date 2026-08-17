import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'
import type { ToolContext } from '../src/tool.js'

let tempRoot: string

let cwdCounter = 0
function freshCtx(): ToolContext {
  cwdCounter += 1
  return { cwd: `D:/dev/sre-assistant-${cwdCounter}` }
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-hypo-'))
  process.env.LITE_AI_HOME = tempRoot
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempRoot, { recursive: true, force: true })
})

async function registry(): Promise<ToolRegistry> {
  const { hypothesisTrackerTool } = await import('../src/tools/hypothesis-tracker.js')
  return new ToolRegistry([hypothesisTrackerTool])
}

const evidence = {
  command: 'kubectl logs payment-6f7d9 -n sock-shop --previous',
  output_summary: 'OOMKilled: container exceeded memory limit 256Mi',
  data_source: 'K8s logs',
  timestamp: 1705611754,
  supports: true,
}

test('add_hypothesis: 注册假设并落盘', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const result = await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_hypothesis',
      id: 'h1',
      description: 'payment 容器 OOMKilled 导致 500',
      priority: 1,
    },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /\[pending\] P1 h1/)

  const { readHypotheses } = await import('../src/utils/hypothesis-store.js')
  const list = await readHypotheses(ctx.cwd)
  assert.equal(list.hypotheses.length, 1)
  assert.equal(list.hypotheses[0]!.status, 'pending')
})

test('add_hypothesis: 重复 id 拒绝', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'dup', description: 'a', priority: 2 },
    ctx,
  )
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'dup', description: 'b', priority: 1 },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /already exists/)
})

test('add_hypothesis: 非法 priority 被 schema 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'bad', description: 'x', priority: 9 },
    freshCtx(),
  )
  assert.equal(result.ok, false)
})

test('add_evidence: 附着证据到假设', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: 'payment OOM', priority: 1 },
    ctx,
  )
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'add_evidence', hypothesis_id: 'h1', evidence },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /SUPPORTS/)

  const { readHypotheses } = await import('../src/utils/hypothesis-store.js')
  const list = await readHypotheses(ctx.cwd)
  assert.equal(list.hypotheses[0]!.evidence.length, 1)
  assert.equal(list.hypotheses[0]!.evidence[0]!.supports, true)
})

test('add_evidence: 未知假设 id 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'add_evidence', hypothesis_id: 'missing', evidence },
    freshCtx(),
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown hypothesis id/)
})

test('update_status: 更新状态并附结论', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: 'payment OOM', priority: 1 },
    ctx,
  )
  const result = await tools.execute(
    'hypothesis_tracker',
    {
      action: 'update_status',
      hypothesis_id: 'h1',
      status: 'confirmed',
      conclusion: 'OOMKilled 确认，内存限制过低',
    },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /\[confirmed\] P1 h1/)
  assert.match(result.output, /Conclusion: OOMKilled 确认/)

  const { readHypotheses } = await import('../src/utils/hypothesis-store.js')
  const list = await readHypotheses(ctx.cwd)
  assert.equal(list.hypotheses[0]!.status, 'confirmed')
  assert.equal(list.hypotheses[0]!.conclusion, 'OOMKilled 确认，内存限制过低')
})

test('update_status: 未知假设 id 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'update_status', hypothesis_id: 'nope', status: 'confirmed' },
    freshCtx(),
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown hypothesis id/)
})

test('refuted 假设保留在列表中（不删除）', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: '磁盘 IO 饱和', priority: 2 },
    ctx,
  )
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'update_status', hypothesis_id: 'h1', status: 'refuted' },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /\[refuted\] P2 h1/)

  const { readHypotheses } = await import('../src/utils/hypothesis-store.js')
  const list = await readHypotheses(ctx.cwd)
  assert.equal(list.hypotheses.length, 1)
  assert.equal(list.hypotheses[0]!.status, 'refuted')
})

test('get_summary: 空链返回 (none)', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'get_summary' },
    freshCtx(),
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /Hypothesis count: 0/)
  assert.match(result.output, /Active: 0/)
})

test('get_summary: 多假设按 priority 排序并计数', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h2', description: '网络丢包', priority: 2 },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: 'OOM', priority: 1 },
    ctx,
  )
  const result = await tools.execute(
    'hypothesis_tracker',
    { action: 'get_summary' },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /Hypothesis count: 2/)
  // priority 1 的 h1 应排在 priority 2 的 h2 之前
  const h1Index = result.output.indexOf('h1')
  const h2Index = result.output.indexOf('h2')
  assert.ok(h1Index !== -1 && h2Index !== -1)
  assert.ok(h1Index < h2Index)
})
