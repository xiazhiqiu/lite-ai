/**
 * 【T56】`GET /info` —— 实例自述路由测试。
 *
 * 部署后"这个实例装了什么"（版本 / 模型 / 用没用 PG / tracing 开没开）此前只能
 * 翻启动日志或逐个试端点。`GET /info` 用一个请求答清。这组测试钉死：
 *
 * 1. 未接线 → **404**（与 `/usage`、`/sessions` 同范式：缺口显式暴露）
 * 2. 接线 → 200，**原样返回装配层给的对象**
 * 3. 需鉴权（401）、方法限定（405）
 * 4. 自述函数抛错 → **503**（不 500、不泄漏内部错误）
 * 5. **挂了静态托管时 GET /info 仍返回 JSON** —— 这正是 `/sessions` 踩过的坑
 *    （SPA fallback 把无扩展名的 API 路径当深链回 index.html）
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp } from '../../src/server/http.js'
import type { ServerApp, ServerInfo } from '../../src/server/http.js'

const KEYS: ApiKeyEntry[] = [{ key: 'key-alice', userId: 'alice' }]
const AUTH = { authorization: 'Bearer key-alice' }

const SAMPLE: ServerInfo = {
  version: '9.9.9',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  capabilities: {
    tracing: false,
    alerts: true,
    sessions: true,
    usageDurable: false,
    static: false,
  },
  runtime: { node: 'v22.0.0', pid: 1234, host: 'test-host' },
}

async function startApp(
  info?: () => ServerInfo | Promise<ServerInfo>,
  webRoot?: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: ServerApp = createServerApp({
    store: createMemoryJobStore(),
    cwd: '/srv/workspace',
    auth: { keys: KEYS },
    ...(info !== undefined ? { info } : {}),
    ...(webRoot !== undefined ? { webRoot } : {}),
  })
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = app.server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

describe('T56 /info：未接线 → 404', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('GET /info → 404（不静默返回空对象）', async () => {
    const res = await fetch(`${ctx.baseUrl}/info`, { headers: AUTH })
    assert.equal(res.status, 404)
  })
})

describe('T56 /info：接线后的行为', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp(() => SAMPLE)
  })
  after(async () => {
    await ctx.close()
  })

  it('GET /info → 200 且原样返回装配层给的对象', async () => {
    const res = await fetch(`${ctx.baseUrl}/info`, { headers: AUTH })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await res.json(), SAMPLE)
  })

  it('未带凭证 → 401（自述暴露部署结构，不能匿名）', async () => {
    const res = await fetch(`${ctx.baseUrl}/info`)
    assert.equal(res.status, 401)
  })

  it('非 GET → 405', async () => {
    const res = await fetch(`${ctx.baseUrl}/info`, { method: 'POST', headers: AUTH })
    assert.equal(res.status, 405)
  })
})

describe('T56 /info：自述失败不伪装成实例损坏', () => {
  it('info() 抛错 → 503，且不泄漏内部错误', async () => {
    const ctx = await startApp(() => {
      throw new Error('pg pool exploded: secret-dsn')
    })
    try {
      const res = await fetch(`${ctx.baseUrl}/info`, { headers: AUTH })
      assert.equal(res.status, 503)
      const body = (await res.json()) as { error: string }
      assert.equal(body.error, 'info unavailable')
      assert.doesNotMatch(JSON.stringify(body), /secret-dsn/, '不得回吐内部错误文本')
    } finally {
      await ctx.close()
    }
  })
})

describe('T56 /info：静态托管不得截胡', () => {
  let root: string
  let ctx: Awaited<ReturnType<typeof startApp>>

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lite-info-static-'))
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>')
    ctx = await startApp(() => SAMPLE, root)
  })

  after(async () => {
    await ctx.close()
    await rm(root, { recursive: true, force: true })
  })

  it('GET /info（挂了静态）→ JSON，不是 index.html', async () => {
    const res = await fetch(`${ctx.baseUrl}/info`, { headers: AUTH })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })

  it('GET /info 未带凭证（挂了静态）→ 401，静态不是鉴权旁路', async () => {
    const res = await fetch(`${ctx.baseUrl}/info`)
    assert.equal(res.status, 401)
  })
})
