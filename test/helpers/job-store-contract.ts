/**
 * JobStore 契约断言集（T2，plan G6）。
 *
 * **为什么单独一个文件**：契约需要被两个测试文件复用——
 * - `jobs-claim.test.ts`        → 用内存实现跑（无 PG 也必须真跑，不 skip）
 * - `jobs-claim-pg.test.ts`     → 用 PG 实现跑（无 PG 时整组 skip）
 *
 * 若把断言集写在 `jobs-claim.test.ts` 里再 import，会**触发其顶层 describe 执行**
 * （ESM import 即执行），导致内存契约在 PG 文件里被重复跑一遍。
 * 因此把纯函数形式的 `runJobStoreContract` 单独放这里，两个测试文件各自调用。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { JobStore } from '../../src/jobs/store.js'
import type { NewJob } from '../../src/jobs/types.js'

export const baseJob = (overrides: Partial<NewJob> = {}): NewJob => ({
  userId: 'user-a',
  cwd: '/srv/workspace',
  kind: 'chat',
  ...overrides,
})

/**
 * 契约断言集：任何 JobStore 实现都必须通过。
 * @param name        suite 名（'memory' / 'pg'）
 * @param makeStore   工厂：返回一个**干净**的 store（每个用例前调用一次）
 */
export function runJobStoreContract(name: string, makeStore: () => JobStore): void {
  describe(`JobStore contract (${name})`, () => {
    let store: JobStore

    beforeEach(async () => {
      store = makeStore()
      // 实现若提供 reset（PG 清表用），先跑一遍
      const maybeReset = (store as unknown as { reset?: () => Promise<void> }).reset
      if (typeof maybeReset === 'function') await maybeReset()
    })

    it('create persists a pending job with generated id and seq 0', async () => {
      const job = await store.create(baseJob(), 1000)
      assert.ok(job.id.length > 0)
      assert.equal(job.status, 'pending')
      assert.equal(job.userId, 'user-a')
      assert.equal(job.cwd, '/srv/workspace')
      assert.equal(job.kind, 'chat')
      assert.equal(job.assignee, null)
      assert.equal(job.claimedAt, null)
      assert.equal(job.requestSeq, 0)
      assert.equal(job.createdAt, 1000)
    })

    it('create assigns distinct ids to distinct jobs', async () => {
      const a = await store.create(baseJob(), 1000)
      const b = await store.create(baseJob(), 1000)
      assert.notEqual(a.id, b.id)
    })

    it('claim marks the job running and records assignee', async () => {
      const created = await store.create(baseJob(), 1000)
      const claimed = await store.claim({ assignee: 'w1' }, 2000)

      assert.equal(claimed.length, 1)
      assert.equal(claimed[0]!.id, created.id)
      assert.equal(claimed[0]!.status, 'running')
      assert.equal(claimed[0]!.assignee, 'w1')
      // 乐观并发守卫：认领即递增
      assert.equal(claimed[0]!.requestSeq, 1)
    })

    it('claim returns [] when there is nothing pending', async () => {
      assert.deepEqual(await store.claim({ assignee: 'w1' }, 2000), [])
    })

    it('claim is first-come-first-served by createdAt', async () => {
      const older = await store.create(baseJob({ payload: { tag: 'older' } }), 1000)
      await store.create(baseJob({ payload: { tag: 'newer' } }), 1500)

      const claimed = await store.claim({ assignee: 'w1', limit: 1 }, 2000)
      assert.equal(claimed.length, 1)
      assert.equal(claimed[0]!.id, older.id)
    })

    it('respects the claim limit', async () => {
      await store.create(baseJob(), 1000)
      await store.create(baseJob(), 1001)
      await store.create(baseJob(), 1002)

      assert.equal((await store.claim({ assignee: 'w1', limit: 2 }, 2000)).length, 2)
      assert.equal((await store.claim({ assignee: 'w1', limit: 5 }, 2001)).length, 1)
    })

    // ---- 本组断言的存在理由：并发下不得重复分配 ----
    it('concurrent claims never hand the same job to two workers', async () => {
      const TOTAL = 9
      for (let i = 0; i < TOTAL; i++) await store.create(baseJob(), 1000 + i)

      // 5 个 worker 同时抢，每个每次抢 3 条（共 15 次机会 > 9 条）
      const rounds = await Promise.all(
        Array.from({ length: 5 }, (_, w) =>
          store.claim({ assignee: `w${w}`, limit: 3 }, 3000),
        ),
      )

      const ids = rounds.flat().map(j => j.id)
      assert.equal(new Set(ids).size, ids.length, '同一 job 被分配给了多个 worker')
      assert.equal(ids.length, TOTAL, '9 条 pending 应被恰好分配完')

      // 再抢一次应该空（全部 running，无 pending）
      assert.deepEqual(await store.claim({ assignee: 'w9', limit: 5 }, 3001), [])
    })

    it('a running job is not claimable again', async () => {
      const job = await store.create(baseJob(), 1000)
      const first = await store.claim({ assignee: 'w1' }, 2000)
      assert.equal(first[0]!.id, job.id)

      assert.deepEqual(await store.claim({ assignee: 'w2' }, 2001), [])
    })

    it('after finish the job is no longer claimable', async () => {
      const job = await store.create(baseJob(), 1000)
      await store.claim({ assignee: 'w1' }, 2000)
      assert.equal(await store.finish(job.id, 'completed', { now: 3000 }), true)

      assert.deepEqual(await store.claim({ assignee: 'w2' }, 3001), [])
      assert.equal((await store.get(job.id))!.status, 'completed')
    })

    // ---- 故障转移：worker 崩溃后 job 可被重新 claim ----
    it('reassignStale returns a dead worker lease to pending', async () => {
      const job = await store.create(baseJob(), 1000)
      await store.claim({ assignee: 'dead-worker' }, 2000)

      // 租约 1000ms，已过 5000ms → 判定 stale
      const swept = await store.reassignStale(1000, 5000)
      assert.equal(swept.length, 1)
      assert.equal(swept[0]!.id, job.id)
      assert.equal(swept[0]!.status, 'pending')

      // 另一个实例可以重新认领
      const reclaimed = await store.claim({ assignee: 'w2' }, 5001)
      assert.equal(reclaimed.length, 1)
      assert.equal(reclaimed[0]!.id, job.id)
      assert.equal(reclaimed[0]!.assignee, 'w2')
      // 再次认领后计数继续递增
      assert.ok(reclaimed[0]!.requestSeq > swept[0]!.requestSeq)
    })

    it('reassignStale leaves fresh leases alone', async () => {
      await store.create(baseJob(), 1000)
      await store.claim({ assignee: 'busy-worker' }, 2000)

      // 租约 1000ms，只过了 100ms → 不动
      assert.deepEqual(await store.reassignStale(1000, 2100), [])
      assert.deepEqual(await store.claim({ assignee: 'w2' }, 2101), [])
    })

    it('reassignStale never resurrects terminal jobs', async () => {
      const done = await store.create(baseJob(), 1000)
      const failed = await store.create(baseJob(), 1001)
      await store.claim({ assignee: 'w1', limit: 2 }, 2000)
      await store.finish(done.id, 'completed', { now: 2100 })
      await store.finish(failed.id, 'failed', { error: 'boom', now: 2101 })

      assert.deepEqual(await store.reassignStale(100, 99999), [])
      assert.equal((await store.get(done.id))!.status, 'completed')
      assert.equal((await store.get(failed.id))!.status, 'failed')
    })

    it('finish records the error message for failures', async () => {
      const job = await store.create(baseJob(), 1000)
      await store.claim({ assignee: 'w1' }, 2000)
      await store.finish(job.id, 'failed', { error: 'provider timeout', now: 2500 })

      const after = await store.get(job.id)
      assert.equal(after!.status, 'failed')
      assert.equal(after!.error, 'provider timeout')
      assert.equal(after!.finishedAt, 2500)
    })

    it('finish refuses to move a pending job to a terminal state', async () => {
      const job = await store.create(baseJob(), 1000)
      // 未 claim（仍 pending）→ 不应允许直接落终态
      assert.equal(await store.finish(job.id, 'completed', { now: 2000 }), false)
      assert.equal((await store.get(job.id))!.status, 'pending')
    })

    it('finish returns false for an unknown job', async () => {
      assert.equal(await store.finish('no-such-job', 'completed'), false)
    })

    it('get returns null for an unknown job', async () => {
      assert.equal(await store.get('no-such-job'), null)
    })

    it('list filters by status and by user', async () => {
      await store.create(baseJob({ userId: 'user-a' }), 1000)
      const b = await store.create(baseJob({ userId: 'user-b' }), 1001)
      // 两条都要 running 才能 finish；否则 finish(pending) 按契约返回 false
      await store.claim({ assignee: 'w1', limit: 2 }, 2000)
      assert.equal(await store.finish(b.id, 'completed', { now: 2100 }), true)

      assert.equal((await store.list({ status: 'pending' })).length, 0)
      assert.equal((await store.list({ status: 'running' })).length, 1)
      assert.equal((await store.list({ status: 'completed' })).length, 1)
      assert.equal((await store.list({ userId: 'user-a' })).length, 1)
      assert.equal((await store.list({ userId: 'user-b' })).length, 1)
    })

    it('list filters by incidentId and sessionId', async () => {
      await store.create(baseJob({ incidentId: 'inc-1', sessionId: 'inc-1' }), 1000)
      await store.create(baseJob({ incidentId: 'inc-2', sessionId: 'inc-2' }), 1001)

      assert.equal((await store.list({ incidentId: 'inc-1' })).length, 1)
      assert.equal((await store.list({ sessionId: 'inc-2' })).length, 1)
      assert.equal((await store.list({ incidentId: 'inc-404' })).length, 0)
    })

    it('events are appended with strictly increasing seq starting at 1', async () => {
      const job = await store.create(baseJob(), 1000)
      const e1 = await store.appendEvent(job.id, 'tool_start', { tool: 'read_file' }, 1100)
      const e2 = await store.appendEvent(job.id, 'tool_result', { ok: true }, 1200)
      const e3 = await store.appendEvent(job.id, 'assistant', { text: 'done' }, 1300)

      assert.equal(e1.seq, 1)
      assert.equal(e2.seq, 2)
      assert.equal(e3.seq, 3)
      assert.equal(e3.kind, 'assistant')
    })

    it('listEvents returns only rows after the given seq', async () => {
      const job = await store.create(baseJob(), 1000)
      for (let i = 0; i < 5; i++) {
        await store.appendEvent(job.id, 'tick', { i }, 1100 + i)
      }

      assert.equal((await store.listEvents(job.id)).length, 5)
      const tail = await store.listEvents(job.id, 3)
      assert.equal(tail.length, 2)
      assert.deepEqual(tail.map(e => e.seq), [4, 5])
      // 事件内容完整往返（SSE 的 payload 靠它）
      assert.deepEqual(tail[0]!.payload, { i: 3 })
    })

    it('listEvents is scoped to its job', async () => {
      const a = await store.create(baseJob(), 1000)
      const b = await store.create(baseJob(), 1001)
      await store.appendEvent(a.id, 'x', {}, 1100)
      await store.appendEvent(b.id, 'y', {}, 1101)

      assert.equal((await store.listEvents(a.id)).length, 1)
      assert.equal((await store.listEvents(b.id))[0]!.kind, 'y')
    })

    // ---- 批量追加（T5）：一次 turn 里数百条工具事件靠它压掉逐条 IO ----
    it('appendEvents writes the whole batch with contiguous increasing seq', async () => {
      const job = await store.create(baseJob(), 1000)
      const batch = await store.appendEvents!(job.id, [
        { kind: 'tool_start', payload: { tool: 'a' } },
        { kind: 'tool_result', payload: { tool: 'a', ok: true } },
        { kind: 'assistant_message', payload: { content: 'done' } },
      ], 1100)

      assert.equal(batch.length, 3)
      assert.deepEqual(batch.map(e => e.seq), [1, 2, 3])
      assert.deepEqual(
        batch.map(e => e.kind),
        ['tool_start', 'tool_result', 'assistant_message'],
        '返回顺序必须与入参顺序一一对应（前端按序渲染）',
      )
      assert.equal(batch[0]!.jobId, job.id)
      assert.equal(batch[2]!.payload.content, 'done')
    })

    it('appendEvents continues from the existing max seq', async () => {
      const job = await store.create(baseJob(), 1000)
      await store.appendEvent(job.id, 'before', {}, 1050)
      const batch = await store.appendEvents!(job.id, [
        { kind: 'a', payload: {} },
        { kind: 'b', payload: {} },
      ], 1100)

      assert.deepEqual(batch.map(e => e.seq), [2, 3])
      // 读回来也必须是连续 1,2,3 —— 中间不能有洞
      assert.deepEqual(
        (await store.listEvents(job.id)).map(e => e.seq),
        [1, 2, 3],
      )
    })

    it('appendEvents with an empty batch is a no-op', async () => {
      const job = await store.create(baseJob(), 1000)
      assert.deepEqual(await store.appendEvents!(job.id, [], 1100), [])
      assert.equal((await store.listEvents(job.id)).length, 0)
    })

    it('appendEvents is scoped to its own job', async () => {
      const a = await store.create(baseJob(), 1000)
      const b = await store.create(baseJob(), 1001)
      await store.appendEvents!(a.id, [
        { kind: 'x', payload: {} },
        { kind: 'y', payload: {} },
      ], 1100)

      assert.equal((await store.listEvents(a.id)).length, 2)
      assert.equal((await store.listEvents(b.id)).length, 0)
    })
  })
}
