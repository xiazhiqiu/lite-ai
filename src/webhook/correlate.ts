/**
 * 跨源告警关联层（确定性，无 LLM）—— **批次内**分组。
 *
 * 定位：Vigil 式"指纹精确去重"（dedupe.ts，L1）与事件级 RCA（diagnose.ts，L4）
 * 之间的 L2 —— 把同一服务维度、同一时间窗内的多源告警聚成 **Incident 事件对象**，
 * 事件成为诊断单元（sessionId = incidentId），告警退化为事件成员。
 *
 * 本文件只做**单批 payload 内**的分组（无状态、纯函数）；跨批次把新告警并入已有 open 事件
 * 由 incident-registry.ts 负责（照 OpenObserve 的 incident correlation 子系统）。
 *
 * 设计红线：
 * - 纯确定性：仅依赖稳定标签 + 时间桶，零 LLM、零网络，结果可复现、可审计。
 *   关联发生在 RCA 之前、证据最少之时，LLM 在此只会瞎猜且不可追溯（错并灾难）。
 * - 不误合并：无稳定标签的告警不参与关联（保持单例诊断），宁可漏关联也不错并。
 * - 阈值护栏：同组同窗成员数 < minAlerts 时不生成事件（保持单条诊断），
 *   避免把"只是恰好同时到达的两条无关告警"硬并成事件。
 *
 * 实现的是 AIOps 关联规则中的确定性四条：
 *   ① 标签相等 ② 时间窗相近 ③ 数量达阈值  —— 处理同服务/同维度的告警
 *   ④ 拓扑关联（topology.ts）              —— 回收 ①②③ 的漏网单例（跨服务同根因）
 * 因果（需因果图）与语义（需 LLM）不在此实现：语义关联违反"关联必须确定性"的红线。
 */
import { createHash } from 'node:crypto'
import type { Alert, Incident, IncidentRef, IncidentType } from './types.js'
import { severityWeight } from './types.js'
import {
  clusterByTopology,
  DEFAULT_TOPOLOGY_SERVICE_KEYS,
  type DependencyGraph,
} from './topology.js'

export type CorrelationConfig = {
  /** 是否启用跨源关联（生成事件）。默认 true。 */
  enabled: boolean
  /** 按优先级探测的稳定标签键：取第一个命中的作为 incident 分组维度。 */
  groupByKeys: string[]
  /** 时间窗口（毫秒）：同一时间桶内、同分组的告警归入同一事件。默认 5 分钟。 */
  windowMs: number
  /** 同组同窗内达到该成员数才生成事件；低于则退化为单条诊断。默认 2。 */
  minAlerts: number
  /**
   * 拓扑关联（规则④）参数。图由调用方注入（`graph` 为 null 时自动跳过）。
   * 只作用于 ①②③ 未并组的"漏网单例"，绝不改动已并好的规则事件。
   */
  topology?: {
    /** 是否启用拓扑关联，默认 true（但无图时自动跳过）。 */
    enabled?: boolean
    /** 告警中用于对齐图节点的标签键，按优先级取第一个非空。 */
    serviceKeys?: string[]
    /** 拓扑事件的最小成员数，缺省沿用 minAlerts。 */
    minAlerts?: number
  }
}

export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = {
  enabled: true,
  groupByKeys: ['app', 'service', 'job', 'namespace', 'cluster'],
  // 业界主流聚合窗为 60s ~ 5min（OneUptime / BMC / Keep），取 5 分钟。
  windowMs: 5 * 60 * 1000,
  // 单条告警不等窗口、立即诊断；≥2 条同组才聚合成事件（对齐 Keep threshold / OneUptime min_alerts）。
  minAlerts: 2,
}

/**
 * 按 groupByKeys 优先级取第一个非空标签，返回命中的**键名**与分组键。
 * 键名用于判定事件键强度（primary / secondary）；全部缺失返回 null（无稳定维度）。
 */
export function matchFirstKey(
  alert: Alert,
  groupByKeys: string[] = DEFAULT_CORRELATION_CONFIG.groupByKeys,
): { keyName: string; groupKey: string } | null {
  for (const key of groupByKeys) {
    const value = alert.labels?.[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return { keyName: key, groupKey: `${key}=${value}` }
    }
  }
  return null
}

/**
 * 计算告警的稳定分组键，形如 `service=payment`。
 * 按 groupByKeys 顺序取第一个非空标签；全部缺失时返回 null（不参与关联）。
 */
export function computeIncidentKey(
  alert: Alert,
  groupByKeys: string[] = DEFAULT_CORRELATION_CONFIG.groupByKeys,
): string | null {
  return matchFirstKey(alert, groupByKeys)?.groupKey ?? null
}

