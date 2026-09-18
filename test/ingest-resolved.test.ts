import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IncidentRegistry, type DiagnosisUnit } from '../src/webhook/incident-registry.js'
import { IngestPipeline, type IngestConfig } from '../src/ingest/pipeline.js'
import { computeAlertId, type Alert } from '../src/webhook/types.js'

const silent = () => {
  /* no-op */
}

/** 构造一条统一 Alert（id 用统一 fingerprint，保证与注册表成员可比对）。 */
function alertOf(
  title: string,
  labels: Record<string, string>,
  status: Alert['status'] = 'firing',
): Alert {
  return {
    id: computeAlertId(title, labels),
    title,
    severity: 'warning',
    summary: `${title} summary`,
    description: `${title} description`,
    labels,
    startsAt: new Date().toISOString(),
    status,
  }
}

/** 从 resolve() 结果里取事件 id（判别联合需显式收窄）。 */
function incidentIdOf(units: DiagnosisUnit[]): string {
  const unit = units.find(u => u.level === 'incident')
  if (unit === undefined || unit.level !== 'incident') {
    throw new Error('期望存在事件级诊断单元')
  }
  return unit.incident.incidentId
}

const firingCfg: IngestConfig = { autoDiagnose: true, maxConcurrentDiagnoses: 2 }

// ---------------------------------------------------------------- 注册表：收敛路径

test('markResolved: 只有全部成员都恢复才关闭事件（单成员恢复不关）', () => {
  const registry = new IncidentRegistry()
  const now = Date.parse('2026-09-18T10:00:00Z')
  const mysql = alertOf('MySQLDown', { service: 'payments' })
  const es = alertOf('ESConnRefused', { service: 'payments' })

  const incidentId = incidentIdOf(registry.resolve([mysql, es], {}, now, null).units)

  // 只恢复其中一个成员：事件必须保持 open（多根因下单个成员好了不代表整件事好了）
  const partial = registry.markResolved(
    [alertOf('MySQLDown', { service: 'payments' }, 'resolved')],
    {},
    now + 1000,
  )
  assert.deepEqual(partial.closed, [])
  assert.equal(partial.resolvedMembers, 1)
  assert.equal(registry.get(incidentId)!.status, 'open')

  // 另一个成员也恢复 → 关闭
  const full = registry.markResolved(
    [alertOf('ESConnRefused', { service: 'payments' }, 'resolved')],
    {},
    now + 2000,
  )
  assert.deepEqual(full.closed, [incidentId])
  assert.equal(registry.get(incidentId)!.status, 'resolved')
  assert.equal(registry.get(incidentId)!.resolvedAt, now + 2000)
  assert.equal(registry.stats().open, 0)
})

test('markResolved: 未匹配任何 open 事件时只计数，不新建事件', () => {
  const registry = new IncidentRegistry()
  const result = registry.markResolved(
    [alertOf('NeverSeenBefore', { service: 'ghost' }, 'resolved')],
    {},
    Date.now(),
  )
  assert.deepEqual(result.closed, [])
  assert.equal(result.resolvedMembers, 0)
  assert.equal(result.unmatched, 1)
  assert.equal(registry.stats().total, 0, '恢复通知不构成新事件')
})

test('markResolved: 事件关闭后重复收到恢复不再重报关闭', () => {
  const registry = new IncidentRegistry()
  const now = Date.parse('2026-09-18T10:00:00Z')
  const members = [alertOf('A', { service: 's' }), alertOf('B', { service: 's' })]
  const incidentId = incidentIdOf(registry.resolve(members, {}, now, null).units)

  const first = registry.markResolved([alertOf('A', { service: 's' }, 'resolved')], {}, now + 1)
  const second = registry.markResolved([alertOf('B', { service: 's' }, 'resolved')], {}, now + 2)
  assert.deepEqual(first.closed, [], '仅部分成员恢复不关')
  assert.deepEqual(second.closed, [incidentId])

  const again = registry.markResolved([alertOf('A', { service: 's' }, 'resolved')], {}, now + 3)
  assert.deepEqual(again.closed, [], '已关闭的事件不再重复上报')
})

// ---------------------------------------------------------------- 管道：分流语义

