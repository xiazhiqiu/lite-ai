import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '../src/types.js'
import { StreamingToolExecutor } from '../src/utils/streaming-tool-executor.js'

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms) })

function call(id: string, safe: boolean): ToolCall {
  return { id, toolName: 'x', input: { safe } }
}

/** 统计同时在飞峰值的 runner 工厂 */
function makeRunner() {
  let running = 0
  const state = {
    maxRunning: 0,
    startedOrder: [] as string[],
    run: async (name: string, ms = 5) => {
      running += 1
      state.maxRunning = Math.max(state.maxRunning, running)
      state.startedOrder.push(name)
      await sleep(ms)
      running -= 1
      return name
    },
  }
  return state
}

test('StreamingToolExecutor: 空注册 all() 返回空数组', async () => {
  const executor = new StreamingToolExecutor<string>()
  assert.deepEqual(await executor.all(), [])
})

test('StreamingToolExecutor: 全 safe 同时起跑，all() 按发射序返回', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: c => (c.input as { safe: boolean }).safe,
  })
  // 反向完成时间：越早发射越晚完成
  executor.register(call('a', true), () => runner.run('a', 30))
  executor.register(call('b', true), () => runner.run('b', 10))
  executor.register(call('c', true), () => runner.run('c', 1))
  const results = await executor.all()
  assert.equal(runner.maxRunning, 3)
  assert.deepEqual(results, ['a', 'b', 'c'])
})

test('StreamingToolExecutor: unsafe 需在跑为空才独占起跑', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: c => (c.input as { safe: boolean }).safe,
  })
  executor.register(call('w', false), () => runner.run('w', 20))
  executor.register(call('r', true), () => runner.run('r', 1))
  const results = await executor.all()
  // r 必须等 w 完成才能起跑
  assert.deepEqual(runner.startedOrder, ['w', 'r'])
  assert.equal(runner.maxRunning, 1)
  assert.deepEqual(results, ['w', 'r'])
})

test('StreamingToolExecutor: safe 可越过排队中的 unsafe 起跑（动态准入）', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: c => (c.input as { safe: boolean }).safe,
  })
  executor.register(call('r1', true), () => runner.run('r1', 10))
  executor.register(call('w', false), () => runner.run('w', 10))
  executor.register(call('r2', true), () => runner.run('r2', 10))
  const results = await executor.all()
  // r2 与 r1 并行（越过队首的 w）；w 独占（起跑时 executing 为空）
  assert.deepEqual(runner.startedOrder, ['r1', 'r2', 'w'])
  assert.equal(runner.maxRunning, 2)
  assert.deepEqual(results, ['r1', 'w', 'r2'])
})

test('StreamingToolExecutor: unsafe 在跑时 safe 不起跑', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: c => (c.input as { safe: boolean }).safe,
  })
  executor.register(call('w1', false), () => runner.run('w1', 30))
  executor.register(call('r1', true), () => runner.run('r1', 5))
  executor.register(call('r2', true), () => runner.run('r2', 5))
  const results = await executor.all()
  // w1 独占期间 r1/r2 只能排队；w1 完成后 r1/r2 并行
  assert.deepEqual(runner.startedOrder, ['w1', 'r1', 'r2'])
  assert.equal(runner.maxRunning, 2)
  assert.deepEqual(results, ['w1', 'r1', 'r2'])
})

test('StreamingToolExecutor: 同时在飞不超过 limit', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<number>({
    isSafe: () => true,
    limit: 2,
  })
  for (let i = 0; i < 5; i++) {
    executor.register(call(`c${i}`, true), () => runner.run(`c${i}`, 5).then(Number))
  }
  await executor.all()
  assert.equal(runner.maxRunning, 2)
})

test('StreamingToolExecutor: 同 id 重复注册去重（兜底注册幂等）', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: () => true,
  })
  executor.register(call('a', true), () => runner.run('a'))
  executor.register(call('a', true), () => runner.run('a-again'))
  const results = await executor.all()
  assert.deepEqual(results, ['a'])
  assert.equal(runner.startedOrder.filter(n => n === 'a').length, 1)
})

test('StreamingToolExecutor: isSafe 抛异常 → fail-closed 串行', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: () => {
      throw new Error('boom')
    },
  })
  executor.register(call('a', true), () => runner.run('a', 5))
  executor.register(call('b', true), () => runner.run('b', 5))
  const results = await executor.all()
  assert.deepEqual(runner.startedOrder, ['a', 'b'])
  assert.equal(runner.maxRunning, 1)
  assert.deepEqual(results, ['a', 'b'])
})

test('StreamingToolExecutor: 缺省 isSafe → 全部串行（fail-closed）', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>()
  executor.register(call('a', true), () => runner.run('a', 5))
  executor.register(call('b', true), () => runner.run('b', 5))
  await executor.all()
  assert.equal(runner.maxRunning, 1)
})

test('StreamingToolExecutor: run reject → all() 立刻 reject，未起跑的不悬空', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: () => true,
    limit: 1,
  })
  executor.register(call('a', true), () => runner.run('a', 1))
  executor.register(call('b', true), () => {
    throw new Error('boom')
  })
  executor.register(call('c', true), () => runner.run('c', 100))
  await assert.rejects(() => executor.all(), /boom/)
  // limit=1：a 完成后 b reject，c 未起跑 —— 其 promise 已被 failAll 拒绝，不会永久悬空
  assert.equal(runner.startedOrder.includes('c'), false)
})

test('StreamingToolExecutor: 动态准入与贪心分批的并发集等价（读写交错）', async () => {
  const runner = makeRunner()
  const executor = new StreamingToolExecutor<string>({
    isSafe: c => (c.input as { safe: boolean }).safe,
  })
  // 对齐 tool-parallel 分批示例 [read, read, grep, edit, read]
  const plan: Array<[string, boolean]> = [
    ['r1', true],
    ['r2', true],
    ['g', true],
    ['e', false],
    ['r3', true],
  ]
  for (const [name, safe] of plan) {
    executor.register(call(name, safe), () => runner.run(name, 8))
  }
  const results = await executor.all()
  // 动态准入：r3（safe）越过队首的 e 与 r1/r2/g 并行；e 等在跑清空后独占收尾
  assert.deepEqual(runner.startedOrder, ['r1', 'r2', 'g', 'r3', 'e'])
  assert.equal(runner.maxRunning, 4)
  assert.deepEqual(results, ['r1', 'r2', 'g', 'e', 'r3'])
})
