/**
 * 跨批次事件注册表（Incident Registry）。
 *
 * 定位：correlate.ts 只做**单批 payload 内**的分组（无状态纯函数）；本模块补上
 * **批次之间**的记忆 —— 新到的告警先与"已有 open 事件"匹配，能并入就并入（记成员、
 * 必要时升级严重度），否则新建事件。这解决"批 1 的 MySQLDown 已诊断完、2 分钟后
 * 批 2 的 ESConnRefused 才到"这类**跨批次碎片化**，以及"同组告警在冷却窗口内第二次
 * 到达被静默丢弃"的既有缺陷。
 *
 * 设计**照搬 OpenObserve**（`src/config/src/meta/alerts/incidents.rs` /
 * `src/infra/src/table/alert_incidents.rs`，main 分支源码）的四处机制：
 *
 * 1. **KeyType 三档强度**：`alertId`（无稳定维度，按告警隔离）→ `secondary` → `primary`。
 *    关键点：无稳定维度**不是"不关联"**，而是"用告警自身隔离成一个最弱的 incident"，
 *    全链路一条路径、没有分支（lite-ai 此前是"退化成单条 alert"，两套概念）。
 * 2. **DimensionRelationship::check()**：同键不同值 → `incompatible` → **新建事件（保守）**；
 *    新维度更具体 → `newIsSuperset` → 升级事件维度；`equal` / `newIsSubset` → 并入。
 *    冲突时宁可新建 —— 与"漏关联只是多跑一次、错并会污染根因"的代价不对称一致。
 * 3. **IncidentCorrelationOutcome 四态**：新建 / 新成员加入 / **同一告警重复到达** / 严重度升级。
 *    重复到达改为"保留成员记录 + 累计次数 + 不重复触发 RCA"，而非静默丢弃。
 * 4. **CorrelationReason**：每条告警记录"为什么被关联进来"，满足可审计 / 可解释红线。
 *
 * 处理顺序（三阶段，与"① 先并同服务、④ 再救跨服务漏网单例"一致）：
 * A. 规则键分组 —— 本批达 `minAlerts` 的直接成事件；未达阈值的**先查注册表**
 *    （同键 open 事件存在就并入 → 第二批到达即升级为事件级），否则留给拓扑层。
 * B. 拓扑层 —— 对 A 的漏网候选做图聚类（跨服务同 application / 调用链邻居）。
 * C. 剩余候选 —— 有规则键者按规则键建"弱事件"（跨批次仍可继续累积），
 *    无稳定维度者按 alertId 隔离。**统一走 incident 路径，没有"漏网"分支。**
 *
 * 并发：Node 单线程下 `resolve()` 同步完成（无 await），天然按事件串行化 —— 对应
 * OpenObserve 的 per-incident `FOR UPDATE` 行锁（它需要显式加锁是因为其 ORM 事务可交错）。
 * 若将来引入异步增量续跑（P4），必须为同一 incidentId 加串行锁，避免两次续跑互相覆盖会话。
 */
import { createHash } from 'node:crypto'
import type {
  Alert,
  CorrelationReason,
  Incident,
  IncidentCorrelationOutcome,
  IncidentKeyStrength,
  IncidentRef,
  IncidentType,
} from './types.js'
import { severityWeight } from './types.js'
import {
  DEFAULT_CORRELATION_CONFIG,
  collectAffectedServices,
  earliestStartsAt,
  matchFirstKey,
  pickPrimary,
  type AlertGroup,
  type CorrelationConfig,
} from './correlate.js'
import {
  DEFAULT_TOPOLOGY_SERVICE_KEYS,
  clusterByTopology,
  type DependencyGraph,
} from './topology.js'

/** 事件键分层：业务维度（强）与基础设施维度（弱）。 */
export type IncidentKeyTiers = {
  /** 业务维度（最强证据）：同 app / application / service 视为同一事件。 */
  primary: string[]
  /** 基础设施维度（较弱证据）：job / namespace / cluster / pod 等。 */
  secondary: string[]
}

export const DEFAULT_INCIDENT_KEY_TIERS: IncidentKeyTiers = {
  primary: ['app', 'application', 'service'],
  secondary: ['job', 'namespace', 'cluster', 'pod', 'instance', 'container', 'node'],
}

