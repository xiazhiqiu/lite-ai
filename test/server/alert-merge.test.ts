/**
 * G7 端到端：`POST /webhook` 由 `--serve` 吸收，告警诊断入**同一个 jobs 队列**。
 *
 * ## 为什么必须有这个文件
 *
 * 合并之前，告警诊断是在**摄入管道自己的并发池里直接跑**的
 * （`pipeline.ts` 的 `pool.enqueue(() => this.diagnose(...))`）。那条路的问题是：
 * 告警诊断**根本不是一个 job** —— 没有 jobId、没有事件流、没有终态、崩溃无法重派。
 * 值班台因此**看不到告警诊断的过程**，运维只能等通知里那一段结论文本。
 *
 * 单测各测一侧，两侧之间的"告警 → 队列 → Worker → 事件"这条链没人守。
 * 本文件用真 HTTP + 真 Worker + 真实 `IngestPipeline` 把它钉死：
 *
 * 1. **闭环**：告警 → 202 → 落成 `kind='alert'` 的 job → Worker 消费 →
 *    工具事件与结论逐条进 `job_events` → 终态 `completed`。
 *    这是"告警诊断第一次拥有可见的调查过程"的机器证明。
 * 2. **归属**：告警 job 落在**投递方身份**下（`userId`），per-user 隔离照常生效 ——
 *    否则值班台按 userId 过滤时会把告警 job 隔在外面，运维看不到自己系统的告警。
 * 3. **鉴权统一**：`/webhook` 只认 serve 的 API key（不再单独认 `webhook.secret`）。
 *
 * ## 不测什么
 *
 * 不碰真实 LLM：`alertDiagnoser` 注入替身。本文件只证明**传输与编排**成立。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'

import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import type { JobStore } from '../../src/jobs/store.js'
import { BoundedPool } from '../../src/jobs/pool.js'
import { createJobExecutor } from '../../src/jobs/exec.js'
import { createWorker } from '../../src/jobs/worker.js'
import { IngestPipeline } from '../../src/ingest/pipeline.js'
import { alertSessionId } from '../../src/webhook/types.js'
import type { SessionStore } from '../../src/session/store.js'
import type { ChatMessage } from '../../src/types.js'
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp, type ServerApp } from '../../src/server/http.js'

const KEYS: ApiKeyEntry[] = [
  { key: 'key-alice', userId: 'alice' },
  { key: 'key-bob', userId: 'bob' },
]

const CWD = '/srv/workspace'

/** Alertmanager 标准投递体（与 `test/webhook.test.ts` 同款，确认可被 adapter 识别）。 */
function alertmanagerPayload(alerts: Array<Record<string, unknown>>): unknown {
  return { status: 'firing', alerts }
}

function firingAlert(name: string, service: string): Record<string, unknown> {
  return {
    status: 'firing',
    labels: { alertname: name, severity: 'critical', service },
    annotations: { summary: `${service} ${name}` },
    startsAt: '2026-09-22T00:00:00Z',
    endsAt: '0001-01-01T00:00:00Z',
  }
}

const nullSessionStore = {
  async load(): Promise<ChatMessage[] | null> {
    return null
  },
  async save(): Promise<void> {},
} as unknown as SessionStore

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终未成立')
    await sleep(10)
  }
}

