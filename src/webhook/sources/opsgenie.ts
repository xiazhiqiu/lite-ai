/**
 * Opsgenie webhook 适配器。
 *
 * 参考 payload：https://docs.opsgenie.com/docs/webhook-integration
 * 顶层结构：{ action, alert: {...}, integrationName, userName, webhookId }
 *
 * `action` 常见取值：Create / Acknowledge / Close / AddNote / AssignOwnership /
 * Update priority / Custom（自定义动作名，如 "Restart Service"）。
 * 只有 **Close** 视为恢复（resolved）；其余动作都当作 firing 告警处理。
 *
 * 严重度：Opsgenie 用 **`priority: P1..P5`** 而非 severity 字段 → 显式映射。
 */
import {
  computeAlertId,
  DEFAULT_SEVERITY,
  normalizeSeverity,
  type Alert,
  type AlertSourceAdapter,
} from '../types.js'
import {
  asArray,
  asDisplayRecord,
  asIso,
  asRecord,
  firstString,
  labelsToDescription,
  toAlertStatus,
} from './util.js'

/** Opsgenie 的 priority(P1..P5) → 内部严重度；非 P 值返回 '' 交由后续兜底。 */
function priorityToSeverity(priority: string): string {
  switch (priority.trim().toUpperCase()) {
    case 'P1':
      return 'critical'
    case 'P2':
      return 'error'
    case 'P3':
      return 'warning'
    case 'P4':
    case 'P5':
      return 'info'
    default:
      return ''
  }
}

export const opsgenieAdapter: AlertSourceAdapter = {
  name: 'opsgenie',
  matches(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    return 'action' in candidate && 'alert' in candidate
  },
  parse(body: unknown): Alert[] {
    if (typeof body !== 'object' || body === null) {
      throw new Error('opsgenie: payload 为空')
    }
    const payload = asRecord(body)
    const alert = asRecord(payload.alert)
    if (Object.keys(alert).length === 0) return []

    const action = firstString(payload, ['action'])
    const status =
      action.trim().toLowerCase() === 'close'
        ? 'resolved'
        : toAlertStatus(firstString(alert, ['status']), ['closed', 'resolved'])
    // T6 之前统一过滤 resolved。
    if (status === 'resolved') return []

    const title =
      firstString(alert, ['message', 'name', 'alias']) || 'untitled-alert'
    const priority = firstString(alert, ['priority'])
    const severity =
      priorityToSeverity(priority) ||
      normalizeSeverity(firstString(alert, ['severity', 'severity_level'])) ||
      DEFAULT_SEVERITY

    const labels: Record<string, string> = {}
    for (const tag of asArray(alert.tags)) {
      const t = String(tag).trim()
      if (t !== '') labels[t] = 'true'
    }
    const entity = firstString(alert, ['entity'])
    if (entity !== '') labels.entity = entity

    // details 里的值可能是数字（如队列长度），展示必须保留 → 用 asDisplayRecord。
    const details = asDisplayRecord(alert.details)
    const url = firstString(alert, ['alertUrl', 'url', 'tinyId'])
    const parts: string[] = []
    if (Object.keys(details).length > 0) {
      parts.push(
        Object.entries(details)
          .map(([k, v]) => `${k}=${v}`)
          .join(', '),
      )
    }
    if (url !== '') parts.push(`URL: ${url}`)
    const description = parts.length > 0 ? parts.join('\n') : labelsToDescription(labels)

    const startsAt = asIso(
      firstString(alert, ['createdAt', 'created_at', 'updatedAt']),
      new Date().toISOString(),
    )

    return [
      {
        id: computeAlertId(title, labels),
        title,
        severity,
        source: 'opsgenie',
        summary: firstString(alert, ['description', 'message']),
        description,
        labels,
        startsAt,
        status: 'firing',
      },
    ]
  },
}
