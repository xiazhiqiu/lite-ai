/**
 * T4 Worker 测试 —— **内存 JobStore，不依赖 PG、不 skip**。
 *
 * 这里验证的是"异步队列到底解决了什么问题"：
 * 1. claim loop 把 pending 拉起来执行，并落终态
 * 2. 并发受**全局单例池**约束（plan G1）
 * 3. **故障转移**：worker 崩溃后 job 卡在 running，stale sweep 打回 pending，
 *    别的实例能重新认领并跑完 —— 这是选异步队列而非同步执行的全部理由
 * 4. 优雅关停：停 claim、等在途 job 跑完，不半途丢掉正在执行的 job
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { BoundedPool } from '../src/jobs/pool.js'
import { createWorker } from '../src/jobs/worker.js'
import type { Job } from '../src/jobs/types.js'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 轮询等待条件成立（避免写死的 sleep 造成 flaky）。 */
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

function makeWorker(
  over: Partial<Parameters<typeof createWorker>[0]> = {},
): ReturnType<typeof createWorker> {
  const store = over.store ?? createMemoryJobStore()
  return createWorker({
    store,
    assignee: 'worker-1',
    pool: new BoundedPool(2, () => {}),
    execute: async () => {},
    pollMs: 20,
    ...over,
  })
}

describe('Worker claim loop', () => {
  it('拉起 pending job，执行后落 completed', async () => {
    const store = createMemoryJobStore()
    const executed: string[] = []
    const worker = makeWorker({
      store,
      execute: async job => {
        executed.push(job.id)
      },
    })

    const job = await store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'hi' },
    })

    worker.start()
    await waitFor(async () => (await store.get(job.id))?.status === 'completed')
    worker.stop()
    await worker.drained()

    assert.deepEqual(executed, [job.id])
    const final = await store.get(job.id)
    assert.equal(final?.status, 'completed')
    assert.equal(final?.assignee, 'worker-1')
    assert.ok(final?.claimedAt !== null, '应记录 claim 时间')
    assert.ok(final?.finishedAt !== null, '应记录完成时间')
  })

  it('执行抛错时落 failed 并带上错误信息（不静默吞掉）', async () => {
    const store = createMemoryJobStore()
    const worker = makeWorker({
      store,
      execute: async () => {
        throw new Error('模型调用失败')
      },
    })

    const job = await store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: {},
    })

    worker.start()
    await waitFor(async () => (await store.get(job.id))?.status === 'failed')
    worker.stop()
    await worker.drained()

    const final = await store.get(job.id)
    assert.equal(final?.status, 'failed')
    assert.match(final?.error ?? '', /模型调用失败/)
  })

  it('多个 pending job 都会被消费（不遗漏）', async () => {
    const store = createMemoryJobStore()
    const seen = new Set<string>()
    const worker = makeWorker({
      store,
      pool: new BoundedPool(3, () => {}),
      execute: async job => {
        seen.add(job.id)
      },
    })

    const jobs: Job[] = []
    for (let i = 0; i < 6; i++) {
      jobs.push(
        await store.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat', payload: {} }),
      )
    }

    worker.start()
    await waitFor(async () => {
      const all = await store.list()
      return all.every(j => j.status === 'completed')
    })
    worker.stop()
    await worker.drained()

    assert.equal(seen.size, 6)
    for (const j of jobs) {
      assert.equal((await store.get(j.id))?.status, 'completed')
    }
  })

  it('并发受池上限约束：峰值在跑数不超过 limit', async () => {
    const store = createMemoryJobStore()
    let active = 0
    let peak = 0
    const worker = makeWorker({
      store,
      pool: new BoundedPool(2, () => {}),
      execute: async () => {
        active += 1
        peak = Math.max(peak, active)
        await sleep(40)
        active -= 1
      },
    })

    for (let i = 0; i < 8; i++) {
      await store.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat', payload: {} })
    }

    worker.start()
    await waitFor(async () => (await store.list({ status: 'completed' })).length === 8)
    worker.stop()
    await worker.drained()

    assert.ok(peak <= 2, `峰值并发应 ≤2，实际 ${peak}`)
    assert.equal(peak, 2, `应真的并行（峰值 2），实际 ${peak}`)
  })
})