/** 批次内预分组结果：一个组 = 一个候选事件。 */
export type AlertGroup = {
  /** 组身份（稳定标识）：规则组 = groupKey；拓扑簇 = cluster.identity。 */
  identity: string
  type: IncidentType
  /** 命中的维度键名；null 表示无稳定维度（单例 / 拓扑簇）。 */
  keyName: string | null
  groupKey: string
  members: Alert[]
}

/**
 * 批次内预分组（纯函数、无状态）：规则 ①②③ 分组 + 拓扑 ④ 回收漏网单例，
 * 剩余未归属者各自成单例组（keyName = null）。
 *
 * 只负责"哪些告警算一组"，**不做阈值判定、不写 ref** —— 阈值与事件构造由调用方决定：
 * - correlateAlerts：批次内直接生成事件（保留原行为）。
 * - incident-registry：作为跨批次注册表的预分组输入。
 */
export function planAlertGroups(
  alerts: Alert[],
  config: Partial<CorrelationConfig> = {},
  now: number = Date.now(),
  graph: DependencyGraph | null = null,
): AlertGroup[] {
  const cfg: CorrelationConfig = { ...DEFAULT_CORRELATION_CONFIG, ...config }
  const groups: AlertGroup[] = []

  if (!cfg.enabled) {
    // 关联关闭：每条告警自成单例组，保持"1 告警 1 诊断"的老行为。
    return alerts.map(singletonGroup)
  }

  const claimed = new Set<Alert>()
  const byKey = new Map<string, { keyName: string; members: Alert[] }>()

  for (const alert of alerts) {
    const hit = matchFirstKey(alert, cfg.groupByKeys)
    if (hit === null) continue
    const entry = byKey.get(hit.groupKey)
    if (entry) {
      entry.members.push(alert)
    } else {
      byKey.set(hit.groupKey, { keyName: hit.keyName, members: [alert] })
    }
  }

  // 只有**达阈值**的规则组才收编成员；未达阈值的成员留给规则④ 拓扑二次回收
  // （与"① 先并同服务、④ 再救跨服务漏网单例"的两阶段设计一致）。
  for (const [groupKey, { keyName, members }] of byKey) {
    if (members.length < cfg.minAlerts) continue
    groups.push({ identity: groupKey, type: 'rule', keyName, groupKey, members })
    for (const member of members) claimed.add(member)
  }

  // 规则④：只回收未被收编的单例（含无稳定标签者），不动已并好的规则组。
  const topo = cfg.topology
  if (graph !== null && topo?.enabled !== false) {
    const singles = alerts.filter(alert => !claimed.has(alert))
    const clusters = clusterByTopology(singles, graph, {
      serviceKeys: topo?.serviceKeys ?? DEFAULT_TOPOLOGY_SERVICE_KEYS,
      windowMs: cfg.windowMs,
      minAlerts: topo?.minAlerts ?? cfg.minAlerts,
    })
    for (const cluster of clusters) {
      groups.push({
        identity: cluster.identity,
        type: 'topology',
        keyName: null,
        groupKey: cluster.groupKey,
        members: cluster.members,
      })
      for (const member of cluster.members) claimed.add(member)
    }
  }

  // 仍未归属（未达阈值且拓扑未覆盖 / 无稳定标签）→ 单例组。
  for (const alert of alerts) {
    if (claimed.has(alert)) continue
    claimed.add(alert)
    groups.push(singletonGroup(alert))
  }

  return groups
}

/** 单例组：无稳定维度，按告警自身隔离（统一走 incident 路径，keyStrength = alertId）。 */
function singletonGroup(alert: Alert): AlertGroup {
  return {
    identity: `alertid=${alert.id}`,
    type: 'rule',
    keyName: null,
    groupKey: `alertid=${alert.id}`,
    members: [alert],
  }
}

/** 同一分组键 + 同一时间桶 → 同一 incidentId。时间桶保证窗口过期后自动换新事件。 */
function incidentIdFor(groupKey: string, windowMs: number, now: number): string {
  const bucket = Math.floor(now / windowMs)
  const digest = createHash('sha1')
    .update(`${groupKey}|${bucket}`)
    .digest('hex')
    .slice(0, 12)
  return `inc-${digest}`
}

/**
 * 主告警选取（first_wins）：severityWeight 最高者优先；同级取 startsAt 最早者。
 * 对应"标注主告警"，为事件级 RCA 提供代表性入口。
 */
export function pickPrimary(members: Alert[]): Alert {
  return [...members].sort((a, b) => {
    const bySeverity = severityWeight(b.severity) - severityWeight(a.severity)
    if (bySeverity !== 0) return bySeverity
    const ta = Date.parse(a.startsAt)
    const tb = Date.parse(b.startsAt)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
    return 0
  })[0]!
}

