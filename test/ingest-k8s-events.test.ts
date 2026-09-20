import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import {
  DEFAULT_K8S_API_SERVER,
  K8sEventsProvider,
  bucketCount,
  buildEventsUrl,
  createK8sEventsProvider,
  parseK8sEventList,
  type K8sEventsConfig,
} from '../src/ingest/providers/k8s-events.js'
import { createSourceProviders } from '../src/ingest/provider.js'
import { IngestPipeline, type IngestConfig } from '../src/ingest/pipeline.js'
import { computeAlertId, type Alert, type Incident } from '../src/webhook/types.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const silent = () => {
  /* no-op */
}

// ---------- 测试用 HTTP stub（本地，无外网依赖） ----------

type StubRequest = { method: string; url: string; headers: http.IncomingHttpHeaders }
type StubReply = { status?: number; body?: string }

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

async function startStub(respond: (req: StubRequest, index: number) => StubReply) {
  const port = await getFreePort()
  const requests: StubRequest[] = []
  const server = http.createServer((req, res) => {
    req.on('data', () => {
      /* drain */
    })
    req.on('end', () => {
      const record: StubRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      }
      requests.push(record)
      const reply = respond(record, requests.length - 1)
      res.statusCode = reply.status ?? 200
      res.setHeader('content-type', 'application/json')
      res.end(reply.body ?? '{}')
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ---------- 测试数据构造 ----------

/**
 * ⚠️ 时间戳必须**相对当前真实时间**生成，不能写死日期。
 *
 * 原因：`K8sEventsProvider.poll()` 内部用真实 `Date.now()` 做 lookback 时间窗过滤
 * （`k8s-events.ts` 的 `lastSeen < nowMs - lookbackMs → continue`，默认窗口仅 15 分钟）。
 * 早先这里写死 `2026-09-18T09:59:30Z`：当天跑是绿的，**隔天跑就会因超出窗口而全被滤掉**，
 * 表现为 `alerts.length` 期望 1 得 0 —— 一颗时间炸弹（time-dependent test）。
 * 改成"相对当前时间偏移"后，无论哪天跑都落在窗口内。
 */
const NOW = Date.now()
const isoAgo = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

/** 构造一条 K8s Event（只填本 provider 用到的字段）。 */
function k8sEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    count: 1,
    // 相对 now 往前 1 分钟 / 30 秒，稳稳落在默认 15 分钟 lookback 窗口内
    firstTimestamp: isoAgo(60_000),
    lastTimestamp: isoAgo(30_000),
    metadata: { name: 'pod-a.17f0', namespace: 'prod' },
    involvedObject: { kind: 'Pod', name: 'payments-7d9f-abc', namespace: 'prod' },
    source: { component: 'kubelet', host: 'node-1' },
    ...over,
  }
}

const eventList = (items: unknown[]): unknown => ({
  kind: 'EventList',
  items,
  metadata: {},
})

const cfgOf = (over: Partial<K8sEventsConfig> = {}): K8sEventsConfig => ({
  name: 'k8s',
  ...over,
})

// ---------- buildEventsUrl：纯函数 ----------

test('buildEventsUrl: 缺省全集群 + type!=Normal + 分页 limit', () => {
  const url = buildEventsUrl(cfgOf())
  assert.ok(url.startsWith(`${DEFAULT_K8S_API_SERVER}/api/v1/events?`), url)
  assert.match(url, /fieldSelector=type%21%3DNormal/)
  assert.match(url, /limit=500/)
})

test('buildEventsUrl: 限定 namespace 走命名空间路径；labelSelector 追加；尾斜杠归一化', () => {
  const url = buildEventsUrl(
    cfgOf({ apiServer: 'http://api.local:8001///', namespace: 'prod', labelSelector: 'app=payments' }),
  )
  assert.ok(url.startsWith('http://api.local:8001/api/v1/namespaces/prod/events?'), url)
  assert.match(url, /labelSelector=app%3Dpayments/)
  assert.ok(!url.includes('///'))
})

test('buildEventsUrl: includeNormal 时不加 fieldSelector；continue 游标附加在查询串', () => {
  const url = buildEventsUrl(cfgOf({ includeNormal: true }), 'tok123')
  assert.ok(!url.includes('fieldSelector'), url)
  assert.match(url, /continue=tok123/)
})

// ---------- bucketCount：避免"重复累加"被判为新信号 ----------

test('bucketCount: 单纯累加落在同一桶，量级跃升才改变', () => {
  assert.equal(bucketCount(1), '1')
  assert.equal(bucketCount(3), '2-5')
  assert.equal(bucketCount(5), '2-5')
  assert.equal(bucketCount(6), '6-20')
  assert.equal(bucketCount(500), '101-1000')
  assert.equal(bucketCount(99999), '>1000')
  assert.equal(bucketCount(Number.NaN), '1')
})

// ---------- parseK8sEventList：字段映射 ----------

test('parseK8sEventList: reason→title、对象/命名空间→labels、Warning→warning', () => {
  const alerts = parseK8sEventList(eventList([k8sEvent()]), cfgOf(), NOW)
  assert.equal(alerts.length, 1)
  const a = alerts[0]!
  assert.equal(a.title, 'BackOff')
  assert.equal(a.severity, 'warning')
  assert.equal(a.source, 'k8s')
  assert.equal(a.status, 'firing', 'K8s Events 无 resolved 语义，恒为 firing')
  assert.equal(a.labels.namespace, 'prod')
  assert.equal(a.labels.kind, 'Pod')
  assert.equal(a.labels.involved, 'Pod/payments-7d9f-abc')
  assert.equal(a.labels.component, 'kubelet')
  assert.equal(a.labels.node, 'node-1')
  assert.equal(a.id, computeAlertId(a.title, a.labels), 'id 必须是统一 fingerprint')
  // 默认构造的 firstTimestamp = NOW - 60s
  assert.equal(new Date(a.startsAt).toISOString(), isoAgo(60_000))
})

test('parseK8sEventList: Normal 默认跳过，includeNormal 时按 info 收录', () => {
  const normal = k8sEvent({ type: 'Normal', reason: 'Scheduled' })
  assert.equal(parseK8sEventList(eventList([normal]), cfgOf(), NOW).length, 0)

  const kept = parseK8sEventList(eventList([normal]), cfgOf({ includeNormal: true }), NOW)
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.severity, 'info')
})

test('parseK8sEventList: 无 reason 跳过、ignoreReasons 生效、severityByReason 覆盖', () => {
  const items = [
    k8sEvent({ reason: '' }), // 无告警名 → 跳过
    k8sEvent({ reason: 'Pulled' }),
    k8sEvent({ reason: 'OOMKilling' }),
  ]
  const alerts = parseK8sEventList(
    eventList(items),
    cfgOf({ ignoreReasons: ['Pulled'], severityByReason: { OOMKilling: 'critical' } }),
    NOW,
  )
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]!.title, 'OOMKilling')
  assert.equal(alerts[0]!.severity, 'critical')
})

