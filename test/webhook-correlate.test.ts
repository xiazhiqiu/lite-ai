import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

let tempHome: string

const SRE_CWD = `D:/dev/sre-correlate-${Date.now()}`

before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-correlate-'))
  process.env.LITE_AI_HOME = tempHome
})

after(async () => {
  delete process.env.LITE_AI_HOME
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_KEY
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

// ---------- 关联规则：标签 + 时间窗 + 阈值 ----------

test('correlateAlerts: 同组同窗 ≥minAlerts → 生成 1 个事件，成员共享 incidentId', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { alertSessionId } = await import('../src/webhook/types.js')
  const a1 = await mkAlert({ title: 'DBDown', labels: { service: 'payment' }, severity: 'critical' })
  const a2 = await mkAlert({ title: 'ConnRefused', labels: { service: 'payment' }, startsAt: '2026-09-17T00:01:00Z' })

  const incidents = correlateAlerts([a1, a2], {}, Date.parse('2026-09-17T00:05:00Z'))

  assert.equal(incidents.length, 1)
  const inc = incidents[0]!
  assert.equal(inc.groupKey, 'service=payment')
  assert.equal(inc.alerts.length, 2)
  // 成员就地写入 incident ref，session 派生为事件 id（= 一次事件级 RCA）
  assert.equal(a1.incident?.incidentId, inc.incidentId)
  assert.equal(a2.incident?.incidentId, inc.incidentId)
  assert.equal(alertSessionId(a1), inc.incidentId)
  assert.equal(alertSessionId(a2), inc.incidentId)
})

test('correlateAlerts: 不同 service → 各自单例，不生成事件', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { alertSessionId } = await import('../src/webhook/types.js')
  const a1 = await mkAlert({ title: 'A', labels: { service: 'payment' } })
  const a2 = await mkAlert({ title: 'B', labels: { service: 'carts' } })

  const incidents = correlateAlerts([a1, a2])

  assert.equal(incidents.length, 0)
  assert.equal(a1.incident, undefined)
  assert.equal(a2.incident, undefined)
  assert.equal(alertSessionId(a1), a1.id)
  assert.equal(alertSessionId(a2), a2.id)
})

test('correlateAlerts: 无稳定标签 → 不参与关联（宁可漏关联也不错并）', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const a1 = await mkAlert({ title: 'A', labels: { alertname: 'X', instance: 'n1' } })
  const a2 = await mkAlert({ title: 'B', labels: { alertname: 'Y', instance: 'n2' } })

  const incidents = correlateAlerts([a1, a2])

  assert.equal(incidents.length, 0)
  assert.equal(a1.incident, undefined)
  assert.equal(a2.incident, undefined)
})

test('correlateAlerts: 同组仅 1 条 → 低于 minAlerts，退化为单条诊断', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const a1 = await mkAlert({ labels: { service: 'payment' } })
  const incidents = correlateAlerts([a1])
  assert.equal(incidents.length, 0)
  assert.equal(a1.incident, undefined)
})

test('correlateAlerts: minAlerts 可配（3 条阈值）', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const two = [
    await mkAlert({ title: 'A', labels: { service: 'payment' } }),
    await mkAlert({ title: 'B', labels: { service: 'payment' } }),
  ]
  assert.equal(correlateAlerts(two, { minAlerts: 3 }).length, 0)

  const three = [
    await mkAlert({ title: 'A', labels: { service: 'payment' } }),
    await mkAlert({ title: 'B', labels: { service: 'payment' } }),
    await mkAlert({ title: 'C', labels: { service: 'payment' } }),
  ]
  const incidents = correlateAlerts(three, { minAlerts: 3 })
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0]!.alerts.length, 3)
})

test('correlateAlerts: enabled=false 时完全不关联', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const alerts = [
    await mkAlert({ labels: { service: 'payment' } }),
    await mkAlert({ labels: { service: 'payment' } }),
  ]
  assert.equal(correlateAlerts(alerts, { enabled: false }).length, 0)
  assert.equal(alerts[0]!.incident, undefined)
})

// ---------- 主告警（first_wins）与事件字段 ----------

test('correlateAlerts: 主告警 = severityWeight 最高，同级取 startsAt 最早', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')

  // warning 早 + critical 晚 → 主告警取 critical（严重度优先）
  const a = await mkAlert({ title: 'warnEarly', severity: 'warning', labels: { service: 'p' }, startsAt: '2026-09-17T00:00:00Z' })
  const b = await mkAlert({ title: 'critLate', severity: 'critical', labels: { service: 'p' }, startsAt: '2026-09-17T00:02:00Z' })
  assert.equal(correlateAlerts([a, b])[0]!.primaryAlert.title, 'critLate')

  // 两条 critical → 主告警取最早的
  const c = await mkAlert({ title: 'critEarly', severity: 'critical', labels: { service: 'q' }, startsAt: '2026-09-17T00:00:00Z' })
  const d = await mkAlert({ title: 'critLater', severity: 'critical', labels: { service: 'q' }, startsAt: '2026-09-17T00:03:00Z' })
  assert.equal(correlateAlerts([c, d])[0]!.primaryAlert.title, 'critEarly')
})

