/**
 * RE2-SS 评测：实例路径映射与真值解析。
 *
 * RE2-SS 测试集结构：dataset/RE2-SS/RE2-SS/{service}_{fault}/{1,2,3}/
 * 每个实例含 cluster_info.json / inject_time.txt / logs.csv / metrics.csv 等。
 * 真值由目录名解析：pay_mem → service="payment", fault="mem"。
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'

export const RE2SS_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'dataset',
  'RE2-SS',
  'RE2-SS',
)

export const KNOWN_SERVICES = [
  'payment',
  'carts',
  'catalogue',
  'orders',
  'user',
  'shipping',
] as const

export const KNOWN_FAULTS = [
  'cpu',
  'mem',
  'disk',
  'socket',
  'delay',
  'loss',
] as const

export type Re2ssScenario = {
  /** 服务名（真值），如 "payment" */
  service: string
  /** 故障类型（真值），如 "mem" */
  fault: string
  /** 场景目录名，如 "payment_mem" */
  name: string
  /** 实例目录列表（1/2/3），如 ["1","2","3"] */
  instances: string[]
}

/** 从目录名解析真值，如 "payment_loss" → { service: "payment", fault: "loss" } */
export function parseTruth(name: string): { service: string; fault: string } | null {
  const sep = name.lastIndexOf('_')
  if (sep <= 0) return null
  const service = name.slice(0, sep)
  const fault = name.slice(sep + 1)
  if (!KNOWN_SERVICES.includes(service as (typeof KNOWN_SERVICES)[number])) return null
  if (!KNOWN_FAULTS.includes(fault as (typeof KNOWN_FAULTS)[number])) return null
  return { service, fault }
}

/** 扫描 RE2-SS 根目录，返回所有场景 + 各自实例。 */
export async function discoverScenarios(
  root: string = RE2SS_ROOT,
): Promise<Re2ssScenario[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const scenarios: Re2ssScenario[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const truth = parseTruth(entry.name)
    if (!truth) continue
    const instanceDir = path.join(root, entry.name)
    const instances = (await readdir(instanceDir, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
    if (instances.length === 0) continue
    scenarios.push({
      service: truth.service,
      fault: truth.fault,
      name: entry.name,
      instances,
    })
  }
  return scenarios.sort((a, b) =>
    a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
  )
}

/** 过滤：name 前缀匹配（如 "payment" 或 "payment_mem"）。 */
export function filterScenarios(
  scenarios: Re2ssScenario[],
  filter?: string,
): Re2ssScenario[] {
  if (!filter || filter.trim().length === 0) return scenarios
  return scenarios.filter(s =>
    s.name.toLowerCase().includes(filter.trim().toLowerCase()),
  )
}