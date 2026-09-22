/**
 * T-obs 扇出测试 —— **注入假 sink，不起任何 OTel/Langfuse SDK**。
 *
 * 要证明的四件事：
 * 1. **双 sink 同时写**：一次回调既落 `job_events`（A 轨）又扇出 span（B 轨），
 *    两者**不是二选一**——这正是"单埋点双 sink"的字面含义。
 * 2. **扇出完整**：tool_start/result → tool span；onLlmCall → generation；
 *    assistant/progress → event；结束 → `end(status)`。
 * 3. **error-safe（纪律 2）**：sink 抛错时 **job 照常完成**、`job_events` 一条不少。
 *    这是"Langfuse 挂了不影响用户看见进度"的可执行证据。
 * 4. **门控**：sink 未启用 / 未传 sink → 根本不调 `startJobTrace`（零开销）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { createJobExecutor } from '../src/jobs/exec.js'
import type { Job } from '../src/jobs/types.js'
import type { ChatMessage } from '../src/types.js'
import type { SessionStore } from '../src/session/store.js'
import type {
  JobTrace,
  JobTraceEnd,
  JobTraceInfo,
  LlmCallEvent,
  TracingSink,
} from '../src/observability/tracing.js'

const fakeModel = { name: 'fake-model' } as unknown as { name: string }

function fakeSessionStore(): SessionStore {
  return {
    async load(): Promise<ChatMessage[] | null> {
      return null
    },
    async save(): Promise<void> {},
  } as unknown as SessionStore
}

type TraceCall = { method: string; args: unknown[] }

/** 记录所有扇出调用的假 sink。`throwIn` 让指定方法抛错，用于验证 error-safe。 */
function fakeTracing(opts: { enabled?: boolean; throwIn?: string } = {}): {
  sink: TracingSink
  infos: JobTraceInfo[]
  calls: TraceCall[]
  ends: Array<JobTraceEnd | undefined>
} {
  const infos: JobTraceInfo[] = []
  const calls: TraceCall[] = []
  const ends: Array<JobTraceEnd | undefined> = []

  const maybeThrow = (method: string): void => {
    if (opts.throwIn === method) throw new Error(`boom:${method}`)
  }

  const sink: TracingSink = {
    enabled: opts.enabled ?? true,
    reason: 'fake',
    startJobTrace(info: JobTraceInfo): JobTrace {
      maybeThrow('startJobTrace')
      infos.push(info)
      return {
        toolStart(toolUseId, toolName, input) {
          maybeThrow('toolStart')
          calls.push({ method: 'toolStart', args: [toolUseId, toolName, input] })
        },
        toolEnd(toolUseId, toolName, output, isError) {
          maybeThrow('toolEnd')
          calls.push({ method: 'toolEnd', args: [toolUseId, toolName, output, isError] })
        },
        generation(record: LlmCallEvent) {
          maybeThrow('generation')
          calls.push({ method: 'generation', args: [record] })
        },
        event(name, payload) {
          maybeThrow('event')
          calls.push({ method: 'event', args: [name, payload] })
        },
        end(result) {
          ends.push(result)
          maybeThrow('end')
        },
      }
    },
    async flush(): Promise<void> {},
    async shutdown(): Promise<void> {},
  }

  return { sink, infos, calls, ends }
}

async function makeJob(
  jobStore: ReturnType<typeof createMemoryJobStore>,
  over: Partial<Parameters<typeof jobStore.create>[0]> = {},
): Promise<Job> {
  const job = await jobStore.create({
    userId: 'u-alice',
    cwd: '/srv/workspace',
    kind: 'chat',
    ...over,
  })
  await jobStore.claim({ assignee: 'w1' })
  return job
}

