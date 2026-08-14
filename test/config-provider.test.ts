import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeConfig } from '../src/config.js'

describe('provider resolution', () => {
  it('resolveProviderName maps openai and falls back to anthropic', async () => {
    const { resolveProviderName } = await import('../src/config.js')
    assert.equal(resolveProviderName('openai'), 'openai')
    assert.equal(resolveProviderName('OPENAI'), 'openai')
    assert.equal(resolveProviderName(undefined), 'anthropic')
    assert.equal(resolveProviderName('weird'), 'anthropic')
    assert.equal(resolveProviderName('anthropic'), 'anthropic')
  })
})

describe('loadRuntimeConfig provider branching', () => {
  const savedEnv = new Map<string, string | undefined>()
  const envKeys = [
    'LITE_AI_HOME',
    'LITE_AI_PROVIDER',
    'LITE_AI_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
  ]

  function snapshotEnv(): void {
    savedEnv.clear()
    for (const key of envKeys) {
      savedEnv.set(key, process.env[key])
    }
  }

  function restoreEnv(): void {
    for (const key of envKeys) {
      const value = savedEnv.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }

  async function loadRuntimeConfig(): Promise<RuntimeConfig> {
    const { loadRuntimeConfig } = await import('../src/config.js')
    return loadRuntimeConfig()
  }

  it('uses OpenAI branch when provider=openai', async () => {
    snapshotEnv()
    const temp = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-test-'))
    process.env.LITE_AI_HOME = temp
    try {
      process.env.LITE_AI_PROVIDER = 'openai'
      process.env.LITE_AI_MODEL = 'deepseek-v4'
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
      process.env.OPENAI_API_KEY = 'openai-key'
      process.env.ANTHROPIC_BASE_URL = 'https://anthropic.test'
      process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-token'

      const runtime = await loadRuntimeConfig()

      assert.equal(runtime.provider, 'openai')
      assert.equal(runtime.model, 'deepseek-v4')
      assert.equal(runtime.baseUrl, 'https://api.deepseek.com/v1')
      assert.equal(runtime.apiKey, 'openai-key')
      assert.equal(runtime.authToken, undefined)
    } finally {
      restoreEnv()
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('keeps Anthropic branch by default', async () => {
    snapshotEnv()
    const temp = await mkdtemp(path.join(os.tmpdir(), 'lite-ai-test-'))
    process.env.LITE_AI_HOME = temp
    try {
      delete process.env.LITE_AI_PROVIDER
      process.env.LITE_AI_MODEL = 'claude-sonnet'
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
      process.env.OPENAI_API_KEY = 'openai-key'
      process.env.ANTHROPIC_BASE_URL = 'https://anthropic.test'
      process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-token'

      const runtime = await loadRuntimeConfig()

      assert.equal(runtime.provider, 'anthropic')
      assert.equal(runtime.model, 'claude-sonnet')
      assert.equal(runtime.baseUrl, 'https://anthropic.test')
      assert.equal(runtime.authToken, 'anthropic-token')
      assert.equal(runtime.apiKey, undefined)
    } finally {
      restoreEnv()
      await rm(temp, { recursive: true, force: true })
    }
  })
})