/** 起一套完整服务：真 HTTP + 真 Worker + 真实摄入管道（告警诊断器是替身）。 */
async function startStack(opts: { withAlerts: boolean }): Promise<{
  baseUrl: string
  store: JobStore
  close: () => Promise<void>
}> {
  const store = createMemoryJobStore()

  // 真实的摄入管道：去重 / 关联这些零 LLM 规则是真的，只有末端 RCA 换成入队。
  const pipeline = new IngestPipeline(
    CWD,
    {
      port: 8787,
      host: '127.0.0.1',
      autoDiagnose: true,
      maxConcurrentDiagnoses: 2,
      notifyHeaders: {},
    },
    {
      // 注入私有池：不注入会取进程级全局单例，与其他用例互相干扰
      pool: new BoundedPool(2, () => {}),
      enqueueDiagnosis: (alert, incident, ctx) => {
        void store.create({
          userId: ctx?.userId ?? 'alertmanager',
          cwd: CWD,
          kind: 'alert',
          incidentId: incident?.incidentId ?? null,
          sessionId: incident ? incident.incidentId : alertSessionId(alert),
          payload: { alert, incident: incident ?? null },
        })
      },
    },
  )

  const exec = createJobExecutor({
    jobStore: store,
    sessionStore: nullSessionStore,
    cwd: CWD,
    model: { name: 'e2e-model' } as never,
    modelName: 'e2e-model',
    flushMs: 5,
    // 告警诊断替身：只关心"过程被逐条落库 + 终态正确"，不真烧 token
    alertDiagnoser: async ({ incident, deps }) => {
      deps?.onToolStart?.('tool-1', 'tail_logs', { service: 'payment' })
      deps?.onToolResult?.('tool-1', 'tail_logs', 'ERROR upstream timeout', false)
      deps?.onAssistantMessage?.('根因：上游超时导致 5xx 激增', { final: true })
      return {
        sessionId: incident?.incidentId ?? 'alert-session',
        diagnosisSummary: '根因：上游超时导致 5xx 激增',
      }
    },
  })

  const app: ServerApp = createServerApp({
    store,
    cwd: CWD,
    auth: { keys: KEYS },
    ...(opts.withAlerts
      ? { alertIngest: (alerts, ctx) => pipeline.ingest(alerts, ctx) }
      : {}),
  })

  const worker = createWorker({
    store,
    assignee: 'g7-worker',
    pool: new BoundedPool(2, () => {}),
    execute: exec,
    pollMs: 20,
    log: () => {},
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
    store,
    close: async (): Promise<void> => {
      worker.stop()
      await worker.drained()
      pipeline.close()
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

async function postWebhook(
  baseUrl: string,
  key: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== null) headers.authorization = `Bearer ${key}`
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

describe('G7 告警摄入并入 --serve：同一队列、可见过程、统一鉴权', () => {
  let ctx: Awaited<ReturnType<typeof startStack>>

  before(async () => {
    ctx = await startStack({ withAlerts: true })
  })
  after(async () => {
    await ctx.close()
  })

  it('告警 → 入 alert job → Worker 消费 → 事件逐条可见 → completed', async () => {
    // 同 service 的两条告警会被关联成一个 incident（事件级诊断，主路径）
    const { status, json } = await postWebhook(
      ctx.baseUrl,
      'key-alice',
      alertmanagerPayload([
        firingAlert('HighMemoryUsage', 'payment'),
        firingAlert('LatencySpike', 'payment'),
      ]),
    )
    assert.equal(status, 202, '告警摄入必须立刻 202（诊断是 Worker 的事）')
    assert.ok(
      (json.accepted as number) >= 1,
      `至少应有 1 个诊断单元被接受，实得 ${JSON.stringify(json)}`,
    )

    // ① 必须真的落成一个 kind='alert' 的 job —— 这是 G7 的核心
    // （`ListJobsFilter` 没有 kind 维度，故取出后显式过滤）
    const job = await waitFor(async () => {
      const all = await ctx.store.list({})
      const alertJobs = all.filter(j => j.kind === 'alert')
      return alertJobs.length > 0 ? alertJobs[0]! : null
    })
    assert.equal(job.kind, 'alert', '告警必须落成 kind=alert 的 job（否则它没有 jobId/事件/重派）')
    assert.ok(job.sessionId !== null && job.sessionId.length > 0, 'sessionId 必须非空（供人工续接）')

    // ② Worker 认领并跑完：终态 completed
    const done = await waitFor(async () => {
      const fresh = await ctx.store.get(job.id)
      return fresh !== null && fresh.status === 'completed' ? fresh : null
    })
    assert.equal(done.status, 'completed')

    // ③ 诊断过程逐条落库 —— 告警诊断第一次可见（值班台 SSE 的数据源）
    const events = await ctx.store.listEvents(job.id)
    const kinds = events.map(e => e.kind)
    assert.ok(kinds.includes('tool_start'), `应有 tool_start，实得 ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes('tool_result'), `应有 tool_result，实得 ${JSON.stringify(kinds)}`)
    assert.ok(
      kinds.includes('assistant_message'),
      `应有 assistant_message，实得 ${JSON.stringify(kinds)}`,
    )
    const conclusion = events.find(e => e.kind === 'assistant_message')
    assert.equal(
      (conclusion?.payload as { final?: boolean }).final,
      true,
      '结论必须带 final=true（前端据此展开 Markdown）',
    )
    // 诊断结果事件：把 sessionId 交给前端，用于"跳到这次调查"
    const diag = events.find(e => e.kind === 'diagnosis')
    assert.ok(diag !== undefined, '应有一条 diagnosis 事件（携带 sessionId 与摘要）')
  })

  it('告警 job 落在投递方身份下（per-user 隔离不因机器投递而失效）', async () => {
    const { status } = await postWebhook(
      ctx.baseUrl,
      'key-bob',
      alertmanagerPayload([firingAlert('DiskPressure', 'billing')]),
    )
    assert.equal(status, 202)

    const job = await waitFor(async () => {
      const jobs = await ctx.store.list({ userId: 'bob' })
      const alertJobs = jobs.filter(j => j.kind === 'alert')
      return alertJobs.length > 0 ? alertJobs[0]! : null
    })
    assert.equal(job.userId, 'bob', '告警 job 必须归属投递告警的凭证身份')

    // alice 的列表里不该出现 bob 的告警 job
    const aliceJobs = await ctx.store.list({ userId: 'alice' })
    assert.ok(
      aliceJobs.every(j => j.userId === 'alice'),
      'per-user 隔离：列表里不应出现他人 job',
    )
  })

  it('鉴权统一：/webhook 未带 API key → 401（不再单独认 webhook.secret）', async () => {
    const { status } = await postWebhook(
      ctx.baseUrl,
      null,
      alertmanagerPayload([firingAlert('AnyAlert', 'svc')]),
    )
    assert.equal(status, 401, '数据面一律先验身份，告警入口不例外')
  })

  it('非 POST → 405', async () => {
    const res = await fetch(`${ctx.baseUrl}/webhook`, {
      headers: { authorization: 'Bearer key-alice' },
    })
    assert.equal(res.status, 405)
    await res.text()
  })
})

describe('G7 未启用告警形态时 /webhook 明确 404', () => {
  let ctx: Awaited<ReturnType<typeof startStack>>

  before(async () => {
    ctx = await startStack({ withAlerts: false })
  })
  after(async () => {
    await ctx.close()
  })

  it('未接线 alertIngest → 404（不是 200 空响应）', async () => {
    const { status } = await postWebhook(
      ctx.baseUrl,
      'key-alice',
      alertmanagerPayload([firingAlert('AnyAlert', 'svc')]),
    )
    // 404 而非"接受但什么也不做"：让"告警没接线"暴露出来，而不是静默吞掉告警
    assert.equal(status, 404)
  })
})
