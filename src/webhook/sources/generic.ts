/**
 * 通用单告警适配器（业务自定义 / 单条事件型源 / CI-CD 回调）。
 *
 * 覆盖"一 POST 一告警"的推送形态：自定义脚本、业务监控埋点、简单 CI/CD 回调等。
 * 这类源**没有 `alerts` 数组**，与 Alertmanager/Grafana 的微批形态互斥。
 *
 * > ⚠️ **注册顺序红线**：本适配器必须排在 `alertSourceAdapters` 的**最后一位**。
 * > 路由用 `adapters.find(a => a.matches(body))`（`index.ts:17`）首个命中即胜，
 * > 放前面会抢占其它源的 payload。
 *
 * 约定：调用方 payload 至少含 `alertname` / `title` / `name` / `alert` 之一作为告警名。
 */
import {
  computeAlertId,
  DEFAULT_SEVERITY,
  normalizeSeverity,
  type Alert,
  type AlertSourceAdapter,
} from '../types.js'
import {
  asIso,
  asRecord,
  asStringRecord,
  firstString,
  labelsToDescription,
  toAlertStatus,
} from './util.js'

/** tags 可能是数组（["prod","payments"]）或对象；统一转成 Record<string,string>。 */
function normalizeTags(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const out: Record<string, string> = {}
    for (const item of value) {
      const tag = String(item).trim()
      if (tag !== '') out[tag] = 'true'
    }
    return out
  }
  return asStringRecord(value)
}

export const genericAdapter: AlertSourceAdapter = {
  name: 'generic',
  matches(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    // 与微批型源互斥：有 alerts 数组的不属于本适配器。
    if (Array.isArray(candidate.alerts)) return false
    return (
      'alertname' in candidate ||
      'title' in candidate ||
      'name' in candidate ||
      'alert' in candidate
    )
  },
  parse(body: unknown): Alert[] {
    if (typeof body !== 'object' || body === null) {
      throw new Error('generic: payload 为空')
    }
    const raw = asRecord(body)
    const nowIso = new Date().toISOString()

    const title =
      firstString(raw, ['alertname', 'title', 'name', 'alert']) || 'untitled-alert'
    const severity =
      normalizeSeverity(
        firstString(raw, ['severity', 'priority', 'level', 'level_name']),
      ) || DEFAULT_SEVERITY
    // resolved 不再丢弃：交由 `IngestPipeline` 走事件收敛路径（不触发 RCA）。
    const status = toAlertStatus(firstString(raw, ['status', 'state', 'eventType']))

    const labels = {
      ...normalizeTags(raw.tags),
      ...asStringRecord(raw.labels),
    }
    const summary = firstString(raw, ['summary', 'message', 'text'])
    const description =
      firstString(raw, ['description', 'detail', 'details']) ||
      labelsToDescription(labels)
    const startsAt = asIso(
      firstString(raw, ['startsAt', 'starts_at', 'timestamp', 'time', 'firedAt']),
      nowIso,
    )

    return [
      {
        id: computeAlertId(title, labels),
        title,
        severity,
        source: firstString(raw, ['source', 'provider']) || 'generic',
        summary,
        description,
        labels,
        startsAt,
        status,
      },
    ]
  },
}
