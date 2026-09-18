/**
 * Grafana Unified Alerting webhook 适配器。
 *
 * 参考 payload：https://grafana.com/docs/grafana/latest/alerting/configure-notifications/webhook-notifier/
 * 顶层结构：{ orgId, title, state, message, alerts: [...], groupLabels, commonLabels, ... }
 *
 * **与 Alertmanager 的区分依据**：两者顶层结构高度重叠（同为 `{ status, alerts: [...] }`），
 * 只能用 Grafana 专有的 **`orgId`** 字段区分。若某版本 Grafana payload 不带 orgId，
 * 会落到 alertmanager 适配器——labels/annotations 位置一致，语义仍可用，仅 source 标记不准。
 *
 * 差异点：Grafana 告警实例状态是 `alerting` / `ok`（Alertmanager 是 firing / resolved）。
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
  asIso,
  asRecord,
  asStringRecord,
  firstString,
  labelsToDescription,
  toAlertStatus,
} from './util.js'

export const grafanaAdapter: AlertSourceAdapter = {
  name: 'grafana',
  matches(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    return Array.isArray(candidate.alerts) && 'orgId' in candidate
  },
  parse(body: unknown): Alert[] {
    if (typeof body !== 'object' || body === null) {
      throw new Error('grafana: payload 为空')
    }
    const payload = asRecord(body)
    const nowIso = new Date().toISOString()
    const result: Alert[] = []

    for (const item of asArray(payload.alerts)) {
      const raw = asRecord(item)
      if (Object.keys(raw).length === 0) continue

      const labels = asStringRecord(raw.labels)
      const annotations = asStringRecord(raw.annotations)
      const status = toAlertStatus(firstString(raw, ['status', 'state']), [
        'ok',
        'normal',
        'resolved',
      ])
      // resolved（Grafana 的 `ok`）不再丢弃：交由 `IngestPipeline` 走事件收敛路径，
      // 关闭事件且不触发 RCA（对齐 alertmanager 适配器）。
      const title =
        labels.alertname || firstString(raw, ['title', 'name']) || 'untitled-alert'
      const severity =
        normalizeSeverity(
          labels.severity || firstString(raw, ['severity', 'priority', 'level']),
        ) || DEFAULT_SEVERITY
      const summary = annotations.summary || firstString(annotations, ['description']) || ''
      // Grafana 的 valueString 带命中指标值，是 RCA 的直接证据，优先保留。
      const valueString = firstString(raw, ['valueString'])
      const description =
        annotations.description || valueString || labelsToDescription(labels)
      const startsAt = asIso(firstString(raw, ['startsAt', 'starts_at']), nowIso)

      result.push({
        id: computeAlertId(title, labels),
        title,
        severity,
        source: 'grafana',
        summary,
        description,
        labels: { ...labels },
        startsAt,
        status,
      })
    }

    return result
  },
}
