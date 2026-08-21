import { describe, before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 验证 toolsets 配置会注入系统提示词，使 LiteAI 开箱即用地查询真实数据源。
 * 通过临时 LITE_AI_HOME + 动态 import 隔离真实用户配置。
 */
describe('toolsets prompt injection', () => {
  let tempRoot: string
  let originalLiteAiHome: string | undefined

  before(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-ds-test-'))
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

  async function buildPrompt(cwd: string): Promise<string> {
    const { buildSystemPrompt } = await import('../src/prompt.js')
    return buildSystemPrompt(cwd, [])
  }

  test('不配置 toolsets 时不注入数据源段落', async () => {
    const prompt = await buildPrompt(tempRoot)
    assert.ok(!prompt.includes('实时数据源'))
    assert.ok(!prompt.includes('prometheus_url'))
  })

  test('配置完整 toolsets 后注入可查询的数据源说明', async () => {
    const settingsPath = path.join(tempRoot, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          toolsets: {
            prometheus: {
              enabled: true,
              type: 'prometheus',
              config: { prometheus_url: 'http://localhost:19090' },
            },
            elasticsearch: {
              enabled: true,
              type: 'elasticsearch',
              config: { es_url: 'http://localhost:19200' },
            },
            database: {
              enabled: true,
              type: 'database',
              config: { connection_url: 'mysql://root@localhost:13306/sock_shop' },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const prompt = await buildPrompt(tempRoot)
      assert.match(prompt, /实时数据源/)
      assert.match(prompt, /prometheus、elasticsearch、database/)
      assert.match(prompt, /不要手搓 curl 请求这些数据源/)
    } finally {
      await rm(settingsPath, { force: true })
    }
  })

  test('config 不完整的 toolset 不注入数据源段落', async () => {
    const settingsPath = path.join(tempRoot, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          toolsets: {
            prometheus: {
              enabled: true,
              type: 'prometheus',
              config: {},
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const prompt = await buildPrompt(tempRoot)
      assert.ok(!prompt.includes('实时数据源'))
    } finally {
      await rm(settingsPath, { force: true })
    }
  })
})