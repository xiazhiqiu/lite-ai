import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { FetchLike, TopologyConfig } from '../src/webhook/topology.js'

let tempHome: string

before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-topology-'))
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

/** 构造一个不联网的 fetch 替身，并记录调用参数。 */
function fakeFetch(payload: unknown) {
  const captured: { url?: string; init?: RequestInit } = {}
  const fetchImpl: FetchLike = async (url, init) => {
    captured.url = url
    captured.init = init
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
    } as unknown as Response
  }
  return { fetchImpl, captured }
}

// ---------- 图模型 ----------

test('createGraph: 边视为无向、别名/归属归一化、maxHops 默认 2', async () => {
  const { createGraph, graphNeighbors, applicationOf, DEFAULT_TOPOLOGY_MAX_HOPS } =
    await import('../src/webhook/topology.js')

  const g = createGraph({
    edges: { mysql: ['elasticsearch'] },
    applications: { 'payment-app': 'payments' },
    aliases: { 'payment-svc': 'payment-app' },
  })

  assert.deepEqual(graphNeighbors(g, 'mysql'), ['elasticsearch'])
  assert.deepEqual(graphNeighbors(g, 'elasticsearch'), ['mysql'], '边应视为无向')
  assert.equal(applicationOf(g, 'payment-svc'), 'payments', '别名应对齐到图节点')
  assert.equal(g.maxHops, DEFAULT_TOPOLOGY_MAX_HOPS)
})

test('graphHops: 同节点 0 / 一跳 1 / 两跳 2 / 超出 maxHops 为 Infinity', async () => {
  const { createGraph, graphHops } = await import('../src/webhook/topology.js')
  const g = createGraph({
    edges: { a: ['b'], b: ['c'], c: ['d'] },
    maxHops: 2,
  })

  assert.equal(graphHops(g, 'a', 'a'), 0)
  assert.equal(graphHops(g, 'a', 'b'), 1)
  assert.equal(graphHops(g, 'a', 'c'), 2)
  assert.equal(graphHops(g, 'a', 'd'), Number.POSITIVE_INFINITY, '3 跳超出 maxHops=2')
})

test('servicesRelated: 同 application 判相关；不相连判不相关', async () => {
  const { createGraph, servicesRelated } = await import('../src/webhook/topology.js')
  const g = createGraph({
    applications: { mysql: 'payments', elasticsearch: 'payments', billing: 'billing' },
  })

  assert.equal(servicesRelated(g, 'mysql', 'elasticsearch'), true, '同业务归属 → 相关')
  assert.equal(servicesRelated(g, 'mysql', 'billing'), false, '不同归属且无调用边 → 不相关')
})

test('mergeGraphs: k8s 归属 + SkyWalking 调用边可叠加', async () => {
  const { createGraph, mergeGraphs, applicationOf, graphHops } = await import(
    '../src/webhook/topology.js'
  )
  const k8s = createGraph({ source: 'k8s', applications: { 'payment-api': 'payments' } })
  const sw = createGraph({ source: 'skywalking', edges: { 'payment-api': ['payment-db'] } })

  const merged = mergeGraphs([k8s, sw])

  assert.equal(applicationOf(merged, 'payment-api'), 'payments')
  assert.equal(graphHops(merged, 'payment-api', 'payment-db'), 1)
})

// ---------- 规则④ 聚类（核心：跨服务同根因） ----------

test('clusterByTopology: 标签各异的 mysql/es/apm 因同业务归属并成一簇', async () => {
  const { createGraph, clusterByTopology } = await import('../src/webhook/topology.js')
  const alerts = [
    await mkAlert({ title: 'MySQLDown', severity: 'critical', labels: { service: 'mysql' } }),
    await mkAlert({ title: 'ESConnRefused', labels: { service: 'elasticsearch' } }),
    await mkAlert({ title: 'APMLatency', labels: { service: 'apm' } }),
  ]
  const graph = createGraph({
    applications: { mysql: 'payments', elasticsearch: 'payments', apm: 'payments' },
  })

  const clusters = clusterByTopology(alerts, graph, {
    serviceKeys: ['service'],
    windowMs: 5 * 60 * 1000,
    minAlerts: 2,
  })

  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]!.members.length, 3)
  assert.equal(clusters[0]!.groupKey, 'application=payments')
  assert.equal(clusters[0]!.application, 'payments')
})

