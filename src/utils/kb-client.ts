import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { LITE_AI_DIR } from '../config.js'
import { postmortemFilePath } from '../tools/generate-postmortem.js'
import { isEnoentError } from './errors.js'
import { chunkMarkdown, type Chunk } from './kb-chunker.js'
import { checkEmbeddingAvailability, embed, embedBatch } from './kb-embedder.js'
import {
  closeDb,
  countIndexedFiles,
  deleteByFile,
  insertChunks,
  isIndexed,
  searchKb,
  type KbChunkInput,
} from './kb-store.js'

export type KbSearchResult = {
  file: string
  section: string
  content: string
  service: string
  project_slug: string
  checkpoint_id: string
  distance: number
}

export type KbIndexResult = {
  status: 'indexed' | 'skipped'
  chunks: number
  file: string
}

export function postmortemsDir(): string {
  return path.join(LITE_AI_DIR, 'postmortems')
}

/** 文件名形如 {projectSlug}-{checkpointId}.md，拆分 project_slug 与 checkpoint_id。 */
function parseFileSlug(filePath: string): { project_slug: string; checkpoint_id: string } {
  const base = path.basename(filePath).replace(/\.md$/, '')
  const sep = base.lastIndexOf('-')
  if (sep <= 0) return { project_slug: base, checkpoint_id: '' }
  return { project_slug: base.slice(0, sep), checkpoint_id: base.slice(sep + 1) }
}

/** 索引单个 postmortem 文件。若文件已按相同 mtime 索引则跳过。 */
export async function indexPostmortem(filePath: string): Promise<KbIndexResult> {
  const statInfo = await stat(filePath)
  const mtime = Math.floor(statInfo.mtimeMs)
  if (isIndexed(filePath, mtime)) {
    return { status: 'skipped', chunks: 0, file: filePath }
  }

  const md = await readFile(filePath, 'utf8')
  const chunks = chunkMarkdown(md)
  const texts = chunks.map(c => (c.section_title ? `## ${c.section_title}\n${c.content}` : c.content))
  const embeddings = await embedBatch(texts)

  const inputs: KbChunkInput[] = chunks.map((c: Chunk, i) => ({
    embedding: embeddings[i],
    file_path: filePath,
    section_title: c.section_title,
    content: c.content,
    project_slug: parseFileSlug(filePath).project_slug,
    checkpoint_id: parseFileSlug(filePath).checkpoint_id,
    service: '',
    file_mtime: mtime,
  }))

  insertChunks(inputs)
  return { status: 'indexed', chunks: inputs.length, file: filePath }
}

/** 全量扫描 postmortems 目录，补齐未索引或已变更的文件。返回处理的文件数。 */
export async function reindexAll(
  dir: string = postmortemsDir(),
): Promise<{ status: string; files: number; chunks: number }> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    if (isEnoentError(e)) {
      return { status: 'ok', files: 0, chunks: 0 }
    }
    throw e
  }

  let files = 0
  let chunks = 0
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const filePath = path.join(dir, name)
    try {
      const result = await indexPostmortem(filePath)
      if (result.status === 'indexed') {
        files += 1
        chunks += result.chunks
      }
    } catch (e) {
      // 单文件失败不阻断整体
      void e
    }
  }
  return { status: 'ok', files, chunks }
}

/** 语义检索相似历史事故。 */
export async function searchIncidentKb(
  query: string,
  options: { n?: number; service?: string } = {},
): Promise<KbSearchResult[]> {
  const qVector = await embed(query)
  const results = searchKb(qVector, {
    n: options.n ?? 5,
    service: options.service?.trim() || undefined,
  })
  return results.map(r => ({
    file: r.file_path,
    section: r.section_title,
    content: r.content,
    service: r.service,
    project_slug: r.project_slug,
    checkpoint_id: r.checkpoint_id,
    distance: r.distance,
  }))
}

/** 检查 KB 端到端可用（本地模型 + sqlite-vec）。 */
export function checkKbAvailable(): {
  ok: boolean
  modelError?: string
  indexedFiles: number
} {
  const model = checkEmbeddingAvailability()
  let indexedFiles = 0
  if (model.ok) {
    try {
      indexedFiles = countIndexedFiles()
    } catch {
      indexedFiles = 0
    }
  }
  return {
    ok: model.ok,
    modelError: model.ok ? undefined : model.error,
    indexedFiles,
  }
}

/** 删除某 postmortem 的索引（文件被删除时清理幽灵结果）。 */
export function unindexPostmortem(filePath: string): number {
  return deleteByFile(filePath)
}

export { closeDb }
export { postmortemFilePath }