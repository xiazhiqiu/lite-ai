import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LITE_AI_DIR } from '../config.js'
import { isEnoentError } from './errors.js'
import { projectSlug } from './project-slug.js'

export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3'] as const
export type Severity = (typeof SEVERITIES)[number]

export type IncidentCheckpoint = {
  id: string
  name: string
  incident_title: string
  severity: Severity
  created_at: number
  /** 创建检查点时从假设链提取的快照（用于交接简报，跨 session 可读）。 */
  hypothesis_summary: string
  /** 已执行的关键诊断命令（最多 10 条）。 */
  key_commands: string[]
  /** 检查点是否处于"当前活动"状态（resume 时识别上次进度）。 */
  active: boolean
}

export type CheckpointList = {
  project: string
  updatedAt: string
  checkpoints: IncidentCheckpoint[]
}

export const checkpointProjectSlug = projectSlug

export function checkpointsFilePath(cwd: string): string {
  return path.join(LITE_AI_DIR, 'checkpoints', `${checkpointProjectSlug(cwd)}.json`)
}

export const MAX_CHECKPOINTS = 5

export function emptyCheckpointList(cwd: string): CheckpointList {
  return {
    project: checkpointProjectSlug(cwd),
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  }
}

export async function readCheckpoints(cwd: string): Promise<CheckpointList> {
  try {
    const raw = await readFile(checkpointsFilePath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as CheckpointList).checkpoints)
    ) {
      return emptyCheckpointList(cwd)
    }
    return parsed as CheckpointList
  } catch (error) {
    if (isEnoentError(error)) return emptyCheckpointList(cwd)
    throw error
  }
}

export async function saveCheckpoints(cwd: string, list: CheckpointList): Promise<void> {
  await mkdir(path.join(LITE_AI_DIR, 'checkpoints'), { recursive: true })
  await writeFile(
    checkpointsFilePath(cwd),
    `${JSON.stringify({ ...list, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

/** 校验结构：字段类型、severity 枚举。 */
export function validateCheckpointList(list: CheckpointList): string | null {
  for (const cp of list.checkpoints) {
    if (typeof cp.id !== 'string' || cp.id.length === 0) {
      return 'Each checkpoint must have a non-empty string "id".'
    }
    if (typeof cp.name !== 'string' || cp.name.length === 0) {
      return `Checkpoint "${cp.id}" must have a non-empty string "name".`
    }
    if (!(SEVERITIES as readonly string[]).includes(cp.severity)) {
      return `Checkpoint "${cp.id}" has invalid severity "${String(cp.severity)}". Must be one of: ${SEVERITIES.join(', ')}.`
    }
    if (!Array.isArray(cp.key_commands)) {
      return `Checkpoint "${cp.id}" must have an array "key_commands".`
    }
  }
  return null
}

/** 超过上限时合并最旧的非活动检查点（保留最新的 MAX_CHECKPOINTS 个；活动检查点始终保留）。 */
export function enforceCheckpointLimit(list: CheckpointList): string | null {
  if (list.checkpoints.length <= MAX_CHECKPOINTS) return null
  const sorted = [...list.checkpoints].sort((a, b) => b.created_at - a.created_at)
  const kept = sorted.slice(0, MAX_CHECKPOINTS)
  const active = sorted.find(cp => cp.active)
  // 若活动检查点不在最新 MAX_CHECKPOINTS 个中，保留它并合并一个更旧的非活动检查点
  if (active && !kept.some(cp => cp.id === active.id)) {
    kept.pop()
    kept.push(active)
  }
  list.checkpoints = kept
  return `Checkpoint limit reached (${MAX_CHECKPOINTS}). Merged oldest inactive checkpoint(s).`
}