test('correlateAlerts: startedAt 取最早、severity 取主告警、影响面聚合 service 集合', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const a = await mkAlert({ title: 'A', severity: 'critical', labels: { app: 'payments', service: 'payments-api' }, startsAt: '2026-09-17T00:03:00Z' })
  const b = await mkAlert({ title: 'B', severity: 'warning', labels: { app: 'payments', service: 'payments-db' }, startsAt: '2026-09-17T00:01:00Z' })

  const inc = correlateAlerts([a, b])[0]!

  // 分组键优先取 app
  assert.equal(inc.groupKey, 'app=payments')
  assert.equal(inc.startedAt, '2026-09-17T00:01:00Z')
  assert.equal(inc.severity, 'critical')
  assert.deepEqual([...inc.affectedServices].sort(), ['payments-api', 'payments-db'])
})

test('correlateAlerts: 时间桶轮换 → 窗口过期后换新事件 id', async () => {
  const { correlateAlerts, DEFAULT_CORRELATION_CONFIG } = await import('../src/webhook/correlate.js')
  const t0 = Date.parse('2026-09-17T00:00:00Z')
  const mk = async () => [
    await mkAlert({ labels: { service: 'payment' } }),
    await mkAlert({ labels: { service: 'payment' } }),
  ]
  const inc1 = correlateAlerts(await mk(), {}, t0)[0]!
  const inc2 = correlateAlerts(await mk(), {}, t0 + DEFAULT_CORRELATION_CONFIG.windowMs)[0]!
  assert.notEqual(inc1.incidentId, inc2.incidentId)
})

// ---------- 事件级诊断消息 ----------

test('normalizeIncidentMessage: 含事件包 + 逐告警确认根因/允许多重根因协议', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { normalizeIncidentMessage } = await import('../src/webhook/types.js')
  const a = await mkAlert({ title: 'MySQLDown', severity: 'critical', labels: { service: 'payment' } })
  const b = await mkAlert({ title: 'ESConnRefused', severity: 'warning', labels: { service: 'payment' }, startsAt: '2026-09-17T00:01:00Z' })

  const inc = correlateAlerts([a, b])[0]!
  const text = normalizeIncidentMessage(inc)

  assert.match(text, /\[事件级告警触发\]/)
  assert.match(text, new RegExp(inc.incidentId))
  assert.match(text, /MySQLDown/)
  assert.match(text, /ESConnRefused/)
  assert.match(text, /\[主告警\]/)
  assert.match(text, /允许多重根因/)
})

// ---------- index.ts 接线：事件级触发一次 ----------

async function startServer() {
  const port = await getFreePort()
  const controller = new AbortController()
  const calls: Array<{ title: string; incidentSize: number; sessionId: string }> = []

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
      calls.push({ title: alert.title, incidentSize: incident?.alerts.length ?? 0, sessionId })
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

test('HTTP: 同组多条 → 一次事件级诊断（accepted=1，sessionId=incidentId）', async () => {
  const srv = await startServer()
  try {
    const payload = {
      status: 'firing',
      alerts: [
        { status: 'firing', labels: { alertname: 'MySQLDown', severity: 'critical', service: 'payment' }, annotations: { summary: 'db down' }, startsAt: '2026-09-17T00:00:00Z' },
        { status: 'firing', labels: { alertname: 'ESConnRefused', severity: 'warning', service: 'payment' }, annotations: { summary: 'conn refused' }, startsAt: '2026-09-17T00:01:00Z' },
      ],
    }
    const res = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(res.status, 202)
    const j = (await res.json()) as { accepted: number; deduplicated: number }
    assert.equal(j.accepted, 1, '两条同组告警应折叠为 1 个事件')
    assert.equal(j.deduplicated, 0)

    for (let i = 0; i < 50 && srv.calls.length < 1; i++) await sleep(20)
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]!.incidentSize, 2)
    assert.equal(srv.calls[0]!.title, 'MySQLDown', '主告警应为 critical')
    assert.match(srv.calls[0]!.sessionId, /^inc-/)
  } finally {
    srv.close()
  }
  await srv.done
})

test('HTTP: 不同组 → 各自单条诊断（accepted=2，sessionId=alertId）', async () => {
  const srv = await startServer()
  try {
    const payload = {
      status: 'firing',
      alerts: [
        { status: 'firing', labels: { alertname: 'A', severity: 'critical', service: 'payment' }, annotations: {}, startsAt: '2026-09-17T00:00:00Z' },
        { status: 'firing', labels: { alertname: 'B', severity: 'warning', service: 'carts' }, annotations: {}, startsAt: '2026-09-17T00:01:00Z' },
      ],
    }
    const res = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const j = (await res.json()) as { accepted: number }
    assert.equal(j.accepted, 2)

    for (let i = 0; i < 50 && srv.calls.length < 2; i++) await sleep(20)
    assert.equal(srv.calls.length, 2)
    assert.ok(srv.calls.every(c => c.incidentSize === 0), '单条诊断不携带 incident')
    assert.ok(srv.calls.every(c => !c.sessionId.startsWith('inc-')), '单条 sessionId 不应是事件 id')
  } finally {
    srv.close()
  }
  await srv.done
})
