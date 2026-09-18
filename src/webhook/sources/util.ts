/**
 * 告警源适配器共用的取值工具。
 *
 * 各源 payload 来自外部系统，字段类型不可信（可能是数字、嵌套对象、缺失），
 * 因此统一用**宽松取值**而非类型断言：单个畸形字段只退化为空值，
 * 不会让整个 payload 解析失败（否则一条坏数据会吃掉同批所有告警）。
 */
import type { Alert } from '../types.js'

/** 取字符串；非字符串返回 ''。 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 取对象（非数组）；其它返回 {}。 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 取数组；非数组返回 []。 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 取标签对象：只保留值为字符串的条目（Alert.labels 约定为 Record<string,string>）。
 * 非字符串值直接丢弃，避免把数字/null 塞进 labels 影响 fingerprint 稳定性。
 */
export function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') out[key] = val
  }
  return out
}

/**
 * 取展示用记录：标量（string/number/boolean）都转成字符串，用于拼 description。
 *
 * 与 `asStringRecord` 的区别是**策略不同**：
 * - labels 用严格过滤（asStringRecord）——非字符串值会被丢掉，以保 fingerprint 稳定。
 * - description 是给 Agent 看的证据，数字必须保留（如 Opsgenie details 里的队列长度 90000），
 *   否则关键证据被静默丢弃。
 */
export function asDisplayRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(record)) {
    const s = scalarToString(val)
    if (s !== '') out[key] = s
  }
  return out
}

/**
 * 取标量并转成字符串（number / boolean 也接受），对象/数组/null 返回 ''。
 *
 * 用于那些**类型可能是数字**的字段（如 PagerDuty 的 `incident_number`、
 * Opsgenie 的 `tinyId`）——只收字符串的 asString 会把它们静默丢掉。
 */
export function scalarToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 依次取多个候选键中第一个非空字符串（适配各源字段名不一致）。 */
export function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = asString(source[key])
    if (v !== '') return v
  }
  return ''
}

/**
 * 取时间并归一化为 ISO 字符串；缺失或无法解析时返回 fallback。
 * 各源时间字段名与格式不一（startsAt / created_on / occurred_at / timestamp ...）。
 */
export function asIso(value: unknown, fallback: string): string {
  const raw = asString(value)
  if (raw === '') return fallback
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString()
}

/**
 * 各源状态词 → `firing` | `resolved`。
 * 未知状态按 **firing** 处理：漏关比"误判已恢复"安全——误判会让真故障被丢弃。
 */
export function toAlertStatus(
  value: unknown,
  resolvedWords: readonly string[] = ['resolved', 'ok', 'recovered', 'closed'],
): Alert['status'] {
  const s = asString(value).trim().toLowerCase()
  return resolvedWords.includes(s) ? 'resolved' : 'firing'
}

/** labels 拼接成可读描述（无 description 时的兜底）。 */
export function labelsToDescription(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
}
