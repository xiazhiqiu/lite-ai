/**
 * PagerDuty webhook 适配器。
 *
 * 支持两种形态：
 * - **v2**：`{ messages: [{ id, event, incident: {...}, log_entries: [...] }] }`
 *   event 取值如 `incident.trigger` / `incident.resolve` / `incident.acknowledge`。
 * - **v3**：`{ event: { id, event_type, resource, occurred_at }, incident: {...} }`
 *
 * 严重度：较新的 PD API 提供 `severity`（critical/error/warning/info）；
 * 经典版本只有 `urgency: high|low`，此处映射为 error/warning。
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
  firstString,
  labelsToDescription,
  scalarToString,
  toAlertStatus,
} from './util.js'

/** PD 经典版无 severity 字段，只有 urgency：high → error，low → warning。 */
function urgencyToSeverity(urgency: string): string {
  return urgency.trim().toLowerCase() === 'high' ? 'error' : 'warning'
}

export const pagerdutyAdapter: AlertSourceAdapter = {
  name: 'pagerduty',
  matches(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    if (Array.isArray(candidate.messages)) return true
    return 'incident' in candidate && 'event' in candidate
  },
  parse(body: unknown): Alert[] {
    if (typeof body !== 'object' || body === null) {
      throw new Error('pagerduty: payload 为空')
    }
    const payload = asRecord(body)
    const messages = asArray(payload.messages)
    const nowIso = new Date().toISOString()
    // v2 取 messages 内每条的 incident；v3（无 messages）视为单事件。
    const entries = messages.length > 0 ? messages.map(asRecord) : [payload]
    const result: Alert[] = []

    for (const entry of entries) {
      const incident = asRecord(entry.incident)
      if (Object.keys(incident).length === 0) continue

      const status = toAlertStatus(firstString(incident, ['status']), ['resolved'])
      // T6 之前统一过滤 resolved。
      if (status === 'resolved') continue

      const service = asRecord(incident.service)
      const priority = asRecord(incident.priority)
      const triggerSummary = asRecord(incident.trigger_summary_data)
      const title =
        firstString(incident, ['title', 'description']) ||
        firstString(triggerSummary, ['subject', 'description']) ||
        'untitled-alert'

      const rawSeverity = firstString(incident, ['severity'])
      const urgency = firstString(incident, ['urgency'])
      const severity =
        rawSeverity !== ''
          ? normalizeSeverity(rawSeverity)
          : urgency !== ''
            ? urgencyToSeverity(urgency)
            : DEFAULT_SEVERITY

      // labels 保持**少量且稳定**：它们参与 fingerprint（computeAlertId），
      // 塞入可变字段会让同一告警每次算出不同 id，破坏去重与跨批次关联。
      const labels: Record<string, string> = {}
      const serviceName = firstString(service, ['name', 'summary'])
      if (serviceName !== '') labels.service = serviceName
      if (urgency !== '') labels.urgency = urgency
      // incident_number 在真实 payload 里是**数字**，用 scalarToString 而非 firstString。
      const incidentNumber = scalarToString(
        incident.incident_number ?? incident.incidentNumber,
      )
      if (incidentNumber !== '') labels.incident_number = incidentNumber
      const priorityName = firstString(priority, ['name', 'summary'])
      if (priorityName !== '') labels.priority = priorityName

      const url = firstString(incident, ['html_url', 'url'])
      const description = url !== '' ? `URL: ${url}` : labelsToDescription(labels)
      const created =
        firstString(incident, ['created_on', 'created_at', 'occurred_at']) ||
        firstString(entry, ['created_on', 'occurred_at'])

      result.push({
        id: computeAlertId(title, labels),
        title,
        severity,
        source: 'pagerduty',
        summary: firstString(incident, ['description']) || title,
        description,
        labels,
        startsAt: asIso(created, nowIso),
        status: 'firing',
      })
    }

    return result
  },
}
