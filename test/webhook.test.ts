import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

let tempHome: string

const SRE_CWD = `D:/dev/sre-${Date.now()}`
const FIRING_PAYLOAD = {
  status: 'firing',
  alerts: [
    {
      status: 'firing',
      labels: {
        alertname: 'HighMemoryUsage',
        severity: 'critical',
        service: 'payment',
      },
      annotations: {
        summary: 'payment Pod memory usage > 90%',
        description: 'payment 服务内存使用率持续超过 90%，可能触发 OOM',
      },
      startsAt: '2026-08-18T21:30:00Z',
      endsAt: '0001-01-01T00:00:00Z',
    },
    {
      status: 'firing',
      labels: { alertname: 'LatencySpike', severity: 'warning', service: 'carts' },
      annotations: { summary: 'carts P99 延迟升高' },
      startsAt: '2026-08-18T21:31:00Z',
    },
  ],
  groupLabels: {},
  commonLabels: {},
  commonAnnotations: {},
}

before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-webhook-'))
  process.env.LITE_AI_HOME = tempHome
})

after(async () => {
  delete process.env.LITE_AI_HOME
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_KEY
  await rm(tempHome, { recursive: true, force: true })
})

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------- 告警源适配 ----------

test('alertmanagerAdapter.matches: 合法/非法 payload', async () => {
  const { alertmanagerAdapter } = await import('../src/webhook/sources/alertmanager.js')
  assert.equal(alertmanagerAdapter.matches(FIRING_PAYLOAD), true)
  assert.equal(alertmanagerAdapter.matches({ alerts: [] }), true)
  assert.equal(alertmanagerAdapter.matches({ foo: 1 }), false)
  assert.equal(alertmanagerAdapter.matches('string'), false)
  assert.equal(alertmanagerAdapter.matches(null), false)
})

test('routeAlertSource: 路由到 alertmanager；未知格式抛错', async () => {
  const { routeAlertSource } = await import('../src/webhook/sources/index.js')
  assert.equal(routeAlertSource(FIRING_PAYLOAD).name, 'alertmanager')
  assert.throws(() => routeAlertSource({ random: true }), /无法识别/)
})

test('alertmanagerAdapter.parse: firing 解析；resolved 被过滤；缺字段走默认', async () => {
  const { alertmanagerAdapter } = await import('../src/webhook/sources/alertmanager.js')
  const alerts = alertmanagerAdapter.parse(FIRING_PAYLOAD)
  assert.equal(alerts.length, 2)
  const first = alerts[0]!
  assert.equal(first.title, 'HighMemoryUsage')
  assert.equal(first.severity, 'critical')
  assert.equal(first.status, 'firing')
  assert.match(first.summary, /90%/)
  assert.equal(first.labels.service, 'payment')
  assert.ok(first.startsAt.length > 0)

  // resolved 被过滤；缺 severity 走默认
  const kept = alertmanagerAdapter.parse({
    alerts: [
      { status: 'resolved', labels: { alertname: 'A', severity: 'warning' } },
      { status: 'firing', labels: { alertname: 'B' } },
    ],
  })
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.title, 'B')
  assert.equal(kept[0]!.severity, 'SEV3')
})

test('normalizeToUserMessage: 含服务/严重级别/时间', async () => {
  const { alertmanagerAdapter } = await import('../src/webhook/sources/alertmanager.js')
  const { normalizeToUserMessage } = await import('../src/webhook/types.js')
  const alert = alertmanagerAdapter.parse(FIRING_PAYLOAD)[0]!
  const text = normalizeToUserMessage(alert)
  assert.match(text, /\[告警自动触发\]/)
  assert.match(text, /payment/)
  assert.match(text, /critical/)
  assert.match(text, /2026-08-18T21:30:00Z/)
})

test('alertSessionId: 同 alertId 派生同 sessionId', async () => {
  const { alertmanagerAdapter } = await import('../src/webhook/sources/alertmanager.js')
  const { alertSessionId } = await import('../src/webhook/types.js')
  const alert = alertmanagerAdapter.parse(FIRING_PAYLOAD)[0]!
  assert.equal(alertSessionId(alert), alert.id)
})

// ---------- 去重 + 截断 ----------

