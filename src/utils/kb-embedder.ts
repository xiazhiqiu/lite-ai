import { existsSync } from 'node:fs'
import path from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

export const EMBEDDING_DIMENSION = 384

let extractor: FeatureExtractionPipeline | null = null
let loadError: Error | null = null

export type EmbeddingAvailability =
  | { ok: true }
  | { ok: false; error: string }

/**
 * 配置 transformers.js 使用本地离线模型（从 ModelScope 下载，国内可达）。
 * - localModelPath 指向包含 `Xenova/all-MiniLM-L6-v2/...` 的父目录。
 * - 关闭远程下载，纯本地加载。
 */
function configuredLocalModelRoot(): string {
  const envRoot = process.env.LITE_AI_EMBED_MODEL_DIR
  if (envRoot && envRoot.trim()) return envRoot.trim()
  // 默认相对项目根目录的 models/embedding（与 scripts/download-embedding-model.mjs 一致）
  return 'models/embedding'
}

function configureEnv(): void {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = configuredLocalModelRoot()
  env.useFS = true
  env.cacheDir = 'models/embedding/.cache'
}

/** 检查 embedding 模型是否就绪（本地模型文件存在）。 */
export function checkEmbeddingAvailability(): EmbeddingAvailability {
  const root = configuredLocalModelRoot()
  const onnxPath = path.join(
    root,
    'Xenova',
    'all-MiniLM-L6-v2',
    'onnx',
    'model.onnx',
  )
  const configPath = path.join(root, 'Xenova', 'all-MiniLM-L6-v2', 'config.json')
  if (!existsSync(onnxPath) || !existsSync(configPath)) {
    return {
      ok: false,
      error:
        `Embedding model file not found under "${root}". ` +
        'Run `node scripts/download-embedding-model.mjs <root>` to fetch it from ModelScope.',
    }
  }
  return { ok: true }
}

async function getExtractor() {
  if (extractor) return extractor
  configureEnv()
  try {
    const pipe = (await pipeline(
      'feature-extraction',
      MODEL_ID,
    )) as FeatureExtractionPipeline
    extractor = pipe
    loadError = null
  } catch (e) {
    loadError = e instanceof Error ? e : new Error(String(e))
    throw loadError
  }
  return extractor
}

/** 生成单条 embedding（384 维 Float32Array）。 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getExtractor()
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  const data = output.data as Float32Array
  return new Float32Array(data)
}

/** 批量生成 embedding。 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getExtractor()
  const results: Float32Array[] = []
  for (const t of texts) {
    const output = await pipe(t, { pooling: 'mean', normalize: true })
    results.push(new Float32Array(output.data as Float32Array))
  }
  return results
}

/** 重置已加载的 extractor（测试隔离用）。 */
export function resetEmbedder(): void {
  extractor = null
  loadError = null
}