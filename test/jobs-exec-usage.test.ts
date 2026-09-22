/**
 * 用量记账尾差修复测试 —— `/usage` 账本必须落**真实 token**。
 *
 * 背景：`recordUsage` 曾硬编码 `inputTokens/outputTokens = 0`，注释写「等 runner
 * 把 usage 透传上来再填」。T-obs 新增的 `onLlmCall` 回调已经把 provider 的 usage
 * 透出来了，所以这里钉死四件事：
 *
 * 1. 成功一轮：**模型名 + input/output token 真落进账本**；
 * 2. 一轮内多次 LLM 调用 → token **累加**（不是只取最后一次）；
 * 3. provider 没给 usage（回调未触发 / 字段缺失）→ 仍然是 0，**不编造数字**；
 * 4. 失败一轮：只要失败前发生过 LLM 调用，也记到真实用量（失败的调查同样要审计）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryJobStore } from '../src/jobs/memory-store.js'
import { createJobExecutor } from '../src/jobs/exec.js'
import type { Job } from '../src/jobs/types.js'
import type { ChatMessage } from '../src/types.js'
import type { SessionStore } from '../src/session/store.js'
import { createMemoryUsageStore } from '../src/usage/index.js'

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

describe('exec：用量记账（T-obs 尾差修复）', () => {
  it('成功一轮：模型名与 input/output token 真落进账本', async () => {
    const { job, store } = await runningJob()
    const usage = createMemoryUsageStore()

    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      modelName: 'ctor-model',
      usage,
      turnRunner: async args => {
        args.onLlmCall?.({
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
          latencyMs: 900,
        })
        args.onAssistantMessage?.('结论', { final: true })
        return [{ role: 'assistant', content: '结论' }] as ChatMessage[]
      },
    })

    await exec(job)

    const rows = await usage.list({ userId: 'u1' })
    assert.equal(rows.length, 1, '一轮 job 记一条账')
    assert.equal(rows[0]!.status, 'completed')
    // 模型取**实测**的那个，而不是装配期的 ctor-model。
    assert.equal(rows[0]!.model, 'deepseek-v4-flash')
    assert.equal(rows[0]!.inputTokens, 120)
    assert.equal(rows[0]!.outputTokens, 45)
  })

  it('一轮内多次 LLM 调用：token 累加，模型取最后一次', async () => {
    const { job, store } = await runningJob()
    const usage = createMemoryUsageStore()

    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      usage,
      turnRunner: async args => {
        args.onLlmCall?.({ model: 'm-a', inputTokens: 100, outputTokens: 10 })
        args.onLlmCall?.({ model: 'm-b', inputTokens: 200, outputTokens: 20 })
        args.onLlmCall?.({ model: 'm-b', inputTokens: 300, outputTokens: 30 })
        return [] as ChatMessage[]
      },
    })

    await exec(job)

    const rows = await usage.list({ userId: 'u1' })
    assert.equal(rows[0]!.inputTokens, 600, '600 = 100 + 200 + 300（累加，不是取最后一次）')
    assert.equal(rows[0]!.outputTokens, 60)
    assert.equal(rows[0]!.model, 'm-b', '模型名取最后一次调用')
  })

  it('provider 未回传 usage（回调不触发）：token 保持 0，且模型回退到装配值', async () => {
    const { job, store } = await runningJob()
    const usage = createMemoryUsageStore()

    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      modelName: 'ctor-model',
      usage,
      // 完全不调 onLlmCall —— 模拟 provider 没给 usage。
      turnRunner: async () => [] as ChatMessage[],
    })

    await exec(job)

    const rows = await usage.list({ userId: 'u1' })
    assert.equal(rows[0]!.inputTokens, 0, '没数字就是 0，不编造')
    assert.equal(rows[0]!.outputTokens, 0)
    assert.equal(rows[0]!.model, 'ctor-model', '没有实测模型时回退装配期探测值')
  })

  it('token 字段缺失（只有部分字段）不污染：缺的按 0 累计', async () => {
    const { job, store } = await runningJob()
    const usage = createMemoryUsageStore()

    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      usage,
      turnRunner: async args => {
        args.onLlmCall?.({ model: 'm', inputTokens: 50 }) // 没给 outputTokens
        args.onLlmCall?.({ model: 'm', outputTokens: 7 }) // 没给 inputTokens
        return [] as ChatMessage[]
      },
    })

    await exec(job)
    const rows = await usage.list({ userId: 'u1' })
    assert.equal(rows[0]!.inputTokens, 50)
    assert.equal(rows[0]!.outputTokens, 7)
  })

  it('失败一轮：失败前发生过的 LLM 调用同样记进账本（status=failed）', async () => {
    const { job, store } = await runningJob()
    const usage = createMemoryUsageStore()

    const exec = createJobExecutor({
      jobStore: store,
      sessionStore: emptySessionStore,
      cwd: '/srv/workspace',
      model: fakeModel,
      usage,
      turnRunner: async args => {
        args.onLlmCall?.({ model: 'm-err', inputTokens: 88, outputTokens: 9 })
        throw new Error('runner boom')
      },
    })

    await assert.rejects(() => exec(job), /runner boom/)

    const rows = await usage.list({ userId: 'u1' })
    assert.equal(rows.length, 1, '失败的调查也是一条账')
    assert.equal(rows[0]!.status, 'failed')
    assert.equal(rows[0]!.model, 'm-err')
    assert.equal(rows[0]!.inputTokens, 88)
    assert.equal(rows[0]!.outputTokens, 9)
  })
})