test('parseK8sEventList: 过期事件被时间窗过滤（Events 保留了约 1 小时历史）', () => {
  // fresh 落在默认 15 分钟窗内；stale 退到 30 分钟前，必然超窗
  const fresh = k8sEvent({ lastTimestamp: isoAgo(5 * 60_000) })
  const stale = k8sEvent({ lastTimestamp: isoAgo(30 * 60_000) })

  const kept = parseK8sEventList(eventList([fresh, stale]), cfgOf(), NOW)
  assert.equal(kept.length, 1, '默认 5 分钟窗内只应留下 fresh')
  assert.equal(new Date(kept[0]!.startsAt).toISOString(), isoAgo(60_000))

  const all = parseK8sEventList(eventList([fresh, stale]), cfgOf({ lookbackMs: 0 }), NOW)
  assert.equal(all.length, 2, 'lookbackMs=0 时不做过期过滤')
})

test('parseK8sEventList: count 落对数桶 —— 累加不改内容、跃升才改', () => {
  const descOf = (count: number): string =>
    parseK8sEventList(eventList([k8sEvent({ count })]), cfgOf(), NOW)[0]!.description

  assert.equal(descOf(2), descOf(3), '同一桶内累加不应改变 description（否则每轮都重烧 token）')
  assert.notEqual(descOf(3), descOf(50), '量级跃升必须构成新信号')
  assert.match(descOf(1), /累计 1 次/)
  assert.match(descOf(50), /累计 21-100 次/)
  // 1 与 ≥2 有意分档：首现 vs 已重复，仍是一条新信息。
  assert.notEqual(descOf(1), descOf(2))
})

