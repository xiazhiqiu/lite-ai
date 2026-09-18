import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import {
  createSourceProviders,
  type PullProviderConfig,
  type SourceProvider,
} from '../src/ingest/provider.js'
import {
  HttpPollProvider,
  createHttpPollProvider,
  getByPath,
  parseHttpPollItems,
  type HttpPollConfig,
} from '../src/ingest/providers/http-poll.js'
import { startPullScheduler } from '../src/ingest/scheduler.js'
import { IngestPipeline, type IngestConfig } from '../src/ingest/pipeline.js'
import { computeAlertId, type Alert, type Incident } from '../src/webhook/types.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const silent = () => {
  /* no-op */
}

// ---------- 测试用 HTTP stub（本地，无外网依赖） ----------

type StubRequest = {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

type StubReply = { status?: number; body?: string; delayMs?: number }

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

async function startStub(respond: (req: StubRequest) => StubReply) {
  const port = await getFreePort()
  const requests: StubRequest[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      const record: StubRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw,
      }
      requests.push(record)
      const reply = respond(record)
      const finish = (): void => {
        try {
          res.statusCode = reply.status ?? 200
          res.setHeader('content-type', 'application/json')
          res.end(reply.body ?? '{}')
        } catch {
          /* 客户端可能已超时断开，忽略 */
        }
      }
      if (reply.delayMs !== undefined && reply.delayMs > 0) setTimeout(finish, reply.delayMs)
      else finish()
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ---------- provider 工厂：默认关闭 / 配置不全 ----------

test('createSourceProviders: 默认关闭、未知类型、配置不全 → 全部跳过', () => {
  const cases: PullProviderConfig[] = [
    { type: 'httpPoll', name: 'no-flag', url: 'http://x/', map: { title: 'name' } },
    { type: 'httpPoll', name: 'explicit-off', enabled: false, url: 'http://x/', map: { title: 'name' } },
    { type: 'mystery', name: 'unknown-type', enabled: true },
    { type: 'httpPoll', name: 'no-url', enabled: true, map: { title: 'name' } },
    {
      type: 'httpPoll',
      name: 'no-title-map',
      enabled: true,
      url: 'http://x/',
      map: {},
    },
  ]
  const { providers, skipped } = createSourceProviders(cases)
  assert.equal(providers.length, 0)
  assert.equal(skipped.length, 5)
  // 未显式 enabled 的源应给出"默认关闭"的原因，而不是被当成配置错误
  assert.match(skipped[0]!.reason, /默认关闭/)
  assert.match(skipped[2]!.reason, /未知的 provider 类型/)
  assert.match(skipped[3]!.reason, /配置不完整/)
})

test('createSourceProviders: enabled + 配置完整 → 创建 provider（source 取 name）', () => {
  const { providers, skipped } = createSourceProviders([
    {
      type: 'httpPoll',
      name: 'zabbix',
      enabled: true,
      url: 'http://zabbix/api_jsonrpc.php',
      itemsPath: 'result',
      map: { title: 'name', severity: 'priority' },
    },
  ])
  assert.equal(skipped.length, 0)
  assert.equal(providers.length, 1)
  assert.equal(providers[0]!.name, 'zabbix')
  assert.ok(providers[0] instanceof HttpPollProvider)
})

test('createHttpPollProvider: 缺 url 或 map.title 返回 null', () => {
  assert.equal(createHttpPollProvider({ name: 'a', url: '', map: { title: 'n' } }), null)
  assert.equal(createHttpPollProvider({ name: 'a', url: 'http://x/', map: { title: ' ' } }), null)
  assert.ok(createHttpPollProvider({ name: 'a', url: 'http://x/', map: { title: 'n' } }) !== null)
})

// ---------- 纯函数解析：字段映射 ----------

test('getByPath: 点号路径 / 数组下标 / 缺段返回 undefined / 空路径取顶层', () => {
  const payload = { data: { alerts: [{ n: 'a' }] } }
  assert.deepEqual(getByPath(payload, ''), payload)
  assert.equal(getByPath(payload, 'data.alerts.0.n'), 'a')
  assert.equal(getByPath(payload, 'data.nope.n'), undefined)
  assert.equal(getByPath(payload, 'data.alerts.notAnIndex.n'), undefined)
})

test('parseHttpPollItems: itemsPath + severity 归一化 + labelsFrom + staticLabels', () => {
  // 典型 Zabbix 风格：severity=disaster（原 severityWeight 不认，会落到默认权重）
  const payload = {
    result: [
      { name: 'Zabbix agent is not available', host: 'web-01', priority: 'disaster', clock: '2026-09-18T01:00:00Z' },
      { name: 'Disk space is low', host: 'db-01', priority: 'average', clock: '2026-09-18T01:01:00Z' },
    ],
  }
  const cfg: HttpPollConfig = {
    name: 'zabbix',
    url: 'http://zabbix/api_jsonrpc.php',
    itemsPath: 'result',
    staticLabels: { env: 'prod' },
    map: {
      title: 'name',
      severity: 'priority',
      startsAt: 'clock',
      labelsFrom: ['host'],
    },
  }
  const alerts = parseHttpPollItems(payload, cfg)
  assert.equal(alerts.length, 2)

  const first = alerts[0]!
  assert.equal(first.title, 'Zabbix agent is not available')
  assert.equal(first.severity, 'critical', 'disaster 应归一化为 critical')
  assert.equal(alerts[1]!.severity, 'warning', 'average 应归一化为 warning')
  assert.equal(first.source, 'zabbix', 'source 应写入 provider 名')
  assert.equal(first.labels.env, 'prod', 'staticLabels 应保留')
  assert.equal(first.labels.host, 'web-01', 'labelsFrom 的键 = 路径最后一段')
  assert.equal(first.id, computeAlertId(first.title, first.labels), 'id 必须是统一 fingerprint')
  assert.equal(first.status, 'firing')
  assert.equal(new Date(first.startsAt).toISOString(), '2026-09-18T01:00:00.000Z')
})

test('parseHttpPollItems: 顶层数组、跳过无标题条目、过滤已恢复', () => {
  const cfg: HttpPollConfig = {
    name: 'custom',
    url: 'http://x/',
    map: { title: 'alertname', status: 'state' },
  }
  const alerts = parseHttpPollItems(
    [
      { alertname: 'HighCPU' },
      { alertname: '' }, // 无标题 → 跳过（不是告警，可能是分页元数据）
      { notAnAlert: true },
      { alertname: 'RecoveredAlready', state: 'resolved' }, // 恢复通知不触发 RCA
    ],
    cfg,
  )
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]!.title, 'HighCPU')
  assert.equal(alerts[0]!.severity, 'SEV3', '缺 severity 走默认词')
})

