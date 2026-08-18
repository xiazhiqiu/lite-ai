import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { LITE_AI_DIR } from '../config.js'

export const VECTOR_DIMENSION = 384

export type KbChunkInput = {
  embedding: Float32Array
  file_path: string
  section_title: string
  content: string
  project_slug: string
  checkpoint_id: string
  /** 可选：事故涉及的服务名（如 payment），用于精确过滤。 */
  service: string
  file_mtime: number
}

export type KbChunk = {
  id: number
  file_path: string
  section_title: string
  content: string
  project_slug: string
  checkpoint_id: string
  service: string
  distance: number
}

/** KB 数据库文件：LITE_AI_HOME/incident-kb/kb.db */
export function kbDbPath(): string {
  return path.join(LITE_AI_DIR, 'incident-kb', 'kb.db')
}

/** sqlite-vec 用 JSON 数字数组字符串表示向量。 */
function vectorToString(v: Float32Array): string {
  return '[' + Array.from(v).join(',') + ']'
}

let dbInstance: Database.Database | null = null

function getDb(): Database.Database {
  if (dbInstance) return dbInstance
  const dbPath = kbDbPath()
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  sqliteVec.load(db)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS incident_vectors USING vec0(
      embedding float[${VECTOR_DIMENSION}]
    );
    CREATE TABLE IF NOT EXISTS incident_chunks (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      section_title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      project_slug TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL DEFAULT '',
      service TEXT NOT NULL DEFAULT '',
      file_mtime INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON incident_chunks(file_path, file_mtime);
  `)
  dbInstance = db
  return db
}

/**
 * 插入向量 + 元数据。
 * sqlite-vec 的 vec0 不能显式写 rowid，须先写入向量拿到自增 rowid，
 * 再用该 rowid 作为 incident_chunks.id 建立关联。
 * 事务内：先按 file 清旧行，再写新行，最后清孤儿向量。
 */
export function insertChunks(chunks: KbChunkInput[]): number {
  if (chunks.length === 0) return 0
  const db = getDb()
  const file = chunks[0].file_path
  const insertVector = db.prepare('INSERT INTO incident_vectors(embedding) VALUES (?)')
  const insertChunk = db.prepare(`
    INSERT INTO incident_chunks
      (id, file_path, section_title, content, project_slug, checkpoint_id, service, file_mtime)
    VALUES (@id, @file_path, @section_title, @content, @project_slug, @checkpoint_id, @service, @file_mtime)
  `)
  const delByFile = db.prepare('DELETE FROM incident_chunks WHERE file_path = ?')
  const delOrphans = db.prepare(
    'DELETE FROM incident_vectors WHERE rowid NOT IN (SELECT id FROM incident_chunks)',
  )

  const tx = db.transaction(() => {
    delByFile.run(file)
    for (const c of chunks) {
      const vInfo = insertVector.run(vectorToString(c.embedding))
      const rowid = Number(vInfo.lastInsertRowid)
      insertChunk.run({
        id: rowid,
        file_path: c.file_path,
        section_title: c.section_title,
        content: c.content,
        project_slug: c.project_slug,
        checkpoint_id: c.checkpoint_id,
        service: c.service,
        file_mtime: c.file_mtime,
      })
    }
    delOrphans.run()
  })
  tx()
  return chunks.length
}

/** 检查某文件是否已按指定 mtime 索引。 */
export function isIndexed(filePath: string, mtime: number): boolean {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT 1 AS found FROM incident_chunks WHERE file_path = ? AND file_mtime = ? LIMIT 1',
    )
    .get(filePath, mtime) as { found: number } | undefined
  return row !== undefined
}

/** 删除某文件的所有 chunk（含向量行）。 */
export function deleteByFile(filePath: string): number {
  const db = getDb()
  const ids = db.prepare('SELECT id FROM incident_chunks WHERE file_path = ?').all(filePath) as Array<{
    id: number
  }>
  for (const { id } of ids) {
    db.prepare('DELETE FROM incident_vectors WHERE rowid = ?').run(id)
  }
  const info = db.prepare('DELETE FROM incident_chunks WHERE file_path = ?').run(filePath)
  return info.changes
}

/** 统计库里已索引的文件数（用于全量补漏判断）。 */
export function countIndexedFiles(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(DISTINCT file_path) AS n FROM incident_chunks').get() as {
    n: number
  }
  return row.n
}

const SELECT_CHUNK =
  'incident_chunks.id, incident_chunks.file_path, incident_chunks.section_title, ' +
  'incident_chunks.content, incident_chunks.project_slug, incident_chunks.checkpoint_id, ' +
  'incident_chunks.service, v.distance'

/** KNN 检索：先对 vec0 做小范围 KNN（LIMIT 池），再外层 JOIN 元数据；可按 service 精确过滤。 */
export function searchKb(
  queryVector: Float32Array,
  options: { n: number; service?: string },
): KbChunk[] {
  const db = getDb()
  const limit = Math.max(1, Math.floor(options.n))
  const service = options.service?.trim()
  const queryBlob = vectorToString(queryVector)

  // service 过滤发生在 JOIN 之后，故检索池需扩大。
  const poolLimit = service ? Math.max(limit * 8, limit) : limit

  const base = `
    FROM (
      SELECT rowid, distance FROM incident_vectors
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    ) v
    JOIN incident_chunks ON incident_chunks.id = v.rowid
  `
  const where = service ? 'WHERE incident_chunks.service = ?' : ''
  const sql = `SELECT ${SELECT_CHUNK} ${base} ${where} ORDER BY v.distance LIMIT ?`
  const params = service
    ? [queryBlob, poolLimit, service, limit]
    : [queryBlob, poolLimit, limit]

  const rows = db.prepare(sql).all(...params) as unknown[]
  return rows.map(r => ({ ...(r as KbChunk) }))
}

/** 关闭数据库连接（测试/生命周期退出时调用）。 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}