export type IncidentRegistryConfig = {
  keyTiers: IncidentKeyTiers
  /** 成员数达到该值才升级为**事件级 RCA**；低于则先单条诊断（后续新成员加入再升级）。 */
  minAlerts: number
  /**
   * open 事件静默超过该时长即判 resolved，不再接受新成员。
   * 默认 30 分钟（对齐 OpenObserve 的维度升级窗口 `upgrade_window_minutes = 30`）。
   */
  resolveAfterMs: number
  /** 注册表容量上限（防无界增长）；超出时先淘汰最旧的 resolved，再淘汰最旧的 open。 */
  maxIncidents: number
}

export const DEFAULT_REGISTRY_CONFIG: IncidentRegistryConfig = {
  keyTiers: DEFAULT_INCIDENT_KEY_TIERS,
  minAlerts: DEFAULT_CORRELATION_CONFIG.minAlerts,
  resolveAfterMs: 30 * 60 * 1000,
  maxIncidents: 1000,
}

/**
 * 维度关系（对齐 OpenObserve 的 `DimensionRelationship::check()`）：
 * 判定"新告警的维度"与"已有事件积累的维度"是否兼容。
 */
export type DimensionRelationship =
  | 'equal'
  | 'newIsSubset'
  | 'newIsSuperset'
  | 'partialOverlap'
  | 'incompatible'

/**
 * 维度兼容判定（纯函数、可单测）。
 * - 同键不同值 → `incompatible`（立即判定，避免把两个不同实体并成一伙）
 * - 无增无减 → `equal`；新更具体 → `newIsSuperset`；新更宽泛 → `newIsSubset`
 * - 有增有减 → `partialOverlap`（语义模糊，调用方按 OpenObserve 处理为"新建"）
 */
export function checkDimensionRelationship(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): DimensionRelationship {
  for (const [key, value] of Object.entries(incoming)) {
    const prior = existing[key]
    if (prior !== undefined && prior !== value) {
      return 'incompatible'
    }
  }

  let added = 0
  let removed = 0
  for (const key of Object.keys(incoming)) {
    if (existing[key] === undefined) added += 1
  }
  for (const key of Object.keys(existing)) {
    if (incoming[key] === undefined) removed += 1
  }

  if (added === 0 && removed === 0) return 'equal'
  if (added > 0 && removed === 0) return 'newIsSuperset'
  if (added === 0 && removed > 0) return 'newIsSubset'
  return 'partialOverlap'
}

/** 提取告警的关联维度（仅分层键中存在的部分）。 */
export function extractDimensions(
  alert: Alert,
  tiers: IncidentKeyTiers = DEFAULT_INCIDENT_KEY_TIERS,
): Record<string, string> {
  const dims: Record<string, string> = {}
  for (const key of [...tiers.primary, ...tiers.secondary]) {
    const value = alert.labels?.[key]
    if (typeof value === 'string' && value.trim() !== '') dims[key] = value
  }
  return dims
}

/** 组的公共维度 = 全部成员维度交集（同键同值才保留），避免批次内标签差异造成伪冲突。 */
function commonDimensions(
  members: Alert[],
  tiers: IncidentKeyTiers,
): Record<string, string> {
  let acc: Record<string, string> | null = null
  for (const member of members) {
    const dims = extractDimensions(member, tiers)
    if (acc === null) {
      acc = { ...dims }
      continue
    }
    for (const key of Object.keys(acc)) {
      if (dims[key] !== acc[key]) delete acc[key]
    }
  }
  return acc ?? {}
}

function reasonOf(keyStrength: IncidentKeyStrength, type: IncidentType): CorrelationReason {
  if (type === 'topology') return 'topology'
  if (keyStrength === 'primary') return 'primaryMatch'
  if (keyStrength === 'secondary') return 'secondaryMatch'
  return 'alertId'
}

/** 注册表中的 open 事件（内部状态）。 */
export type OpenIncident = {
  incidentId: string
  type: IncidentType
  keyStrength: IncidentKeyStrength
  /** 命中的维度键名；null = 无稳定维度（alertId 档 / 拓扑簇） */
  keyName: string | null
  groupKey: string
  /** 已积累的维度（跨批次用于兼容判定；`newIsSuperset` 时升级） */
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
  reasons: Set<CorrelationReason>
}

