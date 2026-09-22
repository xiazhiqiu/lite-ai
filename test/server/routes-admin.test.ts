/**
 * 【T57】`POST /admin/reload` 测试。
 *
 * 管理面是**默认关闭**的运维口子（对齐 HolmesGPT `ENABLE_ADMIN_API`）。这组钉死：
 *
 * 1. 未接线 → **404**（默认关闭 = 路由不存在，而不是"存在但拒绝"）
 * 2. 接线后 POST → 200，原样返回 `reload()` 的结果（含 changes / note）
 * 3. **必须鉴权**：未带凭证 → 401（不存在匿名重载配置的口子）
 * 4. 方法限定：GET → 405（且不得被 SPA fallback 回 index.html）
 * 5. reload 抛错 → **500 且不回吐内部错误文本**（配置内容可能含敏感字段）
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
import type { AdminReloadResult, ServerApp } from '../../src/server/http.js'

const KEYS: ApiKeyEntry[] = [{ key: 'key-alice', userId: 'alice' }]
const AUTH = { authorization: 'Bearer key-alice' }

const RELOAD_RESULT: AdminReloadResult = {
  reloaded: true,
  changes: [{ field: 'model', from: 'old-model', to: 'new-model' }],
  note: 'ok',
}

async function startApp(
  admin?: { reload: () => Promise<AdminReloadResult> | AdminReloadResult },
  webRoot?: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: ServerApp = createServerApp({
    store: createMemoryJobStore(),
    cwd: '/srv/workspace',
    auth: { keys: KEYS },
    ...(admin !== undefined ? { admin } : {}),
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

describe('T57 /admin/reload：默认关闭', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('未接线 POST → 404（默认不挂路由）', async () => {
    const res = await fetch(`${ctx.baseUrl}/admin/reload`, { method: 'POST', headers: AUTH })
    assert.equal(res.status, 404)
  })

  it('未接线 GET → 404（不是 405 —— 路由压根不存在）', async () => {
    const res = await fetch(`${ctx.baseUrl}/admin/reload`, { headers: AUTH })
    assert.equal(res.status, 404)
  })
})

describe('T57 /admin/reload：接线后', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp({ reload: () => RELOAD_RESULT })
  })
  after(async () => {
    await ctx.close()
  })

  it('POST → 200 且原样返回 reload 结果', async () => {
    const res = await fetch(`${ctx.baseUrl}/admin/reload`, { method: 'POST', headers: AUTH })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), RELOAD_RESULT)
  })

  it('未带凭证 → 401（不存在匿名重载）', async () => {
    const res = await fetch(`${ctx.baseUrl}/admin/reload`, { method: 'POST' })
    assert.equal(res.status, 401)
  })

  it('非 POST → 405', async () => {
    const res = await fetch(`${ctx.baseUrl}/admin/reload`, { headers: AUTH })
    assert.equal(res.status, 405)
  })
})

describe('T57 /admin/reload：失败不泄漏内部错误', () => {
  it('reload 抛错 → 500 且不回吐错误文本', async () => {
    const ctx = await startApp({
      reload: () => {
        throw new Error('config parse failed at /etc/secret-path/config.yaml')
      },
    })
    try {
      const res = await fetch(`${ctx.baseUrl}/admin/reload`, { method: 'POST', headers: AUTH })
      assert.equal(res.status, 500)
      const body = (await res.json()) as { error: string }
      assert.equal(body.error, 'reload failed')
      assert.doesNotMatch(JSON.stringify(body), /secret-path/, '不得回吐配置路径')
    } finally {
      await ctx.close()
    }
  })
})

describe('T57 /admin/reload：静态托管下仍是 API', () => {
  let root: string
  let ctx: Awaited<ReturnType<typeof startApp>>

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lite-admin-static-'))
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await writeFile(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>')
    ctx = await startApp({ reload: () => RELOAD_RESULT }, root)
  })

  after(async () => {
    await ctx.close()
    await rm(root, { recursive: true, force: true })
  })

  it('GET /admin/reload（挂了静态）→ 405，不是 index.html', async () => {
    const res = await fetch(`${ctx.baseUrl}/admin/reload`, { headers: AUTH })
    assert.equal(res.status, 405)
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/html/)
  })
})
