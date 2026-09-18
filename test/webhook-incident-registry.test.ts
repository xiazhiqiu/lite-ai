import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

let tempHome: string

const SRE_CWD = `D:/dev/sre-registry-${Date.now()}`

before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-registry-'))
  process.env.LITE_AI_HOME = tempHome
})

after(async () => {
  delete process.env.LITE_AI_HOME
  await rm(tempHome, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
  })
}

async function mkAlert(over: {
  title?: string
  severity?: string
  labels?: Record<string, string>
  startsAt?: string
}) {
  const { computeAlertId } = await import('../src/webhook/types.js')
  const labels = over.labels ?? { service: 'payment' }
  const title = over.title ?? 'T'
  return {
    id: computeAlertId(title, labels),
    title,
    severity: over.severity ?? 'warning',
    summary: `${title} summary`,
    description: `${title} description`,
    labels,
    startsAt: over.startsAt ?? '2026-09-17T00:00:00Z',
    status: 'firing' as const,
  }
}

// ---------- 维度关系判定（纯函数） ----------

test('checkDimensionRelationship: 五种关系判定', async () => {
  const { checkDimensionRelationship } = await import('../src/webhook/incident-registry.js')
  const base = { service: 'payment', cluster: 'A' }

  assert.equal(checkDimensionRelationship(base, { service: 'payment', cluster: 'A' }), 'equal')
  assert.equal(checkDimensionRelationship(base, { service: 'payment' }), 'newIsSubset')
  assert.equal(
    checkDimensionRelationship(base, { service: 'payment', cluster: 'A', namespace: 'prod' }),
    'newIsSuperset',
  )
  assert.equal(
    checkDimensionRelationship(base, { service: 'payment', namespace: 'prod' }),
    'partialOverlap',
  )
  assert.equal(checkDimensionRelationship(base, { service: 'payment', cluster: 'B' }), 'incompatible')
})

// ---------- 跨批次：新成员并入已有 open 事件 ----------

test('registry: 跨批次同组新成员并入已有 open 事件（不再碎片化）', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  // 批 1：单条 → 成员数 1 < minAlerts(2) → 单条诊断，但事件已在注册表登记为 open
  const a1 = await mkAlert({ title: 'MySQLDown', severity: 'critical', labels: { service: 'payment' } })
  const r1 = registry.resolve([a1], {}, t0)
  assert.equal(r1.units.length, 1)
  assert.equal(r1.units[0]!.level, 'alert')
  assert.equal(r1.created, 1)

  // 批 2：同 service 的新告警 → 并入同一事件 → 达到阈值 → 升级为事件级 RCA
  const a2 = await mkAlert({
    title: 'ESConnRefused',
    labels: { service: 'payment' },
    startsAt: '2026-09-17T00:02:00Z',
  })
  const r2 = registry.resolve([a2], {}, t0 + 60_000)

  assert.equal(r2.created, 0, '不应新建事件')
  assert.equal(r2.units.length, 1)
  assert.equal(r2.units[0]!.level, 'incident')
  const unit = r2.units[0]!
  if (unit.level !== 'incident') throw new Error('unreachable')
  assert.equal(unit.incident.alerts.length, 2)
  assert.equal(unit.incident.primaryAlert.title, 'MySQLDown')
  // 两批的告警共享同一 incidentId（跨批次合并的核心证据）
  assert.equal(a1.incident?.incidentId, unit.incident.incidentId)
  assert.equal(a2.incident?.incidentId, unit.incident.incidentId)
  assert.deepEqual(r2.decisions.map(d => d.outcome), ['newAlertTypeJoined'])
})

// ---------- 跨批次：同一告警重复到达不再被静默丢弃 ----------