test('clusterByTopology: 无共享标签但调用链两跳可达 → 传递合并为一簇', async () => {
  const { createGraph, clusterByTopology } = await import('../src/webhook/topology.js')
  const alerts = [
    await mkAlert({ title: 'MySQLDown', labels: { service: 'mysql' } }),
    await mkAlert({ title: 'ESConnRefused', labels: { service: 'elasticsearch' } }),
    await mkAlert({ title: 'APMLatency', labels: { service: 'apm' } }),
  ]
  // mysql — es — apm（各一跳，maxHops=2 内可传递合并）
  const graph = createGraph({ edges: { mysql: ['elasticsearch'], elasticsearch: ['apm'] } })

  const clusters = clusterByTopology(alerts, graph, {
    serviceKeys: ['service'],
    windowMs: 5 * 60 * 1000,
    minAlerts: 2,
  })

  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]!.members.length, 3)
  assert.equal(clusters[0]!.groupKey, 'topology=apm+elasticsearch+mysql')
})

test('clusterByTopology: 超出 maxHops 的服务不并（宁可漏也不错并）', async () => {
  const { createGraph, clusterByTopology } = await import('../src/webhook/topology.js')
  const alerts = [
    await mkAlert({ title: 'A', labels: { service: 'a' } }),
    await mkAlert({ title: 'B', labels: { service: 'b' } }),
  ]
  // a — x — y — b：4 跳，maxHops=2 不可达
  const graph = createGraph({ edges: { a: ['x'], x: ['y'], y: ['b'] }, maxHops: 2 })

  assert.equal(
    clusterByTopology(alerts, graph, { serviceKeys: ['service'], windowMs: 300_000, minAlerts: 2 })
      .length,
    0,
  )
})

test('clusterByTopology: 时间窗超出 → 不并（防"同业务但时隔久远"被硬并）', async () => {
  const { createGraph, clusterByTopology } = await import('../src/webhook/topology.js')
  const alerts = [
    await mkAlert({ title: 'A', labels: { service: 'mysql' }, startsAt: '2026-09-17T00:00:00Z' }),
    await mkAlert({ title: 'B', labels: { service: 'es' }, startsAt: '2026-09-17T03:00:00Z' }),
  ]
  const graph = createGraph({ applications: { mysql: 'payments', es: 'payments' } })

  assert.equal(
    clusterByTopology(alerts, graph, { serviceKeys: ['service'], windowMs: 300_000, minAlerts: 2 })
      .length,
    0,
  )
})

test('clusterByTopology: 未达 minAlerts 或缺少 service 标签 → 不产出簇', async () => {
  const { createGraph, clusterByTopology } = await import('../src/webhook/topology.js')
  const graph = createGraph({ applications: { mysql: 'payments', es: 'payments' } })
  const opts = { serviceKeys: ['service'], windowMs: 300_000, minAlerts: 2 }

  // 只有单条可解析 → 不足 minAlerts
  assert.equal(
    clusterByTopology(
      [await mkAlert({ labels: { service: 'mysql' } })],
      graph,
      opts,
    ).length,
    0,
  )
  // 两条都无 service 标签 → 无法对齐图节点
  assert.equal(
    clusterByTopology(
      [
        await mkAlert({ title: 'A', labels: { instance: 'n1' } }),
        await mkAlert({ title: 'B', labels: { instance: 'n2' } }),
      ],
      graph,
      opts,
    ).length,
    0,
  )
})

test('clusterByTopology: 两个互不相关的簇各自成簇（不串味）', async () => {
  const { createGraph, clusterByTopology } = await import('../src/webhook/topology.js')
  const alerts = [
    await mkAlert({ title: 'M1', labels: { service: 'mysql' } }),
    await mkAlert({ title: 'E1', labels: { service: 'es' } }),
    await mkAlert({ title: 'R1', labels: { service: 'redis' } }),
    await mkAlert({ title: 'K1', labels: { service: 'kafka' } }),
  ]
  const graph = createGraph({
    applications: { mysql: 'payments', es: 'payments', redis: 'cache', kafka: 'cache' },
  })

  const clusters = clusterByTopology(alerts, graph, {
    serviceKeys: ['service'],
    windowMs: 300_000,
    minAlerts: 2,
  })

  assert.equal(clusters.length, 2)
  assert.deepEqual(
    clusters.map(c => c.groupKey).sort(),
    ['application=cache', 'application=payments'],
  )
})

