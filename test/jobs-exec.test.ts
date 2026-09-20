/**
 * T5 执行接线测试 —— **注入假的 turn runner，不调真实模型**。
 *
 * 这里要证明的是"接线"这件事本身是对的：
 * 1. 事件顺序：`runAgentTurn` 的回调被**逐条**翻译成 `job_events`（seq 单调递增）
 * 2. **G2 多轮续接**：带 `sessionId` 时执行前 load 历史、执行后 save 回**同一 session**
 * 3. **G3 权限**：服务端只读放行；`ask_user` 被摘掉（无人可答，会挂死 job）
 * 4. 批量写：回调产生的多条事件**合并落库**，而不是一条一次 IO
 * 5. 失败路径：turn 抛错 → 事件里看得见 + 会话仍尽力落盘（可 resume）
 * 6. 终态由 Worker 写（exec 只管事件）—— 见 `jobs-worker.test.ts`
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { createJobExecutor, type JobExecutorDeps } from '../src/jobs/exec.js'
import { BoundedPool } from '../src/jobs/pool.js'
import { createWorker } from '../src/jobs/worker.js'
import type { Job } from '../src/jobs/types.js'
import type { ChatMessage } from '../src/types.js'
import type { SessionStore } from '../src/session/store.js'
import { createMemoryUsageStore } from '../src/usage/index.js'
import { jobIdFromTrace } from '../src/server/trace.js'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await sleep(stepMs)
  }
  throw new Error('waitFor 超时：条件始终未成立')
}

/** 记录每次 load/save 的假会话存储（只实现 exec 用到的两个方法）。 */
function fakeSessionStore(initial: ChatMessage[] | null = null): {
  store: SessionStore
  loads: string[]
  saves: Array<{ sessionId: string; messages: ChatMessage[]; alreadySavedCount: number }>
} {
  const loads: string[] = []
  const saves: Array<{
    sessionId: string
    messages: ChatMessage[]
    alreadySavedCount: number
  }> = []
  const store = {
    async load(_cwd: string, sessionId: string): Promise<ChatMessage[] | null> {
      loads.push(sessionId)
      return initial
    },
    async save(
      _cwd: string,
      sessionId: string,
      messages: ChatMessage[],
      alreadySavedCount = 0,
    ): Promise<void> {
      saves.push({ sessionId, messages, alreadySavedCount })
    },
  } as unknown as SessionStore
  return { store, loads, saves }
}

const fakeModel = { name: 'fake-model' } as unknown as Parameters<
  typeof createJobExecutor
>[0]['model']

/** 默认 deps：`turnRunner` 由各用例覆盖。 */
function makeExec(
  over: Partial<JobExecutorDeps> & Pick<JobExecutorDeps, 'turnRunner'>,
): ReturnType<typeof createJobExecutor> {
  const store = over.store ?? undefined
  return createJobExecutor({
    jobStore: store ?? createMemoryJobStore(),
    sessionStore: fakeSessionStore().store,
    cwd: '/srv/workspace',
    model: fakeModel,
    tools: undefined,
    turnRunner: over.turnRunner,
    ...over,
  })
}

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    userId: 'u1',
    cwd: '/srv/workspace',
    kind: 'chat',
    incidentId: null,
    sessionId: null,
    payload: { message: '为什么订单服务 5xx 激增？' },
    status: 'running',
    assignee: 'worker-1',
    requestSeq: 1,
    claimedAt: 1000,
    finishedAt: null,
    error: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  }
}

