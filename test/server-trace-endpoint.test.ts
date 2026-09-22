/**
 * `GET /trace/:jobId` —— 跨轨聚合视图（观测层查询出口）。
 *
 * 本文件要钉住的是**这个端点存在的全部理由**：把原本散在四条轨、只能靠人工
 * 按 `jobId` 事后 join 的事实，一次给全。所以断言不测"HTTP 200"，而测语义：
 *
 * 1. **A 轨（`job_events`）与 D 轨（`usage_events`）真的被合并到同一个响应里**，
 *    且各自带 `source` 标注（合并了但分不清来源等于没合并）。
 * 2. **两套 traceId 都回、且必须不相等** —— 这条最容易被"顺手统一一下"改坏，
 *    而统一会废掉 `jobIdFromTrace()` 的反解能力（见 `observability/tracing.ts`
 *    的完整论证 + `test/server/trace.test.ts`）。这里用断言把它钉死。
 * 3. **C 轨（`metrics.db`）如实标不可用**，且给出原因 —— 不是省略该键。
 *    "漏了一个键"和"这个轨按 jobId 本来就查不到"是两回事，响应体必须说得清。
 * 4. **B 轨未启用时不假装有**（`enabled:false` + `traceId:null`），启用时才给
 *    `baseUrl` 与 `otelTraceId`。
 * 5. **D 轨未接线时端点仍可用**（A 轨不该被 D 轨拖累成 404）。
 * 6. **越权与不存在同口径 404**（不泄漏 job 存在性，可被用来枚举他人 jobId）。
 *
 * 全程内存实现，不依赖 PG / Langfuse，**不 skip**。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { createMemoryUsageStore } from '../src/usage/memory-store.js'
import type { UsageStore } from '../src/usage/store.js'
import type { ApiKeyEntry } from '../src/server/auth.js'
import { createServerApp } from '../src/server/http.js'
import type { ServerApp } from '../src/server/http.js'
import { createNoopTracingSink, deriveTraceId } from '../src/observability/tracing.js'
import type { TracingSink } from '../src/observability/tracing.js'
import { traceIdForJob } from '../src/server/trace.js'

const TEST_USER = 'u1'
const OTHER_USER = 'u2'
const TEST_KEY = 'test-key-u1'
const OTHER_KEY = 'test-key-u2'
const TEST_KEYS: ApiKeyEntry[] = [
  { key: TEST_KEY, userId: TEST_USER },
  { key: OTHER_KEY, userId: OTHER_USER },
]
const AUTH = { authorization: `Bearer ${TEST_KEY}` }
const AUTH_OTHER = { authorization: `Bearer ${OTHER_KEY}` }

/** B 轨"已启用"的假 sink：`enabled` + `baseUrl` 是端点唯一会读的两个事实。 */
const ENABLED_SINK: TracingSink = {
  ...createNoopTracingSink(),
  enabled: true,
  baseUrl: 'http://127.0.0.1:13000',
}

