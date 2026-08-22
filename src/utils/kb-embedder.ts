import { existsSync } from 'node:fs'
import path from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { embeddingDimension } from '../config.js'

export type EmbedderMode = 'api' | 'local'

export type EmbedderConfig = {
  mode: EmbedderMode
  /** 远程 API 模式：OpenAI 兼容 embeddings 端点。 */
  url?: string
  apiKey?: string
  model?: string
  /** 本地模型模式（transformers.js）。 */
  modelId: string
  modelRoot: string
}

/**
 * 资源上限：防止超大/超多文本导致 embedding 成本失控或模型 token 截断异常。
 * - 单条文本过长时先截断（embedding 模型通常有 token 上限）。
 * - 批量嵌入时按 EMBED_BATCH_MAX 分批，返回顺序与条数不变。
 */
const EMBED_TEXT_MAX_CHARS = 16_000
const EMBED_BATCH_MAX = 32

function capText(text: string): string {
  if (text.length <= EMBED_TEXT_MAX_CHARS) return text
  return text.slice(0, EMBED_TEXT_MAX_CHARS)
}

/**
 * 决定 embedding 来源，优先级从高到低：
 * 1. 设置 LITE_AI_EMBED_API_URL → 使用用户自己的在线 embedding API。
 * 2. 否则使用本地模型：LITE_AI_EMBED_MODEL_ID 指定模型（默认 Xenova/all-MiniLM-L6-v2），
 *    LITE_AI_EMBED_MODEL_DIR 指定模型根目录（默认 models/embedding）。
 */
export function embeddingConfig(): EmbedderConfig {
  const apiUrl = process.env.LITE_AI_EMBED_API_URL?.trim()
  if (apiUrl) {
    return {
      mode: 'api',
      url: apiUrl,
      apiKey: process.env.LITE_AI_EMBED_API_KEY?.trim() || undefined,
      model: process.env.LITE_AI_EMBED_MODEL?.trim() || 'text-embedding-3-small',
      modelId: '',
      modelRoot: '',
    }
  }
  const modelId = process.env.LITE_AI_EMBED_MODEL_ID?.trim() || 'Xenova/all-MiniLM-L6-v2'
  const modelRoot = process.env.LITE_AI_EMBED_MODEL_DIR?.trim() || 'models/embedding'
  return { mode: 'local', modelId, modelRoot }
}

export type EmbeddingAvailability =
  | { ok: true }
  | { ok: false; error: string }

/**
 * 检查所选 embedding 来源是否就绪。
 * - API 模式：只要配置了端点即视为就绪；真实调用错误在 embed 阶段暴露。
 * - 本地模式：校验模型文件是否存在（基于用户配置的 modelId/modelRoot）。
 */
export function checkEmbeddingAvailability(): EmbeddingAvailability {
  const cfg = embeddingConfig()
  if (cfg.mode === 'api') {
    return { ok: true }
  }
  const modelDir = path.join(cfg.modelRoot, ...cfg.modelId.split('/'))
  const onnxPath = path.join(modelDir, 'onnx', 'model.onnx')
  const configPath = path.join(modelDir, 'config.json')
  if (!existsSync(onnxPath) || !existsSync(configPath)) {
    return {
      ok: false,
      error:
        `Local embedding model "${cfg.modelId}" not found under "${cfg.modelRoot}". ` +
        `Either set LITE_AI_EMBED_API_URL to use your own embedding API, ` +
        `or place the model at "${path.join(cfg.modelRoot, ...cfg.modelId.split('/'))}" ` +
        `(model id via LITE_AI_EMBED_MODEL_ID, root via LITE_AI_EMBED_MODEL_DIR).`,
    }
  }
  return { ok: true }
}

/**
 * 维度校验：写入/检索前确认向量维度与向量库一致。
 * 维度通过 LITE_AI_EMBED_DIMENSION 配置，默认 384，不一致时给出明确报错。
 */
function assertDimension(vec: Float32Array): Float32Array {
  const dim = embeddingDimension()
  if (vec.length === dim) return vec
  throw new Error(
    `Embedding dimension ${vec.length} does not match knowledge base dimension ${dim}. ` +
      `Set LITE_AI_EMBED_DIMENSION=${vec.length} to use this model.`,
  )
}

/** 远程 API 模式：POST {model, input: string[]} 到 OpenAI 兼容 embeddings 端点。 */
async function embedRemoteBatch(
  texts: string[],
  cfg: EmbedderConfig,
): Promise<Float32Array[]> {
  const res = await fetch(cfg.url!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, input: texts.map(capText) }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const detail = body ? `: ${body.slice(0, 300)}` : ''
    throw new Error(`Embedding API ${res.status} ${res.statusText}${detail}`)
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> }
  if (!Array.isArray(json.data) || json.data.length !== texts.length) {
    throw new Error('Embedding API response missing expected "data" array.')
  }
  return json.data.map(item => assertDimension(new Float32Array(item.embedding)))
}

// ---- 本地模型（transformers.js）：加载与缓存 ----

const DEFAULT_LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

let extractor: FeatureExtractionPipeline | null = null
let loadError: Error | null = null

function configureEnv(modelRoot: string): void {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = modelRoot
  env.useFS = true
  env.cacheDir = path.join(modelRoot, '.cache')
}

async function getExtractor(modelId: string, modelRoot: string) {
  if (extractor) return extractor
  configureEnv(modelRoot)
  try {
    extractor = (await pipeline('feature-extraction', modelId)) as FeatureExtractionPipeline
    loadError = null
  } catch (e) {
    loadError = e instanceof Error ? e : new Error(String(e))
    throw loadError
  }
  return extractor
}

async function embedLocalSingle(text: string, modelId: string, modelRoot: string): Promise<Float32Array> {
  const pipe = await getExtractor(modelId, modelRoot)
  const output = await pipe(capText(text), { pooling: 'mean', normalize: true })
  return assertDimension(new Float32Array(output.data as Float32Array))
}

async function embedLocalBatch(
  texts: string[],
  modelId: string,
  modelRoot: string,
): Promise<Float32Array[]> {
  const pipe = await getExtractor(modelId, modelRoot)
  const results: Float32Array[] = []
  for (const t of texts) {
    const output = await pipe(capText(t), { pooling: 'mean', normalize: true })
    results.push(assertDimension(new Float32Array(output.data as Float32Array)))
  }
  return results
}

/** 生成单条 embedding。 */
export async function embed(text: string): Promise<Float32Array> {
  const cfg = embeddingConfig()
  if (cfg.mode === 'api') return (await embedRemoteBatch([text], cfg))[0]!
  return embedLocalSingle(text, cfg.modelId || DEFAULT_LOCAL_MODEL_ID, cfg.modelRoot)
}

/** 批量生成 embedding（自动分批，保持顺序与条数不变）。 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const cfg = embeddingConfig()
  const batch = (t: string[]) =>
    cfg.mode === 'api' ? embedRemoteBatch(t, cfg) : embedLocalBatch(t, cfg.modelId || DEFAULT_LOCAL_MODEL_ID, cfg.modelRoot)
  const results: Float32Array[] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH_MAX) {
    results.push(...(await batch(texts.slice(i, i + EMBED_BATCH_MAX))))
  }
  return results
}

/** 重置已加载的本地 extractor（测试隔离用）。 */
export function resetEmbedder(): void {
  extractor = null
  loadError = null
}