/**
 * 告警统一抽象与告警源适配器接口。
 *
 * 不同告警源（Alertmanager / Grafana / PagerDuty...）经各自适配器解析为统一的
 * Alert[]，业务层（diagnose / notify / index.ts）只依赖 Alert，不感知具体来源。
 */
import { createHash } from 'node:crypto'

/**
 * 跨源关联结果（由 correlate.ts / incident-registry.ts 写入）。
 * 告知本次诊断该告警属于哪个事件、同组有哪些相关告警，以及**为什么**被关联（可审计）。
 */
export type IncidentRef = {
  /** 确定性 incident id（分组键派生；事件成为诊断单元后即其 sessionId） */
  incidentId: string
  /** 命中的分组维度，形如 "service=payment" */
  groupKey: string
  /** 同事件的其他告警标题（不含自身） */
  siblingTitles: string[]
  /** 事件键强度（注册表写入时提供） */
  keyStrength?: IncidentKeyStrength
  /** 关联原因集合（可审计：解释"为什么这条告警被关联进来"） */
  reasons?: CorrelationReason[]
}

/**
 * 事件（Incident）：诊断单元。
 *
 * 由 correlate.ts 在同一分组 + 时间窗内、成员数达 `minAlerts` 时生成（确定性、零 LLM）。
 * 与 IncidentRef 的区别：Ref 是挂在单条 Alert 上的轻量引用；Incident 是完整事件实体，
 * 承载"主告警 / 成员列表 / 严重度 / 影响面 / 起始时间"，是事件级 RCA 的输入。
 */
/** 事件来源：规则关联（①②③）或拓扑关联（④）。 */
export type IncidentType = 'rule' | 'topology'

/**
 * 事件键强度（对齐 OpenObserve 的 `KeyType`）。
 * 层级：`alertId`（最弱）→ `secondary` → `primary`（最强）；新成员只升不降。
 * - `primary`   命中业务维度（app / application / service）—— 最强的同源证据
 * - `secondary` 仅命中基础设施维度（namespace / cluster / pod ...）—— 较弱证据
 * - `alertId`   无任何稳定维度 —— 按告警自身隔离。语义等价单条诊断，
 *               但**仍走 incident 路径**（统一路径，避免分支与"漏网"两个概念）。
 */
export type IncidentKeyStrength = 'primary' | 'secondary' | 'alertId'

/**
 * 跨批次关联结果（对齐 OpenObserve 的 `IncidentCorrelationOutcome`）。
 *
 * 关键价值：区分"新成员加入"与"同一告警重复到达"——
 * 后者不再被静默丢弃，而是**保留成员记录 + 累计到达次数 + 不重复触发 RCA**。
 */
export type IncidentCorrelationOutcome =
  /** 新建事件（首个成员到达） */
  | 'newIncidentCreated'
  /** 新成员加入已有 open 事件（不同 alertId） */
  | 'newAlertTypeJoined'
  /** 同一告警重复到达（同 alertId）—— 记时间线，不重复烧 token */
  | 'existingAlertRepeated'
  /** 新成员严重度高于事件当前严重度 → 升级 */
  | 'severityEscalated'

/** 关联原因（可审计，对齐 OpenObserve 的 `CorrelationReason`）：这条告警因何被关联。 */
export type CorrelationReason =
  | 'primaryMatch'
  | 'secondaryMatch'
  | 'topology'
  | 'alertId'

export type Incident = {
  /** 确定性事件 id（= 成员的 sessionId） */
  incidentId: string
  /** 关联来源：rule = 标签+时间窗+阈值；topology = 拓扑图（归属/调用边） */
  type: IncidentType
  /** 命中的分组维度，形如 "service=payment" / "application=payments" */
  groupKey: string
  /** 主告警：severityWeight 最高、startsAt 最早（first_wins） */
  primaryAlert: Alert
  /** 全部成员告警（含主告警） */
  alerts: Alert[]
  /** 事件严重度 = 主告警严重度 */
  severity: string
  /** 事件起始时间 = 成员中最早的 startsAt */
  startedAt: string
  /** 影响面：成员涉及的 service 集合（无 CMDB，仅按标签聚合） */
  affectedServices: string[]
  /** 事件键强度（注册表判定；correlate.ts 批次内直出时缺省） */
  keyStrength?: IncidentKeyStrength
  /** 原始到达次数（含同一告警重复到达）；成员数 ≠ 到达次数 */
  observedCount?: number
  /** 关联原因集合（可审计） */
  reasons?: CorrelationReason[]
}

export type Alert = {
  /** alertname + labels 哈希，用于去重与派生 sessionId */
  id: string
  /** alertname */
  title: string
  /** labels.severity，默认 "SEV3" */
  severity: string
  /**
   * 来源 provider 标识（alertmanager / grafana / pagerduty / opsgenie / generic ...）。
   * 用于溯源与按源过滤（对齐 Keep 的 alert.source）。**可选**，以保持向后兼容：
   * 既有落库数据与单测构造的 Alert 不含该字段也能正常工作。
   */
  source?: string
  /** annotations.summary */
  summary: string
  /** annotations.description 或 labels 拼接 */
  description: string
  labels: Record<string, string>
  /** 触发时间（ISO 字符串） */
  startsAt: string
  /** firing | resolved */
  status: 'firing' | 'resolved'
  /** 跨源关联结果（可选）；由 correlate.ts 在解析后写入。 */
  incident?: IncidentRef
}

export interface AlertSourceAdapter {
  /** 唯一标识，用于路由 */
  name: string
  /** 判断 body 是否属于本源（用于自动路由） */
  matches(body: unknown): boolean
  /** 解析为统一 Alert[] */
  parse(body: unknown): Alert[]
}

