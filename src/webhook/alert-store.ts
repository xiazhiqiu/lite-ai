/**
 * webhook 告警记录存储：LITE_AI_HOME/webhook/alerts.jsonl。
 *
 * 每次收到告警追加一条 'received'，诊断完成后追加一条同 alertId 的 'diagnosed'。
 * /alerts 命令按其列出（按 alertId 取最新状态）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { LITE_AI_DIR } from '../config.js'
import { isEnoentError } from '../utils/errors.js'

export const WEBHOOK_ALERTS_PATH = path.join(LITE_AI_DIR, 'webhook', 'alerts.jsonl')

export type AlertRecord = {
  alertId: string
  sessionId: string
  title: string
  severity: string
  summary: string
  status: 'received' | 'diagnosed'
  timestamp: string
}

function recordLine(record: AlertRecord): string {
  return JSON.stringify(record)
}

export async function appendAlertRecord(
  record: Omit<AlertRecord, 'timestamp'>,
  filePath = WEBHOOK_ALERTS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, recordLine({ ...record, timestamp: new Date().toISOString() }) + '\n', 'utf8')
}

/** 读取告警记录，按 alertId 保留最新一条。 */
export async function listAlertRecords(
  filePath = WEBHOOK_ALERTS_PATH,
): Promise<AlertRecord[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isEnoentError(error)) return []
    throw error
  }

  const latest = new Map<string, AlertRecord>()
  for (const line of content.trim().split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line) as AlertRecord
      if (!record.alertId) continue
      // 同 alertId 取最新的状态（后追加的覆盖先前的）
      latest.set(record.alertId, record)
    } catch {
      // 跳过损坏行
    }
  }

  return [...latest.values()].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  )
}