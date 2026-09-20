/**
 * 会话存储的类型定义（从 `session.ts` 抽出，供 `store.ts` / `file-store.ts` 共用）。
 * 抽出的目的是避免 store.ts 与 session.ts 形成循环依赖。
 */

/** snip 边界事件的元信息（写入 jsonl 事件信封的 `snipMetadata` 字段）。 */
export type SnipBoundaryMetadata = {
  type: 'snip_boundary'
  removedMessageIds: string[]
  removedCount: number
  tokensFreed: number
  timestamp: string
  createdAt: string
}

/** 会话元信息（`listSessions` 的返回项）。 */
export type SessionMeta = {
  id: string
  title: string | undefined
  messageCount: number
  updatedAt: number
}

/** 项目元信息（`listAllProjects` 的返回项）。 */
export type ProjectMeta = {
  dir: string
  sessionCount: number
  latestUpdatedAt: number
}

/** TUI 回显用的 transcript 条目（`loadTranscript` 的返回项）。 */
export type PersistedTranscriptEntry =
  | { kind: 'user' | 'assistant' | 'progress'; body: string }
  | { kind: 'tool'; body: string; toolName: string; status: 'running' | 'success' | 'error' }
