import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ORIG = {
  API_URL: process.env.LITE_AI_EMBED_API_URL,
  API_KEY: process.env.LITE_AI_EMBED_API_KEY,
  MODEL: process.env.LITE_AI_EMBED_MODEL,
  MODEL_ID: process.env.LITE_AI_EMBED_MODEL_ID,
  MODEL_DIR: process.env.LITE_AI_EMBED_MODEL_DIR,
}

function resetEnv() {
  delete process.env.LITE_AI_EMBED_API_URL
  delete process.env.LITE_AI_EMBED_API_KEY
  delete process.env.LITE_AI_EMBED_MODEL
  delete process.env.LITE_AI_EMBED_MODEL_ID
  delete process.env.LITE_AI_EMBED_MODEL_DIR
}

test('embeddingConfig: 设置 LITE_AI_EMBED_API_URL 时走远程 API 模式', async () => {
  resetEnv()
  process.env.LITE_AI_EMBED_API_URL = 'https://embed.example/v1/embeddings'
  process.env.LITE_AI_EMBED_API_KEY = 'sk-test'
  process.env.LITE_AI_EMBED_MODEL = 'my-embed'
  const { embeddingConfig } = await import('../src/utils/kb-embedder.js')
  const cfg = embeddingConfig()
  assert.equal(cfg.mode, 'api')
  assert.equal(cfg.url, 'https://embed.example/v1/embeddings')
  assert.equal(cfg.apiKey, 'sk-test')
  assert.equal(cfg.model, 'my-embed')
})

test('embeddingConfig: 未配置 API 时默认本地模型，模型 ID/目录可覆盖', async () => {
  resetEnv()
  const { embeddingConfig } = await import('../src/utils/kb-embedder.js')
  let cfg = embeddingConfig()
  assert.equal(cfg.mode, 'local')
  assert.equal(cfg.modelId, 'Xenova/all-MiniLM-L6-v2')
  assert.equal(cfg.modelRoot, 'models/embedding')

  process.env.LITE_AI_EMBED_MODEL_ID = 'some/other-model'
  process.env.LITE_AI_EMBED_MODEL_DIR = '/tmp/my-models'
  cfg = embeddingConfig()
  assert.equal(cfg.mode, 'local')
  assert.equal(cfg.modelId, 'some/other-model')
  assert.equal(cfg.modelRoot, '/tmp/my-models')
})

test('checkEmbeddingAvailability: API 模式视为就绪；本地模型缺失时给出明确错误', async () => {
  const { checkEmbeddingAvailability } = await import('../src/utils/kb-embedder.js')

  process.env.LITE_AI_EMBED_API_URL = 'https://embed.example/v1/embeddings'
  assert.deepEqual(checkEmbeddingAvailability(), { ok: true })

  // 本地模式「缺失」分支：先清掉上方设置的 API_URL（否则会走 API 模式），
  // 再把模型目录指向一个确定不存在的空目录，避免依赖默认路径恰好无模型。
  resetEnv()
  const missRoot = await mkdtemp(path.join(os.tmpdir(), 'embed-miss-'))
  process.env.LITE_AI_EMBED_MODEL_ID = 'some/absent-model'
  process.env.LITE_AI_EMBED_MODEL_DIR = missRoot
  const miss = checkEmbeddingAvailability()
  assert.equal(miss.ok, false)
  if (miss.ok === false) {
    assert.match(miss.error, /LITE_AI_EMBED_API_URL/)
    assert.match(miss.error, /LITE_AI_EMBED_MODEL_ID/)
  }

  // 本地模型实际就位 → ok
  const root = await mkdtemp(path.join(os.tmpdir(), 'embed-root-'))
  const modelDir = path.join(root, 'my', 'model')
  await mkdir(path.join(modelDir, 'onnx'), { recursive: true })
  await writeFile(path.join(modelDir, 'onnx', 'model.onnx'), 'x')
  await writeFile(path.join(modelDir, 'config.json'), '{}')
  process.env.LITE_AI_EMBED_MODEL_ID = 'my/model'
  process.env.LITE_AI_EMBED_MODEL_DIR = root
  assert.deepEqual(checkEmbeddingAvailability(), { ok: true })
  await rm(root, { recursive: true, force: true })
  await rm(missRoot, { recursive: true, force: true })
})

test('embeddingDimension: 默认 384，可由 LITE_AI_EMBED_DIMENSION 覆盖，非法值抛错', async () => {
  const { embeddingDimension } = await import('../src/config.js')
  const prev = process.env.LITE_AI_EMBED_DIMENSION

  delete process.env.LITE_AI_EMBED_DIMENSION
  assert.equal(embeddingDimension(), 384)

  process.env.LITE_AI_EMBED_DIMENSION = '768'
  assert.equal(embeddingDimension(), 768)

  process.env.LITE_AI_EMBED_DIMENSION = 'abc'
  assert.throws(() => embeddingDimension(), /positive integer/)

  if (prev === undefined) delete process.env.LITE_AI_EMBED_DIMENSION
  else process.env.LITE_AI_EMBED_DIMENSION = prev
})

// 恢复环境
process.on('exit', () => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[`LITE_AI_EMBED_${k}`]
    else process.env[`LITE_AI_EMBED_${k}`] = v
  }
})