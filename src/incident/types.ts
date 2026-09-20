/**
 * 聚合 / 去重的持久化状态类型（T12）。
 *
 * 这两组类型是**存储层与逻辑层之间的契约**：
 * - `IncidentStore` 承载 `IncidentRegistry` 的 `byId: Map<string, OpenIncident>`；
 * - `DedupeStore` 承载 `AlertDedupe` 的 `seen: Map<alertId, {hash, firstSeen}>`。
 *
 * 为什么要抽出来（plan G9）：
 * 原先二者都是 `new` 在进程内存里的 Map。多实例部署时，实例 A 收到的告警与实例 B 的
 * 注册表**互相看不见** → 本该并入同一 incident 的告警会各自开新事件，一个事故被拆成
 * 两次诊断；重启即丢未关闭事件。把状态读改写换成入库，多实例下才成立。
 *
 * 设计约束（**重要**）：
 * - 这里只描述"状态长什么样"，**不含任何聚合规则**。聚合逻辑（分组 / 维度兼容判定 /
 *   TTL 收敛）仍留在 `incident-registry.ts`，红线是"关联纯规则、零 LLM"。
 * - 归档状态必须能**无损还原**成内存对象（含 `seen` / `resolvedIds` / `reasons`），
 *   否则跨实例续跑会丢失"同一告警重复到达"与"部分成员恢复"这两个关键事实。
 */
import type { Alert } from '../webhook/types.js'
import type {
  CorrelationReason,
  IncidentKeyStrength,
  IncidentType,
} from '../webhook/types.js'

/**
 * 注册表中的 open/resolved 事件（与 `incident-registry.ts` 的 `OpenIncident` 同构）。
 *
 * 字段语义**逐条对齐**内存实现 `incident-registry.ts:176-207`——本类型就是它的
 * 可持久化投影。任何字段增删都必须同步改内存实现与 PG 实现，否则跨实例还原会丢事实。
 */
export type IncidentRecord = {
  incidentId: string
  type: IncidentType
  keyStrength: IncidentKeyStrength
  /** 命中的维度键名；null = 无稳定维度（alertId 档 / 拓扑簇） */
  keyName: string | null
  groupKey: string
  /** 已积累的维度（跨批次用于兼容判定；`newIsSuperset` 时只升不降） */
  dimensions: Record<string, string>
  /** 去重后的成员告警（按首次到达顺序） */
  alerts: Alert[]
  /** alertId → 到达次数（区分"新成员"与"重复到达"） */
  seen: Map<string, number>
  primaryAlert: Alert
  severity: string
  startedAt: string
  lastAlertAt: number
  createdAt: number
  status: 'open' | 'resolved'
  /** 是否已被诊断过（true 时后续新成员触发的诊断标记为"增量重分析"） */
  diagnosed: boolean
  /** 已收到 resolved 的成员 alertId 集合 */
  resolvedIds: Set<string>
  /** 事件被源侧恢复关闭的时间（null = 仍 open 或仅被 TTL 收敛） */
  resolvedAt: number | null
  reasons: Set<CorrelationReason>
}

/**
 * 去重条目（与 `dedupe.ts` 的 `seen: Map<alertId, {hash, firstSeen}>` 同构）。
 *
 * 注意 **`firstSeen` 在 `updated` 时有意不推进**（`dedupe.ts:108`）——
 * 因此它必须原样持久化，**不能**在存储层做"滑动窗口"式的更新。
 */
export type DedupeRecord = {
  /** 内容哈希：title|severity|summary|description|labels 的 sha1 前 16 位 */
  hash: string
  /** 静默窗口起点（毫秒时间戳） */
  firstSeen: number
}
