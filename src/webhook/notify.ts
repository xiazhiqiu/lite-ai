/**
 * 诊断完成后的 IM 通知推送（可选）。
 *
 * 配置了 notifyUrl 时，用 node 内置 fetch POST 诊断摘要；零新增依赖。
 * 跳过会抛错，避免诊断主流程被通知失败影响。
 */
import type { WebhookConfig } from '../config.js'
import type { Alert } from './types.js'

export async function notifyIfConfigured(
  config: WebhookConfig,
  alert: Alert,
  sessionId: string,
  diagnosisSummary: string,
): Promise<void> {
  const notifyUrl = config.notifyUrl?.trim()
  if (!notifyUrl) return

  const body = {
    alert: alert.title,
    severity: alert.severity,
    status: 'firing',
    summary: diagnosisSummary.trim() || '(无总结)',
    sessionId,
    resumeCommand: `lite-ai --resume ${sessionId}`,
    timestamp: new Date().toISOString(),
  }

  try {
    await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.notifyHeaders ?? {}),
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    // 通知失败不影响诊断结果，仅记录
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[webhook:notify] 推送失败 ${notifyUrl}: ${reason}`)
  }
}