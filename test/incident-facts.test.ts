import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry, type ToolContext } from '../src/tool.js'

let tempRoot: string
let cwdCounter = 0
function freshCtx(): ToolContext {
  cwdCounter += 1
  return { cwd: `D:/dev/incident-facts-${cwdCounter}` }
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-if-'))
  process.env.LITE_AI_HOME = tempRoot
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempRoot, { recursive: true, force: true })
})

async function registry(): Promise<ToolRegistry> {
  const { incidentCheckpointTool } = await import(
    '../src/tools/incident-checkpoint.js'
  )
  const { hypothesisTrackerTool } = await import(
    '../src/tools/hypothesis-tracker.js'
  )
  return new ToolRegistry([incidentCheckpointTool, hypothesisTrackerTool])
}

function createdId(output: string): string {
  const m = /Checkpoint created: (cp_[a-z0-9]+)/.exec(output)
  assert.ok(m, `expected checkpoint id in output: ${output}`)
  return m[1]!
}

async function seedHypotheses(
  tools: ToolRegistry,
  ctx: ToolContext,
): Promise<void> {
  // confirmed 假设 + 2 条证据
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: 'OOM 假设', priority: 1 },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_evidence',
      hypothesis_id: 'h1',
      evidence: {
        command: 'kubectl get pod payment-abc',
        output_summary: 'CrashLoopBackOff',
        data_source: 'kubectl',
        timestamp: 1705611600,
        supports: true,
      },
    },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_evidence',
      hypothesis_id: 'h1',
      evidence: {
        command: 'kubectl logs payment-abc --previous',
        output_summary: 'OOMKilled',
        data_source: 'kubectl logs',
        timestamp: 1705611700,
        supports: true,
      },
    },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'update_status',
      hypothesis_id: 'h1',
      status: 'confirmed',
      conclusion: '内存限制不足，建议提升至 512Mi',
    },
    ctx,
  )

  // refuted 假设
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h2', description: '代码 bug', priority: 2 },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'update_status',
      hypothesis_id: 'h2',
      status: 'refuted',
      conclusion: '日志无 panic',
    },
    ctx,
  )

  // pending 假设
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h3', description: '网络丢包', priority: 3 },
    ctx,
  )
}

async function seedCheckpoint(
  tools: ToolRegistry,
  ctx: ToolContext,
): Promise<string> {
  const cp = await tools.execute(
    'incident_checkpoint',
    {
      action: 'create',
      name: 'payment OOM',
      incident_title: 'payment OOM 500 事故',
      severity: 'SEV1',
    },
    ctx,
  )
  return createdId(cp.output)
}

// --- extractIncidentFactSnapshot ---

