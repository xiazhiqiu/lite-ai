/**
 * 兜底去重 + 硬截断护栏。
 *
 * Alertmanager 自身已提供分组（group_by）、重复控制（repeat_interval）、
 * 抑制（inhibit_rules）、静默（silence）。lite-ai 侧仅做轻量兜底 + 硬截断护栏：
 * - 兜底去重：覆盖 HA 双发（秒级）、网络重试（分钟级）
 * - 硬截断：防 Alertmanager 误配导致单次请求含大量告警
 */
import type { Alert } from './types.js'
import { severityWeight } from './types.js'

/** 单次请求最多处理的告警数（防误配的最后一道防线） */
export const MAX_ALERTS_PER_BATCH = 10

/**
 * 硬截断护栏：按严重级别排序后截断，critical 优先。
 * 返回 { alerts, truncated } ，truncated 为被截掉的告警数。
 */
export function truncateAlerts(
  alerts: Alert[],
): { alerts: Alert[]; truncated: number } {
  if (alerts.length <= MAX_ALERTS_PER_BATCH) {
    return { alerts, truncated: 0 }
  }
  const sorted = [...alerts].sort(
    (a, b) => severityWeight(b.severity) - severityWeight(a.severity),
  )
  return {
    alerts: sorted.slice(0, MAX_ALERTS_PER_BATCH),
    truncated: alerts.length - MAX_ALERTS_PER_BATCH,
  }
}

export class AlertDedupe {
  private diagnosed = new Map<string, number>()
  private readonly windowMs: number

  /** @param windowMs 冷却窗口，默认 5 分钟 */
  constructor(windowMs = 300_000) {
    this.windowMs = windowMs
  }

  /** 是否应诊断：alertId 处于冷却窗口内则跳过。 */
  shouldDiagnose(alertId: string): boolean {
    const now = Date.now()
    const lastTime = this.diagnosed.get(alertId)

    if (lastTime !== undefined && now - lastTime < this.windowMs) {
      return false
    }

    this.diagnosed.set(alertId, now)

    // 窗口结束后自动清理该 key，防止 Map 无限膨胀。
    setTimeout(() => {
      this.diagnosed.delete(alertId)
    }, this.windowMs + 1)

    return true
  }
}