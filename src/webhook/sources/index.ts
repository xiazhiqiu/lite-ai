/**
 * 告警源适配器注册表 + 自动路由。
 *
 * 新增告警源：只需实现 AlertSourceAdapter 并在此数组注册，无需改动执行路径。
 */
import type { AlertSourceAdapter } from '../types.js'
import { alertmanagerAdapter } from './alertmanager.js'

export const alertSourceAdapters: AlertSourceAdapter[] = [
  alertmanagerAdapter,
  // grafanaAdapter,     // 后续新增，不改执行路径
  // pagerdutyAdapter,
  // zabbixAdapter,
]

export function routeAlertSource(body: unknown): AlertSourceAdapter {
  const adapter = alertSourceAdapters.find(a => a.matches(body))
  if (!adapter) {
    throw new Error('无法识别告警源 payload 格式')
  }
  return adapter
}

export { alertmanagerAdapter }