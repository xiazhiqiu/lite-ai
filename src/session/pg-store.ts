/**
 * 会话存储的 **PG 实现**（T8）—— `SessionStore` 的第二个后端。
 *
 * ## 设计核心：**事件信封是唯一真源**，列是从它派生的投影
 *
 * 文件实现落盘的是 JSONL，每行一个**事件信封**（`SessionEvent`）。PG 表
 * （`schema.sql` 的 `sessions`）把信封里常用的字段**显式成列**（`type` /
 * `role` / `parent_uuid` 之类便于索引查询），同时保留 `event` JSONB 存**信封全文**。
 *
 * 写路径：`event` JSONB 是权威，其余列从它派生（不手工 mapping 两次）。
 * 读路径：**直接反序列化 `event`**，完全走文件实现那套纯函数
 * （`reconstructSnippedEvents` / 找最后一个 compact_boundary / …）。
 *
 * 这样做的好处是硬的：**"两种实现语义等价"由同一个来源保证**，而不是靠
 * 两份手写的字段映射维持一致 —— 后者只要有人加了信封字段忘了同步，就会
 * 产生"只在 PG 形态下复现"的诡异 bug。
 *
 * ## append-only 与 seq
 *
 * `seq` 是 `(cwd, session_id)` **作用域内**自 1 递增（对齐 JSONL 的行号语义）。
 * 与 `job_events` 同一手法：`COALESCE(MAX(seq), 0) + 1` 在**单条 INSERT 语句内**算出，
 * 且 `PRIMARY KEY (cwd, session_id, seq)` 挡住并发重复 —— 调用方重试即可。
 *
 * `save()` 的去重语义（对齐文件实现 `file-store.ts:242-253`）：
 * - 跳过 `messages[0]`（system 消息**不落盘**，与 JSONL 一致）；
 * - 已有 `id` 且库里已存在 → 跳过（幂等重放）；
 * - 已有 `id` 但库里没有 → 写入；
 * - 无 `id` → 退回"按位置判断"（`index >= alreadySavedCount`）。
 *
 * 关键：**文件实现是"读整个文件算已有 uuid 集合"，PG 用一条 SELECT 等价替换**。
 * 语义必须一致，否则同一段对话在两种后端下会落出不同条数。
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ChatMessage } from '../types.js'
import {
  createContextCollapseState,
  type CollapseSpan,
  type ContextCollapseState,
} from '../compact/context-collapse.js'
import type { SessionStore } from './store.js'
import type {
  PersistedTranscriptEntry,
  ProjectMeta,
  SessionMeta,
  SnipBoundaryMetadata,
} from './types.js'

const MAX_TITLE_LENGTH = 60

/** 与文件实现同名的 `EventType`（这里只用于类型约束，值由信封决定）。 */
type EventType =
  | 'system' | 'user' | 'assistant' | 'thinking' | 'progress' | 'tool_call' | 'tool_result'
  | 'summary' | 'compact_boundary' | 'snip_boundary' | 'context_collapse' | 'rename'

/**
 * 事件信封 —— 与 `file-store.ts:32-46` 的 `SessionEvent` **逐字段等价**。
 *
 * 为什么两处各写一份而不共享：这是**持久化格式**，格式一旦发布就要求稳定；
 * 共享类型会让"改文件实现的结构体"看起来是无害重构，实则改了落盘协议。
 * 各写一份 + 有契约测试守等价，是更安全的选择。
 */
type SessionEvent = {
  type: EventType
  message?: ChatMessage
  uuid: string
  timestamp: string
  sessionId: string
  cwd: string
  parentUuid: string | null
  logicalParentUuid?: string | null
  subtype?: string
  compactMetadata?: { trigger: string; preTokens: number; postTokens: number }
  snipMetadata?: SnipBoundaryMetadata
  contextCollapseSpan?: CollapseSpan
  title?: string
}

type SessionRow = {
  cwd: string
  session_id: string
  seq: number | string
  type: string
  role: string
  content: unknown
  event: SessionEvent | null
  created_at: number | string
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : Number(value)
}

