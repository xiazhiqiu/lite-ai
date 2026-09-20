/**
 * 聚合 / 去重状态的内存实现（T12，plan G9）。
 *
 * 用途与 `jobs/memory-store.ts` 一致：
 * 1. **单测**——让"双实例共享同一 store"的跨批次关联语义可在无 PG 环境被真实证明；
 * 2. **单进程形态**（CLI / 单进程 webhook）——零依赖即可跑，行为零变化；
 * 3. **PG 实现的语义基准**——两者跑同一组契约测试。
 *
 * 并发语义：所有临界区**全程同步无 await**（Map 操作无 IO，JS 不会在同步代码中间
 * 切换协程）。一旦插入 await，互斥即刻失效——这是本文件最脆弱的约束。
 *
 * ⚠️ 与 `jobs/memory-store.ts` 的关键差异：本实现**可以被两个"实例"共享**
 * （测试里 `new IncidentRegistry({ store })` 两次、传同一个 store），
 * 这正是用来模拟"多实例共用一库"的核心手法——不需要真起两个进程。
 */
import type { IncidentDiff, IncidentSnapshot, IncidentStore, DedupeStore } from './store.js'
import type { IncidentRecord, DedupeRecord } from './types.js'

/**
 * 深拷贝事件记录：`alerts` / `dimensions` 是对象引用，`seen` / `resolvedIds` / `reasons`
 * 是可变集合。若返回引用，调用方（registry）的修改会**直接写穿**到 store 内部，
 * 让"回写"变成空操作——快照语义被破坏，多实例模拟也就失去意义。
 */
function cloneRecord(record: IncidentRecord): IncidentRecord {
  return {
    ...record,
    dimensions: { ...record.dimensions },
    alerts: record.alerts.map(alert => ({
      ...alert,
      labels: { ...alert.labels },
      incident: alert.incident === undefined ? undefined : { ...alert.incident },
    })),
    primaryAlert: {
      ...record.primaryAlert,
      labels: { ...record.primaryAlert.labels },
      incident:
        record.primaryAlert.incident === undefined
          ? undefined
          : { ...record.primaryAlert.incident },
    },
    seen: new Map(record.seen),
    resolvedIds: new Set(record.resolvedIds),
    reasons: new Set(record.reasons),
  }
}

export function createMemoryIncidentStore(): IncidentStore {
  const byId = new Map<string, IncidentRecord>()

  return {
    async loadAll(): Promise<IncidentSnapshot> {
      // 深拷贝出快照：调用方对快照的一切修改都不影响 store，直到 commit 显式回写。
      return { byId: new Map([...byId].map(([id, rec]) => [id, cloneRecord(rec)])) }
    },

    async commit(diff: IncidentDiff): Promise<void> {
      // 全程同步。删除 → 新建 → 更新，顺序无关（id 不会同时出现在多组），
      // 但显式写成三步便于 PG 实现保持同样顺序。
      for (const id of diff.deleted) {
        byId.delete(id)
      }
      for (const record of diff.created) {
        // 幂等：已存在则不覆盖（对应 PG 的 ON CONFLICT DO NOTHING）。
        if (!byId.has(record.incidentId)) byId.set(record.incidentId, cloneRecord(record))
      }
      for (const record of diff.updated) {
        byId.set(record.incidentId, cloneRecord(record))
      }
    },

    async clear(): Promise<void> {
      byId.clear()
    },
  }
}

export function createMemoryDedupeStore(): DedupeStore {
  const seen = new Map<string, DedupeRecord>()

  return {
    async get(alertId: string): Promise<DedupeRecord | null> {
      const rec = seen.get(alertId)
      return rec === undefined ? null : { ...rec }
    },

    async check(
      alertId: string,
      next: DedupeRecord,
    ): Promise<DedupeRecord | null> {
      // ↓↓↓ 临界区：读旧值 + 写新值必须同 tick 完成，否则两次并发调用都会读到 null ↓↓↓
      const prev = seen.get(alertId)
      seen.set(alertId, { ...next })
      return prev === undefined ? null : { ...prev }
      // ↑↑↑ 临界区结束 ↑↑↑
    },

    async purgeExpired(silenceMs: number, now = Date.now()): Promise<number> {
      let removed = 0
      for (const [alertId, rec] of seen) {
        // 对应 dedupe.ts:112-117：窗口结束后清理，防 Map 无限膨胀。
        if (now - rec.firstSeen >= silenceMs) {
          seen.delete(alertId)
          removed += 1
        }
      }
      return removed
    },

    async clear(): Promise<void> {
      seen.clear()
    },
  }
}