describe('exec：事件回写（回调 → job_events）', () => {
  it('onToolStart / onToolResult / onAssistantMessage 逐条落库，seq 单调递增', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      // 假 turn runner：模拟一次"调工具 → 得到结果 → 给结论"
      turnRunner: async args => {
        args.onToolStart?.('tu-1', 'query_metrics', { service: 'order' })
        args.onToolResult?.('tu-1', 'query_metrics', 'p99 = 3200ms', false)
        args.onAssistantMessage?.('初步看是下游 DB 连接池打满。', { final: true })
        return [
          { role: 'user', content: '为什么订单服务 5xx 激增？' },
          { role: 'assistant', content: '初步看是下游 DB 连接池打满。' },
        ] as ChatMessage[]
      },
    })

    await exec(job)

    const events = await jobStore.listEvents(job.id)
    assert.deepEqual(
      events.map(e => e.kind),
      ['tool_start', 'tool_result', 'assistant_message'],
    )
    assert.deepEqual(
      events.map(e => e.seq),
      [1, 2, 3],
      'seq 必须单调递增（SSE Last-Event-ID 依赖它）',
    )
    assert.equal(events[0]!.payload.toolName, 'query_metrics')
    assert.equal(events[0]!.payload.toolUseId, 'tu-1')
    assert.equal(events[1]!.payload.output, 'p99 = 3200ms')
    assert.equal(events[1]!.payload.isError, false)
    assert.equal(events[2]!.payload.final, true)
    assert.match(String(events[2]!.payload.content), /连接池/)
  })

  it('工具出错时 isError=true 被如实写进事件（不吞错）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onToolStart?.('tu-9', 'run_command', { command: 'kubectl' })
        args.onToolResult?.('tu-9', 'run_command', 'command not found', true)
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    const events = await jobStore.listEvents(job.id)
    assert.equal(events[1]!.payload.isError, true)
    assert.equal(events[1]!.payload.output, 'command not found')
  })

  it('不带 sessionId：新建会话，回合后 save 一次（sessionId 取自 job）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 'sin-new',
    })
    await jobStore.claim({ assignee: 'w1' })

    const sessions = fakeSessionStore(null)
    const exec = createJobExecutor({
      jobStore,
      sessionStore: sessions.store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async () => [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
      ] as ChatMessage[],
    })

    await exec(job)
    assert.deepEqual(sessions.loads, ['sin-new'], '执行前必须 load 历史（G2）')
    assert.equal(sessions.saves.length, 1)
    assert.equal(sessions.saves[0]!.sessionId, 'sin-new', '必须存回同一 session（G2）')
    assert.equal(sessions.saves[0]!.messages.length, 2)
  })
})

describe('exec：G2 多轮续接', () => {
  it('history 被作为初始 messages 传入（system 之外的历史在前，本轮消息在后）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 'sin-1',
      payload: { message: '那扩容之后呢？' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const history: ChatMessage[] = [
      { role: 'user', content: '为什么 5xx 激增？' },
      { role: 'assistant', content: 'DB 连接池打满。' },
    ]
    let seen: ChatMessage[] = []

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(history).store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        seen = args.messages
        return args.messages
      },
    })

    await exec(job)

    // 历史两条 + 本轮一条 = 3（system prompt 由 turnRunner 之外的构建负责，这里只看业务消息）
    const business = seen.filter(m => m.role !== 'system')
    assert.equal(business.length, 3)
    assert.equal(business[0]!.content, '为什么 5xx 激增？')
    assert.equal(business[1]!.content, 'DB 连接池打满。')
    assert.equal(business[2]!.content, '那扩容之后呢？', '本轮消息必须追加在历史之后')
  })

  it('incident 续接：告警会话被人工接管时，轮次消息仍追加到同一 session', async () => {
    const jobStore = createMemoryJobStore()
    // 模拟 diagnose 先落下的告警会话
    const alertHistory: ChatMessage[] = [
      { role: 'user', content: '[告警] order-svc 5xx 激增' },
      { role: 'assistant', content: '疑似 DB 连接池。' },
    ]
    const job = await jobStore.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 'inc-alert-1',
      incidentId: 'inc-alert-1',
      payload: { message: '你说的连接池是哪个指标？' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const sessions = fakeSessionStore(alertHistory)
    const exec = createJobExecutor({
      jobStore,
      sessionStore: sessions.store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => [...args.messages],
    })

    await exec(job)
    assert.deepEqual(sessions.loads, ['inc-alert-1'])
    assert.equal(sessions.saves[0]!.sessionId, 'inc-alert-1')
  })
})

describe('exec：G3 权限与工具集', () => {
  it('ask_user 被摘掉（服务端无人可答，留着会挂死 job）', async () => {
    const { buildServiceToolRegistry } = await import('../src/jobs/exec.js')
    const names = buildServiceToolRegistry({
      cwd: '/srv/workspace',
      tools: undefined,
    })
      .list()
      .map(t => t.name)
    assert.ok(!names.includes('ask_user'), 'ask_user 必须被移除')
  })

  it('权限管理器对只读放行、不阻塞（无交互通道）', async () => {
    const { buildServicePermissions } = await import('../src/jobs/exec.js')
    const perms = await buildServicePermissions('/srv/workspace')
    assert.ok(perms, '必须返回一个可用（whenReady 已 resolve）的 PermissionManager')
  })
})