/** 严重级别权重，用于截断时 critical 优先。 */
export function severityWeight(severity: string): number {
  const s = severity.trim().toLowerCase()
  if (s === 'critical' || s === 'critical1' || s === 'sev1' || s === 'p0' || s === 'severe') {
    return 4
  }
  if (s === 'error' || s === 'major' || s === 'sev2' || s === 'p1' || s === 'high') {
    return 3
  }
  if (s === 'warning' || s === 'warn' || s === 'sev3' || s === 'p2' || s === 'medium') {
    return 2
  }
  if (s === 'info' || s === 'sev4' || s === 'sew4') {
    return 1
  }
  return 2
}

/**
 * 多源 severity 词表归一化 → 内部标准词。
 *
 * **只处理 severityWeight 当前识别不了的外来词表**（这些词原本会落到默认权重 2，
 * 例如 Zabbix 的 disaster/average、CloudWatch 的 ALARM、Opsgenie 的 P3）。
 * 对已识别的别名（high / medium / p1 / sev1 / critical1 ...）保持原样返回，
 * 以免改变既有 Alertmanager 路径的严重度权重（行为保持优先）。
 */
export function normalizeSeverity(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (s === 'disaster' || s === 'fatal') return 'critical'
  if (s === 'alarm') return 'error'
  if (s === 'average' || s === 'moderate' || s === 'p3') return 'warning'
  if (s === 'low' || s === 'trivial' || s === 'not_classified') return 'info'
  return raw
}

const DEFAULT_SEVERITY = 'SEV3'

/** 根据 alertname + 稳定排序后的 labels 派生告警 id。 */
export function computeAlertId(title: string, labels: Record<string, string>): string {
  const sortedLabels = Object.keys(labels)
    .sort()
    .map(key => `${key}=${labels[key]}`)
    .join(',')
  return createHash('sha1')
    .update(`${title}|${sortedLabels}`)
    .digest('hex')
    .slice(0, 12)
}

export function normalizeToUserMessage(alert: Alert): string {
  const lines = [
    '[告警自动触发]',
    `告警: ${alert.title} (${alert.severity})`,
    `状态: ${alert.status}`,
    `触发时间: ${alert.startsAt}`,
    `摘要: ${alert.summary}`,
    `描述: ${alert.description}`,
    `Labels: ${Object.entries(alert.labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  ]

  // 跨源关联富化：告知本条告警所属 incident 与同批相关告警（不合并诊断）。
  if (alert.incident) {
    lines.push(
      `事件关联: ${alert.incident.incidentId}（分组 ${alert.incident.groupKey}）`,
    )
    if (alert.incident.siblingTitles.length > 0) {
      lines.push(
        `同批相关告警 ${alert.incident.siblingTitles.length} 条（可能同源，仅供参考）: ${alert.incident.siblingTitles.join('、')}`,
      )
    }
  }

  lines.push(
    '',
    '请按照事故诊断协议执行根因分析：调用诊断工具（Prometheus / ES / kubectl / tail_logs / search_incident_kb）收集证据，建立并验证假设链，给出根因结论与处置建议。完成后可生成复盘报告。',
  )
  return lines.join('\n')
}

/**
 * 派生可 resume 的会话 id。
 * - 归属事件的告警：共享 `incidentId` → 一个事件 = 一个 session = 一次 RCA。
 * - 未归属事件的告警（单例）：用自身 `alertId`。
 */
export function alertSessionId(alert: Alert): string {
  return alert.incident?.incidentId ?? alert.id
}

/**
 * 事件级诊断消息：把整个事件包（主告警 + 全部成员）交给 Agent，统筹分析。
 *
 * 与单条 `normalizeToUserMessage` 的关键差异：注入"逐条确认根因、允许多重根因"协议，
 * 避免系统把不同根因的告警硬并成单一结论（错并是 RCA 的灾难，比噪音更危险）。
 */
export function normalizeIncidentMessage(incident: Incident): string {
  const source = incident.type === 'topology' ? '拓扑关联（同业务/调用链邻居）' : '规则关联（标签+时间窗）'
  const lines = [
    '[事件级告警触发]',
    `事件: ${incident.incidentId}（分组 ${incident.groupKey}，来源 ${source}）`,
    `严重度: ${incident.severity}`,
    `起始时间: ${incident.startedAt}`,
    `影响服务: ${incident.affectedServices.join('、') || '未知'}`,
    `成员告警 ${incident.alerts.length} 条（同一事件，非孤立信号）：`,
  ]

  incident.alerts.forEach((alert, index) => {
    const isPrimary = alert === incident.primaryAlert
    lines.push(
      `${index + 1}. ${alert.title} (${alert.severity})${isPrimary ? ' [主告警]' : ''}`,
      `   状态: ${alert.status}  触发时间: ${alert.startsAt}`,
      `   摘要: ${alert.summary}`,
      `   描述: ${alert.description}`,
      `   Labels: ${Object.entries(alert.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    )
  })

  lines.push(
    '',
    '以上为同一事件（同一分组 + 时间窗内）的全部相关告警，请按事件级事故诊断协议执行根因分析：',
    '- 统筹分析全部成员告警，构建全局时间线与因果链（谁最先异常、如何扩散、影响哪些服务）。',
    '- **逐条确认成员告警的根因是否相同；若不同，请分别给出独立根因（允许多重根因），切勿强行归并为单一根因。**',
    '- 调用诊断工具（Prometheus / ES / kubectl / tail_logs / search_incident_kb）收集证据，建立并验证假设链，给出根因结论与处置建议。完成后可生成复盘报告。',
  )
  return lines.join('\n')
}

export { DEFAULT_SEVERITY }