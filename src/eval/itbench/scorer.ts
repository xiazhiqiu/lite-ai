/**
 * ITBench 判分器：precision@full-recall。
 *
 * 从 agent 假设链中提取"已确认根因实体"，与真值实体集对比：
 *  - 若漏掉任一真值实体（有 false negative）→ 该实例得 0 分
 *  - 否则 precision = |P∩G| / |P|（提交数越多且无关，precision 越低）
 *
 * 这同时惩罚漏报（FN）与误报（FP），鼓励 agent 少而准地定位根因。
 */

import type { HypothesisList } from '../../utils/hypothesis-store.js'

export type ItbenchGroundTruth = {
  entities: string[]
  fault?: string
  remediation?: string[]
}

/** 单实例结果（一个场景一次运行）。 */
export type ItbenchInstanceResult = {
  scenario: string
  repeat: number
  steps: number
  completed: boolean
  fullRecall: boolean
  precision: number
  score: number
  submitted: string[]
  groundTruth: string[]
  error?: string
}

/** 聚合结果。 */
export type ItbenchAggregated = {
  instances: ItbenchInstanceResult[]
  fullRecallRate: number
  avgPrecision: number
  avgScore: number
  completed: number
  byScenario: Record<string, ItbenchAggregated>
}

/**
 * OpenTelemetry Demo 的全部服务名，用于从自由文本中提取"根因实体"。
 * 子串匹配（小写），作为实体提取的已知库。
 */
const KNOWN_ENTITIES = [
  'frontend',
  'paymentservice',
  'checkoutservice',
  'productcatalogservice',
  'recommendationservice',
  'cartservice',
  'shippingservice',
  'emailservice',
  'accountingservice',
  'quotationservice',
  'adservice',
  'flagservice',
  'frauddetectionservice',
  'kafka',
  'jaeger',
  'loadgenerator',
  'otelcollector',
  'grafana',
  'prometheus',
  'redis',
  'mongodb',
  'cassandra',
  'linux',
]

/** 归一化实体：小写 + 去非字母数字。让 payment-service 与 paymentservice 视为同一实体。 */
export function normalizeEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 从文本中提取提交的实体集合（基于已知实体库子串匹配）。 */
export function extractEntities(text: string): string[] {
  const lower = text.toLowerCase()
  const found = new Set<string>()
  for (const raw of KNOWN_ENTITIES) {
    if (lower.includes(raw)) {
      found.add(normalizeEntity(raw))
    }
  }
  return [...found]
}

/**
 * 对单次运行判分。
 * @param hypotheses agent 产生的假设链
 * @param groundTruth 真值实体
 * @param totalSteps agent 消耗的工具步数
 * @param completed 是否正常完成（无错误）
 * @param scenario 场景 id（结果里记录用）
 * @param repeat 重复次数序号
 * @param error 若运行出错保存原因
 */
export function scoreInstance(
  hypotheses: HypothesisList,
  groundTruth: ItbenchGroundTruth,
  totalSteps: number,
  completed: boolean,
  scenario: string,
  repeat: number,
  error?: string,
): ItbenchInstanceResult {
  const truth = groundTruth.entities.map(normalizeEntity)

  // 只取 confirmed 假设作为提交的根因实体
  const confirmedText = (hypotheses.hypotheses ?? [])
    .filter(h => h.status === 'confirmed')
    .map(h => `${h.description ?? ''} ${h.conclusion ?? ''}`)
    .join('\n')

  let submitted: string[] = []
  if (confirmedText.trim() !== '') {
    submitted = extractEntities(confirmedText)
  }

  const submittedSet = new Set(submitted)
  const truthSet = new Set(truth)

  const recallFull = truth.every(e => submittedSet.has(e))
  const hasTrue = submitted.filter(e => truthSet.has(e)).length
  const precision = submitted.length > 0 ? hasTrue / submitted.length : 0
  const score = recallFull ? precision : 0

  const steps = Math.max(0, totalSteps)

  return {
    scenario,
    repeat,
    steps,
    completed,
    fullRecall: recallFull,
    precision,
    score,
    submitted,
    groundTruth: truth,
    ...(error ? { error } : {}),
  }
}

/** 聚合多实例结果（只统计 completed 且无 error 的实例）。 */
export function aggregateResults(
  instances: ItbenchInstanceResult[],
): ItbenchAggregated {
  const valid = instances.filter(i => i.completed && !i.error)

  const byScenario: Record<string, ItbenchAggregated> = {}
  for (const inst of valid) {
    const bucket = instances.filter(i => i.scenario === inst.scenario)
    if (!byScenario[inst.scenario]) {
      byScenario[inst.scenario] = aggregateResults(bucket)
    }
  }

  const completed = valid.length
  return {
    instances,
    completed,
    fullRecallRate: completed > 0
      ? valid.filter(i => i.fullRecall).length / completed
      : 0,
    avgPrecision: completed > 0
      ? valid.reduce((s, i) => s + i.precision, 0) / completed
      : 0,
    avgScore: completed > 0
      ? valid.reduce((s, i) => s + i.score, 0) / completed
      : 0,
    byScenario,
  }
}