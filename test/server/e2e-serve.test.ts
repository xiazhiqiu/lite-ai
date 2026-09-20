/**
 * T9-a 端到端冒烟 —— **真 HTTP + 真 Worker + 真 SSE**。
 *
 * ## 为什么还要再来一个 e2e（前面已有 `usage-e2e.test.ts`）
 *
 * `usage-e2e.test.ts` 验的是"**账本**能不能读到刚跑完的 job"，它只走
 * `GET /jobs/:id` **轮询**路径。而值班台真正给运维看的是 **SSE 实时流**
 * （`InvestigationStream`）——那条路一个用例都没走过：事件格式（`id/event/data`）、
 * 收流时机（终态且无新事件）、断线续传（`Last-Event-ID` / `?after=`）、
 * 响应头（`X-Accel-Buffering`）**全都没有机器验证**。
 *
 * 这正是 T9 存在的理由：**证明"服务端形态真的能跑通"，而不是"每个零件各自单测通过"**。
 * 单测各测一侧，两侧之间的传输契约没人守 —— T10 已经为此栽过一次
 * （`GET /jobs` 列表路由压根没实现，三个页面在生产齐刷刷 404）。
 *
 * ## 测什么
 *
 * 1. **闭环**：`POST /chat` → 202 + jobId → SSE 逐条收到 `tool_start` /
 *    `tool_result` / `assistant_message(final)` → job 落 `completed` → **服务端主动收流**。
 * 2. **响应头**：`Content-Type: text/event-stream` + `X-Accel-Buffering: no`
 *    （plan T9 部署注记：反代缓冲会让事件攒着不下发，这是纯单测查不出来的运维陷阱）。
 * 3. **断线续传**：`?after=<seq>` 只补发该 seq **之后**的事件（前端刷新页面靠它续上）。
 * 4. **轮询增量**：`?after=` 与 SSE 同源，seq 严格递增且无空洞（空洞会让前端永远等下去）。
 * 5. **越权订阅 404**：别人不能订阅我的调查过程（事件流里有工具调用细节与结论）。
 *
 * ## 不测什么
 *
 * 不碰真实 LLM：`turnRunner` 注入假的（真实调查逻辑由 T5 保证是同一份 `runAgentTurn`）。
 * 本文件只证明**传输与编排**成立，不证明模型会说话。
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
import type { ApiKeyEntry } from '../../src/server/auth.js'
import { createServerApp, type ServerApp } from '../../src/server/http.js'

const KEYS: ApiKeyEntry[] = [
  { key: 'key-alice', userId: 'alice' },
  { key: 'key-bob', userId: 'bob' },
]

/** 不落盘的会话存储（本冒烟不关心会话持久化，只关心事件流）。 */
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

type SseFrame = { id?: string; event?: string; data?: string }

/**
 * 收一条 SSE 流直到**服务端主动收流**（或超时）。
 *
 * 为什么必须能"自己结束"：终态且无新事件时服务端 `res.end()`。若它不收流，
 * 前端就会永久挂着一个连接 —— 这个行为只有真连一次才能证明，单测看不到。
 */
async function collectSse(
  url: string,
  key: string,
  timeoutMs = 8000,
): Promise<{ frames: SseFrame[]; headers: Headers; finished: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const frames: SseFrame[] = []
  let finished = false
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    assert.equal(res.status, 200, 'SSE 订阅必须 200')
    const headers = res.headers
    const reader = res.body?.getReader()
    assert.ok(reader !== undefined, 'SSE 响应必须有 body')
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          finished = true
          break
        }
        buf += decoder.decode(value, { stream: true })
        // SSE 以空行分帧；心跳是 `: ping` 注释行，按行首 `:` 跳过
        let idx = buf.indexOf('\n\n')
        while (idx !== -1) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const frame: SseFrame = {}
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue
            const colon = line.indexOf(':')
            if (colon === -1) continue
            const field = line.slice(0, colon)
            const val = line.slice(colon + 1).trim()
            if (field === 'id') frame.id = val
            else if (field === 'event') frame.event = val
            else if (field === 'data') frame.data = val
          }
          if (frame.event !== undefined) frames.push(frame)
          idx = buf.indexOf('\n\n')
        }
      }
    } catch (error) {
      // AbortController 超时：不再抛，交给断言去检查"为什么没收到终态"
      if (!(error instanceof Error && error.name === 'AbortError')) throw error
    }
    return { frames, headers, finished }
  } finally {
    clearTimeout(timer)
  }
}

