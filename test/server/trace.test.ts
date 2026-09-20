/**
 * T7：traceId 与用量 / 审计账本的测试。
 *
 * 三层：
 * 1. **纯函数层**：traceId ↔ jobId 的双向一致性、结构化日志的**序列化降级**。
 *    降级这条尤其重要 —— JSON.stringify 遇到循环引用会抛，而日志写在 job 终态
 *    路径上，抛出去会把"已经成功的 job"变成 failed。必须证明它不会。
 * 2. **存储契约层**：`UsageStore` 的内存实现语义（按 userId 隔离、新→旧、limit 夹取、
 *    summarize 是全量口径而非本页口径）。
 * 3. **HTTP 端到端层**：真监听 + 真 fetch，证明 `/usage` 的 per-user 隔离与
 *    "汇总不受 limit 影响"这两条**在传输层也成立**（不只是 store 层）。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'

import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import {
  createMemoryUsageStore,
  clampUsageLimit,
  USAGE_LIMIT_DEFAULT,
  USAGE_LIMIT_MAX,
  type UsageEvent,
} from '../../src/usage/index.js'
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp } from '../../src/server/http.js'
import type { ServerApp } from '../../src/server/http.js'
import {
  createLifecycleLogger,
  formatLifecycleLog,
  jobIdFromTrace,
  traceIdForJob,
} from '../../src/server/trace.js'

// ---------------------------------------------------------------- 1. 纯函数

describe('T7-a traceId：从 jobId 确定性派生', () => {
  it('往返一致：traceIdForJob → jobIdFromTrace 回到原值', () => {
    for (const jobId of ['job-abc', 'job-0f9c1e2d-3a4b-5c6d-7e8f-9a0b1c2d3e4f', 'x']) {
      const traceId = traceIdForJob(jobId)
      assert.equal(jobIdFromTrace(traceId), jobId)
    }
  })

  it('确定性：同一 jobId 永远得到同一 traceId（这正是"不用存列"的前提）', () => {
    // 若 traceId 带随机后缀，就必须落库才能反查 —— 那才需要 jobs.trace_id 列。
    // 断言"可重算"就是在守护这个设计前提。
    assert.equal(traceIdForJob('job-1'), traceIdForJob('job-1'))
  })

  it('不合法的 traceId 返回 null，而不是抛错或猜一个 jobId', () => {
    assert.equal(jobIdFromTrace('not-a-trace'), null)
    assert.equal(jobIdFromTrace('tr-'), null, '空 jobId 段视为非法')
    assert.equal(jobIdFromTrace(''), null)
    // 前缀只是前缀：`tr-tr-x` 反解出 `tr-x`，这是合法的（jobId 未受限字符集）
    assert.equal(jobIdFromTrace('tr-tr-x'), 'tr-x')
  })
})

describe('T7-c 结构化日志：序列化失败必须降级而不是抛', () => {
  const base = {
    level: 'info' as const,
    event: 'completed' as const,
    traceId: 'tr-job-1',
    jobId: 'job-1',
  }

  it('正常条目序列化成单行 JSON，且带 logger 标识', () => {
    const line = formatLifecycleLog({ ...base, ts: 1000, durationMs: 42 })
    assert.ok(!line.includes('\n'), '必须是单行 —— 多行会破坏 JSONL 逐行解析')
    const parsed = JSON.parse(line) as Record<string, unknown>
    assert.equal(parsed.logger, 'lite-ai')
    assert.equal(parsed.event, 'completed')
    assert.equal(parsed.durationMs, 42)
  })

  it('循环引用不会让整条日志崩掉（降级为保留定位字段的兜底行）', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const line = formatLifecycleLog({ ...base, ts: 1000, error: circular as never })
    const parsed = JSON.parse(line) as Record<string, unknown>
    // 关键：定位信息（traceId/jobId）必须还在 —— 否则这条日志在审计时是废的
    assert.equal(parsed.traceId, 'tr-job-1')
    assert.equal(parsed.jobId, 'job-1')
    assert.match(String(parsed.error), /serialization failed/)
  })

  it('logger 可关（LITE_AI_STRUCTURED_LOG=0 语义由调用方注入）', () => {
    const lines: string[] = []
    const log = createLifecycleLogger({ enabled: false, sink: l => lines.push(l) })
    log({ ...base, ts: 1000 })
    assert.equal(lines.length, 0)
  })

  it('logger 默认开启，逐条写 sink', () => {
    const lines: string[] = []
    const log = createLifecycleLogger({ sink: l => lines.push(l) })
    log({ ...base, ts: 1 })
    log({ ...base, event: 'failed', ts: 2 })
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]!).event, 'failed')
  })
})

// ---------------------------------------------------------------- 2. 存储契约

function ev(over: Partial<UsageEvent> & { userId: string }): UsageEvent {
  return {
    jobId: null,
    sessionId: null,
    traceId: null,
    model: 'mock',
    inputTokens: 0,
    outputTokens: 0,
    durationMs: null,
    status: 'completed',
    ...over,
  }
}

describe('T7-b UsageStore（内存实现）契约', () => {
  it('按 userId 隔离：只返回本人的记录', async () => {
    const store = createMemoryUsageStore()
    await store.record(ev({ userId: 'alice', jobId: 'j1' }))
    await store.record(ev({ userId: 'bob', jobId: 'j2' }))
    const rows = await store.list({ userId: 'alice' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.jobId, 'j1')
  })

  it('新 → 旧排序（审计习惯：先看最近发生的事）', async () => {
    const store = createMemoryUsageStore()
    await store.record(ev({ userId: 'a', jobId: 'old' }))
    await store.record(ev({ userId: 'a', jobId: 'new' }))
    const rows = await store.list({ userId: 'a' })
    assert.deepEqual(rows.map(r => r.jobId), ['new', 'old'])
  })

  it('jobId 过滤是在 userId 之上叠加的（传别人的 jobId 得空数组）', async () => {
    const store = createMemoryUsageStore()
    await store.record(ev({ userId: 'alice', jobId: 'alice-job' }))
    await store.record(ev({ userId: 'bob', jobId: 'bob-job' }))
    // alice 指定 bob 的 jobId：返回空，**不泄漏 "bob-job 存在"**
    const rows = await store.list({ userId: 'alice', jobId: 'bob-job' })
    assert.equal(rows.length, 0)
  })

  it('limit 夹取：非法回退默认、超限夹到上限（不报错）', () => {
    assert.equal(clampUsageLimit(undefined), USAGE_LIMIT_DEFAULT)
    assert.equal(clampUsageLimit(0), USAGE_LIMIT_DEFAULT)
    assert.equal(clampUsageLimit(-5), USAGE_LIMIT_DEFAULT)
    assert.equal(clampUsageLimit(Number.NaN), USAGE_LIMIT_DEFAULT)
    assert.equal(clampUsageLimit(10), 10)
    assert.equal(clampUsageLimit(USAGE_LIMIT_MAX + 1), USAGE_LIMIT_MAX)
    assert.equal(clampUsageLimit(9999), USAGE_LIMIT_MAX)
  })

  it('summarize 是全量口径 —— **不受 list 的 limit 影响**', async () => {
    const store = createMemoryUsageStore()
    for (let i = 0; i < 5; i += 1) {
      await store.record(ev({ userId: 'a', inputTokens: 10, outputTokens: 1, durationMs: 100 }))
    }
    const page = await store.list({ userId: 'a', limit: 2 })
    assert.equal(page.length, 2, '明细被分页限制到 2 条')
    const sum = await store.summarize('a')
    // 而汇总仍然是 5 条的全量口径 —— 这正是"唯一口径"的意义
    assert.equal(sum.total, 5)
    assert.equal(sum.inputTokens, 50)
    assert.equal(sum.avgDurationMs, 100)
  })

  it('summarize 只计 completed/failed，其余状态进 total 但不进两项计数', async () => {
    const store = createMemoryUsageStore()
    await store.record(ev({ userId: 'a', status: 'completed' }))
    await store.record(ev({ userId: 'a', status: 'failed' }))
    await store.record(ev({ userId: 'a', status: 'running' }))
    await store.record(ev({ userId: 'a', status: null }))
    const sum = await store.summarize('a')
    assert.equal(sum.total, 4)
    assert.equal(sum.completed, 1)
    assert.equal(sum.failed, 1)
  })

  it('无有效耗时样本时 avgDurationMs 为 null（不是 0）', async () => {
    const store = createMemoryUsageStore()
    await store.record(ev({ userId: 'a', durationMs: null }))
    const sum = await store.summarize('a')
    assert.equal(sum.avgDurationMs, null, 'null 与 0 语义不同：前者是"无样本"')
  })

  it('summarize 按用户隔离（别人的 token 不计入我的）', async () => {
    const store = createMemoryUsageStore()
    await store.record(ev({ userId: 'alice', inputTokens: 100 }))
    await store.record(ev({ userId: 'bob', inputTokens: 999 }))
    const sum = await store.summarize('alice')
    assert.equal(sum.total, 1)
    assert.equal(sum.inputTokens, 100)
  })

  it('record 返回带主键与时间的落库行', async () => {
    const store = createMemoryUsageStore()
    const rec = await store.record(ev({ userId: 'a', jobId: 'j' }), 1234)
    assert.equal(rec.id, 1)
    assert.equal(rec.createdAt, 1234)
    assert.equal(rec.jobId, 'j')
  })
})

// ---------------------------------------------------------------- 3. HTTP 端到端

const KEYS: ApiKeyEntry[] = [
  { key: 'key-alice', userId: 'alice' },
  { key: 'key-bob', userId: 'bob' },
]

async function startApp(usage?: ReturnType<typeof createMemoryUsageStore>) {
  const store = createMemoryJobStore()
  const app: ServerApp = createServerApp({
    store,
    usage,
    cwd: '/srv/workspace',
    auth: { keys: KEYS },
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

describe('T7 GET /usage：per-user 隔离与唯一口径', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>
  const usage = createMemoryUsageStore()

  before(async () => {
    // alice 3 条、bob 1 条。alice 的第 3 条耗时 null（验证 AVG 忽略 NULL）。
    await usage.record(ev({ userId: 'alice', jobId: 'a1', inputTokens: 10, durationMs: 200 }))
    await usage.record(ev({ userId: 'alice', jobId: 'a2', inputTokens: 20, durationMs: 400 }))
    await usage.record(ev({ userId: 'alice', jobId: 'a3', inputTokens: 30, durationMs: null, status: 'failed' }))
    await usage.record(ev({ userId: 'bob', jobId: 'b1', inputTokens: 999 }))
    ctx = await startApp(usage)
  })
  after(async () => {
    await ctx.close()
  })

  it('无凭证 → 401（用量同属数据面，不因"只是数字"而放行）', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage`)
    assert.equal(res.status, 401)
  })

  it('只返回本人的用量明细', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { events: Array<{ jobId: string }>; summary: { total: number } }
    assert.equal(body.events.length, 3)
    assert.deepEqual(
      body.events.map(e => e.jobId).sort(),
      ['a1', 'a2', 'a3'],
    )
    assert.equal(body.summary.total, 3)
  })

  it('查询串里的 userId 被忽略（不能靠 ?userId=bob 读别人账本）', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage?userId=bob`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    const body = (await res.json()) as { events: Array<{ jobId: string }>; summary: { total: number } }
    assert.equal(body.summary.total, 3, '仍应是 alice 自己的 3 条，不是 bob 的 1 条')
    assert.ok(body.events.every(e => e.jobId.startsWith('a')), '不得出现 b1')
  })

  it('汇总不受 limit 影响（唯一口径）', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage?limit=1`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    const body = (await res.json()) as {
      events: unknown[]
      summary: { total: number; inputTokens: number; avgDurationMs: number | null }
    }
    assert.equal(body.events.length, 1, '明细按 limit 截断')
    assert.equal(body.summary.total, 3, '汇总仍是全量 3 条')
    assert.equal(body.summary.inputTokens, 60)
    assert.equal(body.summary.avgDurationMs, 300, '(200+400)/2 —— 忽略 null 那条')
  })

  it('jobId 过滤可回溯到单次调查', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage?jobId=a2`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    const body = (await res.json()) as { events: Array<{ jobId: string }> }
    assert.equal(body.events.length, 1)
    assert.equal(body.events[0]!.jobId, 'a2')
  })

  it('别人的 jobId → 空数组（与"该 job 不存在"不可区分）', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage?jobId=b1`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { events: unknown[] }
    assert.equal(body.events.length, 0)
  })

  it('非法 limit 回退默认值而不是 400（列表接口不因脏参数而拒绝服务）', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage?limit=abc`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { events: unknown[] }
    assert.equal(body.events.length, 3)
  })

  it('POST /usage → 405（用量账本只读，没有写入端点）', async () => {
    const res = await fetch(`${ctx.baseUrl}/usage`, {
      method: 'POST',
      headers: { authorization: 'Bearer key-alice' },
      body: '{}',
    })
    assert.equal(res.status, 405)
  })

  it('未接线 usage 时 → 404（不是 200 空数组，避免"看起来合规"）', async () => {
    const bare = await startApp(undefined)
    try {
      const res = await fetch(`${bare.baseUrl}/usage`, {
        headers: { authorization: 'Bearer key-alice' },
      })
      assert.equal(res.status, 404)
    } finally {
      await bare.close()
    }
  })
})