test('registry: 同一告警重复到达 → 记成员但不再触发诊断（修复静默丢弃）', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  const a1 = await mkAlert({ title: 'MySQLDown', labels: { service: 'payment' } })
  registry.resolve([a1], {}, t0)

  // 同一条告警（同 alertname + 同 labels → 同 alertId）再次到达
  const again = await mkAlert({ title: 'MySQLDown', labels: { service: 'payment' } })
  const r2 = registry.resolve([again], {}, t0 + 30_000)

  assert.deepEqual(r2.decisions.map(d => d.outcome), ['existingAlertRepeated'])
  assert.equal(r2.repeated, 1)
  assert.equal(r2.units.length, 0, '重复到达不应触发任何诊断')

  // 关键：成员记录保留、到达次数累计（旧实现是直接丢弃）
  const incidentId = a1.incident!.incidentId
  const open = registry.get(incidentId)!
  assert.equal(open.alerts.length, 1, '去重后的成员数仍为 1')
  assert.equal(open.seen.get(a1.id), 2, '到达次数累计为 2')
})

// ---------- 跨批次：严重度升级 ----------

test('registry: 新成员严重度更高 → severityEscalated 且主告警切换', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  const warn = await mkAlert({ title: 'Latency', severity: 'warning', labels: { service: 'payment' } })
  registry.resolve([warn], {}, t0)

  const crit = await mkAlert({
    title: 'PaymentDown',
    severity: 'critical',
    labels: { service: 'payment' },
    startsAt: '2026-09-17T00:01:00Z',
  })
  const r2 = registry.resolve([crit], {}, t0 + 60_000)

  assert.deepEqual(r2.decisions.map(d => d.outcome), ['severityEscalated'])
  assert.equal(r2.units.length, 1)
  const unit = r2.units[0]!
  if (unit.level !== 'incident') throw new Error('unreachable')
  assert.equal(unit.incident.severity, 'critical')
  assert.equal(unit.incident.primaryAlert.title, 'PaymentDown', '主告警应切换为 critical')
})

// ---------- 跨批次：维度冲突保守新建 ----------

test('registry: 同 service 但 cluster 不同 → incompatible → 保守新建（不错并）', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  const a1 = await mkAlert({
    title: 'A',
    labels: { service: 'payment', cluster: 'A' },
  })
  registry.resolve([a1], {}, t0)

  const b1 = await mkAlert({
    title: 'B',
    labels: { service: 'payment', cluster: 'B' },
    startsAt: '2026-09-17T00:01:00Z',
  })
  const r2 = registry.resolve([b1], {}, t0 + 60_000)

  assert.equal(r2.created, 1, '维度冲突应新建事件')
  assert.equal(r2.decisions[0]!.relationship, 'incompatible')
  assert.notEqual(a1.incident?.incidentId, b1.incident?.incidentId)
  assert.equal(registry.stats().open, 2)
})

// ---------- TTL：静默超期后不再并入 ----------

test('registry: open 事件静默超期（TTL）后同组告警新建事件', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry({ resolveAfterMs: 60_000 })
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  const a1 = await mkAlert({ title: 'A', labels: { service: 'payment' } })
  registry.resolve([a1], {}, t0)
  const firstId = a1.incident!.incidentId

  const a2 = await mkAlert({ title: 'B', labels: { service: 'payment' } })
  const r2 = registry.resolve([a2], {}, t0 + 120_000) // 超出 60s TTL

  assert.notEqual(a2.incident?.incidentId, firstId, '超期后应新建事件')
  assert.equal(registry.get(firstId)!.status, 'resolved')
})

// ---------- 键强度：alertId 档 ----------

test('registry: 无稳定标签 → alertId 档、单条诊断（统一路径而非分支）', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  // 两条都无 app/service/job/namespace/cluster
  const a1 = await mkAlert({ title: 'X', labels: { alertname: 'X', instance: 'n1' } })
  const a2 = await mkAlert({ title: 'Y', labels: { alertname: 'Y', instance: 'n2' } })
  const r = registry.resolve([a1, a2], {}, t0)

  assert.equal(r.units.length, 2)
  assert.ok(r.units.every(u => u.level === 'alert'), 'alertId 档永不为事件级')
  assert.ok(r.decisions.every(d => d.keyStrength === 'alertId'))
  assert.ok(r.decisions.every(d => d.reason === 'alertId'))
  // 但每条仍被包成事件（统一路径）—— ref 存在，只是强度最弱
  assert.ok(a1.incident !== undefined && a2.incident !== undefined)
  assert.notEqual(a1.incident!.incidentId, a2.incident!.incidentId)
})