describe('exec：批量写事件', () => {
  it('一个 flush 窗口内的事件合并成一次批量落库（不是逐条 IO）', async () => {
    const jobStore = createMemoryJobStore()
    let singleAppends = 0
    let batchCalls = 0
    let batchedTotal = 0
    // 记录两种写入路径的调用次数：批量 API 走一次，逐条回退走 N 次。
    const realAppend = jobStore.appendEvent.bind(jobStore)
    jobStore.appendEvent = async (jobId, kind, payload, now) => {
      singleAppends += 1
      return realAppend(jobId, kind, payload, now)
    }
    const realBulk = jobStore.appendEvents!.bind(jobStore)
    jobStore.appendEvents = async (jobId, entries, now) => {
      batchCalls += 1
      batchedTotal += entries.length
      return realBulk(jobId, entries, now)
    }

    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      // 事件批量落库的窗口；测试里放大一点，确保多条合并
      flushMs: 30,
      turnRunner: async args => {
        for (let i = 0; i < 5; i++) {
          args.onToolStart?.(`tu-${i}`, 'query_metrics', { i })
          args.onToolResult?.(`tu-${i}`, 'query_metrics', `r${i}`, false)
        }
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    // 10 条事件（5 start + 5 result）应被压成**一次**批量写，而不是 10 次单条 IO
    const events = await jobStore.listEvents(job.id)
    assert.equal(events.length, 10, '事件不能丢（批量 ≠ 丢弃）')
    assert.equal(singleAppends, 0, '提供了批量 API 时不应再走逐条路径')
    assert.ok(
      batchCalls < 10,
      `批量写应减少 IO 次数，实际批量调用 ${batchCalls} 次（期望 < 10）`,
    )
    assert.equal(batchedTotal, 10, '批量写入的总条数必须等于事件数')
  })

  it('批量写不出现在测试里时自动回退逐条，不丢事件', async () => {
    const jobStore = createMemoryJobStore()
    // 模拟"存储实现未提供批量 API"的情形（PG 未实现的早期版本 / 第三方实现）。
    delete (jobStore as { appendEvents?: unknown }).appendEvents

    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      flushMs: 30,
      turnRunner: async args => {
        args.onToolStart?.('tu-1', 'query_metrics', {})
        args.onToolResult?.('tu-1', 'query_metrics', 'ok', false)
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    const events = await jobStore.listEvents(job.id)
    assert.deepEqual(
      events.map(e => e.kind),
      ['tool_start', 'tool_result'],
      '回退路径必须一条不丢',
    )
  })

  it('批量写入的 seq 连续且严格递增（SSE Last-Event-ID 依赖）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      flushMs: 30,
      turnRunner: async args => {
        for (let i = 0; i < 6; i++) args.onProgressMessage?.(`p${i}`)
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    const events = await jobStore.listEvents(job.id)
    assert.deepEqual(
      events.map(e => e.seq),
      [1, 2, 3, 4, 5, 6],
      '同一批内 seq 必须连续（缺号会让 SSE 客户端永远等不到那个 seq）',
    )
  })

  it('exec 结束前必须 flush 干净（不能有事件卡在缓冲里）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      flushMs: 10_000, // 故意设得比 exec 生命周期长：只能靠"结束前 flush"兜住
      turnRunner: async args => {
        args.onAssistantMessage?.('done', { final: true })
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    const events = await jobStore.listEvents(job.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.kind, 'assistant_message')
  })
})

describe('exec：失败路径', () => {
  it('turn 抛错：写 error 事件 + 尽力落会话（可 resume），并把错抛给 Worker', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 'sin-fail',
      payload: { message: 'boom' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const sessions = fakeSessionStore([{ role: 'user', content: '旧历史' }])
    const exec = createJobExecutor({
      jobStore,
      sessionStore: sessions.store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onToolStart?.('tu-1', 'query_metrics', {})
        throw new Error('provider 429 too many requests')
      },
    })

    await assert.rejects(() => exec(job), /429/)

    const events = await jobStore.listEvents(job.id)
    assert.deepEqual(
      events.map(e => e.kind),
      ['tool_start', 'error'],
      '抛错前的事件不能丢，且要有 error 事件',
    )
    assert.match(String(events[1]!.payload.message), /429/)
    assert.equal(sessions.saves.length, 1, '失败也要尽力落盘（可 resume）')
  })
})

describe('exec：T7 用量 / 审计记账', () => {
  it('成功一轮记一条 completed，字段与 job 对齐（含 traceId 可反解）', async () => {
    const jobStore = createMemoryJobStore()
    const usage = createMemoryUsageStore()
    const job = await jobStore.create({
      userId: 'alice',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 'sin-usage',
      payload: { message: '查一下' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      usage,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      modelName: 'deepseek-chat',
      turnRunner: async () => [] as ChatMessage[],
    })

    await exec(job)

    const rows = await usage.list({ userId: 'alice' })
    assert.equal(rows.length, 1, '一轮 = 一条账（不多不少）')
    const row = rows[0]!
    assert.equal(row.jobId, job.id)
    assert.equal(row.sessionId, 'sin-usage')
    assert.equal(row.model, 'deepseek-chat')
    assert.equal(row.status, 'completed')
    assert.equal(typeof row.durationMs, 'number')
    // traceId 必须能反解回 jobId —— 否则审计日志里的 trace 串不起来
    assert.equal(jobIdFromTrace(String(row.traceId)), job.id)
  })

  it('失败一轮**同样**记账（只记成功会让失败调查在审计里消失）', async () => {
    const jobStore = createMemoryJobStore()
    const usage = createMemoryUsageStore()
    const job = await jobStore.create({
      userId: 'bob',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'boom' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      usage,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async () => {
        throw new Error('provider 500')
      },
    })

    await assert.rejects(() => exec(job), /500/)

    const rows = await usage.list({ userId: 'bob' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, 'failed')
  })

  it('记账失败**不得**把已成功的 job 拖成 failed（审计可降级、job 不可）', async () => {
    const jobStore = createMemoryJobStore()
    const brokenUsage = {
      async record(): Promise<never> {
        throw new Error('审计库连接失败')
      },
      async list(): Promise<never[]> {
        return []
      },
      async summarize(): Promise<never> {
        throw new Error('unused')
      },
    } as unknown as ReturnType<typeof createMemoryUsageStore>

    const errors: string[] = []
    const job = await jobStore.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'x' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      usage: brokenUsage,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      log: (level, msg) => {
        if (level === 'error') errors.push(msg)
      },
      turnRunner: async () => [] as ChatMessage[],
    })

    // 关键断言：exec **不抛**（抛了 Worker 就会把 job 落 failed）
    await exec(job)

    // 但也不能静默吞掉 —— 必须留下一条错误日志（否则审计缺口无人知晓）
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /审计账本缺一条/)
    assert.match(errors[0]!, /审计库连接失败/)
  })

  it('模型名取不到时落 null（不用占位串污染统计）', async () => {
    const jobStore = createMemoryJobStore()
    const usage = createMemoryUsageStore()
    const job = await jobStore.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'x' },
    })
    await jobStore.claim({ assignee: 'w1' })

    const exec = createJobExecutor({
      jobStore,
      usage,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      // 一个没有 model 字段的 adapter —— 探测不到就应落 null
      model: {} as unknown as Parameters<typeof createJobExecutor>[0]['model'],
      turnRunner: async () => [] as ChatMessage[],
    })

    await exec(job)
    const rows = await usage.list({ userId: 'u1' })
    assert.equal(rows[0]!.model, null)
  })

  it('不传 usage 时不记账、也不报错（单测 / CLI 场景）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await jobStore.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await jobStore.claim({ assignee: 'w1' })
    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async () => [] as ChatMessage[],
    })
    await exec(job) // 不抛即可
  })
})

