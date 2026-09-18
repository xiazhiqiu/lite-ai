/**
 * Alertmanager webhook 适配器。
 *
 * 参考 payload：https://prometheus.io/docs/alerting/latest/webhook/
 * 顶层结构：{ status, alerts: [...], commonLabels, commonAnnotations, ... }
 *
 * > ⚠️ 与 Grafana 的 payload 结构高度重叠（同为 `{ status, alerts: [...] }`），
 * > 两者靠 Grafana 专有的 **`orgId` 字段**区分（见 grafana.ts）。若某版本 Grafana
 * > 不带 orgId，会落到本适配器——语义仍可用（labels/annotations 位置一致），
 * > 只是 `source` 会标成 alertmanager。
 */
import {
  computeAlertId,
  DEFAULT_SEVERITY,
  normalizeSeverity,
  type Alert,
  type AlertSourceAdapter,
} from '../types.js'
import { asRecord, asString, asStringRecord, labelsToDescription } from './util.js'

export const alertmanagerAdapter: AlertSourceAdapter = {
  name: 'alertmanager',
  matches(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    return 'alerts' in candidate && Array.isArray(candidate.alerts)
  },
  parse(body: unknown): Alert[] {
    if (typeof body !== 'object' || body === null) {
      throw new Error('alertmanager: payload 为空')
    }
    const payload = body as Record<string, unknown>
    const raws = Array.isArray(payload.alerts) ? payload.alerts : []
    const result: Alert[] = []

    for (const item of raws) {
      const raw = asRecord(item)
      if (Object.keys(raw).length === 0) continue
      // 只处理 firing；resolved 直接过滤
      if (asString(raw.status) === 'resolved') continue

      const labels = asStringRecord(raw.labels)
      const annotations = asStringRecord(raw.annotations)
      const title = labels.alertname || 'untitled-alert'
      const severity = normalizeSeverity(labels.severity || '') || DEFAULT_SEVERITY
      const summary = annotations.summary || ''
      const description = annotations.description || labelsToDescription(labels)
      const startsAt = asString(raw.startsAt) || new Date(0).toISOString()

      result.push({
        id: computeAlertId(title, labels),
        title,
        severity,
        source: 'alertmanager',
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
