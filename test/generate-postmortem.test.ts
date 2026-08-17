import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry, type ToolContext } from '../src/tool.js'

let tempRoot: string

let cwdCounter = 0
function freshCtx(): ToolContext {
  cwdCounter += 1
  return { cwd: `D:/dev/sre-postmortem-${cwdCounter}` }
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-pm-'))
  process.env.LITE_AI_HOME = tempRoot
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempRoot, { recursive: true, force: true })
})

async function registry(): Promise<ToolRegistry> {
  const { generatePostmortemTool } = await import(
    '../src/tools/generate-postmortem.js'
  )
  const { incidentCheckpointTool } = await import(
    '../src/tools/incident-checkpoint.js'
  )
  const { hypothesisTrackerTool } = await import(
    '../src/tools/hypothesis-tracker.js'
  )
  return new ToolRegistry([
    generatePostmortemTool,
    incidentCheckpointTool,
    hypothesisTrackerTool,
  ])
}

function createdId(output: string): string {
  const m = /Checkpoint created: (cp_[a-z0-9]+)/.exec(output)
  assert.ok(m, `expected checkpoint id in output: ${output}`)
  return m[1]!
}

/** 准备一个完整事故场景：1 个检查点 + 1 confirmed + 1 refuted 假设，含证据。 */
async function seedIncident(
  tools: ToolRegistry,
  ctx: ToolContext,
): Promise<string> {
  // 检查点
  const cp = await tools.execute(
    'incident_checkpoint',
    {
      action: 'create',
      name: 'payment 500',
      incident_title: 'payment 服务 OOMKilled 导致 500',
      severity: 'SEV1',
    },
    ctx,
  )
  const cpId = createdId(cp.output)

  // confirmed 假设 + 2 条支持证据
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_hypothesis',
      id: 'h1',
      description: 'payment 容器 OOMKilled',
      priority: 1,
    },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_evidence',
      hypothesis_id: 'h1',
      evidence: {
        command: 'kubectl get pod payment-abc -n sock-shop',
        output_summary: 'STATUS: CrashLoopBackOff, RESTARTS: 7',
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
        command: 'kubectl logs payment-abc -n sock-shop --previous',
        output_summary: 'OOMKilled: container exceeded memory limit 256Mi',
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
      conclusion: '容器内存限制 256Mi 不足，被 OOMKilled 后 CrashLoopBackOff',
    },
    ctx,
  )

  // refuted 假设 + 1 条反驳证据
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_hypothesis',
      id: 'h2',
      description: 'payment 服务代码 bug 导致 panic',
      priority: 2,
    },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'add_evidence',
      hypothesis_id: 'h2',
      evidence: {
        command: 'kubectl logs payment-abc -n sock-shop --previous',
        output_summary: '日志中无 panic/goroutine stack trace',
        data_source: 'kubectl logs',
        timestamp: 1705611750,
        supports: false,
      },
    },
    ctx,
  )
  await tools.execute(
    'hypothesis_tracker',
    {
      action: 'update_status',
      hypothesis_id: 'h2',
      status: 'refuted',
      conclusion: '日志无 panic 痕迹，排除代码 bug',
    },
    ctx,
  )

  return cpId
}

// --- 正路径 ---

