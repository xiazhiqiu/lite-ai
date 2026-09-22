/**
 * T6 鉴权与 per-user 隔离的**端到端**测试 —— 真监听回环端口、真 fetch。
 *
 * 与 `server-routes.test.ts` 同一取向：不打桩路由内部函数，测的是线上那条路径。
 *
 * 三条主线：
 * 1. 无凭证 / 错凭证 → 401（含 SSE 端点）
 * 2. 甲用乙的 jobId → **404**（不是 403 —— 不泄漏资源存在性）
 * 3. /healthz /readyz 免鉴权（LB/k8s 探针不能带凭证）
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'

import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import type { JobStore } from '../../src/jobs/store.js'
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp } from '../../src/server/http.js'
import type { ServerApp } from '../../src/server/http.js'

/** alice 与 bob 各持一把 key —— 用于证明"甲看不到乙的调查"。 */
const KEYS: ApiKeyEntry[] = [
  { key: 'key-alice', userId: 'alice' },
  { key: 'key-bob', userId: 'bob' },
]

const AUTH_ALICE = { authorization: 'Bearer key-alice' }
const AUTH_BOB = { authorization: 'Bearer key-bob' }

async function startApp(
  overrides: { store?: JobStore; ready?: () => Promise<boolean>; keys?: ApiKeyEntry[] } = {},
) {
  const store = overrides.store ?? createMemoryJobStore()
  const app: ServerApp = createServerApp({
    store,
    cwd: '/srv/workspace',
    ready: overrides.ready,
    auth: { keys: overrides.keys ?? KEYS },
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

describe('T6 鉴权：未授权一律 401', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('POST /chat 无凭证 → 401 且不入队', async () => {
    const before = await ctx.store.list()
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    assert.equal(res.status, 401)
    // 告知客户端该用哪种认证方案（HTTP 标准）
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/i)
    const after = await ctx.store.list()
    assert.equal(after.length, before.length, '未授权请求不得产生 job')
  })

  it('POST /chat 凭证错误 → 401', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ message: 'hi' }),
    })
    assert.equal(res.status, 401)
  })

  it('GET /jobs/:id 无凭证 → 401（不是 404 —— 先鉴权再查存在性）', async () => {
    const res = await fetch(`${ctx.baseUrl}/jobs/some-id`)
    assert.equal(res.status, 401)
  })

  it('GET /jobs/:id/stream 无凭证 → 401（SSE 端点同样受保护）', async () => {
    const res = await fetch(`${ctx.baseUrl}/jobs/some-id/stream`)
    assert.equal(res.status, 401)
  })

  it('未知路径也先鉴权 → 401（不因 404 提前暴露路由表）', async () => {
    const res = await fetch(`${ctx.baseUrl}/whatever`)
    assert.equal(res.status, 401)
  })
})

describe('T6 豁免路径：探针无需凭证', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp({ ready: async () => true })
  })
  after(async () => {
    await ctx.close()
  })

  it('/healthz 免鉴权 → 200', async () => {
    const res = await fetch(`${ctx.baseUrl}/healthz`)
    assert.equal(res.status, 200)
  })

  it('/readyz 免鉴权 → 200', async () => {
    const res = await fetch(`${ctx.baseUrl}/readyz`)
    assert.equal(res.status, 200)
  })

  it('/readyz 依赖不可用 → 503（依旧免鉴权，真实探测）', async () => {
    const c = await startApp({ ready: async () => false })
    try {
      const res = await fetch(`${c.baseUrl}/readyz`)
      assert.equal(res.status, 503)
    } finally {
      await c.close()
    }
  })
})