test('parseHttpPollItems: itemsPath 取不到数组 → 抛错（配置错误立刻暴露，不静默 0 条）', () => {
  const cfg: HttpPollConfig = {
    name: 'loki',
    url: 'http://loki/',
    itemsPath: 'data.alerts',
    map: { title: 'name' },
  }
  assert.throws(() => parseHttpPollItems({ data: { unexpected: [] } }, cfg), /不是数组/)
})

// ---------- HttpPollProvider：真实 HTTP 往返 ----------

test('HttpPollProvider.poll: GET 拉取并按配置解析', async () => {
  const stub = await startStub(() => ({
    body: JSON.stringify({ result: [{ name: 'A', host: 'h1' }] }),
  }))
  try {
    const provider = new HttpPollProvider({
      name: 'stub',
      url: stub.url,
      itemsPath: 'result',
      map: { title: 'name', labelsFrom: ['host'] },
    })
    const alerts = await provider.poll()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]!.title, 'A')
    assert.equal(alerts[0]!.source, 'stub')
    assert.equal(stub.requests[0]!.method, 'GET')
  } finally {
    await stub.close()
  }
})

test('HttpPollProvider.poll: POST 透传 headers 与 JSON body', async () => {
  const stub = await startStub(() => ({ body: JSON.stringify([{ name: 'B' }]) }))
  try {
    const provider = new HttpPollProvider({
      name: 'zabbix',
      url: stub.url,
      method: 'POST',
      headers: { authorization: 'Bearer t0ken' },
      body: { jsonrpc: '2.0', method: 'alert.get' },
      map: { title: 'name' },
    })
    const alerts = await provider.poll()
    assert.equal(alerts.length, 1)
    const sent = stub.requests[0]!
    assert.equal(sent.method, 'POST')
    assert.equal(sent.headers.authorization, 'Bearer t0ken')
    assert.deepEqual(JSON.parse(sent.body), { jsonrpc: '2.0', method: 'alert.get' })
  } finally {
    await stub.close()
  }
})