/** 单条告警的关联决策（可审计）。 */
export type CorrelationDecision = {
  alert: Alert
  incidentId: string
  outcome: IncidentCorrelationOutcome
  reason: CorrelationReason
  keyStrength: IncidentKeyStrength
  /** 命中的维度关系；新建事件时为 null */
  relationship: DimensionRelationship | null
  /** 事件当前成员数（含本次） */
  memberCount: number
  /** 是否需要触发/重跑 RCA（重复到达为 false —— 只记时间线，不烧 token） */
  shouldDiagnose: boolean
  /** 该事件此前是否已诊断过（true = 本次是对已有事件的增量重分析） */
  isReanalysis: boolean
}

/** 诊断单元：事件级（一次 RCA 覆盖整个事件）或单条（未达事件阈值）。 */
export type DiagnosisUnit =
  | { level: 'incident'; incident: Incident; isReanalysis: boolean }
  | { level: 'alert'; alert: Alert }

export type ResolveResult = {
  /** 需要触发诊断的单元列表（按事件 / 单条） */
  units: DiagnosisUnit[]
  /** 每条告警的关联决策（可审计） */
  decisions: CorrelationDecision[]
  /** 同一告警重复到达的次数（已记录成员、未触发诊断） */
  repeated: number
  /** 本次新建的事件数 */
  created: number
  /** 本次需要（重新）诊断的事件数（含严重度升级触发的新分析） */
  reanalyzed: number
}

/** 内部：把一组告警纳入某个事件的产出。 */
type ConsumeOutcome = {
  incident: OpenIncident
  created: boolean
  repeated: number
  /** 事件内容是否发生变化（新建 / 有新成员 / 严重度升级）→ 需要（重新）诊断 */
  changed: boolean
}

/**
 * 跨批次事件注册表。
 *
 * 用法：
 * ```ts
 * const registry = new IncidentRegistry()
 * const { units, repeated } = registry.resolve(alerts, cfg, Date.now(), graph)
 * // ... 跑诊断 ...
 * for (const u of units) if (u.level === 'incident') registry.markDiagnosed(u.incident.incidentId)
 * ```
 */
export class IncidentRegistry {
  private readonly byId = new Map<string, OpenIncident>()
  private readonly cfg: IncidentRegistryConfig

  constructor(config: Partial<IncidentRegistryConfig> = {}) {
    this.cfg = {
      minAlerts: config.minAlerts ?? DEFAULT_REGISTRY_CONFIG.minAlerts,
      resolveAfterMs: config.resolveAfterMs ?? DEFAULT_REGISTRY_CONFIG.resolveAfterMs,
      maxIncidents: config.maxIncidents ?? DEFAULT_REGISTRY_CONFIG.maxIncidents,
      keyTiers: {
        primary: config.keyTiers?.primary ?? DEFAULT_INCIDENT_KEY_TIERS.primary,
        secondary: config.keyTiers?.secondary ?? DEFAULT_INCIDENT_KEY_TIERS.secondary,
      },
    }
  }