test('extractIncidentFactSnapshot: 假设链为空时返回 null（降级为原 compact 行为）', async () => {
  const { extractIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  const ctx = freshCtx()
  // 不创建任何假设
  const snapshot = await extractIncidentFactSnapshot(ctx.cwd)
  assert.equal(snapshot, null)
})

test('extractIncidentFactSnapshot: 有假设无 checkpoint 时用默认值填充元信息', async () => {
  const { extractIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  const tools = await registry()
  const ctx = freshCtx()
  await seedHypotheses(tools, ctx)

  const snapshot = await extractIncidentFactSnapshot(ctx.cwd)

  assert.ok(snapshot)
  // 无 checkpoint → 用默认值
  assert.equal(snapshot.incident_title, '(未命名事故)')
  assert.equal(snapshot.severity, 'unknown')
  // start_time 回退到第一个假设的 created_at
  assert.ok(snapshot.start_time > 0)
  // 假设计数
  assert.equal(snapshot.hypotheses.active, 1) // h3 pending
  assert.equal(snapshot.hypotheses.confirmed, 1) // h1
  assert.equal(snapshot.hypotheses.refuted, 1) // h2
  // key_commands 从 evidence 提取（h1 有 2 条）
  assert.ok(snapshot.key_commands.length <= 10)
  assert.ok(snapshot.key_commands.includes('kubectl get pod payment-abc'))
  // next_steps：有 confirmed → 用其 conclusion
  assert.match(snapshot.next_steps, /根因已确认/)
  assert.match(snapshot.next_steps, /512Mi/)
})

test('extractIncidentFactSnapshot: 有活动 checkpoint 时用其元信息', async () => {
  const { extractIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  const tools = await registry()
  const ctx = freshCtx()
  await seedHypotheses(tools, ctx)
  await seedCheckpoint(tools, ctx)

  const snapshot = await extractIncidentFactSnapshot(ctx.cwd)

  assert.ok(snapshot)
  assert.equal(snapshot.incident_title, 'payment OOM 500 事故')
  assert.equal(snapshot.severity, 'SEV1')
})

test('extractIncidentFactSnapshot: key_commands 上限 10 条', async () => {
  const { extractIncidentFactSnapshot, MAX_KEY_COMMANDS } = await import(
    '../src/compact/incident-facts.js'
  )
  const tools = await registry()
  const ctx = freshCtx()
  // 创建一个假设 + 12 条 evidence（超过 MAX_KEY_COMMANDS=10）
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: '测试', priority: 1 },
    ctx,
  )
  for (let i = 0; i < 12; i++) {
    await tools.execute(
      'hypothesis_tracker',
      {
        action: 'add_evidence',
        hypothesis_id: 'h1',
        evidence: {
          command: `cmd-${i}`,
          output_summary: `out-${i}`,
          data_source: 'test',
          timestamp: 1705611600 + i,
          supports: true,
        },
      },
      ctx,
    )
  }

  const snapshot = await extractIncidentFactSnapshot(ctx.cwd)
  assert.ok(snapshot)
  assert.equal(snapshot.key_commands.length, MAX_KEY_COMMANDS)
  // 按时间戳排序，前 10 条是 cmd-0 到 cmd-9
  assert.deepEqual(snapshot.key_commands, [
    'cmd-0', 'cmd-1', 'cmd-2', 'cmd-3', 'cmd-4',
    'cmd-5', 'cmd-6', 'cmd-7', 'cmd-8', 'cmd-9',
  ])
})

test('extractIncidentFactSnapshot: 无 confirmed 时 next_steps 提示继续验证最高优先级', async () => {
  const { extractIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: '低优先级', priority: 3 },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h2', description: '高优先级', priority: 1 },
    ctx,
  )

  const snapshot = await extractIncidentFactSnapshot(ctx.cwd)
  assert.ok(snapshot)
  assert.match(snapshot.next_steps, /继续验证最高优先级假设/)
  assert.match(snapshot.next_steps, /高优先级/)
})

