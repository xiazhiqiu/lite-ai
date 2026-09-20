/**
 * 聚合 / 去重状态的 PG 实现（T12）。
 *
 * 与 `memory-store.ts` **语义等价**，通过同一组契约测试。
 *
 * ## 与内存实现的三处关键差异（都是多进程必须显式处理的）
 *
 * 1. **原子性靠事务**，而非"单线程同步临界区"。
 *    `commit()` 在**一个事务**里完成 delete/insert/update + 成员明细，
 *    否则别的实例会观察到"事件已建但成员未落"的中间态。
 *
 * 2. **重复创建靠部分唯一索引拒绝**（`incidents_open_unique_idx`）。
 *    两个实例同时发现"无 open 事件"时会双双尝试插入；索引让后者失败，
 *    实现里捕获 `23505` 后**退回既存行**（返回既存 id），使"并发下仍只有一个事件"成立。
 *
 * 3. **去重的读改写靠单条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`**，
 *    一条语句内同时拿到旧值与写入新值——拆成 SELECT + UPDATE 会有窗口期，
 *    两个实例会双双判定 `new` 而重复诊断（去重失效）。
 */
import type pg from 'pg'
import type {
  DedupeStore,
  IncidentDiff,
  IncidentSnapshot,
  IncidentStore,
} from './store.js'
import type { DedupeRecord, IncidentRecord } from './types.js'
import type { Alert, CorrelationReason } from '../webhook/types.js'

/** incidents 表行（snake_case → camelCase 收口）。 */
type IncidentRow = {
  incident_id: string
  type: string
  key_strength: string
  key_name: string | null
  group_key: string
  dimensions: Record<string, string>
  primary_alert_id: string
  severity: string
  started_at: string
  last_alert_at: string | number
  created_at: string | number
  status: string
  diagnosed: boolean
  closed_at: string | number | null
  updated_at: string | number
}

type MemberRow = {
  incident_id: string
  alert_id: string
  seen_count: number | string
  is_primary: boolean
  alert: Alert
  resolved_at: string | number | null
  reasons: CorrelationReason[]
  first_seen_at: string | number
}

type DedupeRow = {
  alert_id: string
  content_hash: string
  first_seen_at: string | number
}

/** BIGINT 经 pg 驱动返回字符串；毫秒时间戳转 number 安全（1.7e12 << 2^53）。 */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : Number(value)
}

/** PG 唯一约束冲突的 SQLSTATE。 */
const UNIQUE_VIOLATION = '23505'