// ---------- 图来源适配器 ----------

test('parseSkyWalkingTopology: 由 nodes/calls 解析出无向调用边', async () => {
  const { parseSkyWalkingTopology, graphHops } = await import('../src/webhook/topology.js')
  const g = parseSkyWalkingTopology({
    data: {
      getGlobalTopology: {
        nodes: [
          { id: '1', name: 'payment-api', type: 'Service' },
          { id: '2', name: 'mysql', type: 'Service' },
          { id: '3', name: 'elasticsearch', type: 'Service' },
        ],
        calls: [
          { id: 'c1', source: '1', target: '2' },
          { id: 'c2', source: '1', target: '3' },
        ],
      },
    },
  })

  assert.equal(g.source, 'skywalking')
  assert.equal(graphHops(g, 'mysql', 'payment-api'), 1)
  assert.equal(graphHops(g, 'mysql', 'elasticsearch'), 2, '同经 payment-api，两跳')
})

test('parseK8sWorkloads: 由 label 推导 service → application 归属', async () => {
  const { parseK8sWorkloads, applicationOf } = await import('../src/webhook/topology.js')
  const g = parseK8sWorkloads({
    items: [
      {
        metadata: {
          name: 'payment-api',
          labels: { 'app.kubernetes.io/name': 'payment-api', 'app.kubernetes.io/part-of': 'payments' },
        },
      },
      {
        metadata: { name: 'payment-db', labels: { app: 'payment-db', 'app.kubernetes.io/part-of': 'payments' } },
      },
    ],
  })

  assert.equal(g.source, 'k8s')
  assert.equal(applicationOf(g, 'payment-api'), 'payments')
  assert.equal(applicationOf(g, 'payment-db'), 'payments')
})

test('SkyWalkingTopologySource: 请求打到 /graphql 并解析结果（注入 fetch）', async () => {
  const { SkyWalkingTopologySource, graphHops } = await import('../src/webhook/topology.js')
  const { fetchImpl, captured } = await fakeFetch({
    data: {
      getGlobalTopology: {
        nodes: [
          { id: 'a', name: 'payment-api' },
          { id: 'b', name: 'mysql' },
        ],
        calls: [{ id: 'c', source: 'a', target: 'b' }],
      },
    },
  })

  const source = new SkyWalkingTopologySource({
    endpoint: 'http://sw-oap:12800/',
    fetchImpl,
  })
  const graph = await source.load()

  assert.equal(captured.url, 'http://sw-oap:12800/graphql', '应去掉尾斜杠并补 /graphql')
  assert.equal(captured.init?.method, 'POST')
  assert.match(String(captured.init?.body), /getGlobalTopology/)
  assert.equal(graphHops(graph, 'payment-api', 'mysql'), 1)
})

test('K8sTopologySource: 缺 token 时抛错（数据缺失不静默瞎猜）', async () => {
  const { K8sTopologySource } = await import('../src/webhook/topology.js')
  const { fetchImpl } = await fakeFetch({ items: [] })
  const source = new K8sTopologySource({ token: '', fetchImpl })

  await assert.rejects(() => source.load(), /缺少 token/)
})

test('K8sTopologySource: 拉取 deployments 并构建归属（注入 fetch）', async () => {
  const { K8sTopologySource, applicationOf } = await import('../src/webhook/topology.js')
  const { fetchImpl, captured } = await fakeFetch({
    items: [
      { metadata: { name: 'payment-api', labels: { app: 'payment-api', 'app.kubernetes.io/part-of': 'payments' } } },
    ],
  })

  const source = new K8sTopologySource({
    apiServer: 'https://k8s.local',
    token: 'tk',
    fetchImpl,
  })
  const graph = await source.load()

  assert.equal(captured.url, 'https://k8s.local/apis/apps/v1/deployments?limit=500')
  assert.equal(applicationOf(graph, 'payment-api'), 'payments')
})

