/**
 * `OpenIncident`（内存态） ↔ `IncidentRecord`（可持久化态）的序列化（T12）。
 *
 * 为什么单独一个文件：**这是唯一的形状转换点**。若散落在 registry / store 两处，
 * 字段增删时极易只改一边，导致跨实例还原丢事实（如漏掉 `resolvedIds` 会让
 * "全部成员恢复才关闭"退化成"任意成员恢复即关闭"）。集中一处便于审计。
 *
 * 三条不可违反的规则：
 * 1. `alerts` 必须**深拷贝**——`Alert` 上的 `incident: IncidentRef` 会被 registry
 *    原地改写（`writeRef`），共享引用会让快照被写穿。
 * 2. `seen` / `resolvedIds` / `reasons` 必须**双向转换**（Map/Set ↔ 普通结构），
 *    这三个是跨批次连续性的全部依据。
 * 3. `undefined` 字段不能变成 `null`（JSON 化会丢），故显式考滤可选字段。
 */
import type { Alert, CorrelationReason } from '../webhook/types.js'
import type { IncidentRecord } from './types.js'
import type { IncidentDiff } from './store.js'

/**
 * 内存态结构的最小投影。
 *
 * 这里**不 import** `incident-registry.ts` 的 `OpenIncident` 类型，避免
 * "registry 依赖 serialize、serialize 依赖 registry"的循环。改为结构化声明——
 * 只要形状一致 TS 就接受，且能编译期抓住字段改名。
 */
export type OpenIncidentLike = {
  incidentId: string
  type: 'rule' | 'topology'
  keyStrength: 'primary' | 'secondary' | 'alertId'
  keyName: string | null
  groupKey: string
  dimensions: Record<string, string>
  alerts: Alert[]
  seen: Map<string, number>
  primaryAlert: Alert
  severity: string
  startedAt: string
  lastAlertAt: number
  createdAt: number
  status: 'open' | 'resolved'
  diagnosed: boolean
  resolvedIds: Set<string>
  resolvedAt: number | null
  reasons: Set<CorrelationReason>
}

function cloneAlert(alert: Alert): Alert {
  return {
    ...alert,
    labels: { ...alert.labels },
    incident:
      alert.incident === undefined
        ? undefined
        : { ...alert.incident, siblingTitles: [...alert.incident.siblingTitles] },
  }
}

/** 内存态 → 可持久化态（深拷贝，切断一切共享引用）。 */
export function recordFromOpen(open: OpenIncidentLike): IncidentRecord {
  return {
    incidentId: open.incidentId,
    type: open.type,
    keyStrength: open.keyStrength,
    keyName: open.keyName,
    groupKey: open.groupKey,
    dimensions: { ...open.dimensions },
    alerts: open.alerts.map(cloneAlert),
    seen: new Map(open.seen),
    primaryAlert: cloneAlert(open.primaryAlert),
    severity: open.severity,
    startedAt: open.startedAt,
    lastAlertAt: open.lastAlertAt,
    createdAt: open.createdAt,
    status: open.status,
    diagnosed: open.diagnosed,
    resolvedIds: new Set(open.resolvedIds),
    resolvedAt: open.resolvedAt,
    reasons: new Set(open.reasons),
  }
}

/**
 * 可持久化态 → 内存态。
 *
 * 返回 `OpenIncidentLike`（而非 registry 的 `OpenIncident`）：形状一致即可直接放进
 * `byId`。这样 serialize 不需要认识 registry 的私有类型。
 */
export function openFromRecord(record: IncidentRecord): OpenIncidentLike {
  return {
    incidentId: record.incidentId,
    type: record.type,
    keyStrength: record.keyStrength,
    keyName: record.keyName,
    groupKey: record.groupKey,
    dimensions: { ...record.dimensions },
    alerts: record.alerts.map(cloneAlert),
    seen: new Map(record.seen),
    primaryAlert: cloneAlert(record.primaryAlert),
    severity: record.severity,
    startedAt: record.startedAt,
    lastAlertAt: record.lastAlertAt,
    createdAt: record.createdAt,
    status: record.status,
    diagnosed: record.diagnosed,
    resolvedIds: new Set(record.resolvedIds),
    resolvedAt: record.resolvedAt,
    reasons: new Set(record.reasons),
  }
}

/**
 * 计算回写差异（T12）。
 *
 * @param byId      当前内存里全部事件
 * @param persisted 记账：上次 flush 时库里已有的事件 id
 * @param evicted   本周期被容量淘汰的事件 id
 */
export function toIncidentDiff(
  byId: Map<string, OpenIncidentLike>,
  persisted: ReadonlySet<string>,
  evicted: ReadonlySet<string>,
): IncidentDiff {
  const created: IncidentRecord[] = []
  const updated: IncidentRecord[] = []

  for (const [id, open] of byId) {
    const record = recordFromOpen(open)
    if (persisted.has(id)) updated.push(record)
    else created.push(record)
  }

  return {
    created,
    updated,
    // 同时被淘汰又重建的极端情形不应出现（id 含时间戳），故直接取差集。
    deleted: [...evicted].filter(id => !byId.has(id)),
    // 成员明细由 PG 实现从 `alerts` / `seen` / `reasons` 展开写入，
    // 内存实现无需单独处理（整行已在 created/updated 里）。
    memberUpserts: [],
  }
}