/** role → 事件类型（**逐行复制** `file-store.ts:71-84`，契约测试守等价）。 */
function roleToType(role: string): EventType {
  switch (role) {
    case 'system': return 'system'
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'assistant_thinking': return 'thinking'
    case 'assistant_progress': return 'progress'
    case 'assistant_tool_call': return 'tool_call'
    case 'tool_result': return 'tool_result'
    case 'context_summary': return 'summary'
    case 'snip_boundary': return 'snip_boundary'
    default: return 'user'
  }
}

function ensureMessageId(message: ChatMessage): string {
  if (message.id) return message.id
  message.id = randomUUID()
  return message.id
}

/** 造一个消息事件信封（等价 `file-store.ts:92-114` 的 `wrapEvent`）。 */
function wrapEvent(
  message: ChatMessage,
  sessionId: string,
  cwd: string,
  parentUuid: string | null,
): SessionEvent {
  const uuid = ensureMessageId(message)
  const event: SessionEvent = {
    type: roleToType(message.role),
    message,
    uuid,
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
    parentUuid,
  }
  if (message.role === 'snip_boundary') {
    event.snipMetadata = {
      type: 'snip_boundary',
      removedMessageIds: message.removedMessageIds,
      removedCount: message.removedCount,
      tokensFreed: message.tokensFreed,
      timestamp: event.timestamp,
      createdAt: event.timestamp,
    }
  }
  return event
}

function unwrapMessage(event: SessionEvent): ChatMessage | null {
  if (event.message) return { ...event.message, id: event.uuid } as ChatMessage
  return null
}

/**
 * 把被 snip 删掉的消息**位置**还原成 snip 标记。
 *
 * **逐行搬自** `file-store.ts:131-174`。存成纯函数而非复用导出的那份：
 * `file-store.ts` 没有导出它，而导出会扩大其模块的公开面。契约测试保证两份等价。
 */
function reconstructSnippedEvents(events: SessionEvent[]): SessionEvent[] {
  const snipEvents = events.filter(event => (
    event.type === 'snip_boundary' &&
    event.snipMetadata &&
    event.snipMetadata.removedMessageIds.length > 0
  ))
  if (snipEvents.length === 0) return events

  const removedIdToSnips = new Map<string, SessionEvent[]>()
  for (const snip of snipEvents) {
    for (const removedId of snip.snipMetadata!.removedMessageIds) {
      const existing = removedIdToSnips.get(removedId) ?? []
      existing.push(snip)
      removedIdToSnips.set(removedId, existing)
    }
  }

  const insertedSnips = new Set<string>()
  const result: SessionEvent[] = []

  for (const event of events) {
    if (event.type === 'snip_boundary') continue

    const snipsForRemovedEvent = removedIdToSnips.get(event.uuid) ?? []
    if (snipsForRemovedEvent.length > 0) {
      for (const snip of snipsForRemovedEvent) {
        if (!insertedSnips.has(snip.uuid)) {
          result.push(snip)
          insertedSnips.add(snip.uuid)
        }
      }
      continue
    }
    result.push(event)
  }
  return result
}

/** 从事件序列提取标题（等价 `file-store.ts:176-195`）：rename 事件优先，否则首条 user 消息。 */
function extractTitleFromEvents(events: SessionEvent[]): string | undefined {
  let renameTitle: string | undefined
  for (const event of events) {
    if (event.type === 'rename' && typeof event.title === 'string') {
      renameTitle = event.title
    }
  }
  if (renameTitle) return renameTitle

  for (const event of events) {
    if (event.type !== 'user') continue
    const content = (event.message as { content?: unknown } | null)?.content
    if (typeof content !== 'string' || !content.trim()) continue
    const text = content.trim()
    return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH) + '...' : text
  }
  return undefined
}

/** 找最后一个 compact_boundary 之后的事件（`load` 与 `loadContextCollapseState` 共用）。 */
function activeAfterLastCompact(events: SessionEvent[]): SessionEvent[] {
  let lastBoundaryIndex = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'compact_boundary') {
      lastBoundaryIndex = i
      break
    }
  }
  return events.slice(lastBoundaryIndex + 1)
}