test('createTopologySource: 默认关闭 → null；skywalking 缺 endpoint → null', async () => {
  const { createTopologySource, DEFAULT_TOPOLOGY_CONFIG } = await import(
    '../src/webhook/topology.js'
  )

  assert.equal(createTopologySource(DEFAULT_TOPOLOGY_CONFIG), null, '默认（enabled=false）应关闭')
  assert.equal(
    createTopologySource({ ...DEFAULT_TOPOLOGY_CONFIG, enabled: true, source: 'skywalking' }),
    null,
    '缺 endpoint 时应静默关闭而非报错',
  )
  assert.ok(
    createTopologySource({
      ...DEFAULT_TOPOLOGY_CONFIG,
      enabled: true,
      source: 'static',
      static: { applications: { a: 'x' } },
    }) !== null,
  )
})

// ---------- 与 correlateAlerts 集成 ----------

test('correlateAlerts: 注入拓扑图后，跨服务单例并成一个 topology 事件', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { createGraph } = await import('../src/webhook/topology.js')
  const { alertSessionId } = await import('../src/webhook/types.js')

  const a = await mkAlert({ title: 'MySQLDown', severity: 'critical', labels: { service: 'mysql' } })
  const b = await mkAlert({ title: 'ESConnRefused', labels: { service: 'elasticsearch' } })
  const c = await mkAlert({ title: 'APMLatency', labels: { service: 'apm' } })
  const graph = createGraph({
    applications: { mysql: 'payments', elasticsearch: 'payments', apm: 'payments' },
  })

  const incidents = correlateAlerts([a, b, c], {}, Date.now(), graph)

  assert.equal(incidents.length, 1)
  assert.equal(incidents[0]!.type, 'topology')
  assert.equal(incidents[0]!.groupKey, 'application=payments')
  assert.equal(incidents[0]!.alerts.length, 3)
  assert.equal(incidents[0]!.primaryAlert.title, 'MySQLDown', '主告警取 severity 最高')
  // 成员共享事件 sessionId → 一次事件级 RCA
  assert.equal(alertSessionId(a), incidents[0]!.incidentId)
  assert.equal(alertSessionId(c), incidents[0]!.incidentId)
})

test('correlateAlerts: 无拓扑图（null）→ 跨服务告警保持单例，不误并', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const alerts = [
    await mkAlert({ title: 'MySQLDown', labels: { service: 'mysql' } }),
    await mkAlert({ title: 'ESConnRefused', labels: { service: 'elasticsearch' } }),
    await mkAlert({ title: 'APMLatency', labels: { service: 'apm' } }),
  ]

  assert.equal(correlateAlerts(alerts, {}, Date.now(), null).length, 0)
  assert.ok(alerts.every(a => a.incident === undefined))
})

test('correlateAlerts: 拓扑层不动已并好的规则事件（规则优先）', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { createGraph } = await import('../src/webhook/topology.js')

  // 同 service=payment 两条 → 规则事件；另一条 service=mysql 与 payment 同 app
  const a = await mkAlert({ title: 'PayA', labels: { service: 'payment' } })
  const b = await mkAlert({ title: 'PayB', labels: { service: 'payment' } })
  const c = await mkAlert({ title: 'MySQLDown', labels: { service: 'mysql' } })
  const graph = createGraph({ applications: { payment: 'payments', mysql: 'payments' } })

  const incidents = correlateAlerts([a, b, c], {}, Date.now(), graph)

  // 规则事件（a+b）保持不变；c 单例不足以成拓扑簇
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0]!.type, 'rule')
  assert.equal(incidents[0]!.alerts.length, 2)
  assert.equal(c.incident, undefined, '单例 c 不应被强行并进规则事件')
})

test('correlateAlerts: correlation.topology.enabled=false → 即使有图也跳过④', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { createGraph } = await import('../src/webhook/topology.js')
  const alerts = [
    await mkAlert({ title: 'M', labels: { service: 'mysql' } }),
    await mkAlert({ title: 'E', labels: { service: 'es' } }),
  ]
  const graph = createGraph({ applications: { mysql: 'payments', es: 'payments' } })

  const incidents = correlateAlerts(alerts, { topology: { enabled: false } }, Date.now(), graph)

  assert.equal(incidents.length, 0)
  assert.ok(alerts.every(a => a.incident === undefined))
})

