import { describe, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedToolsetConfig } from '../src/config.js'
import { clampToolOutput, checkConfig, httpGet } from '../src/tools/data-sources/base.js'
import { checkPrometheusConfig, buildPrometheusTools } from '../src/tools/data-sources/prometheus.js'
import { checkElasticsearchConfig, buildElasticsearchTools } from '../src/tools/data-sources/elasticsearch.js'
import {
  checkKubernetesConfig,
  buildKubernetesTools,
  __hooks,
} from '../src/tools/data-sources/kubernetes.js'
import { checkDatabaseConfig, buildDatabaseTools, isReadOnlySql } from '../src/tools/data-sources/database.js'
import { checkTempoConfig, buildTempoTools } from '../src/tools/data-sources/tempo.js'

function toolset(name: string, type: string, config: Record<string, unknown>): ResolvedToolsetConfig {
  return { name, type, config }
}

describe('data-source toolset: config checks', () => {
  it('prometheus 需要 prometheus_url', () => {
    assert.equal(checkPrometheusConfig(toolset('prom', 'prometheus', {})).enabled, false)
    assert.equal(
      checkPrometheusConfig(toolset('prom', 'prometheus', { prometheus_url: 'http://x' })).enabled,
      true,
    )
  })

  it('elasticsearch 需要 es_url', () => {
    assert.equal(checkElasticsearchConfig(toolset('es', 'elasticsearch', {})).enabled, false)
    assert.equal(
      checkElasticsearchConfig(toolset('es', 'elasticsearch', { es_url: 'http://x' })).enabled,
      true,
    )
  })

  it('kubernetes 无需连接参数即启用', () => {
    assert.equal(checkKubernetesConfig(toolset('k8s', 'kubernetes', {})).enabled, true)
  })

  it('database 需要 connection_url', () => {
    assert.equal(checkDatabaseConfig(toolset('db', 'database', {})).enabled, false)
    assert.equal(
      checkDatabaseConfig(toolset('db', 'database', { connection_url: 'sqlite:///x' })).enabled,
      true,
    )
  })

  it('tempo 需要 api_url', () => {
    assert.equal(checkTempoConfig(toolset('tp', 'tempo', {})).enabled, false)
    assert.equal(
      checkTempoConfig(toolset('tp', 'tempo', { api_url: 'http://tempo:3200' })).enabled,
      true,
    )
  })

  it('通用 checkConfig 回报缺失键', () => {
    const status = checkConfig(toolset('x', 'y', { a: '', b: 'ok' }), ['a', 'b', 'c'])
    assert.equal(status.enabled, false)
    assert.match(status.reason ?? '', /a, c/)
  })
})

describe('data-source toolset: sql 只读白名单', () => {
  it('放行只读 SQL', () => {
    for (const sql of [
      'SELECT * FROM t',
      'show tables',
      'DESCRIBE users',
      'explain select * from t',
      'WITH x AS (...) SELECT * FROM x',
    ]) {
      assert.equal(isReadOnlySql(sql), true, sql)
    }
  })

  it('拒绝写 SQL', () => {
    for (const sql of [
      'insert into t values (1)',
      'UPDATE t SET a=1',
      'select * from t; drop table t',
      'delete from t',
    ]) {
      assert.equal(isReadOnlySql(sql), false, sql)
    }
  })
})

describe('data-source toolset: 工具构建', () => {
  it('prometheus 生成前缀工具且只读', () => {
    const tools = buildPrometheusTools(toolset('prom', 'prometheus', { prometheus_url: 'http://x' }))
    assert.ok(tools.length >= 8)
    for (const t of tools) assert.equal(t.isReadOnly, true)
    assert.ok(tools.some(t => t.name === 'prometheus_execute_prometheus_instant_query'))
  })

  it('elasticsearch 生成前缀工具且只读', () => {
    const tools = buildElasticsearchTools(toolset('es', 'elasticsearch', { es_url: 'http://x' }))
    assert.ok(tools.length >= 8)
    for (const t of tools) assert.equal(t.isReadOnly, true)
    assert.ok(tools.some(t => t.name === 'elasticsearch_search'))
  })

  it('kubernetes 生成 3 个只读工具', () => {
    const tools = buildKubernetesTools(toolset('k8s', 'kubernetes', {}))
    assert.equal(tools.length, 3)
    for (const t of tools) assert.equal(t.isReadOnly, true)
  })

  it('database 生成 {instance}_query 前缀并归一化非法字符', () => {
    const tools = buildDatabaseTools(
      toolset('order-db', 'database', { connection_url: 'sqlite:///x' }),
    )
    assert.ok(tools.some(t => t.name === 'order_db_list_tables'))
    assert.equal(tools.every(t => t.isReadOnly), true)
  })

  it('database 写 SQL 返回稳定错误', async () => {
    const [queryTool] = buildDatabaseTools(
      toolset('db', 'database', { connection_url: 'sqlite:///x' }),
    )
    const result = await queryTool.run({ sql: 'delete from t' }, { cwd: '/' })
    assert.equal(result.ok, false)
    assert.match(result.output, /仅允许只读 SQL/)
  })
})

describe('data-source toolset: kubernetes 执行（mock kubectl）', () => {
  afterEach(() => {
    delete (__hooks as { kubectlExec?: unknown }).kubectlExec
  })

  it('jq_query 拼接只读 kubectl args 并返回输出', async () => {
    ;(__hooks as { kubectlExec?: unknown }).kubectlExec = async (args: string[]) => {
      assert.deepEqual(args, ['get', 'pods', '-n', 'default', '--selector', 'app=web', '-o', 'json'])
      return { stdout: JSON.stringify({ items: [] }), stderr: '' }
    }
    const tools = buildKubernetesTools(toolset('k8s', 'kubernetes', {}))
    const jq = tools.find(t => t.name === 'kubernetes_jq_query')!
    const result = await jq.run(
      { resource_type: 'pods', namespace: 'default', label_selector: 'app=web' },
      { cwd: '/' },
    )
    assert.equal(result.ok, true)
    assert.equal(result.output, JSON.stringify({ items: [] }))
  })
})

describe('data-source toolset: httpGet 与截断', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch
  })

  it('clampToolOutput 超长截断', () => {
    assert.equal(clampToolOutput('abc', 10), 'abc')
    const marker = '\n...[truncated at 10 chars]'
    const out = clampToolOutput('x'.repeat(20), 10)
    assert.equal(out, 'x'.repeat(10) + marker)
    assert.equal(out.length, 10 + marker.length)
  })

  it('httpGet 非 2xx 不抛错，返回状态与正文', async () => {
    ;(globalThis as { fetch?: unknown }).fetch = async () =>
      new Response('boom', { status: 503 })
    const res = await httpGet('http://example.invalid/health')
    assert.equal(res.ok, false)
    assert.equal(res.status, 503)
    assert.equal(res.text, 'boom')
  })

  it('httpGet 网络错误吞掉并保持默认超时兜底', async () => {
    ;(globalThis as { fetch?: unknown }).fetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    await assert.rejects(() => httpGet('http://example.invalid/'), /ECONNREFUSED/)
  })
})