test('generate_postmortem: 完整事故场景生成报告并落盘', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const cpId = await seedIncident(tools, ctx)

  const result = await tools.execute(
    'generate_postmortem',
    {
      checkpoint_id: cpId,
      impact: 'payment 服务 500 错误，约 12k 用户支付失败，持续 23 分钟',
      remediation_actions: [
        'kubectl patch deployment payment -p 内存限制 512Mi',
        '观察 5 分钟，错误率归零',
      ],
      lessons_learned: [
        '提升 payment 内存 limit 至 512Mi',
        '为 OOMKilled 配置 Prometheus 告警',
      ],
    },
    ctx,
  )

  assert.equal(result.ok, true)
  assert.match(result.output, /Postmortem generated for "payment 500"/)
  assert.match(result.output, /Saved to: .*postmortems[\\/].*\.md/)

  // 验证报告内容
  assert.match(result.output, /# Postmortem: payment 服务 OOMKilled 导致 500/)
  assert.match(result.output, /SEV1/)
  assert.match(result.output, /## 1\. 概述/)
  assert.match(result.output, /## 2\. 影响范围/)
  assert.match(result.output, /12k 用户支付失败/)
  assert.match(result.output, /## 3\. 时间线/)
  // 时间线按时间戳排序：1705611600 < 1705611700 < 1705611750
  // 顺序应为 CrashLoopBackOff → OOMKilled → panic
  const timelineSection = result.output.split('## 3. 时间线')[1]!.split('## 4.')[0]!
  assert.match(timelineSection, /CrashLoopBackOff[\s\S]*OOMKilled[\s\S]*panic/)
  assert.match(result.output, /## 4\. 根因分析/)
  assert.match(result.output, /h1: payment 容器 OOMKilled/)
  assert.match(result.output, /容器内存限制 256Mi 不足/)
  assert.match(result.output, /## 5\. 已排除的假设/)
  assert.match(result.output, /h2.*代码 bug/)
  assert.match(result.output, /## 6\. 处置记录/)
  assert.match(result.output, /patch deployment payment/)
  assert.match(result.output, /## 7\. 经验教训与改进项/)
  assert.match(result.output, /Prometheus 告警/)
  assert.match(result.output, /附录：完整假设链/)

  // 验证落盘文件
  const { postmortemFilePath } = await import(
    '../src/tools/generate-postmortem.js'
  )
  const filePath = postmortemFilePath(ctx.cwd, cpId)
  const fileContent = await readFile(filePath, 'utf8')
  assert.equal(fileContent, result.output.split('\n\n---\n\n')[1])
})

test('generate_postmortem: 不传 checkpoint_id 时使用最新检查点', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const cpId = await seedIncident(tools, ctx)

  const result = await tools.execute('generate_postmortem', {}, ctx)

  assert.equal(result.ok, true)
  assert.match(result.output, new RegExp(`checkpoint ${cpId}`))
})

test('generate_postmortem: 不传可选字段时报告留占位符', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await seedIncident(tools, ctx)

  const result = await tools.execute('generate_postmortem', {}, ctx)

  assert.equal(result.ok, true)
  assert.match(result.output, /## 2\. 影响范围\n\(待补充\)/)
  assert.match(result.output, /## 6\. 处置记录\n\(未记录\)/)
  assert.match(result.output, /## 7\. 经验教训与改进项\n\(待补充\)/)
})

test('generate_postmortem: 时间线按证据时间戳升序排序', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await seedIncident(tools, ctx)

  const result = await tools.execute('generate_postmortem', {}, ctx)
  // 找到时间线表格行
  const timelineSection = result.output.split('## 3. 时间线')[1]!.split('## 4.')[0]!
  const lines = timelineSection
    .split('\n')
    .filter(l => l.startsWith('| ') && !l.includes('---') && !l.includes('# '))
  assert.ok(lines.length >= 3)
  // 第一行应是最早时间戳 1705611600 (2024-01-18T...)
  assert.match(lines[0]!, /CrashLoopBackOff/)
  // 最后一行应是最晚 1705611750
  assert.match(lines[lines.length - 1]!, /panic/)
})

test('generate_postmortem: 无 confirmed 假设时根因分析给出提示', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  // 只创建检查点，不加假设
  const cp = await tools.execute(
    'incident_checkpoint',
    {
      action: 'create',
      name: '未定位事故',
      incident_title: '某服务间歇性超时',
      severity: 'SEV2',
    },
    ctx,
  )
  const cpId = createdId(cp.output)

  const result = await tools.execute(
    'generate_postmortem',
    { checkpoint_id: cpId },
    ctx,
  )

  assert.equal(result.ok, true)
  assert.match(result.output, /无 confirmed 假设——根因未定位或未确认/)
  assert.match(result.output, /\(暂无证据记录\)/)
  assert.match(result.output, /\(无已排除假设\)/)
  assert.match(result.output, /\(无假设记录\)/)
})

// --- 反路径 ---

test('generate_postmortem: 无检查点时报错', async () => {
  const tools = await registry()
  const ctx = freshCtx()

  const result = await tools.execute('generate_postmortem', {}, ctx)

  assert.equal(result.ok, false)
  assert.match(result.output, /No checkpoint found/)
})

test('generate_postmortem: 未知 checkpoint_id 报错并列出已知', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  await seedIncident(tools, ctx)

  const result = await tools.execute(
    'generate_postmortem',
    { checkpoint_id: 'cp_ghost' },
    ctx,
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown checkpoint id "cp_ghost"/)
  assert.match(result.output, /cp_\w+: payment 500/)
})

test('generate_postmortem: 空字符串 remediation_actions 被 schema 拒绝', async () => {
  const tools = await registry()
  const ctx = freshCtx()
  const cpId = await seedIncident(tools, ctx)

  const result = await tools.execute(
    'generate_postmortem',
    {
      checkpoint_id: cpId,
      remediation_actions: [''],
    },
    ctx,
  )

  assert.equal(result.ok, false)
})

test('generate_postmortem: 不传 checkpoint_id 时优先使用活动检查点（而非最新）', async () => {
  const tools = await registry()
  const ctx = freshCtx()

  // 创建第一个检查点并设为活动
  const cp1 = await tools.execute(
    'incident_checkpoint',
    {
      action: 'create',
      name: '较早事故',
      incident_title: '较早事故（已设为活动）',
      severity: 'SEV2',
    },
    ctx,
  )
  const cp1Id = createdId(cp1.output)
  await tools.execute(
    'incident_checkpoint',
    { action: 'switch_to', checkpoint_id: cp1Id },
    ctx,
  )

  // 创建第二个更新的检查点（不设为活动）
  // 注意：seedIncident 会创建名为 "payment 500" 的检查点，比 cp1 新
  await seedIncident(tools, ctx)

  // 不传 checkpoint_id，应回退到活动检查点（cp1），而非最新的 payment 500
  const result = await tools.execute('generate_postmortem', {}, ctx)

  assert.equal(result.ok, true)
  assert.match(result.output, new RegExp(`checkpoint ${cp1Id}`))
  assert.match(result.output, /较早事故（已设为活动）/)
  // 不应使用最新的 payment 500 检查点
  assert.doesNotMatch(result.output, /payment 服务 OOMKilled 导致 500/)
})
