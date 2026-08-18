/**
 * Alertmanager webhook 适配器（首版唯一实现）。
 *
 * 参考 payload：https://prometheus.io/docs/alerting/latest/webhook/
 * 顶层结构：{ status, alerts: [...], commonLabels, commonAnnotations, ... }
 */
import {
  computeAlertId,
  DEFAULT_SEVERITY,
  type Alert,
  type AlertSourceAdapter,
} from '../types.js'

type AlertmanagerPayload = {
  status?: string
  alerts?: Array<{
    status?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    startsAt?: string
    endsAt?: string
  }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export const alertmanagerAdapter: AlertSourceAdapter = {
  name: 'alertmanager',
  matches(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    return (
      'alerts' in candidate && Array.isArray(candidate.alerts)
    )
  },
  parse(body: unknown): Alert[] {
    if (typeof body !== 'object' || body === null) {
      throw new Error('alertmanager: payload 为空')
    }
    const payload = body as AlertmanagerPayload
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : []
    const result: Alert[] = []

    for (const raw of alerts) {
      if (typeof raw !== 'object' || raw === null) continue
      // 只处理 firing；resolved 直接过滤
      if (raw.status === 'resolved') continue

      const labels = raw.labels ?? {}
      const annotations = raw.annotations ?? {}
      const title = asString(labels.alertname) || 'untitled-alert'
      const severity = asString(labels.severity) || DEFAULT_SEVERITY
      const summary = asString(annotations.summary) || ''
      const description =
        asString(annotations.description) ||
        Object.entries(labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      const startsAt = asString(raw.startsAt) || new Date(0).toISOString()

      result.push({
        id: computeAlertId(title, labels),
        title,
        severity,
        summary,
        description,
        labels: { ...labels },
        startsAt,
        status: 'firing',
      })
    }

    return result
  },
}