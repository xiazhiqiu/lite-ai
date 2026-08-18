/**
 * RE2-SS 评测评分器：对比 agent 诊断输出与真值，计算五项指标。
 *
 * 指标定义：
 *   AC@1 — 首次根因假设（confirmed 且 priority 最小）命中真实故障服务
 *   AC@3 — 前 3 priority 的假设中任一 confirmed 命中真实故障服务
 *   Steps — 从首个工具调用到首个 confirmed 假设的工具调用步数
 *   Evidence Rate — confirmed 假设中至少有一条 evidence 的比例
 *   False Positive — 真实故障服务被标记为 refuted 的次数
 */

import type { HypothesisList } from '../utils/hypothesis-store.js'

export type InstanceResult = {
  /** 场景标识，如 "payment_mem" */
  scenario: string
  /** 实例号，如 "1" */
  instance: string
  /** 重复轮次（0-based） */
  repeat: number
  /** 真实故障服务，如 "payment" */
  truthService: string
  /** 真实故障类型，如 "mem" */
  truthFault: string
  /** 是否在 maxSteps 内完成（未超时） */
  completed: boolean
  /** 总工具调用步数 */
  totalSteps: number
  /** 首个 confirmed 假设时的步数（-1 = 无 confirmed） */
  firstConfirmedStep: number
  /** AC@1 命中 */
  ac1: boolean
  /** AC@3 命中 */
  ac3: boolean
  /** confirmed 假设数 */
  confirmedCount: number
  /** refuted 假设数 */
  refutedCount: number
  /** evidence 总数 */
  evidenceCount: number
  /** confirmed 假设中至少有一条 evidence 的比例 */
  evidenceRate: number
  /** 真实故障服务被 refuted 的次数（false positive） */
  falsePositive: number
  /** 错误信息（如有） */
  error?: string
}

export type AggregateMetrics = {
  /** 总实例数 */
  total: number
  /** 完成数 */
  completed: number
  /** AC@1 均值 */
  ac1: number
  /** AC@3 均值 */
  ac3: number
  /** Steps 均值（仅含完成的实例） */
  avgSteps: number
  /** Evidence Rate 均值 */
  avgEvidenceRate: number
  /** False Positive 总数 */
  totalFalsePositive: number
  /** 各场景细分 */
  byScenario: Record<string, { ac1: number; ac3: number; count: number }>
}

/** 从 description 中提取服务名（忽略大小写，匹配 KNOWN_SERVICES 或常见名称）。 */
function extractService(description: string): string | null {
  const known = [
    'payment', 'carts', 'catalogue', 'orders', 'user', 'shipping',
    'sock-shop', 'sockshop',
  ]
  const lower = description.toLowerCase()
  for (const s of known) {
    if (lower.includes(s)) return s
  }
  // IP/域名模式
  const ipMatch = /(\w+)\s*service/i.exec(lower)
  return ipMatch?.[1] ?? null
}

/** 评分单个实例的假设链。 */
export function scoreInstance(
  hypotheses: HypothesisList,
  truthService: string,
  truthFault: string,
  totalSteps: number,
  firstConfirmedStep: number,
  completed: boolean,
  scenario: string,
  instance: string,
  repeat: number,
  error?: string,
): InstanceResult {
  const all = hypotheses.hypotheses
  const sorted = [...all].sort(
    (a, b) => a.priority - b.priority || a.created_at - b.created_at,
  )

  const confirmed = all.filter(h => h.status === 'confirmed')
  const refuted = all.filter(h => h.status === 'refuted')
  const evidenceCount = all.reduce((sum, h) => sum + h.evidence.length, 0)

  // AC@1: confirmed 且 priority 最小，description 含真实服务
  const rootHypothesis = sorted.find(
    h => h.status === 'confirmed' || h.status === 'inconclusive',
  )
  let ac1 = false
  if (rootHypothesis && rootHypothesis.status === 'confirmed') {
    const svc = extractService(rootHypothesis.description)
    ac1 = svc !== null && svc.toLowerCase() === truthService.toLowerCase()
  }

  // AC@3: 前 3 priority 中任一 confirmed 命中服务
  const top3 = sorted.slice(0, 3)
  const ac3 = top3.some(
    h =>
      h.status === 'confirmed' &&
      extractService(h.description)?.toLowerCase() === truthService.toLowerCase(),
  )

  // Evidence Rate: confirmed 假设中至少有一条 evidence 的比例
  const evidenceRate =
    confirmed.length > 0
      ? confirmed.filter(h => h.evidence.length > 0).length / confirmed.length
      : 0

  // False Positive: 真实服务被 refuted 的次数
  const falsePositive = refuted.filter(
    h =>
      extractService(h.description)?.toLowerCase() ===
      truthService.toLowerCase(),
  ).length

  return {
    scenario,
    instance,
    repeat,
    truthService,
    truthFault,
    completed,
    totalSteps,
    firstConfirmedStep: confirmed.length > 0 ? firstConfirmedStep : -1,
    ac1,
    ac3,
    confirmedCount: confirmed.length,
    refutedCount: refuted.length,
    evidenceCount,
    evidenceRate,
    falsePositive,
    error,
  }
}

/** 聚合多实例结果。 */
export function aggregateResults(
  results: InstanceResult[],
): AggregateMetrics {
  const completed = results.filter(r => r.completed && !r.error)
  const total = results.length

  const ac1 = completed.length > 0
    ? completed.filter(r => r.ac1).length / completed.length
    : 0
  const ac3 = completed.length > 0
    ? completed.filter(r => r.ac3).length / completed.length
    : 0
  const avgSteps = completed.length > 0
    ? completed.reduce((s, r) => s + r.totalSteps, 0) / completed.length
    : 0
  const avgEvidenceRate = completed.length > 0
    ? completed.reduce((s, r) => s + r.evidenceRate, 0) / completed.length
    : 0
  const totalFalsePositive = results.reduce(
    (s, r) => s + r.falsePositive,
    0,
  )

  // 按场景分组
  const byScenario: Record<string, { ac1: number; ac3: number; count: number }> = {}
  for (const r of completed) {
    if (!byScenario[r.scenario]) {
      byScenario[r.scenario] = { ac1: 0, ac3: 0, count: 0 }
    }
    byScenario[r.scenario]!.count += 1
    if (r.ac1) byScenario[r.scenario]!.ac1 += 1
    if (r.ac3) byScenario[r.scenario]!.ac3 += 1
    // 算比例
    byScenario[r.scenario]!.ac1 =
      byScenario[r.scenario]!.ac1 / byScenario[r.scenario]!.count
    byScenario[r.scenario]!.ac3 =
      byScenario[r.scenario]!.ac3 / byScenario[r.scenario]!.count
  }

  return {
    total,
    completed: completed.length,
    ac1,
    ac3,
    avgSteps,
    avgEvidenceRate,
    totalFalsePositive,
    byScenario,
  }
}