export function createPgSessionStore(pool: pg.Pool): SessionStore {
  /** 读某会话的全部事件（按 seq 升序）。 */
  const readEvents = async (cwd: string, sessionId: string): Promise<SessionEvent[]> => {
    const { rows } = await pool.query<SessionRow>(
      `SELECT * FROM sessions WHERE cwd = $1 AND session_id = $2 ORDER BY seq`,
      [cwd, sessionId],
    )
    // `event` 为准；极老/手工插入的行可能没有 event → 用列重建一个最小信封兜底
    return rows.map(row =>
      row.event ?? {
        type: row.type as EventType,
        message: row.content as ChatMessage,
        uuid: '',
        timestamp: new Date(Number(row.created_at)).toISOString(),
        sessionId,
        cwd,
        parentUuid: null,
      },
    )
  }

  /**
   * 追加一批事件（**单条语句**，seq 在同一快照内连续）。
   *
   * 为什么必须单条语句：`MAX(seq)+1` 现算，逐条 INSERT 会让并发写者插进中间，
   * 整批 seq 被打散甚至主键冲突（半批写入）。与 `jobs/pg-store.ts:216` 同一手法。
   */
  const appendEvents = async (
    cwd: string,
    sessionId: string,
    events: SessionEvent[],
    userId: string | null = null,
  ): Promise<void> => {
    if (events.length === 0) return
    const types = events.map(e => e.type)
    const roles = events.map(e => String(e.message?.role ?? e.type))
    const contents = events.map(e => JSON.stringify(e.message ?? {}))
    const payloads = events.map(e => JSON.stringify(e))
    const createdAt = events.map(() => Date.now())
    const userIds = events.map(() => userId)

    await pool.query(
      `WITH base AS (
         SELECT COALESCE((SELECT MAX(seq) FROM sessions WHERE cwd = $1 AND session_id = $2), 0) AS max_seq
       ), input AS (
         SELECT type, role, content, event, created_at, user_id, ordinality
           FROM unnest($3::text[], $4::text[], $5::jsonb[], $6::jsonb[], $7::bigint[], $8::text[])
                WITH ORDINALITY AS t(type, role, content, event, created_at, user_id, ordinality)
       )
       INSERT INTO sessions (cwd, session_id, seq, type, role, content, event, created_at, user_id)
       SELECT $1, $2, base.max_seq + input.ordinality, input.type, input.role,
              input.content, input.event, input.created_at, input.user_id
         FROM input CROSS JOIN base`,
      [cwd, sessionId, types, roles, contents, payloads, createdAt, userIds],
    )
  }

  return {
    async save(
      cwd: string,
      sessionId: string,
      messages: ChatMessage[],
      alreadySavedCount: number = 0,
    ): Promise<void> {
      // 已有 uuid 集合 —— 等价文件实现的 `readExistingEventUuids`（读整个文件）
      const { rows } = await pool.query<{ uuid: string }>(
        `SELECT event->>'uuid' AS uuid FROM sessions
          WHERE cwd = $1 AND session_id = $2 AND event->>'uuid' IS NOT NULL`,
        [cwd, sessionId],
      )
      const existingIds = new Set(rows.map(r => r.uuid))

      // 跳过 messages[0]（system）—— 与文件实现 `file-store.ts:243` 一致
      const nonSystemMessages = messages.slice(1)
      const toSave = nonSystemMessages.filter((message, index) => {
        if (message.id && existingIds.has(message.id)) return false
        if (message.id && !existingIds.has(message.id)) return true
        return index >= alreadySavedCount
      })
      if (toSave.length === 0) return

      // parentUuid 链：接在库里最后一个事件的 uuid 之后
      const { rows: lastRows } = await pool.query<{ uuid: string | null }>(
        `SELECT event->>'uuid' AS uuid FROM sessions
          WHERE cwd = $1 AND session_id = $2
          ORDER BY seq DESC LIMIT 1`,
        [cwd, sessionId],
      )
      let parentUuid = lastRows[0]?.uuid ?? null

      const events: SessionEvent[] = []
      for (const message of toSave) {
        const event = wrapEvent(message, sessionId, cwd, parentUuid)
        parentUuid = event.uuid
        events.push(event)
      }
      await appendEvents(cwd, sessionId, events)
    },

    async load(cwd: string, sessionId: string): Promise<ChatMessage[] | null> {
      try {
        const events = await readEvents(cwd, sessionId)
        if (events.length === 0) return null

        const active = activeAfterLastCompact(events)
        const messages: ChatMessage[] = []
        for (const event of reconstructSnippedEvents(active)) {
          const msg = unwrapMessage(event)
          if (msg) messages.push(msg)
        }
        return messages.length > 0 ? messages : null
      } catch {
        return null
      }
    },

    async clear(cwd: string, sessionId: string): Promise<void> {
      // 不存在不报错 —— DELETE 影响 0 行天然满足
      await pool.query('DELETE FROM sessions WHERE cwd = $1 AND session_id = $2', [
        cwd,
        sessionId,
      ])
    },

    async list(cwd: string): Promise<SessionMeta[]> {
      // 聚合在 SQL 里做（会话数可能上千，拉全量明细到 JS 再分组是浪费）
      const { rows } = await pool.query<{
        session_id: string
        message_count: string | number
        updated_at: string | number
      }>(
        `SELECT session_id,
                COUNT(*)        AS message_count,
                MAX(created_at) AS updated_at
           FROM sessions
          WHERE cwd = $1
          GROUP BY session_id
          ORDER BY MAX(created_at) DESC`,
        [cwd],
      )

      const results: SessionMeta[] = []
      for (const row of rows) {
        // 标题要扫全部事件（rename 可能在任何位置），所以按会话再查一次。
        // 会话数有限，这样比把全部事件拉进内存再分组更省。
        const events = await readEvents(cwd, row.session_id)
        results.push({
          id: row.session_id,
          title: extractTitleFromEvents(events),
          messageCount: toNumber(row.message_count) ?? 0,
          updatedAt: toNumber(row.updated_at) ?? 0,
        })
      }
      return results
    },

    async rename(cwd: string, sessionId: string, newTitle: string): Promise<boolean> {
      // 不存在返回 false（对齐文件实现的"先 readFile 探测存在性"）
      const exists = await pool.query(
        'SELECT 1 FROM sessions WHERE cwd = $1 AND session_id = $2 LIMIT 1',
        [cwd, sessionId],
      )
      if (exists.rowCount === 0) return false

      const event: SessionEvent = {
        type: 'rename',
        title: newTitle,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        parentUuid: null,
      }
      await appendEvents(cwd, sessionId, [event])
      return true
    },

    async fork(cwd: string, sessionId: string): Promise<string | null> {
      const loaded = await this.load(cwd, sessionId)
      if (!loaded || loaded.length === 0) return null

      const newId = randomUUID().slice(0, 8)
      await this.save(cwd, newId, [{ role: 'system', content: '' }, ...loaded])

      const allSessions = await this.list(cwd)
      const source = allSessions.find(s => s.id === sessionId)
      const baseTitle = source?.title ?? 'session'
      const forkPrefix = baseTitle + '_fork'
      const existingForkNums = allSessions
        .filter(s => s.title?.startsWith(forkPrefix))
        .map(s => parseInt(s.title!.slice(forkPrefix.length), 10))
        .filter(n => !isNaN(n))
      const nextNum = existingForkNums.length > 0 ? Math.max(...existingForkNums) + 1 : 1
      await this.rename(cwd, newId, `${baseTitle}_fork${nextNum}`)

      return newId
    },

    async cleanupExpired(cwd: string, maxAgeMs: number): Promise<number> {
      const cutoff = Date.now() - maxAgeMs
      //
      // ⚠️ **返回值必须是"会话数"而不是"行数"**。
      // 文件实现（file-store.ts:397-432）数的是被删的 `.jsonl` 文件数 = 会话数。
      // 若这里直接拿 DELETE 的 rowCount，得到的是**被删的事件行数**
      // （一个会话有多个事件），同一个会话会被重复计数 ——
      // 契约用例 `cleanupExpired：删掉过期会话并计数` 会当场失败。
      //
      // 所以显式 `COUNT(DISTINCT session_id)`。
      //
      // 同时注意：**按会话整体删，不能按行删**。删中间行会给 append-only 的
      // seq 留下永久空洞（后续 `MAX(seq)+1` 仍往后排），历史就断了一截。
      const { rows } = await pool.query<{ removed: string | number }>(
        `WITH expired AS (
           SELECT session_id
             FROM sessions
            WHERE cwd = $1
            GROUP BY session_id
           HAVING MAX(created_at) < $2
         ), deleted AS (
           DELETE FROM sessions
            WHERE cwd = $1 AND session_id IN (SELECT session_id FROM expired)
            RETURNING session_id
         )
         SELECT COUNT(DISTINCT session_id) AS removed FROM deleted`,
        [cwd, cutoff],
      )
      return toNumber(rows[0]?.removed ?? 0) ?? 0
    },

    async listProjects(): Promise<ProjectMeta[]> {
      const { rows } = await pool.query<{
        cwd: string
        session_count: string | number
        latest_updated_at: string | number
      }>(
        `SELECT cwd,
                COUNT(DISTINCT session_id) AS session_count,
                MAX(created_at)            AS latest_updated_at
           FROM sessions
          GROUP BY cwd
          ORDER BY MAX(created_at) DESC`,
      )
      return rows.map(row => ({
        // 与文件实现的 `dir` 对齐：文件实现给的是**目录名**（cwd 转义后），
        // 这里 PG 存的是原始 cwd。用同样的转义规则还原成目录名，
        // 否则 `listAllProjects()` 的消费方（TUI 项目列表）会拿到两种形状。
        dir: projectDirName(row.cwd),
        sessionCount: toNumber(row.session_count) ?? 0,
        latestUpdatedAt: toNumber(row.latest_updated_at) ?? 0,
      }))
    },

    async loadTranscript(
      cwd: string,
      sessionId: string,
    ): Promise<PersistedTranscriptEntry[] | null> {
      try {
        const events = await readEvents(cwd, sessionId)
        if (events.length === 0) return null

        const entries: PersistedTranscriptEntry[] = []
        for (const event of reconstructSnippedEvents(events)) {
          const msg = (event.message ?? {}) as Record<string, unknown>
          switch (event.type) {
            case 'user':
              entries.push({ kind: 'user', body: typeof msg.content === 'string' ? msg.content : '' })
              break
            case 'assistant':
              entries.push({ kind: 'assistant', body: typeof msg.content === 'string' ? msg.content : '' })
              break
            case 'progress':
              entries.push({ kind: 'progress', body: typeof msg.content === 'string' ? msg.content : '' })
              break
            case 'tool_call':
              entries.push({
                kind: 'tool',
                toolName: typeof msg.toolName === 'string' ? msg.toolName : 'unknown',
                status: 'success',
                body: JSON.stringify(msg.input ?? ''),
              })
              break
            case 'summary':
              entries.push({
                kind: 'assistant',
                body: `[Context summary: ${msg.compressedCount ?? 0} messages compressed]`,
              })
              break
            case 'compact_boundary':
              entries.push({
                kind: 'assistant',
                body: `[Context compacted: ${event.compactMetadata?.preTokens ?? '?'} → ${event.compactMetadata?.postTokens ?? '?'} tokens]`,
              })
              break
            case 'snip_boundary':
              entries.push({
                kind: 'assistant',
                body: `[Snipped earlier context: removed ${event.snipMetadata?.removedCount ?? '?'} messages, freed ~${event.snipMetadata?.tokensFreed ?? '?'} tokens]`,
              })
              break
          }
        }
        return entries.length > 0 ? entries : null
      } catch {
        return null
      }
    },

    async appendSnipBoundary(
      cwd: string,
      sessionId: string,
      boundaryMessage: Extract<ChatMessage, { role: 'snip_boundary' }>,
    ): Promise<void> {
      const { rows } = await pool.query<{ uuid: string | null }>(
        `SELECT event->>'uuid' AS uuid FROM sessions
          WHERE cwd = $1 AND session_id = $2 ORDER BY seq DESC LIMIT 1`,
        [cwd, sessionId],
      )
      const lastUuid = rows[0]?.uuid ?? null
      const now = new Date().toISOString()
      const uuid = ensureMessageId(boundaryMessage)

      const event: SessionEvent = {
        type: 'snip_boundary',
        subtype: 'snip_boundary',
        message: boundaryMessage,
        uuid,
        timestamp: now,
        sessionId,
        cwd,
        // 注意：parentUuid 为 null 而 logicalParentUuid 记录真实前驱 ——
        // 与文件实现 `file-store.ts:554-555` 完全一致（snip 是"旁路"事件，不接主链）
        parentUuid: null,
        logicalParentUuid: lastUuid,
        snipMetadata: {
          type: 'snip_boundary',
          removedMessageIds: boundaryMessage.removedMessageIds,
          removedCount: boundaryMessage.removedCount,
          tokensFreed: boundaryMessage.tokensFreed,
          timestamp: now,
          createdAt: now,
        },
      }
      await appendEvents(cwd, sessionId, [event])
    },

    async appendContextCollapseSpan(
      cwd: string,
      sessionId: string,
      span: CollapseSpan,
    ): Promise<void> {
      const { rows } = await pool.query<{ uuid: string | null }>(
        `SELECT event->>'uuid' AS uuid FROM sessions
          WHERE cwd = $1 AND session_id = $2 ORDER BY seq DESC LIMIT 1`,
        [cwd, sessionId],
      )
      const lastUuid = rows[0]?.uuid ?? null

      const event: SessionEvent = {
        type: 'context_collapse',
        subtype: 'context_collapse',
        uuid: span.id,
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        parentUuid: null,
        logicalParentUuid: lastUuid,
        contextCollapseSpan: span,
      }
      await appendEvents(cwd, sessionId, [event])
    },

    async appendCompactBoundary(
      cwd: string,
      sessionId: string,
      summaryText: string,
      trigger: 'auto' | 'manual',
      preTokens: number,
      postTokens: number,
      retainedMessages: ChatMessage[] = [],
    ): Promise<void> {
      const { rows } = await pool.query<{ uuid: string | null }>(
        `SELECT event->>'uuid' AS uuid FROM sessions
          WHERE cwd = $1 AND session_id = $2 ORDER BY seq DESC LIMIT 1`,
        [cwd, sessionId],
      )
      const lastUuid = rows[0]?.uuid ?? null
      const now = new Date().toISOString()

      const boundary: SessionEvent = {
        type: 'compact_boundary',
        subtype: 'compact_boundary',
        uuid: randomUUID(),
        timestamp: now,
        sessionId,
        cwd,
        parentUuid: null,
        logicalParentUuid: lastUuid,
        compactMetadata: { trigger, preTokens, postTokens },
      }

      const summary: SessionEvent = {
        type: 'user',
        message: { role: 'user', content: summaryText },
        uuid: randomUUID(),
        timestamp: now,
        sessionId,
        cwd,
        parentUuid: boundary.uuid,
      }

      // 整批一次写入（boundary + summary + 保留消息）—— 与文件实现同一批 appendFile
      const events: SessionEvent[] = [boundary, summary]
      let parentUuid = summary.uuid
      for (const message of retainedMessages) {
        const event = wrapEvent(message, sessionId, cwd, parentUuid)
        parentUuid = event.uuid
        events.push(event)
      }
      await appendEvents(cwd, sessionId, events)
    },

    async loadContextCollapseState(
      cwd: string,
      sessionId: string,
    ): Promise<ContextCollapseState | null> {
      try {
        const events = await readEvents(cwd, sessionId)
        if (events.length === 0) return null

        const state = createContextCollapseState()
        for (const event of activeAfterLastCompact(events)) {
          if (event.type !== 'context_collapse' || !event.contextCollapseSpan) continue
          if (event.contextCollapseSpan.status !== 'committed') continue
          state.spans.push(event.contextCollapseSpan)
        }
        return state.spans.length > 0 ? state : null
      } catch {
        return null
      }
    },
  }
}

/**
 * cwd → 项目目录名（**逐行复制** `file-store.ts:48-50`）。
 *
 * 为什么重复而不导出共享：这是文件后端的**路径编码规则**，与 PG 无关。
 * 但 `listProjects()` 的返回值要跨后端同形，所以这里必须用同一条规则
 * —— 否则同一批会话在文件形态下显示为 `-srv-workspace`、PG 形态下显示为
 * `/srv/workspace`，消费方（TUI 项目列表）会拿到两种形状的数据。
 */
function projectDirName(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}
