/**
 * 告警源适配器注册表 + 自动路由。
 *
 * 新增告警源：只需实现 AlertSourceAdapter 并在此数组注册，无需改动执行路径。
 *
 * ## 注册顺序是正确性的一部分（不是风格问题）
 * 路由用 `alertSourceAdapters.find(a => a.matches(body))` —— **首个命中即胜**，
 * 所以"匹配越宽泛的适配器越靠后"：
 * 1. **grafana 先于 alertmanager**：两者 payload 顶层结构几乎一样（都是
 *    `{ status, alerts: [...] }`），而 alertmanager 的 matches 只要求"有 alerts
 *    数组"，若排在前会把 Grafana payload 吞掉（Grafana 靠专有字段 orgId 识别）。
 * 2. **generic 必须最后**：它匹配"任何含 alertname/title/name/alert 的单对象"，
 *    放前面会抢占几乎所有源的 payload。
 */
import type { AlertSourceAdapter } from '../types.js'
import { grafanaAdapter } from './grafana.js'
import { pagerdutyAdapter } from './pagerduty.js'
import { opsgenieAdapter } from './opsgenie.js'
import { alertmanagerAdapter } from './alertmanager.js'
import { genericAdapter } from './generic.js'

export const alertSourceAdapters: AlertSourceAdapter[] = [
  grafanaAdapter,
  pagerdutyAdapter,
  opsgenieAdapter,
  alertmanagerAdapter,
  genericAdapter, // 兜底，必须最后
]

export function routeAlertSource(body: unknown): AlertSourceAdapter {
  const adapter = alertSourceAdapters.find(a => a.matches(body))
  if (!adapter) {
    throw new Error('无法识别告警源 payload 格式')
  }
  return adapter
}

export {
  alertmanagerAdapter,
  grafanaAdapter,
  pagerdutyAdapter,
  opsgenieAdapter,
  genericAdapter,
}