test('IngestPipeline: firing 成事件诊断，resolved 只收敛关闭（不烧第二次 token）', async () => {
  const diagnosed: string[] = []
  const pipeline = new IngestPipeline('D:/dev/resolved', firingCfg, {
    log: silent,
    diagnose: async (alert, incident) => {
      diagnosed.push(incident?.incidentId ?? alert.id)
      return { sessionId: incident?.incidentId ?? alert.id, diagnosisSummary: 'ok' }
    },
  })

  try {
    // 第一批：两条同 service 的 firing → 一次事件级 RCA
    const first = pipeline.ingest([
      alertOf('MySQLDown', { service: 'payments' }),
      alertOf('ESConnRefused', { service: 'payments' }),
    ])
    await pipeline.drained()
    assert.equal(first.accepted, 1)
    assert.equal(first.resolved, 0)
    assert.equal(first.closedIncidents, 0)
    assert.equal(diagnosed.length, 1)
    const incidentId = diagnosed[0]!

    // 第二批：两者的恢复通知 → 不触发 RCA，只关闭事件
    const second = pipeline.ingest([
      alertOf('MySQLDown', { service: 'payments' }, 'resolved'),
      alertOf('ESConnRefused', { service: 'payments' }, 'resolved'),
    ])
    await pipeline.drained()
    assert.equal(second.accepted, 0, '恢复通知不该触发 RCA')
    assert.equal(second.resolved, 2)
    assert.equal(second.closedIncidents, 1)
    assert.equal(diagnosed.length, 1, '不应新增任何诊断调用')
    assert.equal(pipeline.incidents.get(incidentId)!.status, 'resolved')
  } finally {
    pipeline.close()
  }
})

test('IngestPipeline: 部分成员恢复不关闭事件，后续新成员仍可并入', async () => {
  const diagnosed: string[] = []
  const pipeline = new IngestPipeline('D:/dev/resolved-partial', firingCfg, {
    log: silent,
    diagnose: async (alert, incident) => {
      diagnosed.push(incident?.incidentId ?? alert.id)
      return { sessionId: incident?.incidentId ?? alert.id, diagnosisSummary: 'ok' }
    },
  })

  try {
    pipeline.ingest([
      alertOf('MySQLDown', { service: 'payments' }),
      alertOf('ESConnRefused', { service: 'payments' }),
    ])
    await pipeline.drained()
    const incidentId = diagnosed[0]!

    // 只恢复一个成员
    const partial = pipeline.ingest([alertOf('MySQLDown', { service: 'payments' }, 'resolved')])
    await pipeline.drained()
    assert.equal(partial.closedIncidents, 0)
    assert.equal(pipeline.incidents.get(incidentId)!.status, 'open')

    // 同一维度又来一条新 firing → 仍并入同一事件（跨批次连续性未被误关打断）
    const third = pipeline.ingest([alertOf('LatencyHigh', { service: 'payments' })])
    await pipeline.drained()
    assert.equal(third.accepted, 1)
    assert.equal(diagnosed[diagnosed.length - 1], incidentId, '应并入事件做增量重分析')
    assert.equal(pipeline.incidents.get(incidentId)!.status, 'open')
  } finally {
    pipeline.close()
  }
})

test('IngestPipeline: autoDiagnose=false 时仍执行收敛（收敛不属于诊断）', () => {
  const logs: string[] = []
  const pipeline = new IngestPipeline(
    'D:/dev/resolved-no-auto',
    { autoDiagnose: false, maxConcurrentDiagnoses: 2 },
    {
      log: (_level, message) => logs.push(message),
      diagnose: async () => ({ sessionId: 'x', diagnosisSummary: 'ok' }),
    },
  )
  try {
    const result = pipeline.ingest([alertOf('X', { service: 's' }, 'resolved')])
    assert.equal(result.accepted, 0, '关了自动诊断自然不产生诊断单元')
    assert.equal(result.resolved, 1)
    assert.ok(
      logs.some(m => m.includes('源侧恢复')),
      '收敛日志应出现 —— 证明收敛路径不受 autoDiagnose 门控',
    )
  } finally {
    pipeline.close()
  }
})

test('IngestPipeline: resolved 不经单条去重（恢复通知不该被当作"重复"抑制掉）', async () => {
  const diagnosed: string[] = []
  const pipeline = new IngestPipeline('D:/dev/resolved-dedupe', firingCfg, {
    log: silent,
    diagnose: async (alert, incident) => {
      diagnosed.push(incident?.incidentId ?? alert.id)
      return { sessionId: incident?.incidentId ?? alert.id, diagnosisSummary: 'ok' }
    },
  })

  try {
    // 单条 firing（未达事件阈值 → 走单条诊断路径，进入双层去重表）
    pipeline.ingest([alertOf('LoneAlert', { service: 'solo' })])
    await pipeline.drained()
    assert.equal(diagnosed.length, 1)

    // 同一条的恢复通知：即使去重表里刚见过该 fingerprint，也必须能走到收敛
    const closed = pipeline.ingest([alertOf('LoneAlert', { service: 'solo' }, 'resolved')])
    await pipeline.drained()
    assert.equal(closed.resolved, 1)
    assert.equal(closed.deduplicated, 0, 'resolved 不参与 alert 去重计数')
    assert.equal(closed.closedIncidents, 1, '唯一成员恢复 → 其弱事件收敛关闭')
    assert.equal(diagnosed.length, 1, '恢复不触发诊断')
  } finally {
    pipeline.close()
  }
})