// ---------- 键强度：secondary 档 ----------

test('registry: 仅命中基础设施维度（cluster）→ secondary 档且可事件级', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  const a1 = await mkAlert({ title: 'A', labels: { alertname: 'A', cluster: 'prod' } })
  const a2 = await mkAlert({ title: 'B', labels: { alertname: 'B', cluster: 'prod' } })
  const r = registry.resolve([a1, a2], {}, t0)

  assert.equal(r.units.length, 1)
  assert.equal(r.units[0]!.level, 'incident')
  assert.equal(r.decisions[0]!.keyStrength, 'secondary')
  assert.equal(r.decisions[0]!.reason, 'secondaryMatch')
})

// ---------- 拓扑簇跨服务并入 ----------

test('registry: 拓扑簇（跨服务同 application）→ 1 个事件级 RCA', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const { createGraph } = await import('../src/webhook/topology.js')
  const graph = createGraph({
    source: 'static',
    applications: { mysql: 'payments', elasticsearch: 'payments', apm: 'payments' },
  })
  const alerts = [
    await mkAlert({ title: 'MySQLDown', severity: 'critical', labels: { service: 'mysql' } }),
    await mkAlert({ title: 'ESConnRefused', labels: { service: 'elasticsearch' } }),
    await mkAlert({ title: 'APMLatency', labels: { service: 'apm' } }),
  ]

  const registry = new IncidentRegistry()
  const { units, decisions } = registry.resolve(alerts, {}, Date.parse('2026-09-17T00:05:00Z'), graph)

  assert.equal(units.length, 1)
  assert.equal(units[0]!.level, 'incident')
  const unit = units[0]!
  if (unit.level !== 'incident') throw new Error('unreachable')
  assert.equal(unit.incident.type, 'topology')
  assert.equal(unit.incident.groupKey, 'application=payments')
  assert.equal(unit.incident.alerts.length, 3)
  assert.equal(unit.incident.keyStrength, 'primary')
  assert.deepEqual([...unit.incident.affectedServices].sort(), ['apm', 'elasticsearch', 'mysql'])
  assert.ok(decisions.every(d => d.reason === 'topology'))
  // 三条告警共享同一 incidentId → 一次 RCA
  assert.equal(new Set(alerts.map(a => a.incident?.incidentId)).size, 1)
})

// ---------- incremental reanalysis 标记 ----------

test('registry: 已诊断事件的新成员 → isReanalysis=true（增量重分析）', async () => {
  const { IncidentRegistry } = await import('../src/webhook/incident-registry.js')
  const registry = new IncidentRegistry()
  const t0 = Date.parse('2026-09-17T00:00:00Z')

  const a1 = await mkAlert({ title: 'A', labels: { service: 'payment' } })
  const a2 = await mkAlert({ title: 'B', labels: { service: 'payment' } })
  const r1 = registry.resolve([a1, a2], {}, t0)
  assert.equal(r1.units[0]!.level, 'incident')
  if (r1.units[0]!.level === 'incident') {
    assert.equal(r1.units[0]!.isReanalysis, false)
    registry.markDiagnosed(r1.units[0]!.incident.incidentId)
  }

  const a3 = await mkAlert({
    title: 'C',
    labels: { service: 'payment' },
    startsAt: '2026-09-17T00:03:00Z',
  })
  const r2 = registry.resolve([a3], {}, t0 + 120_000)
  assert.equal(r2.units.length, 1)
  const unit = r2.units[0]!
  if (unit.level !== 'incident') throw new Error('unreachable')
  assert.equal(unit.isReanalysis, true, '已有事件的新成员应标记为增量重分析')
  assert.equal(unit.incident.alerts.length, 3)
  assert.equal(unit.incident.observedCount, 3)
})