describe('Worker 故障转移（stale sweep）', () => {
  it('【核心】worker 崩溃后遗留的 running job 能被重新认领并跑完', async () => {
    // ── 场景：worker-A 认领了 job 然后"崩溃"（既不落终态也不释放）──
    const store = createMemoryJobStore()
    const t0 = 1_000_000
    const job = await store.create(
      { userId: 'u1', cwd: '/srv/workspace', kind: 'chat', payload: {} },
      t0,
    )
    await store.claim({ assignee: 'worker-A', limit: 1 }, t0)
    assert.equal((await store.get(job.id))?.status, 'running', 'job 卡在 running')

    // ── worker-B 启动，带很短租期 → 立刻把 stale job 打回 pending 并执行 ──
    const executed: string[] = []
    const worker = createWorker({
      store,
      assignee: 'worker-B',
      pool: new BoundedPool(1, () => {}),
      execute: async j => {
        executed.push(j.id)
      },
      pollMs: 20,
      staleLeaseMs: 1000,
      staleSweepMs: 20,
      // 注入时钟：让"租期已过"成立（worker-A 的 claimedAt 停留在 t0）
      now: () => t0 + 60_000,
    })

    worker.start()
    await waitFor(async () => (await store.get(job.id))?.status === 'completed')
    worker.stop()
    await worker.drained()

    // ── 断言：job 最终跑完，且确实是被 worker-B 重新认领后执行的 ──
    assert.deepEqual(executed, [job.id], 'stale job 应被重新执行')
    const final = await store.get(job.id)
    assert.equal(final?.status, 'completed')
    assert.equal(final?.assignee, 'worker-B', '认领方应变为 worker-B')
  })

  it('stale sweep 不会碰已终态的 job（终态不可回退）', async () => {
    const store = createMemoryJobStore()
    const t0 = 2_000_000
    const job = await store.create(
      { userId: 'u1', cwd: '/srv/workspace', kind: 'chat', payload: {} },
      t0,
    )
    await store.claim({ assignee: 'worker-A', limit: 1 }, t0)
    await store.finish(job.id, 'completed', { now: t0 })

    // 直接调 reassignStale 验证语义（不必经由 worker 定时器）
    const reclaimed = await store.reassignStale(1000, t0 + 60_000)
    assert.equal(reclaimed.length, 0, 'completed 的 job 不该被回收')
    assert.equal((await store.get(job.id))?.status, 'completed')
  })

  it('未超租期的 running job 不会被误回收（仍在正常执行中）', async () => {
    const store = createMemoryJobStore()
    const t0 = 3_000_000
    const job = await store.create(
      { userId: 'u1', cwd: '/srv/workspace', kind: 'chat', payload: {} },
      t0,
    )
    await store.claim({ assignee: 'worker-A', limit: 1 }, t0)

    // 只过了 100ms，租期 60s → 不该回收
    const reclaimed = await store.reassignStale(60_000, t0 + 100)
    assert.equal(reclaimed.length, 0, '租期未到不该回收')
    assert.equal((await store.get(job.id))?.status, 'running')
  })
})

describe('Worker 优雅关停', () => {
  it('stop() 后不再 claim 新 job', async () => {
    const store = createMemoryJobStore()
    const executed: string[] = []
    const worker = makeWorker({
      store,
      execute: async job => {
        await sleep(30)
        executed.push(job.id)
      },
    })

    const first = await store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: {},
    })
    worker.start()
    await waitFor(() => executed.includes(first.id))

    worker.stop()
    await worker.drained()

    // stop 之后再入队的 job 不该被这个 worker 消费（已停止 claim）
    const late = await store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: {},
    })
    await sleep(120)
    assert.equal((await store.get(late.id))?.status, 'pending', '已停的 worker 不该认领新 job')
    assert.ok(!executed.includes(late.id))
  })

  it('drained() 会等在途 job 跑完，不半途丢弃', async () => {
    const store = createMemoryJobStore()
    let finished = 0
    const worker = makeWorker({
      store,
      pool: new BoundedPool(2, () => {}),
      execute: async () => {
        await sleep(60)
        finished += 1
      },
    })

    for (let i = 0; i < 2; i++) {
      await store.create({ userId: 'u1', cwd: '/srv/workspace', kind: 'chat', payload: {} })
    }

    worker.start()
    await waitFor(() => finished === 2)
    worker.stop()
    await worker.drained()

    assert.equal(finished, 2, '在途 job 应全部完成')
    const all = await store.list()
    assert.ok(
      all.every(j => j.status === 'completed'),
      '所有 job 都该落终态',
    )
  })

  it('重复 start() 不会起两个 claim 循环（幂等）', async () => {
    const store = createMemoryJobStore()
    let calls = 0
    const worker = makeWorker({
      store,
      execute: async () => {
        calls += 1
      },
    })

    const job = await store.create({
      userId: 'u1',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: {},
    })

    worker.start()
    worker.start()
    await waitFor(async () => (await store.get(job.id))?.status === 'completed')
    await sleep(80)
    worker.stop()
    await worker.drained()

    // 只该执行一次（重复 start 若起了两个循环，job 会被重复消费或报错）
    assert.equal(calls, 1)
  })
})

describe('BoundedPool 全局单例（plan G1）', () => {
  it('同一 limit 反复取到同一个实例（摄入管道与 Worker 必须共用一个池）', async () => {
    const { getGlobalPool, resetGlobalPool } = await import('../src/jobs/pool.js')
    resetGlobalPool()
    const a = getGlobalPool(4, () => {})
    const b = getGlobalPool(4, () => {})
    assert.equal(a, b, '相同 limit 必须返回同一实例，否则并发会翻倍')
    resetGlobalPool()
  })

  it('传入不同 limit 时复用已建池（不抛错、不重建）', async () => {
    const { getGlobalPool, resetGlobalPool } = await import('../src/jobs/pool.js')
    resetGlobalPool()
    const a = getGlobalPool(4, () => {})
    const b = getGlobalPool(9, () => {})
    assert.equal(a, b, '仍应复用第一个池（进程级上限不可被后来者覆盖）')
    resetGlobalPool()
  })
})
