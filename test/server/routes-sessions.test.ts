/**
 * 第 1 档：`/sessions` 系列路由的**端到端**测试（真监听回环端口 + 真 fetch）。
 *
 * 这一组要钉死的是**归属边界**，不只是 happy path：
 *
 * 1. 未接线 `sessions` → **404**（与 `/usage` 同范式：缺口显式暴露，不静默给空数组）
 * 2. `GET /sessions` **只返回"自己有 job"的会话** —— 会话本身没有 userId 维度，
 *    归属完全靠 job 所有权反查；没有 job 的会话（orphan）不该出现在任何人的列表里
 * 3. rename / fork 对**别人的会话返回 404（不是 403）** —— 403 等于确认"此会话存在"，
 *    会成为枚举他人 sessionId 的信道
 * 4. 参数校验：method / body / title
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import type { JobStore } from '../../src/jobs/store.js'
import type { SessionMeta, SessionStore } from '../../src/session/store.js'
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp } from '../../src/server/http.js'
import type { ServerApp } from '../../src/server/http.js'

const KEYS: ApiKeyEntry[] = [
  { key: 'key-alice', userId: 'alice' },
  { key: 'key-bob', userId: 'bob' },
]
const AUTH_ALICE = { authorization: 'Bearer key-alice' }
const AUTH_ALICE_JSON = {
  authorization: 'Bearer key-alice',
  'content-type': 'application/json',
}

/** 最小假会话存储：只实现本组路由用到的方法（list / rename / fork）。 */
function fakeSessions(initial: SessionMeta[] = []): {
  store: SessionStore
  metas: Map<string, SessionMeta>
} {
  const metas = new Map(initial.map(m => [m.id, { ...m }]))
  const store = {
    async list(): Promise<SessionMeta[]> {
      return [...metas.values()]
    },
    async rename(_cwd: string, id: string, title: string): Promise<boolean> {
      const m = metas.get(id)
      if (m === undefined) return false
      m.title = title
      return true
    },
    async fork(_cwd: string, id: string): Promise<string | null> {
      const m = metas.get(id)
      if (m === undefined) return null
      const newId = `${id}-fork`
      metas.set(newId, { ...m, id: newId })
      return newId
    },
  } as unknown as SessionStore
  return { store, metas }
}

async function startApp(
  overrides: { store?: JobStore; sessions?: SessionStore; webRoot?: string } = {},
): Promise<{ baseUrl: string; store: JobStore; close: () => Promise<void> }> {
  const store = overrides.store ?? createMemoryJobStore()
  const app: ServerApp = createServerApp({
    store,
    cwd: '/srv/workspace',
    auth: { keys: KEYS },
    // 只在显式传入时才接线 —— 否则保持"未接线"形态（用于 404 断言）。
    ...(overrides.sessions !== undefined ? { sessions: overrides.sessions } : {}),
    // 静态托管同理：只在显式传入时挂载（用于验证"静态不得抢数据面路由"）。
    ...(overrides.webRoot !== undefined ? { webRoot: overrides.webRoot } : {}),
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

describe('第1档 /sessions：未接线时 404', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('GET /sessions → 404（不静默返回空数组）', async () => {
    const res = await fetch(`${ctx.baseUrl}/sessions`, { headers: AUTH_ALICE })
    assert.equal(res.status, 404)
  })

  it('POST /sessions/:id/rename → 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/sessions/s1/rename`, {
      method: 'POST',
      headers: AUTH_ALICE_JSON,
      body: JSON.stringify({ title: 'x' }),
    })
    assert.equal(res.status, 404)
  })
})

