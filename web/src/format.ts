/**
 * 纯展示逻辑（T10）—— 刻意做成**无 React 依赖**的纯函数，
 * 这样它们可以被 `node:test` 直接覆盖（不需要 DOM / jsdom 环境）。
 */
import type { JobStatus } from './api/types.js'

/** 状态徽标文案。 */
export const STATUS_LABELS: Record<JobStatus, string> = {
  pending: '排队中',
  running: '调查中',
  completed: '已完成',
  failed: '失败',
}

/** job 类型文案。 */
export const KIND_LABELS: Record<string, string> = {
  chat: '人工问询',
  alert: '告警诊断',
  resolve: '恢复收敛',
}

/**
 * 相对时间（中文，粗粒度即可 —— 值班员关心"刚刚/几分钟前"，不看秒）。
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts
  if (!Number.isFinite(diff)) return '—'
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 绝对时间（表格用，精确到秒）。 */
export function formatTime(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 耗时（ms → 人类可读）。 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  return `${min}m${Math.round(sec % 60)}s`
}

/**
 * 从 job 取一行摘要。
 *
 * 服务端 `toWireJob` 已把 payload 裁剪成 `summary`（只取字符串键、限长 200），
 * 前端不再自己解析 payload —— 服务端**刻意不下发完整 payload**（可能含敏感字段）。
 * 老服务端无此字段时给占位文案。
 */
export function summarizeJob(job: { summary?: string | null }): string {
  const s = job.summary
  if (typeof s === 'string' && s.trim().length > 0) return s.trim()
  return '(无摘要)'
}

/**
 * 极简 Markdown → HTML（结论文本渲染用）。
 *
 * **为什么不引 markdown 库**：plan 要求"运行时零新增依赖"，且结论文本来自
 * 我们自己产出的 LLM 输出，格式可控。这里只支持：标题、粗体、行内代码、
 * 无序列表、段落。
 *
 * **安全**：先做 HTML 转义，再插入受控标签 —— 顺序不可颠倒，否则 LLM 输出里的
 * `<script>` 会被当标签解析（LLM 输出**不可信**，等于注入面）。
 */
export function renderMarkdown(src: string): string {
  const escaped = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const lines = escaped.split('\n')
  const out: string[] = []
  let inList = false

  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      closeList()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      closeList()
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(bullet[1]!)}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${inline(trimmed)}</p>`)
  }
  closeList()

  return out.join('')
}

/** 行内标记：粗体 + 行内代码。输入必须是**已转义**文本。 */
function inline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** 把任意值渲染成可读的等宽文本（事件 payload / 工具结果）。 */
export function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

/**
 * 从事件 payload 里提取"一行摘要"，供折叠状态下显示。
 * 让值班员不展开也能看清发生了什么。
 */
export function eventSummary(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'tool_start') {
    const tool = payload.tool ?? payload.name ?? payload.toolName
    const args = payload.args ?? payload.input ?? payload.arguments
    const argStr = args !== undefined ? ` ${truncate(formatPayload(args), 90)}` : ''
    return typeof tool === 'string' ? `${tool}${argStr}` : '(调用工具)'
  }
  if (kind === 'tool_result') {
    if (payload.error !== undefined) return `失败：${truncate(formatPayload(payload.error), 100)}`
    const result = payload.result ?? payload.output ?? payload.data
    if (result !== undefined) return truncate(formatPayload(result), 110)
    return payload.ok === true ? '完成' : '(结果)'
  }
  if (kind === 'assistant_message') {
    const text = payload.text ?? payload.content ?? payload.message
    if (typeof text === 'string') return truncate(text.replace(/\s+/g, ' '), 110)
    return '(回复)'
  }
  return truncate(formatPayload(payload), 110)
}

/** 截断并加省略号（摘要用，避免撑破列表行高）。 */
export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}