/** 起一套完整服务：真 HTTP + 真 worker + 真 exec（turnRunner 是假的，不调模型）。 */
async function startFullStack(deps: { usage?: UsageStore }): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const store = createMemoryJobStore()

  const exec = createJobExecutor({
    jobStore: store,
    usage: deps.usage,
    sessionStore: nullSessionStore,
    cwd: '/srv/workspace',
    model: { name: 'e2e-model' } as unknown as Parameters<typeof createJobExecutor>[0]['model'],
    modelName: 'e2e-model',
    // 事件 flush 窗口压到最小：冒烟不想等 50ms 的批处理窗口
    flushMs: 5,
    turnRunner: async args => {
      // 一条工具调用 + 一条工具结果：值班台的"调查过程"就是这两条撑起来的
      args.onToolStart?.('tool-1', 'tail_logs', { service: 'order-api', lines: 200 })
      await sleep(5)
      args.onToolResult?.('tool-1', 'tail_logs', 'WARN upstream timeout\nERROR 5xx', false)
      args.onToolStart?.('tool-2', 'query_metrics', { metric: 'http_5xx_rate' })
      await sleep(5)
      args.onToolResult?.('tool-2', 'query_metrics', '5xx 从 0.2% 涨到 7.1%', false)
      args.onAssistantMessage?.('上游超时导致 5xx 激增', { final: true })
      return [
        ...args.messages,
        { role: 'assistant', content: '上游超时导致 5xx 激增' },
      ] as ChatMessage[]
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
    assignee: 'e2e-worker',
    // 注入私有池：避免与别的用例共享进程级全局池（见 `pool.ts` 的单例说明）
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
    close: async (): Promise<void> => {
      worker.stop()
      await worker.drained()
      app.server.closeAllConnections?.()
      await new Promise<void>(resolve => app.server.close(() => resolve()))
    },
  }
}

async function submit(baseUrl: string, key: string, message: string): Promise<string> {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ message }),
  })
  assert.equal(res.status, 202, '入队必须立刻 202（执行是 Worker 的事）')
  const body = (await res.json()) as { jobId: string }
  assert.ok(typeof body.jobId === 'string' && body.jobId.length > 0)
  return body.jobId
}

async function getJob(baseUrl: string, key: string, jobId: string, qs = ''): Promise<{
  job: { id: string; status: string; assignee: string | null }
  events: Array<{ seq: number; kind: string; payload: Record<string, unknown> }>
}> {
  const res = await fetch(
    `${baseUrl}/jobs/${encodeURIComponent(jobId)}${qs}`,
    { headers: { authorization: `Bearer ${key}` } },
  )
  assert.equal(res.status, 200)
  return (await res.json()) as never
}