  /**
   * 把一批告警纳入注册表：能并入已有 open 事件则并入（记成员 / 升级严重度），
   * 否则新建事件。返回需要诊断的单元（事件级优先，未达阈值则单条）。
   */
  resolve(
    alerts: Alert[],
    correlationConfig: Partial<CorrelationConfig> = {},
    now: number = Date.now(),
    graph: DependencyGraph | null = null,
  ): ResolveResult {
    this.sweep(now)

    const cfg: CorrelationConfig = { ...DEFAULT_CORRELATION_CONFIG, ...correlationConfig }
    const decisions: CorrelationDecision[] = []
    const touched = new Set<OpenIncident>()
    let repeated = 0
    let created = 0

    const consumeGroup = (group: AlertGroup): void => {
      const outcome = this.consume(group, cfg, now, decisions)
      if (outcome.created) created += 1
      repeated += outcome.repeated
      if (outcome.changed) touched.add(outcome.incident)
    }

    if (!cfg.enabled) {
      // 关联关闭：每条告警按自身 alertId 隔离（保持"1 告警 1 诊断"的老行为）。
      for (const alert of alerts) {
        consumeGroup({
          identity: `alertid=${alert.id}`,
          type: 'rule',
          keyName: null,
          groupKey: `alertid=${alert.id}`,
          members: [alert],
        })
      }
      return this.buildResult(decisions, touched, repeated, created, cfg.minAlerts)
    }

    // ---- 阶段 A：规则键分组（①②③）----
    const byKey = new Map<string, { keyName: string; members: Alert[] }>()
    const noKey: Alert[] = []
    for (const alert of alerts) {
      const hit = matchFirstKey(alert, cfg.groupByKeys)
      if (hit === null) {
        noKey.push(alert)
        continue
      }
      const entry = byKey.get(hit.groupKey)
      if (entry) entry.members.push(alert)
      else byKey.set(hit.groupKey, { keyName: hit.keyName, members: [alert] })
    }

    // 本批未达阈值者 / 无稳定维度者 → 拓扑候选（保留"① 先并、④ 救漏网"的两阶段语义）。
    const topoCandidates: Alert[] = [...noKey]

    for (const [groupKey, { keyName, members }] of byKey) {
      if (members.length >= cfg.minAlerts) {
        consumeGroup({ identity: groupKey, type: 'rule', keyName, groupKey, members })
        continue
      }
      // 未达阈值：先看注册表里是否已有同键的 open 事件（**跨批次累积的关键一步**）。
      // 有 → 并入（于是同键的第二批到达即升级为事件级 RCA）；无 → 留给拓扑层尝试跨服务关联。
      if (this.findOpenByKey(keyName, groupKey) !== null) {
        consumeGroup({ identity: groupKey, type: 'rule', keyName, groupKey, members })
        continue
      }
      topoCandidates.push(...members)
    }

    // ---- 阶段 B：拓扑层（④）----
    const topo = cfg.topology
    const consumed = new Set<Alert>()
    if (graph !== null && topo?.enabled !== false && topoCandidates.length > 0) {
      const clusters = clusterByTopology(topoCandidates, graph, {
        serviceKeys: topo?.serviceKeys ?? DEFAULT_TOPOLOGY_SERVICE_KEYS,
        windowMs: cfg.windowMs,
        minAlerts: topo?.minAlerts ?? cfg.minAlerts,
      })
      for (const cluster of clusters) {
        consumeGroup({
          identity: cluster.identity,
          type: 'topology',
          keyName: null,
          groupKey: cluster.groupKey,
          members: cluster.members,
        })
        for (const member of cluster.members) consumed.add(member)
      }
    }

    // ---- 阶段 C：剩余候选 ----
    // 有规则键者按规则键建"弱事件"（跨批次仍可继续累积）；无稳定维度者按 alertId 隔离。
    // 统一走 incident 路径 —— 没有"漏网 / 分支"概念（对齐 OpenObserve 的 KeyType 三档）。
    for (const alert of topoCandidates) {
      if (consumed.has(alert)) continue
      const hit = matchFirstKey(alert, cfg.groupByKeys)
      if (hit !== null) {
        consumeGroup({
          identity: hit.groupKey,
          type: 'rule',
          keyName: hit.keyName,
          groupKey: hit.groupKey,
          members: [alert],
        })
      } else {
        consumeGroup({
          identity: `alertid=${alert.id}`,
          type: 'rule',
          keyName: null,
          groupKey: `alertid=${alert.id}`,
          members: [alert],
        })
      }
    }

    return this.buildResult(decisions, touched, repeated, created, cfg.minAlerts)
  }

  /** 诊断完成后标记；同一事件后续的新成员将视为"增量重分析"。 */
  markDiagnosed(incidentId: string): void {
    const incident = this.byId.get(incidentId)
    if (incident) incident.diagnosed = true
  }

  /** 查询事件（测试 / 运维观测用）。 */
  get(incidentId: string): OpenIncident | undefined {
    return this.byId.get(incidentId)
  }

  stats(): { open: number; resolved: number; total: number } {
    let open = 0
    let resolved = 0
    for (const incident of this.byId.values()) {
      if (incident.status === 'open') open += 1
      else resolved += 1
    }
    return { open, resolved, total: this.byId.size }
  }

  clear(): void {
    this.byId.clear()
  }

  /** 键强度：命中业务维度为 primary，仅命中基础设施维度为 secondary，无稳定维度为 alertId。 */
  private strengthOf(keyName: string | null): IncidentKeyStrength {
    if (keyName === null) return 'alertId'
    if (this.cfg.keyTiers.primary.includes(keyName)) return 'primary'
    // 未在分层中显式声明的键按弱档处理（保守，不夸大同源强度）。
    return 'secondary'
  }

