/**
 * T-obs 装配测试 —— 验证 **关闭序列** 会调用 tracing 的 flush/shutdown（纪律 3）。
 *
 * ## 为什么单独测这一条
 *
 * "SIGTERM 时把 Langfuse 缓冲刷出去"是**只在进程退出那一刻成立**的行为，
 * 没有任何单测能顺带覆盖到：`exec.ts` 的扇出测试跑完就返回了，根本没走关停路径。
 * 而这条纪律一旦破了，症状是"最后一批 span 静默丢失"——**没有报错、没有日志**，
 * 是最难发现的一类缺陷。所以这里真起一次 `runServe`，再真触发关停。
 *
 * 不碰真实 SDK：注入假 sink 观察调用次数。也不起告警管道（`enableAlerts: false`）。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import { describe, it } from 'node:test'

import { runServe } from '../../src/server/index.js'
import { createMemoryJobStore } from '../../src/jobs/memory-store.js'
import { createMemoryUsageStore } from '../../src/usage/index.js'
import type { JobTrace, TracingSink } from '../../src/observability/tracing.js'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const noopTrace: JobTrace = {
  toolStart: () => {},
  toolEnd: () => {},
  generation: () => {},
  event: () => {},
  end: () => {},
}

function countingSink(): { sink: TracingSink; flushes: () => number; shutdowns: () => number } {
  let flush = 0
  let shutdown = 0
  return {
    sink: {
      enabled: true,
      startJobTrace: () => noopTrace,
      async flush(): Promise<void> {
        flush += 1
      },
      async shutdown(): Promise<void> {
        shutdown += 1
      },
    },
    flushes: () => flush,
    shutdowns: () => shutdown,
  }
}

describe('runServe × tracing 装配', () => {
  it('关停时调用 tracing.shutdown（纪律 3：flush 晚于 drain、早于释放资源）', async () => {
    const abort = new AbortController()
    const counted = countingSink()

    const served = runServe({
      cwd: os.tmpdir(),
      port: 0,
      host: '127.0.0.1',
      apiKeys: [],
      store: createMemoryJobStore(),
      usage: createMemoryUsageStore(),
      execute: async () => {},
      tracing: counted.sink,
      enableAlerts: false,
      abortSignal: abort.signal,
    })

    // 等监听建立，再触发关停。
    await sleep(300)
    abort.abort()
    await served

    assert.equal(counted.shutdowns(), 1, '关停必须恰好调用一次 tracing.shutdown')
  })

  it('未注入 sink 且无凭据 → 走 noop 装配，不崩（不加载 SDK）', async () => {
    const abort = new AbortController()

    const served = runServe({
      cwd: os.tmpdir(),
      port: 0,
      host: '127.0.0.1',
      apiKeys: [],
      store: createMemoryJobStore(),
      usage: createMemoryUsageStore(),
      execute: async () => {},
      enableAlerts: false,
      abortSignal: abort.signal,
    })

    await sleep(300)
    abort.abort()
    await assert.doesNotReject(() => served)
  })
})