async function startApp(
  opts: { usage?: UsageStore; tracing?: TracingSink; withUsage?: boolean } = {},
): Promise<{
  baseUrl: string
  store: ReturnType<typeof createMemoryJobStore>
  /** 与 app 内部**同一个** usage 实例（用来直接播种 D 轨记录）。 */
  usage: UsageStore | undefined
  close: () => Promise<void>
}> {
  const store = createMemoryJobStore()
  const usage = opts.usage ?? (opts.withUsage === true ? createMemoryUsageStore() : undefined)
  const app: ServerApp = createServerApp({
    store,
    cwd: '/srv/workspace',
    auth: { keys: TEST_KEYS },
    ...(usage !== undefined ? { usage } : {}),
    ...(opts.tracing !== undefined ? { tracing: opts.tracing } : {}),
  })
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = app.server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    usage,
    close: async (): Promise<void> => {
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

/** 造一个属于 `userId` 的 job；返回 jobId。 */
async function seedJob(
  store: ReturnType<typeof createMemoryJobStore>,
  userId = TEST_USER,
): Promise<string> {
  const job = await store.create({
    userId,
    cwd: '/srv/workspace',
    kind: 'chat',
    sessionId: 'sin-trace-1',
    payload: { message: '为什么 checkout 的 p99 涨了' },
  })
  return job.id
}

describe('GET /trace/:jobId —— A 轨与 D 轨合并', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp({ withUsage: true })
  })
  after(async () => {
    await ctx.close()
  })

  it('同时返回 job 事件（A）与用量记录（D），并各自标注 source', async () => {
    const jobId = await seedJob(ctx.store)
    await ctx.store.appendEvent(jobId, 'tool_start', { tool: 'kubectl' })
    await ctx.store.appendEvent(jobId, 'assistant_message', { text: '开始排查' })
    await ctx.usage!.record({
      userId: TEST_USER,
      jobId,
      sessionId: 'sin-trace-1',
      traceId: traceIdForJob(jobId),
      model: 'deepseek-chat',
      inputTokens: 1234,
      outputTokens: 321,
      durationMs: 4200,
      status: 'completed',
    })

    const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      job: { id: string; userId: string }
      identity: Record<string, unknown>
      tracks: {
        jobEvents: { source: string; events: Array<{ seq: number; kind: string }> }
        usage: { source: string; records: Array<{ jobId: string | null; inputTokens: number }> }
        langfuse: { enabled: boolean; baseUrl: string | null; traceId: string | null }
        metrics: { available: boolean; source: string; reason: string }
      }
    }

    assert.equal(body.job.id, jobId)
    assert.equal(body.tracks.jobEvents.source, 'job_events')
    assert.deepEqual(
      body.tracks.jobEvents.events.map(e => e.kind),
      ['tool_start', 'assistant_message'],
    )
    assert.equal(body.tracks.usage.source, 'usage_events')
    assert.equal(body.tracks.usage.records.length, 1)
    assert.equal(body.tracks.usage.records[0]!.jobId, jobId)
    assert.equal(body.tracks.usage.records[0]!.inputTokens, 1234)
  })

  it('D 轨按 jobId 收窄：别人的 job 记录不会混进来', async () => {
    const mineJobId = await seedJob(ctx.store)
    const otherJobId = await seedJob(ctx.store, OTHER_USER)
    // 用**同一个** user 写两条、不同 jobId 的记录，验证过滤键是 jobId 不是 userId
    for (const id of [mineJobId, otherJobId]) {
      await ctx.usage!.record({
        userId: TEST_USER,
        jobId: id,
        sessionId: 'sin-trace-1',
        traceId: null,
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        durationMs: null,
        status: 'completed',
      })
    }
    const res = await fetch(`${ctx.baseUrl}/trace/${mineJobId}`, { headers: AUTH })
    const body = (await res.json()) as {
      tracks: { usage: { records: Array<{ jobId: string | null }> } }
    }
    assert.deepEqual(
      body.tracks.usage.records.map(r => r.jobId),
      [mineJobId],
    )
  })

  it('?after=<seq> 的增量语义与 /jobs/:id 一致（不重复实现分页）', async () => {
    const jobId = await seedJob(ctx.store)
    const first = await ctx.store.appendEvent(jobId, 'tool_start', { tool: 'a' })
    await ctx.store.appendEvent(jobId, 'tool_result', { tool: 'a' })

    const res = await fetch(`${ctx.baseUrl}/trace/${jobId}?after=${first.seq}`, {
      headers: AUTH,
    })
    const body = (await res.json()) as {
      tracks: { jobEvents: { events: Array<{ kind: string }> } }
    }
    assert.deepEqual(
      body.tracks.jobEvents.events.map(e => e.kind),
      ['tool_result'],
    )
  })
})

describe('GET /trace/:jobId —— 两套 traceId 并存且不等', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp()
  })
  after(async () => {
    await ctx.close()
  })

  it('auditTraceId 可反解回 jobId；otelTraceId 是 32 hex；两者取值不等', async () => {
    const jobId = await seedJob(ctx.store)
    const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
    const body = (await res.json()) as {
      identity: { jobId: string; auditTraceId: string; otelTraceId: string }
    }

    assert.equal(body.identity.jobId, jobId)
    assert.equal(body.identity.auditTraceId, traceIdForJob(jobId))
    assert.equal(body.identity.otelTraceId, deriveTraceId(jobId))
    assert.match(body.identity.otelTraceId, /^[0-9a-f]{32}$/)

    // 这条断言就是"别顺手统一两套 traceId"的护栏：统一了它会立刻红。
    assert.notEqual(body.identity.auditTraceId, body.identity.otelTraceId)
  })
})

