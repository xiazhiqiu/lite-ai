/**
 * T-obs 抽象层测试 —— **不加载任何 Langfuse / OTel SDK**。
 *
 * 要证明的四件事：
 * 1. **traceId 派生**：`deriveTraceId(jobId)` 是 32 位十六进制的纯函数
 *    （同输入同输出），任何拿到 jobId 的地方都能重算同一个 traceId。
 * 2. **traceparent 往返**：W3C 头解析/序列化对称；畸形输入一律 `null` 而不抛错
 *    （一个坏头不该让调查起不来）。
 * 3. **noop 契约**：`createNoopTracingSink` 的所有方法都不抛错、`flush/shutdown` 可 await。
 * 4. **门控**：`createTracingSink` 在"显式关闭"与"缺凭据"两条路径上都返回 noop，
 *    且**不会**去 import SDK（这正是"开发/CI 零开销"的保证）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createNoopTracingSink,
  createTracingSink,
  deriveTraceId,
  formatTraceparent,
  parseTraceparent,
  randomSpanId,
  resolveTracingCredentials,
} from '../src/observability/tracing.js'

describe('deriveTraceId', () => {
  it('产出 32 位小写十六进制（OTel traceId 格式）', () => {
    const id = deriveTraceId('job-abc')
    assert.match(id, /^[0-9a-f]{32}$/)
  })

  it('是纯函数：同 jobId 必得同 traceId', () => {
    assert.equal(deriveTraceId('job-1'), deriveTraceId('job-1'))
  })

  it('不同 jobId 得到不同 traceId', () => {
    assert.notEqual(deriveTraceId('job-1'), deriveTraceId('job-2'))
  })

  it('traceId 不会是全零（OTel 视为非法）', () => {
    for (const jobId of ['job-1', 'tr-x', '', 'job-'.repeat(50)]) {
      assert.doesNotMatch(deriveTraceId(jobId), /^0{32}$/)
    }
  })
})

describe('randomSpanId', () => {
  it('产出 16 位十六进制且每次不同', () => {
    const a = randomSpanId()
    const b = randomSpanId()
    assert.match(a, /^[0-9a-f]{16}$/)
    assert.notEqual(a, b)
  })
})

describe('parseTraceparent / formatTraceparent', () => {
  const valid = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

  it('解析合法 traceparent', () => {
    const parsed = parseTraceparent(valid)
    assert.notEqual(parsed, null)
    assert.equal(parsed?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
    assert.equal(parsed?.spanId, '00f067aa0ba902b7')
    assert.equal(parsed?.traceFlags, 1)
  })

  it('大小写与首尾空白都能容忍', () => {
    const parsed = parseTraceparent(`  ${valid.toUpperCase()}  `)
    assert.equal(parsed?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736')
  })

  it('序列化后可无损往返', () => {
    const parsed = parseTraceparent(valid)
    assert.notEqual(parsed, null)
    assert.equal(formatTraceparent(parsed!), valid)
  })

  it('畸形输入一律返回 null（不抛错）', () => {
    const bad: Array<string | null | undefined> = [
      null,
      undefined,
      '',
      'garbage',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // 缺 flags
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01', // traceId 全零
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', // spanId 全零
      '00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01',
    ]
    for (const header of bad) {
      assert.equal(parseTraceparent(header), null, `应拒绝: ${String(header)}`)
    }
  })
})

describe('createNoopTracingSink', () => {
  it('enabled=false 且带原因', () => {
    const sink = createNoopTracingSink('test-reason')
    assert.equal(sink.enabled, false)
    assert.equal(sink.reason, 'test-reason')
  })

  it('所有 job trace 方法都不抛错', () => {
    const trace = createNoopTracingSink().startJobTrace({
      jobId: 'job-1',
      kind: 'chat',
      sessionId: 'sin-1',
    })
    assert.doesNotThrow(() => {
      trace.toolStart('t1', 'search', { q: 'x' })
      trace.toolEnd('t1', 'search', 'ok', false)
      trace.generation({ model: 'm', inputTokens: 1 })
      trace.event('progress', { a: 1 })
      trace.end({ status: 'ok' })
    })
  })

  it('flush / shutdown 可 await 且不抛错', async () => {
    const sink = createNoopTracingSink()
    await assert.doesNotReject(() => sink.flush())
    await assert.doesNotReject(() => sink.shutdown())
  })
})

describe('resolveTracingCredentials', () => {
  it('两个 key 齐 → 返回凭据', () => {
    const creds = resolveTracingCredentials({
      LANGFUSE_PUBLIC_KEY: 'pk-1',
      LANGFUSE_SECRET_KEY: 'sk-1',
    })
    assert.deepEqual(creds, { publicKey: 'pk-1', secretKey: 'sk-1' })
  })

  it('缺任一 key → null（不带半套凭据启动）', () => {
    assert.equal(resolveTracingCredentials({ LANGFUSE_PUBLIC_KEY: 'pk-1' }), null)
    assert.equal(resolveTracingCredentials({ LANGFUSE_SECRET_KEY: 'sk-1' }), null)
    assert.equal(resolveTracingCredentials({}), null)
  })

  it('空白字符串视为未配置', () => {
    assert.equal(
      resolveTracingCredentials({ LANGFUSE_PUBLIC_KEY: '   ', LANGFUSE_SECRET_KEY: 'sk' }),
      null,
    )
  })

  it('可选字段：baseUrl / environment / release', () => {
    const creds = resolveTracingCredentials({
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
      LANGFUSE_BASE_URL: 'http://langfuse.internal',
      LANGFUSE_TRACING_ENVIRONMENT: 'staging',
      LANGFUSE_RELEASE: 'v1.2.3',
    })
    assert.equal(creds?.baseUrl, 'http://langfuse.internal')
    assert.equal(creds?.environment, 'staging')
    assert.equal(creds?.release, 'v1.2.3')
  })
})

describe('createTracingSink 门控', () => {
  it('LITE_AI_TRACING=0 → noop(disabled-by-env)，即使配了凭据', async () => {
    const sink = await createTracingSink({
      env: {
        LITE_AI_TRACING: '0',
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
      },
    })
    assert.equal(sink.enabled, false)
    assert.equal(sink.reason, 'disabled-by-env')
  })

  it('缺凭据 → noop(no-langfuse-credentials)（不加载 SDK）', async () => {
    const sink = await createTracingSink({ env: {} })
    assert.equal(sink.enabled, false)
    assert.equal(sink.reason, 'no-langfuse-credentials')
  })
})
