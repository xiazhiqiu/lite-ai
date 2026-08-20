import { describe, before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../src/tool.js'
import type { DataSourceConfig } from '../src/config.js'

/**
 * 多数据源只读查询工具测试。
 * 通过临时 LITE_AI_HOME + __hooks mock fetch/kubectlExec，不依赖真实数据源与网络。
 */
describe('data source query tools', () => {
  let tempRoot: string
  let originalLiteAiHome: string | undefined

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-ds-tools-'))
    originalLiteAiHome = process.env.LITE_AI_HOME
    process.env.LITE_AI_HOME = tempRoot
    await mkdir(tempRoot, { recursive: true })
  })

  after(async () => {
    if (originalLiteAiHome === undefined) {
      delete process.env.LITE_AI_HOME
    } else {
      process.env.LITE_AI_HOME = originalLiteAiHome
    }
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function writeSettings(dataSources: DataSourceConfig[]): Promise<void> {
    await writeFile(
      path.join(tempRoot, 'settings.json'),
      JSON.stringify({ dataSources }, null, 2),
      'utf8',
    )
  }

  async function getMods() {
    const types = await import('../src/tools/data-sources/types.js')
    const es = await import('../src/tools/data-sources/elasticsearch.js')
    const prom = await import('../src/tools/data-sources/prometheus.js')
    const kub = await import('../src/tools/data-sources/kubernetes.js')
    return { types, es, prom, kub }
  }

  // --- 1. 只读标记 ---

  test('三个工具 isReadOnly === true 且 isParallelSafe 返回 true', async () => {
    const { es, prom, kub } = await getMods()
    for (const tool of [es.esQueryTool, prom.promQueryTool, kub.kubectlQueryTool]) {
      assert.equal(tool.isReadOnly, true)
      assert.equal(tool.isParallelSafe?.({}), true)
    }
  })

  // --- 2. 注册表按 type 动态注册 ---

  test('dataSourceToolsetsFor 只注册已配置类型；未配置 ES 不暴露 es_query；gitlab 预留不报错', async () => {
    const { types } = await getMods()
    const tools = types.dataSourceToolsetsFor([
      { name: 'Prometheus metrics', baseUrl: 'http://localhost:19090', type: 'prometheus' },
      { name: 'GitLab', baseUrl: 'https://gitlab.example.com', type: 'gitlab' },
    ])
    const names = tools.map(t => t.name)
    assert.ok(names.includes('prom_query'), 'prom_query 应注册')
    assert.ok(!names.includes('es_query'), '未配置 ES 时不暴露 es_query')
    assert.ok(!names.includes('kubectl_query'), '未配置 K8s 时不暴露 kubectl_query')
  })

  test('dataSourceToolsetsFor 无对应数据源时返回空', async () => {
    const { types } = await getMods()
    const tools = types.dataSourceToolsetsFor([])
    assert.deepEqual(tools, [])
  })

  // --- 3. 子 agent 兼容（isReadOnly 自动进白名单） ---

  test('数据源工具经 subsetForSubAgent 筛选后仍可见', async () => {
    const { types } = await getMods()
    const tools = types.dataSourceToolsetsFor([
      { name: 'Elasticsearch logs', baseUrl: 'http://localhost:19200', type: 'elasticsearch' },
    ])
    const registry = new ToolRegistry(tools)
    const sub = registry.subsetForSubAgent([])
    assert.ok(sub.find('es_query'), 'isReadOnly 工具应进入子 agent 白名单')
    assert.equal(sub.find('run_command'), undefined)
  })

  // --- 4. es_query ---

  test('es_query: q 构造 body 命中 _search；size 夹逼 100；headers 注入 env', async () => {
    await writeSettings([
      {
        name: 'Elasticsearch logs',
        baseUrl: 'http://localhost:19200',
        type: 'elasticsearch',
        headers: { Authorization: '{{ env.ES_KEY }}' },
      },
    ])
    const { types, es } = await getMods()
    const original = types.__hooks.fetch
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }> = []
    types.__hooks.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify({ hits: { total: { value: 1 } } }), { status: 200 })
    }
    process.env.ES_KEY = 'secret-key'
    try {
      const result = await es.esQueryTool.run({ q: 'error AND status:500', size: 500 }, { cwd: tempRoot })
      assert.equal(result.ok, true)
      assert.equal(calls.length, 1)
      assert.match(calls[0]!.url, /\/sock-shop-logs\/_search$/)
      assert.equal(calls[0]!.method, 'POST')
      assert.deepEqual(calls[0]!.body, { query: { query_string: { query: 'error AND status:500' } }, size: 100 })
      assert.equal(calls[0]!.headers!.Authorization, 'secret-key')
      assert.match(result.output, /\[size clamped to 100\]/)
    } finally {
      types.__hooks.fetch = original
      delete process.env.ES_KEY
    }
  })

  test('es_query: dsl 原样透传；hint 索引提取；无 type 时 name 含 elastic 可定位', async () => {
    await writeSettings([
      { name: 'Elasticsearch logs', baseUrl: 'http://localhost:19200', hint: '索引 sock-shop-logs 查询' },
    ])
    const { types, es } = await getMods()
    const original = types.__hooks.fetch
    const calls: Array<{ url: string; body?: unknown }> = []
    types.__hooks.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response('{}', { status: 200 })
    }
    try {
      // hint 索引 + dsl 原样透传（无 type，name 含 elastic 命中）
      const result = await es.esQueryTool.run(
        { dsl: { query: { match_all: {} }, from: 5, size: 20 } },
        { cwd: tempRoot },
      )
      assert.equal(result.ok, true)
      assert.match(calls[0]!.url, /\/sock-shop-logs\/_search$/)
      assert.deepEqual(calls[0]!.body, { query: { match_all: {} }, from: 5, size: 20 })
    } finally {
      types.__hooks.fetch = original
    }
  })

  test('es_query: source 参数选择第二个实例', async () => {
    await writeSettings([
      { name: 'Elasticsearch logs', baseUrl: 'http://localhost:19200', type: 'elasticsearch' },
      { name: 'Elasticsearch archive', baseUrl: 'http://localhost:19201', type: 'elasticsearch' },
    ])
    const { types, es } = await getMods()
    const original = types.__hooks.fetch
    const calls: string[] = []
    types.__hooks.fetch = async url => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }
    try {
      await es.esQueryTool.run({ source: 'Elasticsearch archive', q: 'a' }, { cwd: tempRoot })
      assert.match(calls[0]!, /^http:\/\/localhost:19201\//)
    } finally {
      types.__hooks.fetch = original
    }
  })

  test('es_query: 未配置 ES 数据源时返回 ok:false 并提示', async () => {
    await writeSettings([{ name: 'Prometheus metrics', baseUrl: 'http://localhost:19090' }])
    const { es } = await getMods()
    const result = await es.esQueryTool.run({ q: 'x' }, { cwd: tempRoot })
    assert.equal(result.ok, false)
    assert.match(result.output, /No Elasticsearch data source configured/)
  })

  // --- 5. prom_query ---

  test('prom_query: instant → /api/v1/query；有 start/end → /api/v1/query_range 且带 step', async () => {
    await writeSettings([{ name: 'Prometheus metrics', baseUrl: 'http://localhost:19090', type: 'prometheus' }])
    const { types, prom } = await getMods()
    const original = types.__hooks.fetch
    const calls: string[] = []
    types.__hooks.fetch = async url => {
      calls.push(String(url))
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 })
    }
    try {
      await prom.promQueryTool.run({ query: 'up', instant: true }, { cwd: tempRoot })
      assert.match(calls[0]!, /\/api\/v1\/query\?query=up$/)

      await prom.promQueryTool.run({ query: 'up', start: 0, end: 1500, step: 30 }, { cwd: tempRoot })
      assert.match(calls[1]!, /\/api\/v1\/query_range\?/)
      assert.match(calls[1]!, /step=30/)
    } finally {
      types.__hooks.fetch = original
    }
  })

  test('prom_query: 采样点超 5000 自动调大 step 并标注', async () => {
    await writeSettings([{ name: 'Prometheus metrics', baseUrl: 'http://localhost:19090', type: 'prometheus' }])
    const { types, prom } = await getMods()
    const original = types.__hooks.fetch
    const calls: string[] = []
    types.__hooks.fetch = async url => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }
    try {
      // range = 500000s, step=30 → 16666 点 > 5000 → step 调整为 ceil(500000/5000)=100
      const result = await prom.promQueryTool.run(
        { query: 'up', start: 0, end: 500000, step: 30 },
        { cwd: tempRoot },
      )
      assert.equal(result.ok, true)
      assert.match(calls[0]!, /step=100/)
      assert.match(result.output, /\[step adjusted to 100s/)
    } finally {
      types.__hooks.fetch = original
    }
  })

  test('prom_query: 未配置 Prometheus 数据源时返回 ok:false', async () => {
    await writeSettings([{ name: 'Elasticsearch logs', baseUrl: 'http://localhost:19200' }])
    const { prom } = await getMods()
    const result = await prom.promQueryTool.run({ query: 'up' }, { cwd: tempRoot })
    assert.equal(result.ok, false)
    assert.match(result.output, /No Prometheus data source configured/)
  })

  // --- 6. kubectl_query ---

  test('kubectl_query: 白名单子命令通过，args 数组构造；namespace 缺省 sock-shop', async () => {
    await writeSettings([{ name: 'K8s', baseUrl: 'http://localhost:8001', type: 'kubernetes' }])
    const { types, kub } = await getMods()
    const original = types.__hooks.kubectlExec
    const calls: string[][] = []
    types.__hooks.kubectlExec = async args => {
      calls.push(args)
      return { stdout: 'ok\n', stderr: '' }
    }
    try {
      await kub.kubectlQueryTool.run({ subcommand: 'get', resource: 'pods', output: 'wide' }, { cwd: tempRoot })
      assert.deepEqual(calls[0], ['get', 'pods', '-n', 'sock-shop', '-o', 'wide'])

      await kub.kubectlQueryTool.run({ subcommand: 'version' }, { cwd: tempRoot })
      assert.deepEqual(calls[1], ['version'])

      await kub.kubectlQueryTool.run({ subcommand: 'explain', resource: 'pods' }, { cwd: tempRoot })
      assert.deepEqual(calls[2], ['explain', 'pods'])
    } finally {
      types.__hooks.kubectlExec = original
    }
  })

  test('kubectl_query: logs 默认 tail=50、超 500 夹逼；namespace 可覆盖', async () => {
    await writeSettings([{ name: 'K8s', baseUrl: 'http://localhost:8001', type: 'kubernetes' }])
    const { types, kub } = await getMods()
    const original = types.__hooks.kubectlExec
    const calls: string[][] = []
    types.__hooks.kubectlExec = async args => {
      calls.push(args)
      return { stdout: 'line1\n', stderr: '' }
    }
    try {
      await kub.kubectlQueryTool.run({ subcommand: 'logs', name: 'payment-1' }, { cwd: tempRoot })
      assert.deepEqual(calls[0], ['logs', 'payment-1', '-n', 'sock-shop', '--tail', '50'])

      await kub.kubectlQueryTool.run(
        { subcommand: 'logs', name: 'payment-1', namespace: 'prod', tail: 999 },
        { cwd: tempRoot },
      )
      assert.deepEqual(calls[1], ['logs', 'payment-1', '-n', 'prod', '--tail', '500'])
    } finally {
      types.__hooks.kubectlExec = original
    }
  })

  test('kubectl_query: 非白名单子命令经 schema 校验拒绝', async () => {
    await writeSettings([{ name: 'K8s', baseUrl: 'http://localhost:8001', type: 'kubernetes' }])
    const { kub } = await getMods()
    const registry = new ToolRegistry([kub.kubectlQueryTool])
    const result = await registry.execute('kubectl_query', { subcommand: 'delete', resource: 'pods' }, { cwd: tempRoot })
    assert.equal(result.ok, false)
  })

  test('kubectl_query: logs 缺 name 返回 ok:false', async () => {
    await writeSettings([{ name: 'K8s', baseUrl: 'http://localhost:8001', type: 'kubernetes' }])
    const { kub } = await getMods()
    const result = await kub.kubectlQueryTool.run({ subcommand: 'logs' }, { cwd: tempRoot })
    assert.equal(result.ok, false)
    assert.match(result.output, /requires a pod name/)
  })

  // --- 7. clampToolOutput ---

  test('clampToolOutput 超 200_000 截断并追加标记', async () => {
    const { types } = await getMods()
    const long = 'x'.repeat(200_010)
    const out = types.clampToolOutput(long)
    assert.equal(out, `${'x'.repeat(200_000)}\n[truncated: 200010 chars]`)
  })

  test('clampToolOutput 未超限时原样返回', async () => {
    const { types } = await getMods()
    const short = 'hello'
    assert.equal(types.clampToolOutput(short), short)
  })

  // --- 8. resolveHeaderValue ---

  test('resolveHeaderValue: {{ env.X }} 解析、未命中保留原文', async () => {
    const { resolveHeaderValue } = await import('../src/config.js')
    process.env.DS_TEST_TOKEN = 'tok-123'
    try {
      assert.equal(resolveHeaderValue('{{ env.DS_TEST_TOKEN }}'), 'tok-123')
      assert.equal(resolveHeaderValue('Bearer {{ env.DS_TEST_TOKEN }}'), 'Bearer tok-123')
      assert.equal(resolveHeaderValue('{{ env.DS_MISSING_VAR }}'), '{{ env.DS_MISSING_VAR }}')
      assert.equal(resolveHeaderValue('plain'), 'plain')
    } finally {
      delete process.env.DS_TEST_TOKEN
    }
  })
})