describe('第1档 /sessions：归属过滤（per-user）', () => {
  async function seed(): Promise<{
    store: JobStore
    sessions: SessionStore
    metas: Map<string, SessionMeta>
    ctx: Awaited<ReturnType<typeof startApp>>
  }> {
    const store = createMemoryJobStore()
    await store.create({ userId: 'alice', cwd: '/srv/workspace', kind: 'chat', sessionId: 's-alice' })
    await store.create({ userId: 'bob', cwd: '/srv/workspace', kind: 'chat', sessionId: 's-bob' })
    const { store: sessions, metas } = fakeSessions([
      { id: 's-alice', title: 'A 的会话', messageCount: 2, updatedAt: 300 },
      { id: 's-bob', title: 'B 的会话', messageCount: 1, updatedAt: 200 },
      // 没有任何 job 的会话（例如 CLI 直接建的）—— 不该出现在任何人的列表里。
      { id: 's-orphan', title: '无主会话', messageCount: 0, updatedAt: 100 },
    ])
    const ctx = await startApp({ store, sessions })
    return { store, sessions, metas, ctx }
  }

  it('只返回自己发起过 job 的会话；无主会话不漏给任何人', async () => {
    const { ctx } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions`, { headers: AUTH_ALICE })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string | null }> }
      assert.deepEqual(
        body.sessions.map(s => s.id),
        ['s-alice'],
        'alice 只该看到 s-alice（s-bob 是 bob 的、s-orphan 无主）',
      )
      assert.equal(body.sessions[0]!.title, 'A 的会话')
    } finally {
      await ctx.close()
    }
  })

  it('GET /sessions 非 GET → 405', async () => {
    const { ctx } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions`, {
        method: 'POST',
        headers: AUTH_ALICE,
      })
      assert.equal(res.status, 405)
    } finally {
      await ctx.close()
    }
  })

  it('rename：改自己的会话成功', async () => {
    const { ctx, metas } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions/s-alice/rename`, {
        method: 'POST',
        headers: AUTH_ALICE_JSON,
        body: JSON.stringify({ title: '新标题' }),
      })
      assert.equal(res.status, 200)
      assert.equal(metas.get('s-alice')!.title, '新标题')
    } finally {
      await ctx.close()
    }
  })

  it('rename：别人的会话 → 404（而非 403，不泄漏存在性）', async () => {
    const { ctx, metas } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions/s-bob/rename`, {
        method: 'POST',
        headers: AUTH_ALICE_JSON,
        body: JSON.stringify({ title: '篡改' }),
      })
      assert.equal(res.status, 404)
      assert.equal(metas.get('s-bob')!.title, 'B 的会话', '别人的标题不得被改动')
    } finally {
      await ctx.close()
    }
  })

  it('rename：缺 title → 400', async () => {
    const { ctx } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions/s-alice/rename`, {
        method: 'POST',
        headers: AUTH_ALICE_JSON,
        body: JSON.stringify({}),
      })
      assert.equal(res.status, 400)
    } finally {
      await ctx.close()
    }
  })

  it('fork：派生自己的会话 → 201 + 新 sessionId', async () => {
    const { ctx } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions/s-alice/fork`, {
        method: 'POST',
        headers: AUTH_ALICE,
      })
      assert.equal(res.status, 201)
      const body = (await res.json()) as { sessionId: string }
      assert.equal(body.sessionId, 's-alice-fork')
    } finally {
      await ctx.close()
    }
  })

  it('fork：别人的会话 → 404', async () => {
    const { ctx } = await seed()
    try {
      const res = await fetch(`${ctx.baseUrl}/sessions/s-bob/fork`, {
        method: 'POST',
        headers: AUTH_ALICE,
      })
      assert.equal(res.status, 404)
    } finally {
      await ctx.close()
    }
  })
})

describe('第1档 /sessions：静态托管不得抢数据面路由（回归）', () => {
  // 复现真实事故：`webRoot` 已挂载（前端已构建）时，`GET /sessions` 曾被 SPA
  // fallback 当深链，返回 `index.html`（200 + text/html，**且绕过了鉴权**）。
  // 根因是 http.ts 的静态守卫用了散落的排除列表、加 `/sessions` 时漏登。
  // 修法是集中登记 `API_PATH_PREFIXES` + `isApiPath`。这组测试把边界钉死：
  //   ① 数据面即使挂了静态也必须回 JSON；② 静态**不能**成为鉴权旁路；
  //   ③ 真静态资源（/、/assets/*.js）仍要正常served。
  let root: string
  let ctx: Awaited<ReturnType<typeof startApp>>

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lite-static-'))
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>')
    await writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)\n')

    const store = createMemoryJobStore()
    await store.create({
      userId: 'alice',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 's-alice',
    })
    const { store: sessions } = fakeSessions([
      { id: 's-alice', title: 'A 的会话', messageCount: 1, updatedAt: 1 },
    ])
    ctx = await startApp({ store, sessions, webRoot: root })
  })

  after(async () => {
    await ctx.close()
    await rm(root, { recursive: true, force: true })
  })

  it('GET /sessions（挂了静态）→ 200 JSON，不是 index.html', async () => {
    const res = await fetch(`${ctx.baseUrl}/sessions`, { headers: AUTH_ALICE })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const body = (await res.json()) as { sessions: Array<{ id: string }> }
    assert.deepEqual(body.sessions.map(s => s.id), ['s-alice'])
  })

  it('GET /sessions 未带凭证 → 401（静态不是鉴权旁路）', async () => {
    const res = await fetch(`${ctx.baseUrl}/sessions`)
    assert.equal(res.status, 401)
  })

  it('GET /jobs（挂了静态）→ JSON，不是 index.html', async () => {
    const res = await fetch(`${ctx.baseUrl}/jobs`, { headers: AUTH_ALICE })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })

  it('静态本体仍工作：GET / 与 /assets/app.js', async () => {
    const rootRes = await fetch(`${ctx.baseUrl}/`)
    assert.equal(rootRes.status, 200)
    assert.match(rootRes.headers.get('content-type') ?? '', /text\/html/)
    const assetRes = await fetch(`${ctx.baseUrl}/assets/app.js`)
    assert.equal(assetRes.status, 200)
    assert.match(assetRes.headers.get('content-type') ?? '', /javascript/)
  })
})
