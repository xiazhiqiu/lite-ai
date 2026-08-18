import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LITE_AI_DIR } from '../config.js'
import { isEnoentError } from './errors.js'

export const HYPOTHESIS_STATUSES = [
  'pending',
  'investigating',
  'confirmed',
  'refuted',
  'inconclusive',
] as const

export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number]

export type Evidence = {
  command: string
  output_summary: string
  data_source: string
  timestamp: number
  supports: boolean
}

export type Hypothesis = {
  id: string
  description: string
  priority: number
  status: HypothesisStatus
  created_at: number
  evidence: Evidence[]
  conclusion?: string
}

export type HypothesisList = {
  incident: string
  updatedAt: string
  hypotheses: Hypothesis[]
}

/** 由 cwd 派生项目标识（与 todo-store 同一规则），保证跨 session 共享同一份假设链。 */
export function hypothesisProjectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

export function hypothesesFilePath(cwd: string): string {
  return path.join(LITE_AI_DIR, 'hypotheses', `${hypothesisProjectSlug(cwd)}.json`)
}

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return (
    typeof value === 'string' &&
    (HYPOTHESIS_STATUSES as readonly string[]).includes(value)
  )
}

export function emptyHypothesisList(cwd: string): HypothesisList {
  return {
    incident: hypothesisProjectSlug(cwd),
    updatedAt: new Date().toISOString(),
    hypotheses: [],
  }
}

export async function readHypotheses(cwd: string): Promise<HypothesisList> {
  try {
    const raw = await readFile(hypothesesFilePath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as HypothesisList).hypotheses)
    ) {
      return emptyHypothesisList(cwd)
    }
    return parsed as HypothesisList
  } catch (error) {
    if (isEnoentError(error)) return emptyHypothesisList(cwd)
    throw error
  }
}

export async function saveHypotheses(cwd: string, list: HypothesisList): Promise<void> {
  await mkdir(path.join(LITE_AI_DIR, 'hypotheses'), { recursive: true })
  await writeFile(
    hypothesesFilePath(cwd),
    `${JSON.stringify({ ...list, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

/** 校验结构：字段类型、status 枚举、priority 范围。 */
export function validateHypothesisList(list: HypothesisList): string | null {
  for (const h of list.hypotheses) {
    if (typeof h.id !== 'string' || h.id.length === 0) {
      return 'Each hypothesis must have a non-empty string "id".'
    }
    if (typeof h.description !== 'string' || h.description.length === 0) {
      return `Hypothesis "${h.id}" must have a non-empty string "description".`
    }
    if (!Number.isInteger(h.priority) || h.priority < 1 || h.priority > 5) {
      return `Hypothesis "${h.id}" has invalid priority "${String(h.priority)}". Must be an integer 1-5.`
    }
    if (!isHypothesisStatus(h.status)) {
      return `Hypothesis "${h.id}" has invalid status "${String(h.status)}". Must be one of: ${HYPOTHESIS_STATUSES.join(', ')}.`
    }
    if (!Array.isArray(h.evidence)) {
      return `Hypothesis "${h.id}" must have an array "evidence".`
    }
  }
  return null
}

/** 汇总：按 priority 排序 + 分状态计数 + 紧凑摘要（每假设一行）。 */
export function summarizeHypotheses(list: HypothesisList): {
  active: number
  confirmed: number
  refuted: number
  summary: string
} {
  const sorted = [...list.hypotheses].sort(
    (a, b) => a.priority - b.priority || a.created_at - b.created_at,
  )
  const counts = { active: 0, confirmed: 0, refuted: 0 }
  for (const h of list.hypotheses) {
    if (h.status === 'confirmed') counts.confirmed += 1
    else if (h.status === 'refuted') counts.refuted += 1
    else counts.active += 1
  }
  const lines = sorted.map(
    h =>
      `[${h.status}] P${h.priority} ${h.id}: ${h.description}` +
      (h.evidence.length > 0 ? ` (${h.evidence.length} evidence)` : ''),
  )
  return { ...counts, summary: lines.length > 0 ? lines.join('\n') : '(none)' }
}
