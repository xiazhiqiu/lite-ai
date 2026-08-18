import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'
import type { ToolContext } from '../src/tool.js'
import type { HypothesisList } from '../src/utils/hypothesis-store.js'

let tempRoot: string

let cwdCounter = 0
function freshCtx(): ToolContext {
  cwdCounter += 1
  return { cwd: `D:/dev/sre-incident-${cwdCounter}` }
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-cp-'))
  process.env.LITE_AI_HOME = tempRoot
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempRoot, { recursive: true, force: true })
})

async function registry(): Promise<ToolRegistry> {
  const { incidentCheckpointTool } = await import('../src/tools/incident-checkpoint.js')
  return new ToolRegistry([incidentCheckpointTool])
}

function createdId(output: string): string {
  const m = /Checkpoint created: (cp_[a-z0-9]+)/.exec(output)
  assert.ok(m, `expected checkpoint id in output: ${output}`)
  return m[1]!
}

test('create: 创建检查点并落盘', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'payment 500', incident_title: '支付服务 500', severity: 'SEV1' },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /Checkpoint created: cp_/)
  assert.match(result.output, /payment 500 \(SEV1\)/)

  const { readCheckpoints } = await import('../src/utils/checkpoint-store.js')
  const list = await readCheckpoints(ctx.cwd)
  assert.equal(list.checkpoints.length, 1)
  assert.equal(list.checkpoints[0]!.severity, 'SEV1')
  assert.equal(list.checkpoints[0]!.active, false)
})

test('create: 非法 severity 被 schema 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'x', incident_title: 'y', severity: 'SEV9' },
    freshCtx(),
  )
  assert.equal(result.ok, false)
})

test('create: 空 name 被 schema 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: '', incident_title: 'y', severity: 'SEV2' },
    freshCtx(),
  )
  assert.equal(result.ok, false)
})

test('list: 空列表返回提示', async () => {
  const tools = await registry()
  const result = await tools.execute('incident_checkpoint', { action: 'list' }, freshCtx())
  assert.equal(result.ok, true)
  assert.match(result.output, /No checkpoints yet/)
})

test('list: 按创建时间倒序列出', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'first', incident_title: 'a', severity: 'SEV3' },
    ctx,
  )
  await new Promise(r => setTimeout(r, 2))
  await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'second', incident_title: 'b', severity: 'SEV2' },
    ctx,
  )
  const result = await tools.execute('incident_checkpoint', { action: 'list' }, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /second/)
  const firstIndex = result.output.indexOf('first')
  const secondIndex = result.output.indexOf('second')
  assert.ok(firstIndex !== -1 && secondIndex !== -1)
  assert.ok(secondIndex < firstIndex, '新创建的检查点应排在前面')
})

test('switch_to: 标记活动检查点且唯一', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const create = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'a', incident_title: 't', severity: 'SEV1' },
    ctx,
  )
  const id = createdId(create.output)
  await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'b', incident_title: 't2', severity: 'SEV2' },
    ctx,
  )
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'switch_to', checkpoint_id: id },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /Now active:/)

  const { readCheckpoints } = await import('../src/utils/checkpoint-store.js')
  const list = await readCheckpoints(ctx.cwd)
  const active = list.checkpoints.filter(c => c.active)
  assert.equal(active.length, 1)
  assert.equal(active[0]!.id, id)
})

test('switch_to: 未知 id 拒绝', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'switch_to', checkpoint_id: 'cp_nope' },
    freshCtx(),
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown checkpoint id/)
})

test('generate_handover: 无检查点返回提示', async () => {
  const tools = await registry()
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'generate_handover' },
    freshCtx(),
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /No checkpoint found/)
})