describe('GET /trace/:jobId —— B 轨（Langfuse）如实回报', () => {
  it('未启用（noop sink）时不假装有：enabled=false、baseUrl/traceId 均为 null', async () => {
    const ctx = await startApp({ tracing: createNoopTracingSink('no-langfuse-credentials') })
    try {
      const jobId = await seedJob(ctx.store)
      const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
      const body = (await res.json()) as {
        tracks: { langfuse: { enabled: boolean; baseUrl: string | null; traceId: string | null } }
      }
      assert.equal(body.tracks.langfuse.enabled, false)
      assert.equal(body.tracks.langfuse.baseUrl, null)
      assert.equal(body.tracks.langfuse.traceId, null)
    } finally {
      await ctx.close()
    }
  })

  it('启用时给出 baseUrl 与 otelTraceId（且不拼 UI 深链）', async () => {
    const ctx = await startApp({ tracing: ENABLED_SINK })
    try {
      const jobId = await seedJob(ctx.store)
      const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
      const body = (await res.json()) as {
        tracks: { langfuse: { enabled: boolean; baseUrl: string | null; traceId: string | null } }
      }
      assert.equal(body.tracks.langfuse.enabled, true)
      assert.equal(body.tracks.langfuse.baseUrl, 'http://127.0.0.1:13000')
      assert.equal(body.tracks.langfuse.traceId, deriveTraceId(jobId))
    } finally {
      await ctx.close()
    }
  })
})

describe('GET /trace/:jobId —— C 轨与缺轨的诚实标注', () => {
  it('metrics 轨如实标 available=false 并给出原因（不是省略该键）', async () => {
    const ctx = await startApp()
    try {
      const jobId = await seedJob(ctx.store)
      const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
      const body = (await res.json()) as {
        tracks: { metrics: { available: boolean; source: string; reason: string } }
      }
      assert.equal(body.tracks.metrics.available, false)
      assert.equal(body.tracks.metrics.source, 'metrics.db')
      assert.ok(body.tracks.metrics.reason.length > 0)
    } finally {
      await ctx.close()
    }
  })

  it('未接线 usage 时端点仍可用（A 轨不该被 D 轨拖累成 404），usage 退化为空数组', async () => {
    const ctx = await startApp()
    try {
      const jobId = await seedJob(ctx.store)
      await ctx.store.appendEvent(jobId, 'assistant_message', { text: 'ok' })
      const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        tracks: { jobEvents: { events: unknown[] }; usage: { records: unknown[] } }
      }
      assert.equal(body.tracks.jobEvents.events.length, 1)
      assert.deepEqual(body.tracks.usage.records, [])
    } finally {
      await ctx.close()
    }
  })
})

describe('GET /trace/:jobId —— 鉴权与口径', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  before(async () => {
    ctx = await startApp({ usage: createMemoryUsageStore() })
  })
  after(async () => {
    await ctx.close()
  })

  it('他人的 job 返回 404（不是 403 —— 不泄漏资源存在性）', async () => {
    const jobId = await seedJob(ctx.store, OTHER_USER)
    const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
    assert.equal(res.status, 404)
    // 对照组：同一个 job 换成本人凭证就 200 —— 证明上面的 404 来自归属判定，
    // 而不是"这个 jobId 压根不存在"或路由没生效。
    const own = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH_OTHER })
    assert.equal(own.status, 200)
  })

  it('不存在的 job 返回 404', async () => {
    const res = await fetch(`${ctx.baseUrl}/trace/job-does-not-exist`, { headers: AUTH })
    assert.equal(res.status, 404)
  })

  it('无凭证返回 401（不在豁免路径里）', async () => {
    const jobId = await seedJob(ctx.store)
    const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`)
    assert.equal(res.status, 401)
  })

  it('POST /trace/:jobId 返回 405', async () => {
    const res = await fetch(`${ctx.baseUrl}/trace/job-x`, { method: 'POST', headers: AUTH })
    assert.equal(res.status, 405)
  })

  it('本人可见自己的 job（对照组：证明上面的 404 来自归属而非路由未生效）', async () => {
    const jobId = await seedJob(ctx.store, TEST_USER)
    const res = await fetch(`${ctx.baseUrl}/trace/${jobId}`, { headers: AUTH })
    assert.equal(res.status, 200)
  })
})
