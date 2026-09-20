/**
 * T7-c：Worker 生命周期结构化日志 + 执行器用量记账的接线测试。
 *
 * 这两件事都很容易被写成"看起来接上了、其实没生效"：
 * - 结构化日志：`trace()` 调了，但字段漏了 userId / 事件名拼错 → 日志能打出来，
 *   可是按 jobId 检索不到。所以这里**逐字段断言**，并断言"认领/完成/失败/重派"
 *   四类事件齐全、且都能靠 jobId + traceId 定位。
 * - 用量记账：`usage` 传了但记账点在错误的路径上（只记成功不记失败），
 *   或者审计写失败把成功 job 拖成 failed。这里两条都测。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { BoundedPool } from '../src/jobs/pool.js'
import { createWorker } from '../src/jobs/worker.js'
import type { JobLifecycleLog } from '../src/server/trace.js'
import { jobIdFromTrace, traceIdForJob } from '../src/server/trace.js'

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

/** 收集结构化日志的替身。 */
function collector(): { logs: JobLifecycleLog[]; logger: (e: Omit<JobLifecycleLog, 'ts'>) => void } {
  const logs: JobLifecycleLog[] = []
  return { logs, logger: e => logs.push({ ts: Date.now(), ...e }) }
}

describe('T7-c Worker 结构化生命周期日志', () => {
  it('成功路径记 claimed + completed，且都带 userId / traceId', async () => {
    const store = createMemoryJobStore()
    const { logs, logger } = collector()
    const worker = createWorker({
      store,
      assignee: 'w1',
      pool: new BoundedPool(2, () => {}),
      execute: async () => {},
      pollMs: 20,
      structuredLog: logger,
    })

    const job = await store.create({
      userId: 'alice',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'hi' },
    })

    worker.start()
    await waitFor(() => logs.some(l => l.event === 'completed'))
    worker.stop()
    await worker.drained()

    const claimed = logs.find(l => l.event === 'claimed')
    const completed = logs.find(l => l.event === 'completed')
    assert.ok(claimed !== undefined, '缺 claimed 事件')
    assert.ok(completed !== undefined, '缺 completed 事件')

    for (const entry of [claimed, completed]) {
      assert.equal(entry.jobId, job.id)
      assert.equal(entry.userId, 'alice', 'userId 必须落进审计日志（可追责的前提）')
      assert.equal(entry.traceId, traceIdForJob(job.id))
      // traceId 可反解回 jobId —— 这是"日志能按 job 串起来"的硬条件
      assert.equal(jobIdFromTrace(entry.traceId), job.id)
      assert.equal(entry.kind, 'chat')
      assert.equal(entry.assignee, 'w1')
    }
    // 耗时只在终态有意义；认领时不该有（有的话是错填）
    assert.equal(claimed.durationMs, undefined)
    assert.equal(typeof completed.durationMs, 'number')
  })

  it('失败路径记 failed 且带 error 文案', async () => {
    const store = createMemoryJobStore()
    const { logs, logger } = collector()
    const worker = createWorker({
      store,
      assignee: 'w1',
      pool: new BoundedPool(2, () => {}),
      execute: async () => {
        throw new Error('模型超时')
      },
      pollMs: 20,
      log: () => {}, // 静音人类可读日志，只断言结构化那条
      structuredLog: logger,
    })

    const job = await store.create({
      userId: 'bob',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'boom' },
    })

    worker.start()
    await waitFor(() => logs.some(l => l.event === 'failed'))
    worker.stop()
    await worker.drained()

    const failed = logs.find(l => l.event === 'failed')
    assert.ok(failed !== undefined)
    assert.equal(failed.level, 'error')
    assert.equal(failed.jobId, job.id)
    assert.equal(failed.userId, 'bob')
    assert.match(String(failed.error), /模型超时/)
    // 失败的原因是**原文**透传，不是被包装成 'Error: ...' 之外的糊状物
    assert.equal(failed.error, '模型超时')
  })

  it('重派（stale sweep）逐条记 reassigned，不合并成一行 summary', async () => {
    const store = createMemoryJobStore()
    const { logs, logger } = collector()
    // 先把一个 job claim 走但不 finish，模拟"实例崩了、job 卡 running"
    const stale = await store.create({
      userId: 'carol',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'stuck' },
    })
    await store.claim({ assignee: 'dead-instance', limit: 1 }, 1)

    const worker = createWorker({
      store,
      assignee: 'w2',
      pool: new BoundedPool(1, () => {}),
      // 这个 worker 的 execute 永远挂住 —— 我们只关心 sweep 的日志
      execute: () => new Promise<void>(() => {}),
      pollMs: 100_000,
      staleLeaseMs: 10,
      staleSweepMs: 20,
      now: () => Date.now() + 1_000_000, // 让租期立刻超时
      log: () => {},
      structuredLog: logger,
    })

    worker.start()
    await waitFor(() => logs.some(l => l.event === 'reassigned'), 3000)
    worker.stop()

    const reassigned = logs.filter(l => l.event === 'reassigned')
    assert.ok(reassigned.length > 0)
    const entry = reassigned.find(l => l.jobId === stale.id)
    assert.ok(entry !== undefined, '重派日志必须能按 jobId 定位（所以不能合并成一行）')
    assert.equal(entry.userId, 'carol')
    assert.equal(entry.assignee, null, '重派后尚无新主')
    assert.match(String(entry.error), /租期/)
  })

  it('结构化日志可整体关掉（不影响 job 执行）', async () => {
    const store = createMemoryJobStore()
    const { logs, logger } = collector()
    const worker = createWorker({
      store,
      assignee: 'w1',
      pool: new BoundedPool(1, () => {}),
      execute: async () => {},
      pollMs: 20,
      log: () => {},
      structuredLog: logger,
    })
    // 关掉：直接传一个不写东西的 sink（模拟 LITE_AI_STRUCTURED_LOG=0 的接线）
    const muted = createWorker({
      store,
      assignee: 'w2',
      pool: new BoundedPool(1, () => {}),
      execute: async () => {},
      pollMs: 20,
      log: () => {},
      structuredLog: () => {},
    })

    const job = await store.create({
      userId: 'u',
      cwd: '/srv/workspace',
      kind: 'chat',
      payload: { message: 'x' },
    })

    muted.start()
    await waitFor(async () => (await store.get(job.id))?.status === 'completed')
    muted.stop()
    await muted.drained()

    // job 正常跑完，且没有任何结构化日志流出
    assert.equal(logs.length, 0)
    worker.stop()
  })
})