test('generate_handover: 未指定时用活动检查点，简报含严重级别/时间线/假设状态', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const create = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'handover-a', incident_title: '支付服务 500', severity: 'SEV1' },
    ctx,
  )
  const id = createdId(create.output)
  await tools.execute('incident_checkpoint', { action: 'switch_to', checkpoint_id: id }, ctx)

  // 预置假设链：1 个 confirmed + 1 个 refuted + 1 个 pending（含证据）
  const { saveHypotheses } = await import('../src/utils/hypothesis-store.js')
  const hypList: HypothesisList = {
    incident: 'payment-outage',
    updatedAt: new Date().toISOString(),
    hypotheses: [
      {
        id: 'h1',
        description: 'payment 容器 OOMKilled',
        priority: 1,
        status: 'confirmed',
        created_at: 1,
        evidence: [
          {
            command: 'kubectl logs payment-6f7d9 -n sock-shop --previous',
            output_summary: 'OOMKilled: container exceeded memory limit 256Mi',
            data_source: 'K8s logs',
            timestamp: 1,
            supports: true,
          },
        ],
        conclusion: '内存限制过低',
      },
      {
        id: 'h2',
        description: '数据库连接池耗尽',
        priority: 2,
        status: 'refuted',
        created_at: 2,
        evidence: [
          {
            command: 'kubectl get pods -n sock-shop -o wide',
            output_summary: 'no db pressure',
            data_source: 'kubectl',
            timestamp: 2,
            supports: false,
          },
          {
            command: 'curl -s localhost:9090/api/v1/query?query=up',
            output_summary: 'db healthy',
            data_source: 'Prometheus',
            timestamp: 3,
            supports: false,
          },
        ],
      },
      {
        id: 'h3',
        description: '网络丢包',
        priority: 3,
        status: 'pending',
        created_at: 3,
        evidence: [],
      },
    ],
  }
  await saveHypotheses(ctx.cwd, hypList)

  const result = await tools.execute('incident_checkpoint', { action: 'generate_handover' }, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /## 事故简报：支付服务 500/)
  assert.match(result.output, /### 严重级别/)
  assert.match(result.output, /SEV1/)
  assert.match(result.output, /### 时间线（关键事件）/)
  assert.match(result.output, /kubectl logs payment-6f7d9/)
  assert.match(result.output, /### 已排除的假设/)
  assert.match(result.output, /数据库连接池耗尽/)
  assert.match(result.output, /### 待验证的假设/)
  assert.match(result.output, /\[P3\] 网络丢包 \(pending\)/)
})

test('generate_handover: 指定 checkpoint_id 生成简报', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const create = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'b', incident_title: 't', severity: 'SEV2' },
    ctx,
  )
  const id = createdId(create.output)
  const result = await tools.execute(
    'incident_checkpoint',
    { action: 'generate_handover', checkpoint_id: id },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /Handover brief for "b"/)
})

test('上限: 超过 5 个检查点合并最旧的非活动检查点，保留活动检查点', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const first = await tools.execute(
    'incident_checkpoint',
    { action: 'create', name: 'cp1', incident_title: 't1', severity: 'SEV1' },
    ctx,
  )
  const firstId = createdId(first.output)
  await tools.execute('incident_checkpoint', { action: 'switch_to', checkpoint_id: firstId }, ctx)

  let sixthNotice = ''
  for (let i = 2; i <= 6; i++) {
    await new Promise(r => setTimeout(r, 2))
    const r = await tools.execute(
      'incident_checkpoint',
      { action: 'create', name: `cp${i}`, incident_title: `t${i}`, severity: 'SEV3' },
      ctx,
    )
    if (i === 6) sixthNotice = r.output
  }
  assert.match(sixthNotice, /Checkpoint limit reached \(5\)/)

  const { readCheckpoints } = await import('../src/utils/checkpoint-store.js')
  const list = await readCheckpoints(ctx.cwd)
  assert.equal(list.checkpoints.length, 5)
  assert.ok(list.checkpoints.some(c => c.id === firstId), '活动检查点应被保留')
  assert.equal(list.checkpoints.filter(c => c.active).length, 1)
})