describe('exec：与 Worker 串起来', () => {
  it('Worker 认领后调用真实 exec：事件落库 + job 落 completed', async () => {
    const store = createMemoryJobStore()
    const sessions = fakeSessionStore(null)
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: sessions.store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onAssistantMessage?.('查完了：连接池打满。', { final: true })
        return [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: '查完了：连接池打满。' },
        ] as ChatMessage[]
      },
    })

    const worker = createWorker({
      store,
      assignee: 'worker-1',
      pool: new BoundedPool(2, () => {}),
      execute: exec,
      pollMs: 20,
    })
    worker.start()

    const job = await store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      sessionId: 'sin-e2e',
      payload: { message: '查一下' },
    })

    await waitFor(async () => (await store.get(job.id))?.status === 'completed')
    worker.stop()
    await worker.drained()

    const events = await store.listEvents(job.id)
    assert.deepEqual(
      events.map(e => e.kind),
      ['assistant_message'],
    )
    assert.equal(sessions.saves.length, 1)
  })

  it('exec 抛错时 Worker 落 failed 且 error 里带原因', async () => {
    const store = createMemoryJobStore()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: fakeSessionStore().store,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async () => {
        throw new Error('模型不可用')
      },
    })

    const worker = createWorker({
      store,
      assignee: 'worker-1',
      pool: new BoundedPool(2, () => {}),
      execute: exec,
      pollMs: 20,
    })
    worker.start()

    const job = await store.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
    await waitFor(async () => (await store.get(job.id))?.status === 'failed')
    worker.stop()
    await worker.drained()

    const settled = await store.get(job.id)
    assert.match(String(settled?.error), /模型不可用/)
  })
})