describe('T9 端到端冒烟：POST /chat → Worker → SSE → 终态', () => {
  let ctx: Awaited<ReturnType<typeof startFullStack>>

  before(async () => {
    ctx = await startFullStack({ usage: createMemoryUsageStore() })
  })
  after(async () => {
    await ctx.close()
  })

  it('SSE 逐条收到工具事件与结论，终态后服务端主动收流', async () => {
    const jobId = await submit(ctx.baseUrl, 'key-alice', '订单服务 5xx 激增')

    const { frames, headers, finished } = await collectSse(
      `${ctx.baseUrl}/jobs/${encodeURIComponent(jobId)}/stream`,
      'key-alice',
    )

    // ① 终态后必须收流 —— 不收流前端就会永久挂一个连接
    assert.equal(finished, true, 'SSE 必须在 job 终态后主动结束（否则前端连接永不释放）')

    // ② 响应头：这是运维侧唯一能防"反代把事件攒住"的手段（plan T9 部署注记）
    assert.match(headers.get('content-type') ?? '', /text\/event-stream/)
    assert.equal(headers.get('x-accel-buffering'), 'no', '必须显式关掉 nginx 缓冲')
    assert.match(headers.get('cache-control') ?? '', /no-transform/)

    // ③ 事件序列：两次工具调用 + 两次结果 + 一条最终结论
    const kinds = frames.map(f => f.event)
    assert.equal(
      kinds.filter(k => k === 'tool_start').length,
      2,
      `tool_start 应有 2 条，实得 ${JSON.stringify(kinds)}`,
    )
    assert.equal(kinds.filter(k => k === 'tool_result').length, 2)
    const finals = frames.filter(f => f.event === 'assistant_message')
    assert.equal(finals.length, 1)
    const payload = JSON.parse(String(finals[0]?.data)) as { content: string; final: boolean }
    assert.equal(payload.final, true, '最终结论必须带 final=true（前端据此展开 Markdown）')
    assert.match(payload.content, /5xx/)

    // ④ id 字段就是 seq，供前端断线续传
    const ids = frames.map(f => Number(f.id))
    for (const id of ids) assert.ok(Number.isInteger(id) && id > 0, `SSE id 非法: ${String(id)}`)
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'SSE 事件必须按 seq 递增下发')

    // ⑤ 终态落 completed
    const snap = await getJob(ctx.baseUrl, 'key-alice', jobId)
    assert.equal(snap.job.status, 'completed')
  })

  it('轮询增量：?after=<seq> 只补发之后的事件，seq 连续无空洞', async () => {
    const jobId = await submit(ctx.baseUrl, 'key-alice', '再查一次 5xx')
    await waitFor(async () => (await getJob(ctx.baseUrl, 'key-alice', jobId)).job.status === 'completed')

    const full = await getJob(ctx.baseUrl, 'key-alice', jobId)
    const seqs = full.events.map(e => e.seq)
    assert.ok(seqs.length >= 5, `事件数不足: ${seqs.length}`)
    // seq 必须从 1 起连续 —— 空洞会让前端"永远等不到那个 seq"
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `seq 有空洞或错位: ${JSON.stringify(seqs)}`)

    const last = seqs[seqs.length - 1]!
    const tail = await getJob(ctx.baseUrl, 'key-alice', jobId, `?after=${last}`)
    assert.equal(tail.events.length, 0, '?after=最后一个 seq 应无增量')

    const mid = await getJob(ctx.baseUrl, 'key-alice', jobId, `?after=${seqs[0]}`)
    assert.equal(mid.events.length, seqs.length - 1, '增量条数应等于剩余事件数')
    assert.equal(mid.events[0]?.seq, seqs[1], '增量必须从下一个 seq 开始')
  })

  it('SSE 断线续传：?after=<seq> 只补发该 seq 之后的事件', async () => {
    const jobId = await submit(ctx.baseUrl, 'key-alice', '断线续传演练')
    // 先等它跑完，这样"从头订阅"与"从中间续订"可以严格对比
    await waitFor(async () => (await getJob(ctx.baseUrl, 'key-alice', jobId)).job.status === 'completed')

    const full = await getJob(ctx.baseUrl, 'key-alice', jobId)
    const seqs = full.events.map(e => e.seq)
    const cut = seqs[1]!

    const resumed = await collectSse(
      `${ctx.baseUrl}/jobs/${encodeURIComponent(jobId)}/stream?after=${cut}`,
      'key-alice',
    )
    const resumedIds = resumed.frames.map(f => Number(f.id))
    assert.ok(resumedIds.length > 0, '续订必须还能拿到后续事件')
    assert.ok(
      resumedIds.every(id => id > cut),
      `续订不应回发已收过的事件: ${JSON.stringify(resumedIds)} (cut=${cut})`,
    )
    assert.equal(
      resumed.frames.filter(f => f.event === 'assistant_message').length,
      1,
      '续订也必须能看到最终结论（否则刷新页面就看不到结论了）',
    )
  })

  it('越权订阅他人 job 的 SSE → 404（不泄漏调查过程）', async () => {
    const jobId = await submit(ctx.baseUrl, 'key-alice', '这是我的调查')
    const res = await fetch(`${ctx.baseUrl}/jobs/${encodeURIComponent(jobId)}/stream`, {
      headers: { authorization: 'Bearer key-bob' },
    })
    // 404 而非 403：403 等于承认"这个 job 存在"，可用于枚举他人 jobId
    assert.equal(res.status, 404)
    await res.text()
  })
})