  /** 把一组告警并入匹配的 open 事件，或新建事件。 */
  private consume(
    group: AlertGroup,
    cfg: CorrelationConfig,
    now: number,
    decisions: CorrelationDecision[],
  ): ConsumeOutcome {
    // 拓扑簇按关联依据定强度：整簇同属一个 application → primary（业务归属是最强证据）；
    // 仅靠调用边相连 → secondary。规则组按命中的维度键分层。
    const keyStrength: IncidentKeyStrength =
      group.type === 'topology'
        ? group.groupKey.startsWith('application=')
          ? 'primary'
          : 'secondary'
        : this.strengthOf(group.keyName)

    const dims = commonDimensions(group.members, this.cfg.keyTiers)
    const probe = this.probeMatch(group.keyName, group.groupKey, dims)

    let incident: OpenIncident
    let isNew = false

    if (probe.incident === null) {
      // 无候选，或候选因维度 incompatible / partialOverlap 被拒 → 保守新建。
      incident = this.create(group, keyStrength, dims, now)
      this.byId.set(incident.incidentId, incident)
      isNew = true
    } else {
      incident = probe.incident
      if (probe.relationship === 'newIsSuperset') {
        // 新维度更具体 → 升级事件维度（对齐 OpenObserve：维度只升不降）
        incident.dimensions = { ...incident.dimensions, ...dims }
      }
    }
    const relationship = probe.relationship

    let joined = false
    let repeated = 0
    for (const alert of group.members) {
      const priorCount = incident.seen.get(alert.id) ?? 0
      incident.seen.set(alert.id, priorCount + 1)

      let outcome: IncidentCorrelationOutcome
      if (incident.alerts.length === 0) {
        outcome = 'newIncidentCreated'
      } else if (priorCount > 0) {
        // 同一告警重复到达：保留成员记录（不丢），但不重复触发 RCA。
        outcome = 'existingAlertRepeated'
        repeated += 1
      } else if (severityWeight(alert.severity) > severityWeight(incident.severity)) {
        outcome = 'severityEscalated'
        joined = true
      } else {
        outcome = 'newAlertTypeJoined'
        joined = true
      }

      if (priorCount === 0) incident.alerts.push(alert)
      const reason = reasonOf(keyStrength, group.type)
      incident.reasons.add(reason)
      this.writeRef(alert, incident)

      decisions.push({
        alert,
        incidentId: incident.incidentId,
        outcome,
        reason,
        keyStrength,
        relationship,
        memberCount: incident.alerts.length,
        shouldDiagnose: outcome !== 'existingAlertRepeated',
        isReanalysis: incident.diagnosed,
      })
    }

    // 主告警 / 严重度 / 起始时间重算（severityEscalated 时主告警可能切换）。
    incident.primaryAlert = pickPrimary(incident.alerts)
    incident.severity = incident.primaryAlert.severity
    incident.startedAt = earliestStartsAt(incident.alerts, incident.primaryAlert)
    incident.lastAlertAt = now

    return { incident, created: isNew, repeated, changed: isNew || joined }
  }

  /** 组装诊断单元：达到阈值的事件走事件级（一次 RCA）；否则逐条单条诊断。 */
  private buildResult(
    decisions: CorrelationDecision[],
    touched: Set<OpenIncident>,
    repeated: number,
    created: number,
    minAlerts: number,
  ): ResolveResult {
    const units: DiagnosisUnit[] = []
    let reanalyzed = 0
    for (const incident of touched) {
      if (this.isIncidentLevel(incident, minAlerts)) {
        units.push({
          level: 'incident',
          incident: this.toIncident(incident),
          isReanalysis: incident.diagnosed,
        })
        reanalyzed += 1
        continue
      }
      for (const alert of incident.alerts) {
        const decision = decisions.find(d => d.alert === alert)
        if (decision !== undefined && decision.outcome === 'existingAlertRepeated') continue
        units.push({ level: 'alert', alert })
      }
    }
    return { units, decisions, repeated, created, reanalyzed }
  }

  /** 只按键名 + 分组键探测是否存在 open 事件（不做维度判定，用于跨批次探测）。 */
  private findOpenByKey(keyName: string | null, groupKey: string): OpenIncident | null {
    for (const incident of this.byId.values()) {
      if (incident.status !== 'open') continue
      if (incident.keyName !== keyName) continue
      if (incident.groupKey !== groupKey) continue
      return incident
    }
    return null
  }