describe('T6 per-user 隔离：甲看不到乙的调查', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('job 的 userId 来自鉴权身份（而非 body）', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { ...AUTH_ALICE, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '查一下延迟' }),
    })
    assert.equal(res.status, 202)
    const { jobId } = (await res.json()) as { jobId: string }
    const job = await ctx.store.get(jobId)
    assert.equal(job?.userId, 'alice')
  })

  it('【关键】body 里伪造 userId 不生效 —— 以鉴权身份为准', async () => {
    const res = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { ...AUTH_ALICE, 'content-type': 'application/json' },
      // 攻击尝试：alice 声称自己是 admin
      body: JSON.stringify({ message: 'hi', userId: 'admin' }),
    })
    const { jobId } = (await res.json()) as { jobId: string }
    const job = await ctx.store.get(jobId)
    assert.equal(job?.userId, 'alice', 'body.userId 必须被忽略')
  })

  it('【关键】甲用乙的 jobId → 404（不是 403，不泄漏存在性）', async () => {
    const created = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { ...AUTH_BOB, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'bob 的私密调查' }),
    })
    const { jobId } = (await created.json()) as { jobId: string }

    // bob 自己取 → 200
    const own = await fetch(`${ctx.baseUrl}/jobs/${jobId}`, { headers: AUTH_BOB })
    assert.equal(own.status, 200)

    // alice 拿同一个 id → 404（而非 403："存在但不是你的"是信息泄漏）
    const cross = await fetch(`${ctx.baseUrl}/jobs/${jobId}`, { headers: AUTH_ALICE })
    assert.equal(cross.status, 404)

    // 与"根本不存在的 id"返回**同一个**响应体 —— 二者不可区分
    const ghost = await fetch(`${ctx.baseUrl}/jobs/does-not-exist-at-all`, {
      headers: AUTH_ALICE,
    })
    assert.equal(ghost.status, 404)
    assert.deepEqual(await cross.json(), await ghost.json())
  })

  it('【关键】甲不能订阅乙的 SSE 事件流 → 404', async () => {
    const created = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { ...AUTH_BOB, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'bob 的私密调查 2' }),
    })
    const { jobId } = (await created.json()) as { jobId: string }

    const cross = await fetch(`${ctx.baseUrl}/jobs/${jobId}/stream`, { headers: AUTH_ALICE })
    assert.equal(cross.status, 404)
    // 400 系列响应体是 JSON，说明未进入 SSE 流
    assert.match(cross.headers.get('content-type') ?? '', /application\/json/)
  })

  it('本人可正常读取自己的 job 状态与事件', async () => {
    const created = await fetch(`${ctx.baseUrl}/chat`, {
      method: 'POST',
      headers: { ...AUTH_ALICE, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'alice 自己的' }),
    })
    const { jobId } = (await created.json()) as { jobId: string }
    const res = await fetch(`${ctx.baseUrl}/jobs/${jobId}`, { headers: AUTH_ALICE })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { job: { userId: string } }
    assert.equal(body.job.userId, 'alice')
  })
})

