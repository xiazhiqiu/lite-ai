/**
 * T9-b 故障转移演练 —— **Worker 进程突然死亡后，job 能被回收并重新跑完**。
 *
 * ## 为什么必须有一条演练用例
 *
 * 异步队列（而非"HTTP 请求里同步跑完"）的**唯一理由**就是故障转移：
 * 实例崩了，它占着的 job 不能被永久卡死。plan 的 G6 缺口原话是
 * "故障转移在 CI 里没被验证 —— **核心卖点未被自动化证明**"。
 * 本文件就是补上这块：把"两个实例 + 一个死了"这件事**在 CI 里真跑一遍**。
 *
 * ## 怎么模拟"进程死亡"
 *
 * 不去真 kill 子进程（慢且不可靠），而是模拟它的**可观测后果**：
 * - job 停在 `running`、`assignee` 是死掉的实例；
 * - 该实例的 `execute` **永远不返回**（进程没了，没人会来写终态）；
 * - 它的 claim / sweep 定时器也不再跑（所以不会自己接回去）。
 *
 * 这三点正是真崩溃时别人能观察到的全部事实，等价性成立。
 *
 * ## 时间怎么推进
 *
 * 用**注入时钟**（`worker.now`），而不是 `sleep(租期)`。租期默认 5 分钟，
 * 真等 5 分钟的测试没人会跑；注入时钟让演练在几十毫秒内完成，且完全确定。
 * 这也顺带验证了一件事：**租期判断吃的是注入时钟，不是 `Date.now()`** ——
 * 若哪天有人改回 `Date.now()`，本用例会立刻红。
 *
 * ## 最后还要证明一件更隐蔽的事
 *
 * 死掉的实例"其实没死、只是很慢"时（租期到了但进程还在跑），它跑完会试图
 * 写 `completed`。这时**绝不能覆盖新实例的执行结果** —— 否则同一条调查
 * 的终态被两个实例各写一次，审计数字会莫名其妙。
 * `worker.ts` 用 `store.finish()` 的返回值挡住了这条路径（且留下 warn 日志），
 * 本用例把它钉死。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { BoundedPool } from '../src/jobs/pool.js'
import { createWorker, type Worker } from '../src/jobs/worker.js'
import type { JobLifecycleLog } from '../src/server/trace.js'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await sleep(stepMs)
  }
  throw new Error(`waitFor 超时（${label}）`)
}

type LifecycleEntry = Omit<JobLifecycleLog, 'ts'>

/** 捕获结构化生命周期日志（审计侧唯一能看见"被重派过"的地方）。 */
function captureLogs(): { entries: LifecycleEntry[]; log: (e: LifecycleEntry) => void } {
  const entries: LifecycleEntry[] = []
  return { entries, log: (e: LifecycleEntry): void => void entries.push(e) }
}

