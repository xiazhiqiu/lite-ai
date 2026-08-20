import { describe, before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 验证 dataSources 配置会注入系统提示词，使 LiteAI 开箱即用地查询真实数据源。
 * 通过临时 LITE_AI_HOME + 动态 import 隔离真实用户配置。
 */
describe('data sources prompt injection', () => {
  let tempRoot: string
  let originalLiteAiHome: string | undefined
  let originalDir: string

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-ds-test-'))
    originalLiteAiHome = process.env.LITE_AI_HOME
    originalDir = process.cwd()
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

  async function buildPrompt(cwd: string): Promise<string> {
    const { buildSystemPrompt } = await import('../src/prompt.js')
    return buildSystemPrompt(cwd, [])
  }

  test('不配置 dataSources 时不注入数据源段落', async () => {
    const prompt = await buildPrompt(tempRoot)
    assert.ok(!prompt.includes('实时数据源'))
    assert.ok(!prompt.includes('localhost'))
  })

  test('配置 dataSources 后注入可查询的数据源说明', async () => {
    const settingsPath = path.join(tempRoot, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          dataSources: [
            {
              name: 'Prometheus metrics',
              baseUrl: 'http://localhost:19090',
              hint: 'curl /api/v1/query 查询',
            },
            {
              name: 'Elasticsearch logs',
              baseUrl: 'http://localhost:19200',
              hint: '索引 sock-shop-logs',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const prompt = await buildPrompt(tempRoot)
      assert.match(prompt, /实时数据源/)
      assert.match(prompt, /Prometheus metrics: http:\/\/localhost:19090/)
      assert.match(prompt, /Elasticsearch logs: http:\/\/localhost:19200/)
      assert.match(prompt, /curl \/api\/v1\/query 查询/)
      // 引导优先使用结构化只读工具
      assert.match(prompt, /es_query \/ prom_query \/ kubectl_query/)
      assert.match(prompt, /无需拼 curl/)
      // 要求模型走数据源，不读原始 CSV
      assert.match(prompt, /不要 Read 数据集原始 CSV/)
    } finally {
      await rm(settingsPath, { force: true })
    }
  })
})