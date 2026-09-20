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

describe('T6 关闭鉴权（key 表为空）时的回环开发形态', () => {
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