test('AlertDedupe: 冷却窗内跳过，窗口后重新诊断', async () => {
  const { AlertDedupe } = await import('../src/webhook/dedupe.js')
  const dedupe = new AlertDedupe(100)
  assert.equal(dedupe.shouldDiagnose('a'), true)
  assert.equal(dedupe.shouldDiagnose('a'), false) // 冷却中
  await sleep(160)
  assert.equal(dedupe.shouldDiagnose('a'), true) // 窗口后恢复
  await sleep(40) // 等待原 key 自动清理
})

test('truncateAlerts: 超限按 severity 截断，critical 优先', async () => {
  const { truncateAlerts, MAX_ALERTS_PER_BATCH } = await import('../src/webhook/dedupe.js')
  const alerts = Array.from({ length: 50 }, (_, i) => ({
    id: `id-${i}`,
    title: `alert-${i}`,
    severity: i % 5 === 0 ? 'critical' : 'warning',
    summary: '',
    description: '',
    labels: {},
    startsAt: new Date().toISOString(),
    status: 'firing' as const,
  }))
  const { alerts: kept, truncated } = truncateAlerts(alerts)
  assert.equal(kept.length, MAX_ALERTS_PER_BATCH)
  assert.equal(truncated, 50 - MAX_ALERTS_PER_BATCH)
  assert.ok(kept.slice(0, 5).every(a => a.severity === 'critical'))
})

// ---------- 诊断 + 会话存储 ----------

test('runAlertDiagnosis: 诊断后存会话，loadSession 可读回', async () => {
  const fakeModel = {
    next: async () => ({
      type: 'assistant' as const,
      content:
        '<final>根因定位：payment 服务内存泄漏导致 Pod OOM，建议扩容并排查泄漏。',
    }),
  }

  process.env.OPENAI_MODEL = 'fake-model'
  process.env.OPENAI_API_KEY = 'test-key'

  const { runAlertDiagnosis } = await import('../src/webhook/diagnose.js')
  const { alertSessionId } = await import('../src/webhook/types.js')
  const { alertmanagerAdapter } = await import('../src/webhook/sources/alertmanager.js')

  const alert = alertmanagerAdapter.parse(FIRING_PAYLOAD)[0]!
  const result = await runAlertDiagnosis({
    cwd: SRE_CWD,
    alert,
    deps: {
      model: fakeModel as never,
      config: {
        port: 0,
        host: '127.0.0.1',
        autoDiagnose: true,
        notifyHeaders: {},
      },
    },
  })

  assert.equal(result.sessionId, alertSessionId(alert))

  const { loadSession } = await import('../src/session.js')
  const messages = await loadSession(SRE_CWD, result.sessionId)
  assert.ok(messages)
  // saveSession 不落盘 system 消息（resume 时重新生成）；故为 user + assistant
  assert.equal(messages.length, 2)
  assert.equal(messages[0]!.role, 'user')
  assert.match(messages[0]!.content, /\[告警自动触发\]/)
  assert.equal(messages[1]!.role, 'assistant')
  assert.match(messages[1]!.content, /根因定位/)

  // 告警记录已写入，读回取最新 diagnosed 状态
  const { listAlertRecords } = await import('../src/webhook/alert-store.js')
  const records = await listAlertRecords()
  const record = records.find(r => r.status === 'diagnosed')
  assert.ok(record)
  assert.equal(record!.sessionId, result.sessionId)
  assert.equal(record!.title, 'HighMemoryUsage')
})

// ---------- 只读诊断通道（C1） ----------

test('createWebhookDiagnosisToolRegistry: 仅含只读数据源，排除命令/外联/写工具（C1）', async () => {
  const { createWebhookDiagnosisToolRegistry } = await import('../src/tools/index.js')
  const registry = await createWebhookDiagnosisToolRegistry({ cwd: SRE_CWD, runtime: null })
  const names = new Set(registry.list().map(t => t.name))
  // 必须排除一切可执行命令 / 外联 / 写能力的工具
  for (const forbidden of [
    'run_command',
    'web_fetch',
    'web_search',
    'ask_user',
    'generate_postmortem',
    'rewrite_todo_list',
    'update_todo_status',
    'follow_logs',
    'stop_follow',
  ]) {
    assert.equal(names.has(forbidden), false, `webhook 诊断不应包含 ${forbidden}`)
  }
  // 至少应提供只读数据源 / 日志 / KB 检索 / skill 目录检索
  assert.ok(names.has('tail_logs'), '应保留 tail_logs')
  assert.ok(names.has('search_incident_kb'), '应保留 search_incident_kb')
  assert.ok(names.has('load_skill'), '应放行 load_skill（只读目录检索）')
})

