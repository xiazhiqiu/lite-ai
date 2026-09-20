/**
 * T7 端到端冒烟 —— **真监听回环端口、真 fetch、真 Worker 消费、真执行器记账**。
 *
 * ## 为什么单测不够，非要再来一个 e2e
 *
 * T10 的教训（`test/server/routes-auth.test.ts` 的注释里记着）：单测各测一侧 ——
 * 前端纯函数测前端、后端路由测后端 —— 而**两侧之间的调用契约没有任何东西守护**。
 * 当时正是 e2e 冒烟才发现 `GET /jobs` 列表路由压根没实现，3 个页面在生产会全 404。
 *
 * T7 有同类风险：`/usage` 的**读**路径（HTTP 层）与**写**路径（exec 记账）分别测过，
 * 但"**worker 真跑一轮之后，`/usage` 真能读到那条记录**"这件事没有任何单测能证明 ——
 * 它跨了 5 层：HTTP 入队 → store → worker claim → exec 执行 → usage.record → HTTP 读。
 * 这正是本文件存在的唯一理由。
 *
 * ## 测什么
 *
 * 1. **闭环**：POST /chat → 等 job 终态 → GET /usage 能读到**同一 jobId** 的那条记录，
 *    且 traceId 能反解回 jobId（审计链路真的串起来了，不是各写各的）。
 * 2. **失败也入账**：执行抛错的 job 在账本里是 failed 而不是"消失"。
 * 3. **隔离在传输层成立**：alice 的账本里看不到 bob 的记录（不是只在 store 层成立）。
 * 4. **唯一口径**：`?limit=1` 时明细 1 条、汇总仍是全量。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'

import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import { BoundedPool } from '../../src/jobs/pool.js'
import { createJobExecutor } from '../../src/jobs/exec.js'
import { createWorker } from '../../src/jobs/worker.js'
import { createMemoryUsageStore, type UsageStore } from '../../src/usage/index.js'
import type { SessionStore } from '../../src/session/store.js'
import type { ChatMessage } from '../../src/types.js'
import type { Job } from '../../src/jobs/types.js'
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp, type ServerApp } from '../../src/server/http.js'
import { jobIdFromTrace } from '../../src/server/trace.js'

const KEYS: ApiKeyEntry[] = [
  { key: 'key-alice', userId: 'alice' },
  { key: 'key-bob', userId: 'bob' },
]

/** 不落盘的会话存储（本冒烟不关心会话，只关心账本）。 */
const nullSessionStore = {
  async load(): Promise<ChatMessage[] | null> {
    return null
  },
  async save(): Promise<void> {},
} as unknown as SessionStore

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 15,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await sleep(stepMs)
  }
  throw new Error('waitFor 超时：条件始终未成立')
}

/**
 * 起一套完整的服务：真 HTTP + 真 worker + 真 exec（但 turnRunner 是假的 —— 不调模型）。
 *
 * `failOn` 里的关键词会让那一轮 turn 抛错，用于测失败路径入账。
 */
async function startFullStack(deps: {
  usage: UsageStore
  failOn?: string
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const store = createMemoryJobStore()

  const exec = createJobExecutor({
    jobStore: store,
    usage: deps.usage,
    sessionStore: nullSessionStore,
    cwd: '/srv/workspace',
    model: { name: 'smoke-model' } as unknown as Parameters<
      typeof createJobExecutor
    >[0]['model'],
    modelName: 'smoke-model',
    turnRunner: async args => {
      const last = args.messages[args.messages.length - 1]
      const text = typeof last?.content === 'string' ? last.content : ''
      if (deps.failOn !== undefined && text.includes(deps.failOn)) {
        throw new Error(`冒烟：命中失败关键词 ${deps.failOn}`)
      }
      args.onAssistantMessage?.('冒烟结论', { final: true })
      return [...args.messages, { role: 'assistant', content: '冒烟结论' }] as ChatMessage[]
    },
  })

  const app: ServerApp = createServerApp({
    store,
    usage: deps.usage,
    cwd: '/srv/workspace',
    auth: { keys: KEYS },
  })

  const worker = createWorker({
    store,
    assignee: 'smoke-worker',
    pool: new BoundedPool(2, () => {}),
    execute: exec,
    pollMs: 25,
    log: () => {}, // 静音人类可读日志，保持冒烟输出干净
    structuredLog: () => {},
  })
  worker.start()

  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = app.server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      worker.stop()
      await worker.drained()
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

async function submit(
  baseUrl: string,
  key: string,
  message: string,
): Promise<{ jobId: string; sessionId: string }> {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ message }),
  })
  assert.equal(res.status, 202, '入队必须立刻 202')
  return (await res.json()) as { jobId: string; sessionId: string }
}

async function getJobStatus(baseUrl: string, key: string, jobId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
    headers: { authorization: `Bearer ${key}` },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { job: { status: string } }
  return body.job.status
}

async function getUsage(
  baseUrl: string,
  key: string,
  qs = '',
): Promise<{
  events: Array<{
    id: number
    jobId: string | null
    traceId: string | null
    model: string | null
    status: string | null
    durationMs: number | null
  }>
  summary: {
    total: number
    completed: number
    failed: number
    avgDurationMs: number | null
  }
}> {
  const res = await fetch(`${baseUrl}/usage${qs}`, {
    headers: { authorization: `Bearer ${key}` },
  })
  assert.equal(res.status, 200)
  return (await res.json()) as never
}

