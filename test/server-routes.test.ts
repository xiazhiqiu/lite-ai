/**
 * T3 HTTP/API 层测试 —— **内存 JobStore，不依赖 PG、不 skip**。
 *
 * 与 T2 同样的取向：队列的可用性必须能在任何环境被真实证明，而不是因为
 * CI 里没有 PG 就 skip 掉。所有用例都对着真实 `http.createServer` 发请求
 * （真监听回环端口 + 真 fetch），不打桩路由内部函数——测的是**线上那条路径**。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import type { JobStore } from '../src/jobs/store.js'
import { createServerApp } from '../src/server/http.js'
import type { ServerApp } from '../src/server/http.js'

/** 起一个真实监听回环端口的 app，返回 baseUrl 与关闭函数。 */
async function startApp(overrides: { store?: JobStore; ready?: () => Promise<boolean> } = {}) {
  const store = overrides.store ?? createMemoryJobStore()
  const app: ServerApp = createServerApp({
    store,
    cwd: '/srv/workspace',
    ready: overrides.ready,
  })
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = app.server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    close: async (): Promise<void> => {
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

describe('POST /chat', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('入队后立即返回 202 + jobId（异步队列核心语义，不做长连接阻塞）', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '为什么 api 延迟升高了？' }),
    })
    // 202 而非 200 —— 语义是"已受理、还没跑完"，这是异步队列与同步端点的分界线
    assert.equal(res.status, 202)
    const body = (await res.json()) as { jobId?: string; sessionId?: string }
    assert.ok(typeof body.jobId === 'string' && body.jobId.length > 0, '应返回 jobId')
    assert.ok(typeof body.sessionId === 'string' && body.sessionId.length > 0, '应返回 sessionId')
  })

  it('新建的 job 落库为 pending，且带上提交者与消息内容', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '第二个问题' }),
    })
    const { jobId } = (await res.json()) as { jobId: string }
    const job = await ctx.store.get(jobId)
    assert.ok(job !== null, 'job 应已落库')
    assert.equal(job.status, 'pending')
    assert.equal(job.kind, 'chat')
    assert.equal(job.payload.message, '第二个问题')
    // cwd 是**服务端工作区路径**（plan G4），不是用户本地目录
    assert.equal(job.cwd, '/srv/workspace')
  })

  it('【G2 多轮续接】传 sessionId 时复用该会话，而不是新建', async () => {
    const first = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '第一轮' }),
    })
    const { sessionId } = (await first.json()) as { sessionId: string }

    const second = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '第二轮追问', sessionId }),
    })
    const body = (await second.json()) as { jobId: string; sessionId: string }

    // 返回同一个 sessionId —— 客户端据此继续续接
    assert.equal(body.sessionId, sessionId)
    const job = await ctx.store.get(body.jobId)
    assert.equal(job?.sessionId, sessionId, '续接的 job 应挂在原会话上')
  })

  it('【G2 接管桥】允许对告警诊断产出的会话发起续接', async () => {
    // 模拟 diagnose 落下的告警会话：job kind=alert、带 incidentId
    const alertJob = await ctx.store.create({
      userId: 'system',
      cwd: '/srv/workspace',
      kind: 'alert',
      incidentId: 'inc-42',
      sessionId: 'sin-alert-42',
      payload: { alertName: 'HighErrorRate' },
    })
    assert.equal(alertJob.sessionId, 'sin-alert-42')

    // 值班员接着问 —— 复用同一个 sessionId，这就是"机器先查、人接着问"
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '那这个和昨天的发布有关吗？', sessionId: 'sin-alert-42' }),
    })
    assert.equal(res.status, 202)
    const body = (await res.json()) as { jobId: string; sessionId: string }
    assert.equal(body.sessionId, 'sin-alert-42')

    const job = await ctx.store.get(body.jobId)
    assert.equal(job?.kind, 'chat', '人工追问是 chat 类')
    assert.equal(job?.sessionId, 'sin-alert-42', '挂在告警会话上')
  })

  it('缺少 message 时返回 400 且不入队', async () => {
    const before = await ctx.store.list()
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    })
    assert.equal(res.status, 400)
    const after = await ctx.store.list()
    assert.equal(after.length, before.length, '非法请求不应产生 job')
  })

  it('body 不是合法 JSON 时返回 400', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(res.status, 400)
  })

  it('GET /chat 返回 405（方法不允许）', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`)
    assert.equal(res.status, 405)
  })
})

describe('GET /jobs/:id', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('返回 job 状态快照', async () => {
    const job = await ctx.store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'hi' },
    })
    const res = await fetch(`${ctx.baseUrl}/jobs/${job.id}`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { job: { id: string; status: string }; events: unknown[] }
    assert.equal(body.job.id, job.id)
    assert.equal(body.job.status, 'pending')
    assert.deepEqual(body.events, [])
  })

  it('不存在的 job 返回 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/jobs/job-does-not-exist`)
    assert.equal(res.status, 404)
  })

  it('【增量拉取】?after=<seq> 只返回更新的那部分事件', async () => {
    const job = await ctx.store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: {},
    })
    await ctx.store.appendEvent(job.id, 'tool_start', { tool: 'query_logs' })
    await ctx.store.appendEvent(job.id, 'tool_result', { ok: true })
    await ctx.store.appendEvent(job.id, 'assistant_message', { text: '结论' })

    const all = await fetch(`${ctx.baseUrl}/jobs/${job.id}`)
    const allBody = (await all.json()) as { events: Array<{ seq: number }> }
    assert.equal(allBody.events.length, 3)
    assert.deepEqual(
      allBody.events.map(e => e.seq),
      [1, 2, 3],
    )

    // seq=1 之后 → 只剩 2、3（前端靠这个做断点续拉）
    const inc = await fetch(`${ctx.baseUrl}/jobs/${job.id}?after=1`)
    const incBody = (await inc.json()) as { events: Array<{ seq: number; kind: string }> }
    assert.deepEqual(
      incBody.events.map(e => e.seq),
      [2, 3],
    )
    assert.equal(incBody.events[0]!.kind, 'tool_result')
  })
})