test('HttpPollProvider.poll: 非 2xx / 超时 / 非 JSON 均抛错（不静默吞）', async () => {
  const failing = await startStub(() => ({ status: 503, body: 'upstream down' }))
  const slow = await startStub(() => ({ body: '[]', delayMs: 120 }))
  const notJson = await startStub(() => ({ body: '<html>oops</html>' }))
  try {
    const mk = (url: string, timeoutMs?: number) =>
      new HttpPollProvider({ name: 'src', url, map: { title: 'name' }, timeoutMs })

    await assert.rejects(mk(failing.url).poll(), /HTTP 503/)
    await assert.rejects(mk(slow.url, 30).poll(), /超时/)
    await assert.rejects(mk(notJson.url).poll(), /不是合法 JSON/)
  } finally {
    await failing.close()
    await slow.close()
    await notJson.close()
  }
})

// ---------- 调度器：立即首拉 / 容错 / 停止 ----------

function fakeProvider(
  name: string,
  impl: (signal?: AbortSignal) => Promise<Alert[]>,
  intervalMs = 30,
): SourceProvider {
  return { name, intervalMs, poll: impl }
}

const oneAlert = (title: string): Alert => ({
  id: title,
  title,
  severity: 'warning',
  summary: '',
  description: '',
  labels: {},
  startsAt: new Date().toISOString(),
  status: 'firing',
})

test('startPullScheduler: 启动即首拉；单源失败不影响其它源', async () => {
  const logs: string[] = []
  const ingested: Alert[] = []
  const stop = startPullScheduler(
    [
      fakeProvider('good', async () => [oneAlert('good-1')]),
      fakeProvider('bad', async () => {
        throw new Error('连接被拒绝')
      }),
    ],
    {
      ingest: alerts => ingested.push(...alerts),
      log: (_level, message) => logs.push(message),
    },
  )
  try {
    await sleep(80)
    assert.ok(ingested.some(a => a.title === 'good-1'), '正常源应被摄入')
    assert.ok(
      logs.some(m => m.includes('bad') && m.includes('连接被拒绝')),
      '失败源应只记 warn 而不影响主链路',
    )
  } finally {
    stop()
  }
})

test('startPullScheduler: 同一源上一轮未结束则跳过本轮（防请求堆积）', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const stop = startPullScheduler(
    [
      fakeProvider(
        'slow',
        async () => {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await sleep(90)
          concurrent -= 1
          return []
        },
        20, // 周期远小于单次耗时 → 若无防重入会堆出多个并发请求
      ),
    ],
    { ingest: () => {}, log: silent },
  )
  try {
    await sleep(220)
    assert.equal(maxConcurrent, 1, '重叠执行必须被拦住')
  } finally {
    stop()
  }
})

test('startPullScheduler: stop 后不再拉取，且可重复调用', async () => {
  let polls = 0
  const stop = startPullScheduler(
    [
      fakeProvider('p', async () => {
        polls += 1
        return []
      }, 20),
    ],
    { ingest: () => {}, log: silent },
  )
  await sleep(70)
  stop()
  stop() // 幂等
  const settled = polls
  await sleep(80)
  assert.equal(polls, settled, 'stop 之后不应再有新的拉取')
})

// ---------- 端到端：拉取源与 webhook 共用同一条管道 ----------

test('IngestPipeline: 拉取源经 start() 挂载，告警走同一条管道（折叠为一次事件级 RCA）', async () => {
  const stub = await startStub(() => ({
    body: JSON.stringify({
      result: [
        { name: 'Zabbix agent is not available', host: 'web-01', priority: 'disaster' },
        { name: 'Disk space is low', host: 'web-01', priority: 'warning' },
      ],
    }),
  }))
  const calls: Array<{ alert: Alert; incident?: Incident }> = []
  const config: IngestConfig = {
    autoDiagnose: true,
    maxConcurrentDiagnoses: 2,
    sources: {
      pull: [
        {
          type: 'httpPoll',
          name: 'zabbix',
          enabled: true,
          url: stub.url,
          intervalMs: 50,
          itemsPath: 'result',
          // service 是 groupByKeys 里的键 → 两条同 service 告警应折叠成一个事件
          staticLabels: { service: 'payment' },
          map: { title: 'name', severity: 'priority', labelsFrom: ['host'] },
        },
      ],
    },
  }
  const pipeline = new IngestPipeline('D:/dev/pull-e2e', config, {
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

    assert.equal(calls.length, 1, '两条同 service 告警应折叠为一次事件级 RCA（而非各烧一次）')
    assert.ok(calls[0]!.incident, '应走事件级路径')
    assert.equal(calls[0]!.incident!.alerts.length, 2)
    assert.equal(calls[0]!.incident!.alerts[0]!.source, 'zabbix')
    assert.equal(calls[0]!.incident!.severity, 'critical', 'disaster 归一化后成为事件主告警')
  } finally {
    pipeline.close()
    await stub.close()
  }
})