test('extractIncidentFactSnapshot: 全部 refuted 时 next_steps 提示重新生成假设', async () => {
  const { extractIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  const tools = await registry()
  const ctx = freshCtx()
  await tools.execute(
    'hypothesis_tracker',
    { action: 'add_hypothesis', id: 'h1', description: '假设1', priority: 1 },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    { action: 'update_status', hypothesis_id: 'h1', status: 'refuted' },
    ctx,
  )

  const snapshot = await extractIncidentFactSnapshot(ctx.cwd)
  assert.ok(snapshot)
  assert.match(snapshot.next_steps, /所有假设已排除，建议重新生成根因假设/)
})

// --- formatIncidentFactSnapshot ---

test('formatIncidentFactSnapshot: 输出含所有字段且可读', async () => {
  const { formatIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  type IncidentFactSnapshot = {
    incident_title: string
    severity: string
    start_time: number
    hypotheses: { active: number; confirmed: number; refuted: number; summary: string }
    key_commands: string[]
    next_steps: string
  }
  const snapshot: IncidentFactSnapshot = {
    incident_title: '测试事故',
    severity: 'SEV1',
    start_time: 1705611600000,
    hypotheses: {
      active: 2,
      confirmed: 1,
      refuted: 1,
      summary: '[confirmed] P1 h1: OOM 假设 (2 evidence)\n[refuted] P2 h2: 代码 bug',
    },
    key_commands: ['kubectl get pod', 'kubectl logs'],
    next_steps: '根因已确认，建议进入处置阶段',
  }

  const formatted = formatIncidentFactSnapshot(snapshot)

  assert.match(formatted, /## 事故事实层（compact 保活，请勿丢失）/)
  assert.match(formatted, /\*\*事故\*\*: 测试事故/)
  assert.match(formatted, /\*\*严重级别\*\*: SEV1/)
  assert.match(formatted, /2024-01-18T/) // start_time ISO
  assert.match(formatted, /active=2 confirmed=1 refuted=1/)
  assert.match(formatted, /### 假设链摘要/)
  assert.match(formatted, /\[confirmed\] P1 h1: OOM 假设/)
  assert.match(formatted, /### 已执行关键命令/)
  assert.match(formatted, /`kubectl get pod`/)
  assert.match(formatted, /### 推荐下一步/)
  assert.match(formatted, /根因已确认，建议进入处置阶段/)
})

test('formatIncidentFactSnapshot: key_commands 为空时显示占位符', async () => {
  const { formatIncidentFactSnapshot } = await import(
    '../src/compact/incident-facts.js'
  )
  const formatted = formatIncidentFactSnapshot({
    incident_title: 'test',
    severity: 'SEV2',
    start_time: 1705611600000,
    hypotheses: { active: 0, confirmed: 0, refuted: 0, summary: '(none)' },
    key_commands: [],
    next_steps: '继续排查',
  })
  assert.match(formatted, /\(暂无关键命令记录\)/)
})

// --- 集成：compactConversation 注入快照 ---

test('compactConversation: 传入 cwd 且有假设链时 summary 含事故事实层', async () => {
  const { compactConversation } = await import('../src/compact/compact.js')
  const tools = await registry()
  const ctx = freshCtx()
  await seedHypotheses(tools, ctx)

  // 构造足够多的消息触发压缩（> MIN_KEEP_MESSAGES）
  const messages: any[] = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `用户消息 ${i} `.repeat(50) })
    messages.push({ role: 'assistant', content: `助手回复 ${i} `.repeat(50) })
  }

  // mock modelAdapter 返回固定 summary
  const mockAdapter = {
    next: async () => ({ type: 'assistant' as const, content: '这是压缩摘要。' }),
  }

  const result = await compactConversation(messages, mockAdapter as any, ctx.cwd)
  assert.ok(result)
  assert.match(result.summary.content, /这是压缩摘要。/)
  assert.match(result.summary.content, /## 事故事实层（compact 保活，请勿丢失）/)
  assert.match(result.summary.content, /OOM 假设/)
})

test('compactConversation: 传入 cwd 但假设链为空时 summary 不含事故事实层（降级）', async () => {
  const { compactConversation } = await import('../src/compact/compact.js')
  const ctx = freshCtx() // 不创建假设

  const messages: any[] = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `用户消息 ${i} `.repeat(50) })
    messages.push({ role: 'assistant', content: `助手回复 ${i} `.repeat(50) })
  }

  const mockAdapter = {
    next: async () => ({ type: 'assistant' as const, content: '纯摘要无事故。' }),
  }

  const result = await compactConversation(messages, mockAdapter as any, ctx.cwd)
  assert.ok(result)
  assert.equal(result.summary.content, '纯摘要无事故。')
  assert.doesNotMatch(result.summary.content, /事故事实层/)
})

test('compactConversation: 不传 cwd 时行为不变（向后兼容）', async () => {
  const { compactConversation } = await import('../src/compact/compact.js')
  const tools = await registry()
  const ctx = freshCtx()
  await seedHypotheses(tools, ctx) // 有假设链但不传 cwd

  const messages: any[] = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `用户消息 ${i} `.repeat(50) })
    messages.push({ role: 'assistant', content: `助手回复 ${i} `.repeat(50) })
  }

  const mockAdapter = {
    next: async () => ({ type: 'assistant' as const, content: '摘要。' }),
  }

  const result = await compactConversation(messages, mockAdapter as any) // 不传 cwd
  assert.ok(result)
  assert.equal(result.summary.content, '摘要。')
  assert.doesNotMatch(result.summary.content, /事故事实层/)
})