describe('GET /jobs/:id/stream（SSE）', () => {
  it('把已有事件按 seq 顺序推送，并用 Last-Event-ID 断线续传', async () => {
    const ctx = await startApp()
    try {
      const job = await ctx.store.create({
        userId: 'u1',
        cwd: '/srv/workspace',
        kind: 'chat',
        payload: {},
      })
      // finish 只允许 running → 终态（T2 契约），必须先 claim 模拟 worker 认领
      await ctx.store.claim({ assignee: 'worker-1', limit: 1 })
      await ctx.store.appendEvent(job.id, 'tool_start', { tool: 'a' })
      await ctx.store.appendEvent(job.id, 'tool_result', { ok: true })
      await ctx.store.finish(job.id, 'completed')

      // 带 Last-Event-ID: 1 → 只应收到 seq>1 的事件（断线重连不重复推送）
      const res = await fetch(`${ctx.baseUrl}/jobs/${job.id}/stream`, {
        headers: { 'last-event-id': '1' },
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
      // 反向代理不缓冲（plan T9 注记）
      assert.match(res.headers.get('cache-control') ?? '', /no-cache/)

      const text = await res.text()
      assert.match(text, /^id: 2$/m, '应推送 seq=2 的事件')
      assert.doesNotMatch(text, /^id: 1$/m, 'Last-Event-ID=1 之前的不得重推')
      assert.match(text, /event: tool_result/)
    } finally {
      await ctx.close()
    }
  })

  it('job 已终态时流会正常结束，不挂起', async () => {
    const ctx = await startApp()
    try {
      const job = await ctx.store.create({
        userId: 'u1',
        cwd: '/srv/workspace',
        kind: 'chat',
        payload: {},
      })
      await ctx.store.claim({ assignee: 'worker-1', limit: 1 })
      await ctx.store.finish(job.id, 'completed')

      // 直接读到底就说明连接被正常关闭了（终态后不再等待）
      const res = await fetch(`${ctx.baseUrl}/jobs/${job.id}/stream`)
      await res.text()
      assert.equal(res.status, 200)
    } finally {
      await ctx.close()
    }
  })

  it('不存在的 job 返回 404', async () => {
    const ctx = await startApp()
    try {
      const res = await fetch(`${ctx.baseUrl}/jobs/job-nope/stream`)
      assert.equal(res.status, 404)
    } finally {
      await ctx.close()
    }
  })
})

describe('/healthz 与 /readyz', () => {
  it('/healthz 免鉴权且返回 200', async () => {
    const ctx = await startApp()
    try {
      const res = await fetch(`${ctx.baseUrl}/healthz`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { status?: string }
      assert.equal(body.status, 'ok')
    } finally {
      await ctx.close()
    }
  })

  it('/readyz 在依赖就绪时返回 200', async () => {
    const ctx = await startApp({ ready: async () => true })
    try {
      const res = await fetch(`${ctx.baseUrl}/readyz`)
      assert.equal(res.status, 200)
    } finally {
      await ctx.close()
    }
  })

  it('/readyz 在依赖不可用时返回 503（真实探测，不是恒 ok）', async () => {
    const ctx = await startApp({ ready: async () => false })
    try {
      const res = await fetch(`${ctx.baseUrl}/readyz`)
      assert.equal(res.status, 503)
    } finally {
      await ctx.close()
    }
  })

  it('未知路径返回 404', async () => {
    const ctx = await startApp()
    try {
      const res = await fetch(`${ctx.baseUrl}/nope`)
      assert.equal(res.status, 404)
    } finally {
      await ctx.close()
    }
  })
})