// ---------- alert-store ----------

test('alert-store: 追加记录并按 alertId 去重取最新', async () => {
  const { appendAlertRecord, listAlertRecords } = await import('../src/webhook/alert-store.js')
  await appendAlertRecord({ alertId: 'x', sessionId: 'x1', title: 'T', severity: 'critical', summary: '', status: 'received' })
  await appendAlertRecord({ alertId: 'x', sessionId: 'x1', title: 'T', severity: 'critical', summary: '', status: 'diagnosed' })
  await appendAlertRecord({ alertId: 'y', sessionId: 'y1', title: 'U', severity: 'warning', summary: '', status: 'received' })
  const records = await listAlertRecords()
  const x = records.find(r => r.alertId === 'x')
  const y = records.find(r => r.alertId === 'y')
  assert.equal(x?.status, 'diagnosed')
  assert.equal(y?.status, 'received')
  // 同 alertId 只保留最新一条
  assert.equal(records.filter(r => r.alertId === 'x').length, 1)
})

// ---------- HTTP server ----------

async function startServer(opts: {
  secret?: string
  autoDiagnose?: boolean
}) {
  const port = await getFreePort()
  const diagnosed: string[] = []
  const controller = new AbortController()

  const { runWebhookServer } = await import('../src/webhook/index.js')
  const serverPromise = runWebhookServer({
    cwd: SRE_CWD,
    config: {
      port,
      host: '127.0.0.1',
      autoDiagnose: opts.autoDiagnose ?? true,
      secret: opts.secret,
      notifyHeaders: {},
    },
    abortSignal: controller.signal,
    diagnose: async alert => {
      diagnosed.push(alert.id)
      return { sessionId: alert.id, diagnosisSummary: 'ok' }
    },
  })
  await sleep(150)
  return {
    url: `http://127.0.0.1:${port}`,
    diagnosed,
    close: () => controller.abort(),
    done: serverPromise,
  }
}

test('HTTP: secret 校验放行/拒绝', async () => {
  const srv = await startServer({ secret: 'my-secret' })
  try {
    const wrong = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify(FIRING_PAYLOAD),
    })
    assert.equal(wrong.status, 401)

    const ok = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'my-secret' },
      body: JSON.stringify(FIRING_PAYLOAD),
    })
    assert.equal(ok.status, 202)
  } finally {
    srv.close()
  }
  await srv.done
})

test('HTTP: firing → 202 入队诊断；重复同窗口去重', async () => {
  const srv = await startServer({})
  try {
    const body = JSON.stringify(FIRING_PAYLOAD)
    const first = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(first.status, 202)
    const j1 = (await first.json()) as { accepted: number }
    assert.equal(j1.accepted, 2)

    // 同 payload 再发 → 冷却中去重
    const again = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const j2 = (await again.json()) as { accepted: number; deduplicated: number }
    assert.equal(j2.accepted, 0)
    assert.equal(j2.deduplicated, 2)
  } finally {
    srv.close()
  }
  await srv.done
})

test('HTTP: resolved 告警不诊断；非法 payload → 400', async () => {
  const srv = await startServer({})
  try {
    const resolved = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alerts: [{ status: 'resolved', labels: { alertname: 'A' } }],
      }),
    })
    assert.equal(resolved.status, 202)
    const j = (await resolved.json()) as { accepted: number }
    assert.equal(j.accepted, 0)

    const bad = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })
    assert.equal(bad.status, 400)

    const unknown = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    assert.equal(unknown.status, 400)
  } finally {
    srv.close()
  }
  await srv.done
})

test('HTTP: 硬截断 50 条 → 保留 10 条', async () => {
  const alerts = Array.from({ length: 50 }, (_, i) => ({
    status: 'firing',
    labels: { alertname: `Alert${i}`, severity: i % 5 === 0 ? 'critical' : 'warning' },
    annotations: {},
  }))
  const payload = { status: 'firing', alerts }

  const srv = await startServer({})
  try {
    const res = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(res.status, 202)
    const j = (await res.json()) as { accepted: number; truncated: number }
    assert.equal(j.accepted, 10)
    assert.equal(j.truncated, 40)
  } finally {
    srv.close()
  }
  await srv.done
})