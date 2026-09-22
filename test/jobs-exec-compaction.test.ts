/**
 * 【T55】上下文压缩可见性测试 —— 压缩必须**落成 job 事件**，值班台才看得见。
 *
 * 背景：`agent-loop.ts` 早就提供 `onAutoCompact / onSnipCompact / onContextCollapse`
 * 三个回调，TTY 形态（`tty-app.ts`）一直在用；**服务端 `exec.ts` 一条都没接** ——
 * 于是同一个 agent 在值班台里压缩过程是完全黑箱（只能看到 token 数在动）。
 *
 * 这里钉死四件事：
 *
 * 1. 三个回调都翻译成 `context_compacted` 事件（含 level / 条数 / token 数字）；
 * 2. **没真发生就不报**（snip 的 didSnip=false、collapse 的 collapsed=false）——
 *    压缩器的"检查"每轮都跑，把"没剪"也报出来会把事件流刷成噪音；
 * 3. 数字直接取压缩器给的值，**本层不重算**（纪律同 T-obs 的 usage）；
 * 4. 多次压缩按发生顺序落库（事件流的时间线不能乱）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { createJobExecutor } from '../src/jobs/exec.js'
import type { Job } from '../src/jobs/types.js'
import type { ChatMessage, CompressionResult } from '../src/types.js'
import type { SnipCompactResult } from '../src/compact/snipCompact.js'
import type { ContextCollapseResult } from '../src/compact/context-collapse.js'
import type { SessionStore } from '../src/session/store.js'

const fakeModel = { name: 'fake-model' } as unknown as Parameters<
  typeof createJobExecutor
>[0]['model']

const emptySessionStore = {
  async load(): Promise<ChatMessage[] | null> {
    return null
  },
  async save(): Promise<void> {},
} as unknown as SessionStore

async function runningJob(): Promise<{ job: Job; store: ReturnType<typeof createMemoryJobStore> }> {
  const store = createMemoryJobStore()
  const job = await store.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat' })
  await store.claim({ assignee: 'w1' })
  return { job, store }
}

/** 取该 job 的 `context_compacted` 事件载荷（按落库顺序）。 */
async function compactionEvents(
  store: ReturnType<typeof createMemoryJobStore>,
  jobId: string,
): Promise<Array<Record<string, unknown>>> {
  const events = await store.listEvents(jobId, 0)
  return events
    .filter(e => e.kind === 'context_compacted')
    .map(e => e.payload as Record<string, unknown>)
}

function snipResult(overrides: Partial<SnipCompactResult> = {}): SnipCompactResult {
  return {
    messages: [],
    didSnip: true,
    tokensBefore: 1000,
    tokensAfter: 600,
    tokensFreed: 400,
    removedMessageIds: ['m1', 'm2'],
    ...overrides,
  }
}

function collapseResult(overrides: Partial<ContextCollapseResult> = {}): ContextCollapseResult {
  return {
    messages: [],
    state: { spans: [], enabled: true, consecutiveFailures: 0 },
    collapsed: true,
    spans: [
      {
        id: 'sp1',
        startMessageId: 'm1',
        endMessageId: 'm5',
        messageIds: ['m1', 'm2', 'm3'],
        summary: '...',
        tokensBefore: 2000,
        tokensAfter: 800,
        status: 'committed',
        createdAt: 1,
        reason: 'context_pressure',
      },
    ],
    ...overrides,
  } as ContextCollapseResult
}

function autoCompactResult(): CompressionResult {
  return {
    messages: [],
    summary: { role: 'context_summary', content: 'summary' },
    removedCount: 7,
    tokensBefore: 5000,
    tokensAfter: 1500,
  } as unknown as CompressionResult
}

describe('exec：上下文压缩可见性（T55）', () => {
  it('snip：落一条 context_compacted，数字直取压缩器', async () => {
    const { job, store } = await runningJob()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onSnipCompact?.(snipResult())
        return [] as ChatMessage[]
      },
    })

    await exec(job)

    const rows = await compactionEvents(store, job.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.level, 'snip')
    assert.equal(rows[0]!.removedCount, 2, '2 条被摘（removedMessageIds.length）')
    assert.equal(rows[0]!.tokensFreed, 400)
    assert.equal(rows[0]!.tokensBefore, 1000)
    assert.equal(rows[0]!.tokensAfter, 600)
  })

  it('snip 未真剪（didSnip=false）→ 不产事件（避免每轮刷噪音）', async () => {
    const { job, store } = await runningJob()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onSnipCompact?.(snipResult({ didSnip: false, removedMessageIds: [], tokensFreed: 0 }))
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    assert.equal((await compactionEvents(store, job.id)).length, 0)
  })

  it('collapse：折叠发生时落一条，取本次生效 span 的数字', async () => {
    const { job, store } = await runningJob()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onContextCollapse?.(collapseResult())
        return [] as ChatMessage[]
      },
    })

    await exec(job)

    const rows = await compactionEvents(store, job.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.level, 'collapse')
    assert.equal(rows[0]!.removedCount, 3, '3 条被折叠（span.messageIds.length）')
    assert.equal(rows[0]!.tokensBefore, 2000)
    assert.equal(rows[0]!.tokensAfter, 800)
    assert.equal(rows[0]!.reason, 'context_pressure')
  })

  it('collapse 未折叠（collapsed=false）→ 不产事件', async () => {
    const { job, store } = await runningJob()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onContextCollapse?.(collapseResult({ collapsed: false, spans: [] }))
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    assert.equal((await compactionEvents(store, job.id)).length, 0)
  })

  it('autoCompact：落一条 compact 事件（含 removedCount 与 token 前后）', async () => {
    const { job, store } = await runningJob()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onAutoCompact?.(autoCompactResult())
        return [] as ChatMessage[]
      },
    })

    await exec(job)

    const rows = await compactionEvents(store, job.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.level, 'compact')
    assert.equal(rows[0]!.removedCount, 7)
    assert.equal(rows[0]!.tokensBefore, 5000)
    assert.equal(rows[0]!.tokensAfter, 1500)
  })

  it('多次压缩按发生顺序落库（时间线不乱）', async () => {
    const { job, store } = await runningJob()
    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      turnRunner: async args => {
        args.onSnipCompact?.(snipResult())
        args.onContextCollapse?.(collapseResult())
        args.onAutoCompact?.(autoCompactResult())
        return [] as ChatMessage[]
      },
    })

    await exec(job)

    const rows = await compactionEvents(store, job.id)
    assert.deepEqual(
      rows.map(r => r.level),
      ['snip', 'collapse', 'compact'],
      'L1 → L2 → L3 按发生顺序',
    )
  })
})
