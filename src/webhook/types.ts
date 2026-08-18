/**
 * 告警统一抽象与告警源适配器接口。
 *
 * 不同告警源（Alertmanager / Grafana / PagerDuty...）经各自适配器解析为统一的
 * Alert[]，业务层（diagnose / notify / index.ts）只依赖 Alert，不感知具体来源。
 */
import { createHash } from 'node:crypto'

export type Alert = {
  /** alertname + labels 哈希，用于去重与派生 sessionId */
  id: string
  /** alertname */
  title: string
  /** labels.severity，默认 "SEV3" */
  severity: string
  /** annotations.summary */
  summary: string
  /** annotations.description 或 labels 拼接 */
  description: string
  labels: Record<string, string>
  /** 触发时间（ISO 字符串） */
  startsAt: string
  /** firing | resolved */
  status: 'firing' | 'resolved'
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
    '',
    '请按照事故诊断协议执行根因分析：调用诊断工具（Prometheus / ES / kubectl / tail_logs / search_incident_kb）收集证据，建立并验证假设链，给出根因结论与处置建议。完成后可生成复盘报告。',
  ]
  return lines.join('\n')
}

/** 用 alertId 派生、可 resume 的会话 id。 */
export function alertSessionId(alert: Alert): string {
  return alert.id
}

export { DEFAULT_SEVERITY }