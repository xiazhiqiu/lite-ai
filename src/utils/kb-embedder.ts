import { existsSync } from 'node:fs'
import path from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

/** 知识库向量库固定维度。更换 embedding 模型时需保持一致（否则需重建知识库）。 */
export const EMBEDDING_DIMENSION = 384

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
 * 维度校验：sqlite-vec 向量表维度固定。
 * 不同维度会导致 KNN 检索/写入失败，这里给出明确报错而非底层异常。
 */
function assertDimension(vec: Float32Array): never | Float32Array {
  if (vec.length === EMBEDDING_DIMENSION) return vec
  throw new Error(
    `Embedding dimension ${vec.length} does not match knowledge base dimension ${EMBEDDING_DIMENSION}. ` +
      'Use a model consistent with the KB, or clear and rebuild the KB.',
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
    body: JSON.stringify({ model: cfg.model, input: texts }),
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
  const output = await pipe(text, { pooling: 'mean', normalize: true })
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
    const output = await pipe(t, { pooling: 'mean', normalize: true })
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

/** 批量生成 embedding。 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const cfg = embeddingConfig()
  if (cfg.mode === 'api') return embedRemoteBatch(texts, cfg)
  return embedLocalBatch(texts, cfg.modelId || DEFAULT_LOCAL_MODEL_ID, cfg.modelRoot)
}

/** 重置已加载的本地 extractor（测试隔离用）。 */
export function resetEmbedder(): void {
  extractor = null
  loadError = null
}