describe('T9 故障转移演练：实例死亡 → 租期回收 → 另一实例接手', () => {
  it('running job 被 stale sweep 打回 pending，由新 worker 重新 claim 跑完', async () => {
    const store = createMemoryJobStore()

    // ── 注入时钟：整场演练在毫秒级完成，不依赖真实等待 ──
    let clock = 1_700_000_000_000
    const now = (): number => clock

    const job = await store.create(
      { userId: 'alice', kind: 'chat', payload: { message: '订单服务 5xx 激增' } },
      clock,
    )

    // ── 实例 A：接了活就"死"了（execute 永不返回） ──
    let releaseA: (() => void) | null = null
    const blocked = new Promise<void>(resolve => {
      releaseA = resolve
    })
    const logsA = captureLogs()
    const workerA: Worker = createWorker({
      store,
      assignee: 'worker-A',
      pool: new BoundedPool(1, () => {}),
      execute: () => blocked, // ← 永不返回：模拟进程消失
      pollMs: 10,
      staleLeaseMs: 1000,
      staleSweepMs: 60_000, // A 自己几乎不做 sweep（它马上就要"死"了）
      now,
      log: () => {},
      structuredLog: logsA.log,
    })
    workerA.start()

    await waitFor(async () => (await store.get(job.id))?.status === 'running', 'A 认领')
    const claimed = await store.get(job.id)
    assert.equal(claimed?.status, 'running')
    assert.equal(claimed?.assignee, 'worker-A')

    // ── A "死亡"：停掉它的定时器（在途 execute 仍挂在那儿，没人收尾） ──
    workerA.stop()

    // ── 时间推进超过租期 ──
    clock += 5_000
    const staleBefore = await store.get(job.id)
    assert.equal(staleBefore?.status, 'running', '前置条件：此时还没人回收它')

    // ── 实例 B 上线：sweep 回收 + 自己接手 ──
    const executedByB: string[] = []
    const logsB = captureLogs()
    const workerB: Worker = createWorker({
      store,
      assignee: 'worker-B',
      pool: new BoundedPool(1, () => {}),
      execute: async j => {
        executedByB.push(j.id)
      },
      pollMs: 10,
      staleLeaseMs: 1000,
      staleSweepMs: 20, // 高频 sweep：演练不想等 60s 的默认周期
      now,
      log: () => {},
      structuredLog: logsB.log,
    })
    workerB.start()

    await waitFor(async () => (await store.get(job.id))?.status === 'completed', 'B 跑完')
    workerB.stop()
    await workerB.drained()

    const done = await store.get(job.id)
    assert.equal(done?.status, 'completed', 'job 必须被新实例跑完，而不是卡死在 running')
    assert.equal(done?.assignee, 'worker-B')
    assert.deepEqual(executedByB, [job.id], 'B 恰好执行了一次')

    // ── 审计留痕：重派这件事必须能被检索到 ──
    // 没有这条，"为什么同一条调查跑了两次"在审计里是无解的。
    const reassigned = logsB.entries.filter(e => e.event === 'reassigned' && e.jobId === job.id)
    assert.equal(reassigned.length, 1, `应恰好留一条 reassigned，实得 ${reassigned.length}`)
    assert.equal(reassigned[0]?.level, 'warn')
    assert.match(String(reassigned[0]?.error), /worker-A/, '重派记录要写明原实例是谁')

    // ── 最隐蔽的一条：A "复活"后不能覆盖 B 的结果 ──
    // 租期超时只说明 A 失联，不等于 A 真的死了。它若跑完并写终态，必须被拒。
    releaseA?.()
    await workerA.drained()

    const afterA = await store.get(job.id)
    assert.equal(afterA?.status, 'completed')
    assert.equal(
      afterA?.assignee,
      'worker-B',
      '迟到的旧实例绝不能把终态改回自己的（否则同一条调查两个终态）',
    )
    const rejected = logsA.entries.filter(e => e.event === 'completed' && e.error !== undefined)
    assert.equal(rejected.length, 1, '被拒的完成写入必须留 warn（审计要能看见"重复执行"）')
    assert.match(String(rejected[0]?.error), /完成写入被拒/)
  })

  it('未超租期的 running job 不会被误回收（租期是防误杀的护栏）', async () => {
    const store = createMemoryJobStore()
    let clock = 1_700_000_000_000
    const now = (): number => clock

    const job = await store.create({ userId: 'bob', kind: 'chat', payload: { message: 'x' } }, clock)

    const worker: Worker = createWorker({
      store,
      assignee: 'worker-live',
      pool: new BoundedPool(1, () => {}),
      execute: () => new Promise<void>(() => {}), // 故意挂着，模拟"还在跑"
      pollMs: 10,
      staleLeaseMs: 1000,
      staleSweepMs: 20,
      now,
      log: () => {},
      structuredLog: () => {},
    })
    worker.start()

    await waitFor(async () => (await store.get(job.id))?.status === 'running', '认领')
    // 只推进"租期的一半"：正在跑的 job 不能被当成死掉的实例回收，
    // 否则等于把同一次调查重跑一遍（烧两次 token）。
    clock += 500
    await sleep(80) // 让 sweep 真的跑几轮

    const stillRunning = await store.get(job.id)
    assert.equal(stillRunning?.status, 'running', '未超租期绝不能回收（会重复烧 token）')
    assert.equal(stillRunning?.assignee, 'worker-live')

    worker.stop()
  })
})