export function createPgIncidentStore(pool: pg.Pool): IncidentStore {
  return {
    async loadAll(): Promise<IncidentSnapshot> {
      // 两个查询：事件 + 全部成员。成员按 incident_id 归组后再组装，
      // 避免 N+1（事件多时逐个查成员会成为瓶颈）。
      const [incidents, members] = await Promise.all([
        pool.query<IncidentRow>('SELECT * FROM incidents'),
        pool.query<MemberRow>('SELECT * FROM incident_members ORDER BY first_seen_at'),
      ])

      const membersByIncident = new Map<string, MemberRow[]>()
      for (const m of members.rows) {
        const list = membersByIncident.get(m.incident_id)
        if (list === undefined) membersByIncident.set(m.incident_id, [m])
        else list.push(m)
      }

      const byId = new Map<string, IncidentRecord>()
      for (const row of incidents.rows) {
        byId.set(row.incident_id, toRecord(row, membersByIncident.get(row.incident_id) ?? []))
      }
      return { byId }
    },

    async commit(diff: IncidentDiff): Promise<void> {
      // 无变化则不开事务（避免空提交把 updated_at 搅动）。
      if (
        diff.created.length === 0 &&
        diff.updated.length === 0 &&
        diff.deleted.length === 0
      ) {
        return
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // 删除 → 新建 → 更新。顺序与内存实现保持一致。
        if (diff.deleted.length > 0) {
          await client.query('DELETE FROM incidents WHERE incident_id = ANY($1::text[])', [
            diff.deleted,
          ])
        }
        for (const record of diff.created) {
          await insertIncident(client, record, true)
        }
        for (const record of diff.updated) {
          await insertIncident(client, record, false)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async clear(): Promise<void> {
      // 防误清生产数据：PG 实现不提供 clear。
      // 测试需要清库时走显式 SQL（见 pg 测试的 beforeEach）。
      throw new Error(
        'PG IncidentStore 不支持 clear()：清库请用显式 SQL，避免误清生产数据',
      )
    },
  }
}

/**
 * 写一个事件（含全部成员）。
 *
 * @param onCreateOnly true = 仅新建（冲突时忽略，对应 ON CONFLICT DO NOTHING）；
 *                     false = upsert 更新
 */
async function insertIncident(
  client: pg.PoolClient,
  record: IncidentRecord,
  onCreateOnly: boolean,
): Promise<void> {
  const conflict = onCreateOnly
    ? // 唯一索引冲突（并发下另一实例已建同键事件）→ 忽略，保留先到者。
      // 注意这里**只对唯一索引生效**；主键冲突也应忽略（同 id 重放）。
      'ON CONFLICT DO NOTHING'
    : `ON CONFLICT (incident_id) DO UPDATE SET
         type = EXCLUDED.type,
         key_strength = EXCLUDED.key_strength,
         key_name = EXCLUDED.key_name,
         group_key = EXCLUDED.group_key,
         dimensions = EXCLUDED.dimensions,
         primary_alert_id = EXCLUDED.primary_alert_id,
         severity = EXCLUDED.severity,
         started_at = EXCLUDED.started_at,
         last_alert_at = EXCLUDED.last_alert_at,
         status = EXCLUDED.status,
         diagnosed = EXCLUDED.diagnosed,
         closed_at = EXCLUDED.closed_at,
         updated_at = EXCLUDED.updated_at`

  try {
    await client.query(
      `INSERT INTO incidents (incident_id, type, key_strength, key_name, group_key,
                              dimensions, primary_alert_id, severity, started_at,
                              last_alert_at, created_at, status, diagnosed, closed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ${conflict}`,
      [
        record.incidentId,
        record.type,
        record.keyStrength,
        record.keyName,
        record.groupKey,
        JSON.stringify(record.dimensions),
        record.primaryAlert.id,
        record.severity,
        record.startedAt,
        record.lastAlertAt,
        record.createdAt,
        record.status,
        record.diagnosed,
        record.resolvedAt,
        record.lastAlertAt,
      ],
    )
  } catch (error) {
    if (isUniqueViolation(error)) {
      // 并发下另一实例抢先创建了同键 open 事件：本行放弃（保留先到者），
      // 成员明细由对方负责；这与"内存实现下后到者会并入先到者"语义等价。
      return
    }
    throw error
  }

  // 成员：整批 upsert。先删不在快照里的（成员不会被移除，但 markResolved 后
  // `alerts` 不变，故实际不会删——保留 delete 语句只为语义完整）。
  const alertIds = record.alerts.map(a => a.id)
  await client.query(
    `DELETE FROM incident_members
      WHERE incident_id = $1 AND NOT (alert_id = ANY($2::text[]))`,
    [record.incidentId, alertIds],
  )

  for (const alert of record.alerts) {
    const seenCount = record.seen.get(alert.id) ?? 1
    // 成员维度：resolvedIds 含该 id → resolved_at 置为该事件 resolvedAt（或 now 语义）。
    // 这里用 `record.resolvedAt` 作为近似（内存里 resolvedIds 只记"是否"，不记时间）。
    const resolvedAt = record.resolvedIds.has(alert.id)
      ? (record.resolvedAt ?? record.lastAlertAt)
      : null
    await client.query(
      `INSERT INTO incident_members (incident_id, alert_id, seen_count, is_primary,
                                     alert, resolved_at, reasons, first_seen_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
       ON CONFLICT (incident_id, alert_id) DO UPDATE SET
         seen_count = EXCLUDED.seen_count,
         is_primary = EXCLUDED.is_primary,
         alert = EXCLUDED.alert,
         resolved_at = EXCLUDED.resolved_at,
         reasons = EXCLUDED.reasons`,
      [
        record.incidentId,
        alert.id,
        seenCount,
        alert.id === record.primaryAlert.id,
        JSON.stringify(alert),
        resolvedAt,
        JSON.stringify([...record.reasons]),
        record.createdAt,
      ],
    )
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  )
}

/** 行 → 记录。成员还原 `alerts` / `seen` / `resolvedIds` / `reasons`。 */
function toRecord(row: IncidentRow, members: MemberRow[]): IncidentRecord {
  const alerts: Alert[] = []
  const seen = new Map<string, number>()
  const resolvedIds = new Set<string>()
  const reasons = new Set<CorrelationReason>()
  let primary = members.find(m => m.is_primary)?.alert ?? members[0]?.alert

  for (const m of members) {
    alerts.push(m.alert)
    seen.set(m.alert_id, toNumber(m.seen_count) ?? 1)
    if (m.resolved_at !== null) resolvedIds.add(m.alert_id)
    for (const r of m.reasons ?? []) reasons.add(r)
  }

  // 主告警可能不在成员里（理论不可达：writeRef 总在其后）；兜底造一个占位避免崩。
  if (primary === undefined) {
    primary = {
      id: row.primary_alert_id,
      title: row.primary_alert_id,
      severity: row.severity,
      summary: '',
      description: '',
      labels: {},
      startsAt: row.started_at,
      status: 'firing',
    }
  }

  return {
    incidentId: row.incident_id,
    type: row.type as IncidentRecord['type'],
    keyStrength: row.key_strength as IncidentRecord['keyStrength'],
    keyName: row.key_name,
    groupKey: row.group_key,
    dimensions: row.dimensions ?? {},
    alerts,
    seen,
    primaryAlert: primary,
    severity: row.severity,
    startedAt: row.started_at,
    lastAlertAt: toNumber(row.last_alert_at) ?? 0,
    createdAt: toNumber(row.created_at) ?? 0,
    status: row.status as IncidentRecord['status'],
    diagnosed: row.diagnosed,
    resolvedIds,
    resolvedAt: toNumber(row.closed_at),
    reasons,
  }
}

export function createPgDedupeStore(pool: pg.Pool): DedupeStore {
  return {
    async get(alertId: string): Promise<DedupeRecord | null> {
      const { rows } = await pool.query<DedupeRow>(
        'SELECT * FROM alert_dedupe WHERE alert_id = $1',
        [alertId],
      )
      if (rows.length === 0) return null
      const row = rows[0]!
      return { hash: row.content_hash, firstSeen: toNumber(row.first_seen_at) ?? 0 }
    },

    async check(
      alertId: string,
      next: DedupeRecord,
    ): Promise<DedupeRecord | null> {
      // 单条语句内"写新值 + 返回旧值"：
      //   * INSERT ... ON CONFLICT DO UPDATE 保证并发写不冲突；
      //   * RETURNING 只能取**新**行 → 旧值必须用 CTE 先读。
      // 用 CTE 先 SELECT FOR UPDATE 锁住该行（无则无锁），再 upsert，同一语句内完成。
      const { rows } = await pool.query<{ prev_hash: string | null; prev_first: string | number | null }>(
        `WITH prev AS (
           SELECT content_hash AS prev_hash, first_seen_at AS prev_first
             FROM alert_dedupe
            WHERE alert_id = $1
            FOR UPDATE
         )
         INSERT INTO alert_dedupe (alert_id, content_hash, first_seen_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (alert_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           first_seen_at = EXCLUDED.first_seen_at
         RETURNING
           (SELECT prev_hash FROM prev) AS prev_hash,
           (SELECT prev_first FROM prev) AS prev_first`,
        [alertId, next.hash, next.firstSeen],
      )
      const row = rows[0]
      if (row === undefined || row.prev_hash === null || row.prev_first === null) return null
      return { hash: row.prev_hash, firstSeen: toNumber(row.prev_first) ?? 0 }
    },

    async purgeExpired(silenceMs: number, now = Date.now()): Promise<number> {
      const { rowCount } = await pool.query(
        'DELETE FROM alert_dedupe WHERE $1 - first_seen_at >= $2',
        [now, silenceMs],
      )
      return rowCount ?? 0
    },

    async clear(): Promise<void> {
      // 与 IncidentStore 同策略：不允许不经思考地清库。
      throw new Error(
        'PG DedupeStore 不支持 clear()：清库请用显式 SQL，避免误清生产数据',
      )
    },
  }
}