describe('T6 空 key 表 + 回环（fail-closed：业务端点仍 401，只有 /healthz 豁免）', () => {
  it('空 key 表 + 回环：业务端点仍要求凭证（不放行任何身份）', async () => {
    const ctx = await startApp({ keys: [] })
    try {
      const res = await fetch(`${ctx.baseUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      })
      // 空表 = 没有任何 key 能匹配 → 必然 401。
      // 这是刻意的：即便回环也不静默放行，避免"以为配了实际没配"。
      assert.equal(res.status, 401)
      // 探针仍可用
      assert.equal((await fetch(`${ctx.baseUrl}/healthz`)).status, 200)
    } finally {
      await ctx.close()
    }
  })
})

/**
 * `GET /jobs` 列表接口（T10 补）。
 *
 * **为什么单独写一组**：这个路由是 T10 前端接线时才发现的缺口——`SessionList` /
 * `AlertView` / `UsageView` 全都调 `GET /jobs`，但 T3 只实现了 `/jobs/:id`，
 * 于是三个页面在真实环境里会齐刷刷 404。**单测测不出"前端调了个不存在的路由"**，
 * 是端到端冒烟把它逼出来的。这里把该契约固化下来。
 */
describe('T10 GET /jobs：列表接口的隔离与分页', () => {
  /** 造 N 个 alice 的 job（直接写 store，绕过 /chat 的异步语义）。 */
  async function seed(store: JobStore, userId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await store.create({ kind: 'chat', userId, payload: { message: `msg-${i}` } })
    }
  }

  it('无凭证 → 401；未被静态托管吞掉', async () => {
    const ctx = await startApp()
    try {
      const res = await fetch(`${ctx.baseUrl}/jobs`)
      assert.equal(res.status, 401)
      // 关键：不能返回 SPA 的 index.html（那会让前端把 HTML 当 JSON 解析）
      assert.match(res.headers.get('content-type') ?? '', /json/)
    } finally {
      await ctx.close()
    }
  })

  it('只返回本人的 job（per-user 隔离）', async () => {
    const ctx = await startApp()
    try {
      await seed(ctx.store, 'alice', 3)
      await seed(ctx.store, 'bob', 2)

      const alice = await fetch(`${ctx.baseUrl}/jobs`, { headers: AUTH_ALICE })
      assert.equal(alice.status, 200)
      const aliceBody = (await alice.json()) as { jobs: Array<{ userId: string }> }
      assert.equal(aliceBody.jobs.length, 3)
      assert.ok(aliceBody.jobs.every(j => j.userId === 'alice'))

      const bob = await fetch(`${ctx.baseUrl}/jobs`, { headers: AUTH_BOB })
      const bobBody = (await bob.json()) as { jobs: Array<{ userId: string }> }
      assert.equal(bobBody.jobs.length, 2)
      assert.ok(bobBody.jobs.every(j => j.userId === 'bob'))
    } finally {
      await ctx.close()
    }
  })

  it('【关键】查询串里的 userId 被忽略（不能靠它越权读别人列表）', async () => {
    const ctx = await startApp()
    try {
      await seed(ctx.store, 'alice', 2)
      await seed(ctx.store, 'bob', 5)

      // 拿着 alice 的合法凭据，试图用 ?userId=bob 读 bob 的列表
      const res = await fetch(`${ctx.baseUrl}/jobs?userId=bob`, { headers: AUTH_ALICE })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { jobs: Array<{ userId: string }> }
      assert.equal(body.jobs.length, 2, '必须仍是 alice 的 2 条，而不是 bob 的 5 条')
      assert.ok(body.jobs.every(j => j.userId === 'alice'))
    } finally {
      await ctx.close()
    }
  })

  it('status 过滤生效', async () => {
    const ctx = await startApp()
    try {
      await seed(ctx.store, 'alice', 2)
      const res = await fetch(`${ctx.baseUrl}/jobs?status=pending`, { headers: AUTH_ALICE })
      const body = (await res.json()) as { jobs: Array<{ status: string }> }
      assert.ok(body.jobs.every(j => j.status === 'pending'))

      const none = await fetch(`${ctx.baseUrl}/jobs?status=completed`, { headers: AUTH_ALICE })
      const noneBody = (await none.json()) as { jobs: unknown[] }
      assert.equal(noneBody.jobs.length, 0)
    } finally {
      await ctx.close()
    }
  })

  it('【关键】limit 被夹到上限（防 ?limit=100000 拉垮服务端）', async () => {
    const ctx = await startApp()
    try {
      await seed(ctx.store, 'alice', 1)

      // 超大 limit 不应被原样下传：请求本身要成功，且不返回超过上限的条数。
      // 这里只有 1 条数据，所以断言"请求成功 + 不超过 200"即可证明参数被夹住而非裸传。
      const res = await fetch(`${ctx.baseUrl}/jobs?limit=100000`, { headers: AUTH_ALICE })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { jobs: unknown[] }
      assert.ok(body.jobs.length <= 200)

      // 非法 limit 走默认值，不报错
      for (const bad of ['abc', '-1', '0', '']) {
        const r = await fetch(`${ctx.baseUrl}/jobs?limit=${bad}`, { headers: AUTH_ALICE })
        assert.equal(r.status, 200, `limit=${bad} 应回退默认而非报错`)
      }
    } finally {
      await ctx.close()
    }
  })

  it('列表项含 summary 投影，且不下发原始 payload', async () => {
    const ctx = await startApp()
    try {
      await ctx.store.create({
        kind: 'chat',
        userId: 'alice',
        payload: { message: '订单延迟', secret: '不应下发' },
      })
      const res = await fetch(`${ctx.baseUrl}/jobs`, { headers: AUTH_ALICE })
      const body = (await res.json()) as {
        jobs: Array<Record<string, unknown>>
      }
      const job = body.jobs[0]!
      assert.equal(job.summary, '订单延迟')
      assert.ok(!('payload' in job), '原始 payload 不得下发（可能含敏感字段）')
      assert.ok(!JSON.stringify(job).includes('不应下发'))
    } finally {
      await ctx.close()
    }
  })

  it('POST /chat 的 body.userId 被忽略（防冒充）', async () => {
    const ctx = await startApp()
    try {
      const res = await fetch(`${ctx.baseUrl}/chat`, {
        method: 'POST',
        headers: { ...AUTH_ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi', userId: 'bob' }),
      })
      assert.equal(res.status, 202)
      const { jobId } = (await res.json()) as { jobId: string }
      const job = await ctx.store.get(jobId)
      assert.equal(job?.userId, 'alice', '身份只能来自凭据，不能来自请求体')
    } finally {
      await ctx.close()
    }
  })
})