test('normalizeIncidentMessage: 标注关联来源（拓扑）', async () => {
  const { correlateAlerts } = await import('../src/webhook/correlate.js')
  const { createGraph } = await import('../src/webhook/topology.js')
  const { normalizeIncidentMessage } = await import('../src/webhook/types.js')

  const a = await mkAlert({ title: 'MySQLDown', severity: 'critical', labels: { service: 'mysql' } })
  const b = await mkAlert({ title: 'ESConnRefused', labels: { service: 'es' } })
  const graph = createGraph({ applications: { mysql: 'payments', es: 'payments' } })

  const incident = correlateAlerts([a, b], {}, Date.now(), graph)[0]!
  const text = normalizeIncidentMessage(incident)

  assert.match(text, /拓扑关联/)
  assert.match(text, /允许多重根因/)
})

// ---------- index.ts 端到端：拓扑源接进 webhook ----------

async function startServer(topology?: Partial<TopologyConfig>) {
  const port = await getFreePort()
  const controller = new AbortController()
  const calls: Array<{ title: string; incidentSize: number; sessionId: string }> = []

  const { runWebhookServer } = await import('../src/webhook/index.js')
  const serverPromise = runWebhookServer({
    cwd: tempHome,
    config: {
      port,
      host: '127.0.0.1',
      autoDiagnose: true,
      maxConcurrentDiagnoses: 3,
      notifyHeaders: {},
      ...(topology !== undefined ? { topology } : {}),
    },
    abortSignal: controller.signal,
    diagnose: async (alert, incident) => {
      const sessionId = incident?.incidentId ?? alert.id
      calls.push({ title: alert.title, incidentSize: incident?.alerts.length ?? 0, sessionId })
      return { sessionId, diagnosisSummary: 'ok' }
    },
  })
  await sleep(200)
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => controller.abort(),
    done: serverPromise,
  }
}

const CROSS_SERVICE_PAYLOAD = {
  status: 'firing',
  alerts: [
    { status: 'firing', labels: { alertname: 'MySQLDown', severity: 'critical', service: 'mysql' }, annotations: { summary: 'db down' }, startsAt: '2026-09-17T00:00:00Z' },
    { status: 'firing', labels: { alertname: 'ESConnRefused', severity: 'warning', service: 'elasticsearch' }, annotations: { summary: 'conn refused' }, startsAt: '2026-09-17T00:01:00Z' },
    { status: 'firing', labels: { alertname: 'APMLatency', severity: 'warning', service: 'apm' }, annotations: { summary: 'latency' }, startsAt: '2026-09-17T00:02:00Z' },
  ],
}

test('HTTP: 拓扑源启用 → 跨服务三条折叠为一次事件级诊断', async () => {
  const srv = await startServer({
    enabled: true,
    source: 'static',
    static: {
      applications: { mysql: 'payments', elasticsearch: 'payments', apm: 'payments' },
    },
  })
  try {
    const res = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CROSS_SERVICE_PAYLOAD),
    })
    assert.equal(res.status, 202)
    const j = (await res.json()) as { accepted: number }
    assert.equal(j.accepted, 1, '跨服务三条应折叠为 1 个事件')

    for (let i = 0; i < 50 && srv.calls.length < 1; i++) await sleep(20)
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]!.incidentSize, 3)
    assert.match(srv.calls[0]!.sessionId, /^inc-/)
  } finally {
    srv.close()
  }
  await srv.done
})

test('HTTP: 拓扑源默认关闭 → 跨服务三条各自单条诊断（不误并）', async () => {
  const srv = await startServer()
  try {
    const res = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CROSS_SERVICE_PAYLOAD),
    })
    const j = (await res.json()) as { accepted: number }
    assert.equal(j.accepted, 3, '无拓扑图时三条应各自诊断')

    for (let i = 0; i < 50 && srv.calls.length < 3; i++) await sleep(20)
    assert.equal(srv.calls.length, 3)
    assert.ok(srv.calls.every(c => c.incidentSize === 0))
  } finally {
    srv.close()
  }
  await srv.done
})