test('parseK8sEventList: 兼容 eventTime / series.count，缺失 firstTimestamp', () => {
  const alerts = parseK8sEventList(
    eventList([
      k8sEvent({
        firstTimestamp: undefined,
        lastTimestamp: undefined,
        eventTime: isoAgo(2 * 60_000),
        series: { count: 42, lastObservedTime: isoAgo(90_000) },
        count: undefined,
      }),
    ]),
    cfgOf(),
    NOW,
  )
  assert.equal(alerts.length, 1)
  assert.equal(new Date(alerts[0]!.startsAt).toISOString(), isoAgo(2 * 60_000))
  assert.match(alerts[0]!.description, /累计 21-100 次/, '应从 series.count 回退取值')
})

test('parseK8sEventList: 响应不是 EventList → 抛错（不静默 0 条）', () => {
  assert.throws(
    () => parseK8sEventList({ kind: 'Status', message: 'Unauthorized' }, cfgOf(), NOW),
    /缺少 items 数组/,
  )
})

// ---------- K8sEventsProvider：真实 HTTP 往返 ----------

test('K8sEventsProvider.poll: 携带 Bearer token 与 fieldSelector，解析出统一 Alert', async () => {
  const stub = await startStub(() => ({ body: JSON.stringify(eventList([k8sEvent()])) }))
  try {
    const provider = new K8sEventsProvider({ name: 'k8s', apiServer: stub.base, token: 'sa-token' })
    const alerts = await provider.poll()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]!.source, 'k8s')

    const sent = stub.requests[0]!
    assert.equal(sent.headers.authorization, 'Bearer sa-token')
    assert.match(sent.url, /^\/api\/v1\/events\?/)
    assert.match(sent.url, /fieldSelector=type%21%3DNormal/)
  } finally {
    await stub.close()
  }
})

test('K8sEventsProvider.poll: 缺 token → 明确报错（区分"没告警"与"没跑起来"）', async () => {
  const prev = process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN
  delete process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN
  try {
    const provider = new K8sEventsProvider({ name: 'k8s', apiServer: 'http://127.0.0.1:1' })
    await assert.rejects(provider.poll(), /缺少 token/)
  } finally {
    if (prev !== undefined) process.env.KUBERNETES_SERVICE_ACCOUNT_TOKEN = prev
  }
})

test('K8sEventsProvider.poll: tokenFile 每次 poll 惰性重读（兼容 SA token 轮换）', async () => {
  const stub = await startStub(() => ({ body: JSON.stringify(eventList([])) }))
  let reads = 0
  try {
    const provider = new K8sEventsProvider({
      name: 'k8s',
      apiServer: stub.base,
      tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
      readFileImpl: async () => {
        reads += 1
        return `tok-${reads}\n`
      },
    })
    await provider.poll()
    await provider.poll()
    assert.equal(reads, 2, '必须在每次 poll 时重读文件，而不是启动时缓存一次')
    assert.equal(stub.requests[0]!.headers.authorization, 'Bearer tok-1')
    assert.equal(stub.requests[1]!.headers.authorization, 'Bearer tok-2')
  } finally {
    await stub.close()
  }
})

test('K8sEventsProvider.poll: 跟随 metadata.continue 分页并合并', async () => {
  const stub = await startStub((req, index) => {
    if (index === 0) {
      return {
        body: JSON.stringify({
          kind: 'EventList',
          items: [k8sEvent({ reason: 'BackOff' })],
          metadata: { continue: 'PAGE2' },
        }),
      }
    }
    assert.match(req.url, /continue=PAGE2/)
    return {
      body: JSON.stringify({
        kind: 'EventList',
        items: [k8sEvent({ reason: 'FailedScheduling' })],
        metadata: {},
      }),
    }
  })
  try {
    const provider = new K8sEventsProvider({ name: 'k8s', apiServer: stub.base, token: 't' })
    const alerts = await provider.poll()
    assert.equal(stub.requests.length, 2, '应跟随游标拉第二页')
    assert.deepEqual(
      alerts.map(a => a.title).sort(),
      ['BackOff', 'FailedScheduling'],
    )
  } finally {
    await stub.close()
  }
})