describe('exec × tracing：单埋点双 sink', () => {
  it('chat 分支：工具/生成/事件全部扇出，且 job_events 一条不少（双写而非二选一）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore, { sessionId: 'sin-1' })
    const t = fakeTracing()

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      tracing: t.sink,
      turnRunner: async args => {
        args.onToolStart?.('tu-1', 'query_metrics', { service: 'order' })
        args.onToolResult?.('tu-1', 'query_metrics', 'p99 = 3200ms', false)
        args.onLlmCall?.({
          model: 'deepseek',
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          latencyMs: 880,
        })
        args.onAssistantMessage?.('初步看是下游 DB 连接池打满。', { final: true })
        args.onProgressMessage?.('正在交叉验证日志')
        return [{ role: 'assistant', content: '结论' }] as ChatMessage[]
      },
    })

    await exec(job)

    // A 轨：job_events 完整
    const events = await jobStore.listEvents(job.id)
    assert.deepEqual(events.map(e => e.kind), [
      'tool_start',
      'tool_result',
      'assistant_message',
      'progress',
    ])

    // B 轨：span 扇出
    assert.equal(t.infos.length, 1, '应开启恰好一条 job trace')
    const info = t.infos[0]!
    assert.equal(info.jobId, job.id)
    assert.equal(info.kind, 'chat')
    assert.equal(info.sessionId, 'sin-1')
    assert.equal(info.userId, 'u-alice')

    assert.deepEqual(
      t.calls.map(c => c.method),
      ['toolStart', 'toolEnd', 'generation', 'event', 'event'],
    )
    // generation 带上了真实用量（免解析 provider 原始字段）
    const gen = t.calls.find(c => c.method === 'generation')!.args[0] as LlmCallEvent
    assert.equal(gen.inputTokens, 120)
    assert.equal(gen.outputTokens, 30)
    assert.equal(gen.latencyMs, 880)

    // 收尾：成功 → status ok
    assert.deepEqual(t.ends, [{ status: 'ok' }])
  })

  it('chat 失败：trace 以 error 收尾，且原错照常抛出（不吞）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore)
    const t = fakeTracing()

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      tracing: t.sink,
      turnRunner: async () => {
        throw new Error('模型网关 502')
      },
    })

    await assert.rejects(() => exec(job), /模型网关 502/)
    assert.equal(t.ends.length, 1)
    assert.equal(t.ends[0]?.status, 'error')
    assert.match(String(t.ends[0]?.error), /502/)
  })

  it('alert 分支：诊断过程同样扇出（双 sink 覆盖两条链路）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore, {
      kind: 'alert',
      sessionId: 'inc-42',
      payload: { alert: { id: 'a1', title: 't', severity: 'critical', summary: 's' } },
    })
    const t = fakeTracing()

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      tracing: t.sink,
      alertDiagnoser: async ({ deps }) => {
        deps?.onToolStart?.('t1', 'query_logs', { q: 'error' })
        deps?.onToolResult?.('t1', 'query_logs', 'found 3', false)
        deps?.onLlmCall?.({ model: 'deepseek', inputTokens: 5 })
        deps?.onAssistantMessage?.('根因：连接池', { final: true })
        deps?.onProgressMessage?.('汇总证据')
        return { sessionId: 'inc-42', diagnosisSummary: '根因：连接池' }
      },
    })

    await exec(job)

    assert.equal(t.infos[0]?.kind, 'alert')
    assert.equal(t.infos[0]?.sessionId, 'inc-42')
    assert.deepEqual(
      t.calls.map(c => c.method),
      ['toolStart', 'toolEnd', 'generation', 'event', 'event'],
    )
    assert.deepEqual(t.ends, [{ status: 'ok', output: { sessionId: 'inc-42' } }])
  })
})

describe('exec × tracing：error-safe（纪律 2）', () => {
  it('sink 的 toolStart 抛错 → job 仍完成，job_events 一条不少', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore)
    const t = fakeTracing({ throwIn: 'toolStart' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      tracing: t.sink,
      turnRunner: async args => {
        args.onToolStart?.('tu-1', 'query_metrics', {})
        args.onToolResult?.('tu-1', 'query_metrics', 'ok', false)
        return [] as ChatMessage[]
      },
    })

    // 关键：观测炸了，调查不能炸
    await assert.doesNotReject(() => exec(job))

    const events = await jobStore.listEvents(job.id)
    assert.deepEqual(events.map(e => e.kind), ['tool_start', 'tool_result'])
  })

  it('sink 的 end 抛错 → job 仍完成', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore)
    const t = fakeTracing({ throwIn: 'end' })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      tracing: t.sink,
      turnRunner: async () => [] as ChatMessage[],
    })

    await assert.doesNotReject(() => exec(job))
  })
})

describe('exec × tracing：门控', () => {
  it('未传 sink → 正常跑，不触发任何 tracing', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore)

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onToolStart?.('tu-1', 'query_metrics', {})
        return [] as ChatMessage[]
      },
    })

    await assert.doesNotReject(() => exec(job))
    assert.deepEqual((await jobStore.listEvents(job.id)).map(e => e.kind), ['tool_start'])
  })

  it('sink.enabled=false → 连 startJobTrace 都不调（零开销）', async () => {
    const jobStore = createMemoryJobStore()
    const job = await makeJob(jobStore)
    const t = fakeTracing({ enabled: false })

    const exec = createJobExecutor({
      jobStore,
      sessionStore: fakeSessionStore(),
      cwd: '/srv/workspace',
      model: fakeModel,
      tracing: t.sink,
      turnRunner: async () => [] as ChatMessage[],
    })

    await exec(job)
    assert.equal(t.infos.length, 0)
    assert.equal(t.calls.length, 0)
  })
})