describe('T7 端到端冒烟：入队 → 执行 → 记账 → 读账本', () => {
  let ctx: Awaited<ReturnType<typeof startFullStack>>
  const usage = createMemoryUsageStore()

  before(async () => {
    ctx = await startFullStack({ usage, failOn: '炸' })
  })
  after(async () => {
    await ctx.close()
  })

  it('成功一轮：/usage 能读到同一 jobId 的记录，traceId 可反解', async () => {
    const { jobId } = await submit(ctx.baseUrl, 'key-alice', '订单服务 5xx 激增')

    await waitFor(async () => (await getJobStatus(ctx.baseUrl, 'key-alice', jobId)) === 'completed')

    // 记账在 exec 里、job 终态在 worker 里，两者之间有微小的时序差 —— 轮询等它落账
    await waitFor(async () => {
      const snap = await getUsage(ctx.baseUrl, 'key-alice')
      return snap.events.some(e => e.jobId === jobId)
    })

    const snap = await getUsage(ctx.baseUrl, 'key-alice')
    const row = snap.events.find(e => e.jobId === jobId)
    assert.ok(row !== undefined, '账本里必须有这次调查的记录')
    assert.equal(row.status, 'completed')
    assert.equal(row.model, 'smoke-model')
    assert.equal(typeof row.durationMs, 'number')
    assert.ok(row.durationMs !== null && row.durationMs >= 0)

    // 最关键的一条：审计链路真的串起来了
    assert.equal(jobIdFromTrace(String(row.traceId)), jobId)

    // 汇总也应包含这一条（全量口径）
    assert.ok(snap.summary.total >= 1)
    assert.ok(snap.summary.completed >= 1)
  })

  it('失败一轮：同样入账，状态为 failed（失败调查不会在审计里消失）', async () => {
    const { jobId } = await submit(ctx.baseUrl, 'key-bob', '让它炸掉')

    await waitFor(async () => (await getJobStatus(ctx.baseUrl, 'key-bob', jobId)) === 'failed')

    await waitFor(async () => {
      const snap = await getUsage(ctx.baseUrl, 'key-bob')
      return snap.events.some(e => e.jobId === jobId)
    })

    const snap = await getUsage(ctx.baseUrl, 'key-bob')
    const row = snap.events.find(e => e.jobId === jobId)
    assert.ok(row !== undefined)
    assert.equal(row.status, 'failed')
    assert.equal(snap.summary.failed, 1)
  })

  it('传输层隔离：alice 的账本里没有任何 bob 的 jobId', async () => {
    const aliceUsage = await getUsage(ctx.baseUrl, 'key-alice')
    const bobUsage = await getUsage(ctx.baseUrl, 'key-bob')

    const bobJobIds = new Set(bobUsage.events.map(e => e.jobId))
    assert.ok(bobJobIds.size > 0, '前置条件：bob 确实有记录')
    for (const e of aliceUsage.events) {
      assert.ok(!bobJobIds.has(e.jobId), `alice 账本里混入了 bob 的 ${String(e.jobId)}`)
    }
  })

  it('唯一口径：?limit=1 截断明细，但汇总仍是全量', async () => {
    const full = await getUsage(ctx.baseUrl, 'key-alice')
    const limited = await getUsage(ctx.baseUrl, 'key-alice', '?limit=1')

    assert.equal(limited.events.length, 1, '明细被 limit 截断')
    assert.equal(
      limited.summary.total,
      full.summary.total,
      '汇总绝不能随 limit 变化（否则审计数字有两个口径）',
    )
    assert.equal(limited.summary.completed, full.summary.completed)
  })

  it('按 jobId 回溯单次调查（审计的核心用法）', async () => {
    const { jobId } = await submit(ctx.baseUrl, 'key-alice', '再查一次')
    await waitFor(async () => (await getJobStatus(ctx.baseUrl, 'key-alice', jobId)) === 'completed')
    await waitFor(async () => {
      const snap = await getUsage(ctx.baseUrl, 'key-alice', `?jobId=${encodeURIComponent(jobId)}`)
      return snap.events.length > 0
    })

    const snap = await getUsage(
      ctx.baseUrl,
      'key-alice',
      `?jobId=${encodeURIComponent(jobId)}`,
    )
    assert.equal(snap.events.length, 1, '一次调查对应一条账')
    assert.equal(jobIdFromTrace(String(snap.events[0]!.traceId)), jobId)
  })
})

describe('T7 端到端冒烟：未接线 usage 时 /usage 明确 404', () => {
  it('不传 usage → 404（不是 200 空数组，避免"看起来合规"）', async () => {
    const store = createMemoryJobStore()
    const app = createServerApp({
      store,
      cwd: '/srv/workspace',
      auth: { keys: KEYS },
    })
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject)
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = app.server.address() as AddressInfo
    try {
      const res = await fetch(`http://127.0.0.1:${port}/usage`, {
        headers: { authorization: 'Bearer key-alice' },
      })
      assert.equal(res.status, 404)
      // 但 /jobs 仍然照常工作 —— 缺账本不该影响队列功能
      const jobs = await fetch(`http://127.0.0.1:${port}/jobs`, {
        headers: { authorization: 'Bearer key-alice' },
      })
      assert.equal(jobs.status, 200)
    } finally {
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    }
  })
})