/** 事件起始时间 = 成员中最早的 startsAt（保留原始时间戳字符串，便于溯源）；无有效时间回退主告警。 */
export function earliestStartsAt(members: Alert[], fallback: Alert): string {
  let earliest: Alert | null = null
  let earliestTime = Infinity
  for (const m of members) {
    const t = Date.parse(m.startsAt)
    if (Number.isFinite(t) && t < earliestTime) {
      earliestTime = t
      earliest = m
    }
  }
  return earliest?.startsAt ?? fallback.startsAt
}

/**
 * 影响面：成员涉及的 service 集合。
 * 优先取 `service` 标签（同一事件可能横跨多个服务实例）；缺失时回退分组维度值。
 * 诚实边界：lite-ai 无 CMDB，影响面只能按标签聚合，给不出真实依赖图。
 */
export function collectAffectedServices(
  members: Alert[],
  groupByKeys: string[],
  groupKey: string,
): string[] {
  const set = new Set<string>()
  for (const m of members) {
    const svc = m.labels?.['service']
    if (typeof svc === 'string' && svc.trim() !== '') set.add(svc)
  }
  if (set.size === 0) {
    const key = computeIncidentKey(members[0]!, groupByKeys) ?? groupKey
    const idx = key.indexOf('=')
    set.add(idx >= 0 ? key.slice(idx + 1) : key)
  }
  return [...set]
}

/** 构造 Incident 实体，并把 incident ref 就地写回每个成员告警。 */
export function buildIncident(args: {
  incidentId: string
  type: IncidentType
  groupKey: string
  members: Alert[]
  cfg: CorrelationConfig
}): Incident {
  const { incidentId, type, groupKey, members, cfg } = args
  const primaryAlert = pickPrimary(members)

  for (const alert of members) {
    const ref: IncidentRef = {
      incidentId,
      groupKey,
      siblingTitles: members.filter(member => member !== alert).map(member => member.title),
    }
    alert.incident = ref
  }

  return {
    incidentId,
    type,
    groupKey,
    primaryAlert,
    alerts: members,
    severity: primaryAlert.severity,
    startedAt: earliestStartsAt(members, primaryAlert),
    affectedServices: collectAffectedServices(members, cfg.groupByKeys, groupKey),
  }
}

/**
 * 对一批告警做**批次内**确定性关联：
 * - 规则①②③：同分组 + 同时间桶且成员数 ≥ minAlerts → 生成事件，成员就地写入 `alert.incident`。
 * - 规则④（拓扑）：对上述未并组的**漏网单例**，按注入的依赖图 + 时间窗二次关联。
 * - 未达阈值 / 无稳定标签 / 图不可用 → 不写入，保持单例诊断。
 *
 * 返回本次生成的事件列表（仅含达阈值者）。就地写入 `alert.incident` 的理由：
 * Alert 是每次请求新构造的一次性对象，且关联必须基于整批（siblings 需全批可见），
 * 直接标注比返回旁路 Map 更少胶水代码，也让 `alertSessionId` 能据 ref 派生出事件 sessionId。
 *
 * 跨批次（新告警并入已有 open 事件）不在此函数内 —— 见 incident-registry.ts。
 *
 * @param graph 拓扑图；null / 省略表示无拓扑数据（该层静默跳过，退化为纯规则关联）。
 */
export function correlateAlerts(
  alerts: Alert[],
  config: Partial<CorrelationConfig> = {},
  now: number = Date.now(),
  graph: DependencyGraph | null = null,
): Incident[] {
  const cfg: CorrelationConfig = { ...DEFAULT_CORRELATION_CONFIG, ...config }
  if (!cfg.enabled) return []

  const incidents: Incident[] = []
  for (const group of planAlertGroups(alerts, config, now, graph)) {
    if (group.type === 'topology') {
      // 拓扑簇已在 clusterByTopology 内按拓扑阈值过滤，直接成事件。
      incidents.push(
        buildIncident({
          incidentId: incidentIdFor(group.identity, cfg.windowMs, now),
          type: 'topology',
          groupKey: group.groupKey,
          members: group.members,
          cfg,
        }),
      )
      continue
    }
    // 无稳定维度 → 不生成事件（保持单例诊断，宁可漏关联也不错并）。
    if (group.keyName === null) continue
    // 阈值护栏：未达 minAlerts 不生成事件（避免把无关告警硬并）。
    if (group.members.length < cfg.minAlerts) continue

    incidents.push(
      buildIncident({
        incidentId: incidentIdFor(group.identity, cfg.windowMs, now),
        type: 'rule',
        groupKey: group.groupKey,
        members: group.members,
        cfg,
      }),
    )
  }

  return incidents
}