test('K8sEventsProvider.poll: 超过 maxPages → 抛错提示收窄范围（不静默截断）', async () => {
  const stub = await startStub(() => ({
    body: JSON.stringify({
      kind: 'EventList',
      items: [k8sEvent()],
      metadata: { continue: 'MORE' },
    }),
  }))
  try {
    const provider = new K8sEventsProvider({
      name: 'k8s',
      apiServer: stub.base,
      token: 't',
      maxPages: 2,
    })
    await assert.rejects(provider.poll(), /拉取被截断.*maxPages/s)
    assert.equal(stub.requests.length, 2)
  } finally {
    await stub.close()
  }
})

test('K8sEventsProvider.poll: 非 2xx 抛错（401/503 不能表现为"今天没有告警"）', async () => {
  const stub = await startStub(() => ({ status: 401, body: '{"message":"Unauthorized"}' }))
  try {
    const provider = new K8sEventsProvider({ name: 'k8s', apiServer: stub.base, token: 'bad' })
    await assert.rejects(provider.poll(), /HTTP 401/)
  } finally {
    await stub.close()
  }
})

// ---------- 抽象可复用性：注册表与工厂 ----------

test('createK8sEventsProvider: 缺 name 返回 null；正常配置返回 provider', () => {
  assert.equal(createK8sEventsProvider({ name: '  ' }), null)
  assert.ok(createK8sEventsProvider({ name: 'k8s' }) instanceof K8sEventsProvider)
})

test('createSourceProviders: k8sEvents 已在注册表中，且沿用"默认关闭"约定', () => {
  const off = createSourceProviders([{ type: 'k8sEvents', name: 'k8s' }])
  assert.equal(off.providers.length, 0)
  assert.match(off.skipped[0]!.reason, /默认关闭/)

  const on = createSourceProviders([
    { type: 'k8sEvents', name: 'k8s', enabled: true, namespace: 'prod' },
  ])
  assert.equal(on.skipped.length, 0)
  assert.equal(on.providers.length, 1)
  assert.equal(on.providers[0]!.name, 'k8s')
})

// ---------- 端到端：K8s 事件与 webhook 共用同一条管道 ----------

test('IngestPipeline: k8sEvents 拉取源挂载后，同 namespace 两条事件折叠为一次事件级 RCA', async () => {
  // 时间戳取"刚刚"：本用例走真实 Date.now()（provider 内部），不能用固定常量。
  const nowIso = new Date().toISOString()
  const recent = { firstTimestamp: nowIso, lastTimestamp: nowIso }
  const stub = await startStub(() => ({
    body: JSON.stringify(
      eventList([
        k8sEvent({ reason: 'BackOff', ...recent }),
        k8sEvent({
          reason: 'FailedMount',
          involvedObject: { kind: 'Pod', name: 'payments-7d9f-xyz', namespace: 'prod' },
          ...recent,
        }),
      ]),
    ),
  }))
  const calls: Array<{ alert: Alert; incident?: Incident }> = []
  const config: IngestConfig = {
    autoDiagnose: true,
    maxConcurrentDiagnoses: 2,
    sources: {
      pull: [
        {
          type: 'k8sEvents',
          name: 'k8s',
          enabled: true,
          apiServer: stub.base,
          token: 'sa-token',
          namespace: 'prod',
          intervalMs: 50,
        },
      ],
    },
  }
  const pipeline = new IngestPipeline('D:/dev/k8s-e2e', config, {
    log: silent,
    diagnose: async (alert, incident) => {
      calls.push({ alert, incident })
      return { sessionId: incident?.incidentId ?? alert.id, diagnosisSummary: 'ok' }
    },
  })

  try {
    pipeline.start()
    for (let i = 0; i < 40 && calls.length === 0; i++) await sleep(25)
    await pipeline.drained()

    assert.equal(calls.length, 1, '两条同 namespace 事件应折叠为一次事件级 RCA（而非各烧一次）')
    assert.ok(calls[0]!.incident, '应走事件级路径')
    assert.equal(calls[0]!.incident!.alerts.length, 2)
    assert.ok(calls[0]!.incident!.alerts.every(a => a.source === 'k8s'))
    assert.match(stub.requests[0]!.url, /namespaces\/prod\/events/)
  } finally {
    pipeline.close()
    await stub.close()
  }
})