// ---------- HTTP 端到端：跨批次 ----------

async function startServer() {
  const port = await getFreePort()
  const controller = new AbortController()
  const calls: Array<{ title: string; incidentSize: number; sessionId: string; reanalysis: boolean }> = []

  const { runWebhookServer } = await import('../src/webhook/index.js')
  const serverPromise = runWebhookServer({
    cwd: SRE_CWD,
    config: {
      port,
      host: '127.0.0.1',
      autoDiagnose: true,
      maxConcurrentDiagnoses: 3,
      notifyHeaders: {},
    },
    abortSignal: controller.signal,
    diagnose: async (alert, incident) => {
      const sessionId = incident?.incidentId ?? alert.id
      calls.push({
        title: alert.title,
        incidentSize: incident?.alerts.length ?? 0,
        sessionId,
        reanalysis: false,
      })
      return { sessionId, diagnosisSummary: 'ok' }
    },
  })
  await sleep(150)
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => controller.abort(),
    done: serverPromise,
  }
}

function payloadFor(alerts: Array<{ name: string; severity: string; labels: Record<string, string>; startsAt?: string }>) {
  return {
    status: 'firing',
    alerts: alerts.map(a => ({
      status: 'firing',
      labels: { alertname: a.name, severity: a.severity, ...a.labels },
      annotations: { summary: `${a.name} summary` },
      startsAt: a.startsAt ?? '2026-09-17T00:00:00Z',
    })),
  }
}

async function post(url: string, body: unknown) {
  const res = await fetch(`${url}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, number> }
}

test('HTTP: 跨批次 — 第二批同组新成员并入事件并触发一次事件级诊断', async () => {
  const srv = await startServer()
  try {
    // 批 1：单条 → 低于 minAlerts → 单条诊断
    const r1 = await post(srv.url, payloadFor([{ name: 'MySQLDown', severity: 'critical', labels: { service: 'payment' } }]))
    assert.equal(r1.status, 202)
    assert.equal(r1.json.accepted, 1)
    for (let i = 0; i < 50 && srv.calls.length < 1; i++) await sleep(20)
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]!.incidentSize, 0, '批 1 未达阈值 → 单条诊断')

    // 批 2：同 service 新告警 → 并入 → 事件级
    const r2 = await post(srv.url, payloadFor([{ name: 'ESConnRefused', severity: 'warning', labels: { service: 'payment' }, startsAt: '2026-09-17T00:02:00Z' }]))
    assert.equal(r2.json.accepted, 1)
    for (let i = 0; i < 50 && srv.calls.length < 2; i++) await sleep(20)
    assert.equal(srv.calls.length, 2)
    assert.equal(srv.calls[1]!.incidentSize, 2, '跨批次并入后成员数应为 2')
    assert.match(srv.calls[1]!.sessionId, /^inc-/, '事件级 sessionId 应为 incidentId')
  } finally {
    srv.close()
  }
  await srv.done
})

test('HTTP: 同一告警重复到达 → 不重复诊断（accepted=0，记入 deduplicated）', async () => {
  const srv = await startServer()
  try {
    const body = payloadFor([{ name: 'MySQLDown', severity: 'critical', labels: { service: 'payment' } }])
    const r1 = await post(srv.url, body)
    assert.equal(r1.json.accepted, 1)
    for (let i = 0; i < 50 && srv.calls.length < 1; i++) await sleep(20)

    const r2 = await post(srv.url, body)
    assert.equal(r2.json.accepted, 0)
    assert.ok(r2.json.deduplicated >= 1, '重复到达应计入 deduplicated 而非被静默丢弃')
    await sleep(120)
    assert.equal(srv.calls.length, 1, '重复到达不应再次触发诊断')
  } finally {
    srv.close()
  }
  await srv.done
})