  /**
   * 探测可并入的 open 事件：键名与分组键必须一致。
   * 返回命中的事件与维度关系；若维度 `incompatible` / `partialOverlap`，
   * 则 `incident` 为 null 但**仍返回该关系**（供审计："曾尝试并入、因维度冲突而新建"）。
   */
  private probeMatch(
    keyName: string | null,
    groupKey: string,
    dimensions: Record<string, string>,
  ): { incident: OpenIncident | null; relationship: DimensionRelationship | null } {
    let blocked: DimensionRelationship | null = null
    for (const incident of this.byId.values()) {
      if (incident.status !== 'open') continue
      if (incident.keyName !== keyName) continue
      if (incident.groupKey !== groupKey) continue
      const relationship = checkDimensionRelationship(incident.dimensions, dimensions)
      if (relationship === 'incompatible' || relationship === 'partialOverlap') {
        // 保守新建：宁可碎片化，也不把两个不同实体并成一伙。
        blocked = relationship
        continue
      }
      return { incident, relationship }
    }
    return { incident: null, relationship: blocked }
  }

  private create(
    group: AlertGroup,
    keyStrength: IncidentKeyStrength,
    dimensions: Record<string, string>,
    now: number,
  ): OpenIncident {
    // incidentId 在**创建时**一次性生成并固定（与 correlate.ts 的时间桶不同）：
    // 跨批次必须复用同一 id，才能把后到的成员并进同一个事件。
    const digest = createHash('sha1')
      .update(`${group.identity}|${now}`)
      .digest('hex')
      .slice(0, 12)
    const primaryAlert = pickPrimary(group.members)
    return {
      incidentId: `inc-${digest}`,
      type: group.type,
      keyStrength,
      keyName: group.keyName,
      groupKey: group.groupKey,
      dimensions,
      alerts: [],
      seen: new Map(),
      primaryAlert,
      severity: primaryAlert.severity,
      startedAt: earliestStartsAt(group.members, primaryAlert),
      lastAlertAt: now,
      createdAt: now,
      status: 'open',
      diagnosed: false,
      reasons: new Set(),
    }
  }

  /** 是否达到事件级诊断条件（拓扑簇视为达标；alertId 档永不为事件级）。 */
  private isIncidentLevel(incident: OpenIncident, minAlerts: number): boolean {
    if (incident.type === 'topology') return true
    if (incident.keyStrength === 'alertId') return false
    return incident.alerts.length >= minAlerts
  }

  private writeRef(alert: Alert, incident: OpenIncident): void {
    const ref: IncidentRef = {
      incidentId: incident.incidentId,
      groupKey: incident.groupKey,
      siblingTitles: incident.alerts
        .filter(member => member !== alert)
        .map(member => member.title),
      keyStrength: incident.keyStrength,
      reasons: [...incident.reasons],
    }
    alert.incident = ref
  }

  private toIncident(open: OpenIncident): Incident {
    let observedCount = 0
    for (const count of open.seen.values()) observedCount += count
    return {
      incidentId: open.incidentId,
      type: open.type,
      groupKey: open.groupKey,
      primaryAlert: open.primaryAlert,
      alerts: [...open.alerts],
      severity: open.severity,
      startedAt: open.startedAt,
      affectedServices: collectAffectedServices(
        open.alerts,
        DEFAULT_CORRELATION_CONFIG.groupByKeys,
        open.groupKey,
      ),
      keyStrength: open.keyStrength,
      observedCount,
      reasons: [...open.reasons],
    }
  }

  /** TTL 收敛 + 容量控制。 */
  private sweep(now: number): void {
    for (const incident of this.byId.values()) {
      if (
        incident.status === 'open' &&
        now - incident.lastAlertAt > this.cfg.resolveAfterMs
      ) {
        incident.status = 'resolved'
      }
    }

    if (this.byId.size <= this.cfg.maxIncidents) return

    const ordered = [...this.byId.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'resolved' ? -1 : 1
      return a.lastAlertAt - b.lastAlertAt
    })
    const excess = this.byId.size - this.cfg.maxIncidents
    for (let i = 0; i < excess && i < ordered.length; i++) {
      this.byId.delete(ordered[i]!.incidentId)
    }
  }
}
