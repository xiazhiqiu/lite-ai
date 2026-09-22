/**
 * T6 鉴权单元测试 —— **纯函数，不起服务**。
 *
 * 覆盖三件容易出错的事：
 * 1. key → userId 解析（多 key、单 key 兜底、格式容错）
 * 2. 拒绝路径（没带 / 带错 / 空表）
 * 3. fail-fast：非回环 + 无 key 必须抛错，回环允许
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  authenticate,
  assertAuthConfigForBinding,
  isExemptPath,
  isLoopbackHost,
  resolveApiKeysFromEnv,
  type ApiKeyEntry,
} from '../../src/server/auth.js'

const KEYS: ApiKeyEntry[] = [
  { key: 'k-alpha-secret', userId: 'alice' },
  { key: 'k-beta-secret', userId: 'bob' },
]

describe('authenticate', () => {
  it('Bearer 形式：验证通过并解析出正确 userId', () => {
    const r = authenticate({ authorization: 'Bearer k-alpha-secret' }, { keys: KEYS })
    assert.deepEqual(r, { ok: true, userId: 'alice' })
  })

  it('X-API-Key 形式：同样可用（对齐 HolmesGPT 的 header 习惯）', () => {
    const r = authenticate({ 'x-api-key': 'k-beta-secret' }, { keys: KEYS })
    assert.deepEqual(r, { ok: true, userId: 'bob' })
  })

  it('裸 token（无 Bearer 前缀）也接受', () => {
    const r = authenticate({ authorization: 'k-beta-secret' }, { keys: KEYS })
    assert.deepEqual(r, { ok: true, userId: 'bob' })
  })

  it('小写 bearer 前缀同样接受（HTTP 头值大小写不敏感）', () => {
    const r = authenticate({ authorization: 'bearer k-alpha-secret' }, { keys: KEYS })
    assert.deepEqual(r, { ok: true, userId: 'alice' })
  })

  it('没带任何凭证 → 401 missing', () => {
    const r = authenticate({}, { keys: KEYS })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'missing')
    assert.equal(r.ok === false && r.status, 401)
  })

  it('凭证错误 → 401 invalid', () => {
    const r = authenticate({ authorization: 'Bearer wrong' }, { keys: KEYS })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'invalid')
  })

  it('【关键】不接受 userId 与 key 的"交叉组合"', () => {
    // alice 的 key 不能换来 bob 的身份，反之亦然
    const a = authenticate({ authorization: 'Bearer k-alpha-secret' }, { keys: KEYS })
    assert.equal(a.ok === true && a.userId, 'alice')
    const b = authenticate({ authorization: 'Bearer k-beta-secret' }, { keys: KEYS })
    assert.equal(b.ok === true && b.userId, 'bob')
  })

  it('前缀正确但长度不足的 key 不放行（防"猜前缀"）', () => {
    const r = authenticate({ authorization: 'Bearer k-alpha' }, { keys: KEYS })
    assert.equal(r.ok, false)
  })

  it('key 表为空（未启用鉴权）时一律拒绝 —— 不放行任何请求', () => {
    const r = authenticate({ authorization: 'Bearer anything' }, { keys: [] })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'invalid')
  })

  it('空白凭证（Bearer 后只有空格）视为缺失', () => {
    const r = authenticate({ authorization: 'Bearer   ' }, { keys: KEYS })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'missing')
  })
})

describe('isExemptPath', () => {
  it('默认豁免 /healthz 与 /readyz', () => {
    assert.equal(isExemptPath('/healthz'), true)
    assert.equal(isExemptPath('/readyz'), true)
  })

  it('业务路径不豁免', () => {
    assert.equal(isExemptPath('/chat'), false)
    assert.equal(isExemptPath('/jobs/x'), false)
  })

  it('【关键】前缀相近的路径不误判为豁免（精确匹配，非 startsWith）', () => {
    // 若实现写成 startsWith('/healthz')，这些会被错误豁免 —— 攻击面
    assert.equal(isExemptPath('/healthz/../chat'), false)
    assert.equal(isExemptPath('/healthz-evil'), false)
    assert.equal(isExemptPath('/healthzz'), false)
    assert.equal(isExemptPath('/readyz/secret'), false)
  })

  it('可覆写豁免集合', () => {
    assert.equal(isExemptPath('/metrics', ['/metrics']), true)
    assert.equal(isExemptPath('/healthz', ['/metrics']), false)
  })
})

describe('resolveApiKeysFromEnv', () => {
  it('解析多 key 映射 LITE_AI_API_KEYS="k:u,k2:u2"', () => {
    const keys = resolveApiKeysFromEnv({ LITE_AI_API_KEYS: 'k1:alice, k2:bob' })
    assert.deepEqual(keys, [
      { key: 'k1', userId: 'alice' },
      { key: 'k2', userId: 'bob' },
    ])
  })

  it('【关键】只按首个冒号切分 —— userId 含冒号也正确', () => {
    const keys = resolveApiKeysFromEnv({ LITE_AI_API_KEYS: 'k1:domain\\alice' })
    assert.deepEqual(keys, [{ key: 'k1', userId: 'domain\\alice' }])
  })

  it('跳过残缺项（无冒号 / 空字段）而不是整体失败', () => {
    const keys = resolveApiKeysFromEnv({ LITE_AI_API_KEYS: 'good:u1,broken,:nouser' })
    assert.deepEqual(keys, [{ key: 'good', userId: 'u1' }])
  })

  it('单 key 兜底：LITE_AI_API_KEY → 默认 userId=operator', () => {
    const keys = resolveApiKeysFromEnv({ LITE_AI_API_KEY: 'solo' })
    assert.deepEqual(keys, [{ key: 'solo', userId: 'operator' }])
  })

  it('单 key 兜底可指定 userId', () => {
    const keys = resolveApiKeysFromEnv({
      LITE_AI_API_KEY: 'solo',
      LITE_AI_DEFAULT_USER: 'oncall',
    })
    assert.deepEqual(keys, [{ key: 'solo', userId: 'oncall' }])
  })

  it('多 key 配置优先于单 key 兜底', () => {
    const keys = resolveApiKeysFromEnv({
      LITE_AI_API_KEYS: 'a:x',
      LITE_AI_API_KEY: 'solo',
    })
    assert.deepEqual(keys, [{ key: 'a', userId: 'x' }])
  })

  it('无任何配置 → 空表', () => {
    assert.deepEqual(resolveApiKeysFromEnv({}), [])
  })
})

describe('assertAuthConfigForBinding（fail-fast）', () => {
  it('非回环 + 无 key → 抛错（防忘配 key 静默公开）', () => {
    assert.throws(
      () => assertAuthConfigForBinding('0.0.0.0', []),
      /必须配置 API key/,
    )
    assert.throws(() => assertAuthConfigForBinding('10.0.0.5', []), /拒绝启动/)
  })

  it('非回环 + 有 key → 放行', () => {
    assert.doesNotThrow(() => assertAuthConfigForBinding('0.0.0.0', KEYS))
  })

  it('回环 + 无 key → 允许启动（注意：只放行启动，业务端点仍一律 401）', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      assert.doesNotThrow(() => assertAuthConfigForBinding(h, []), `${h} 应允许`)
    }
  })
})

describe('isLoopbackHost', () => {
  it('识别回环地址（大小写与空白容错）', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('LocalHost'), true)
    assert.equal(isLoopbackHost('  ::1  '), true)
    assert.equal(isLoopbackHost('0.0.0.0'), false)
    assert.equal(isLoopbackHost('192.168.1.1'), false)
  })
})
